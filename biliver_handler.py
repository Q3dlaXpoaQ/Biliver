#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Biliver 协议处理器 (biliver://mpv?k=<token>)

接收浏览器发起的 biliver:// 协议请求，从剪贴板读取播放 payload（JSON），
校验 token 后启动 mpv。纯标准库实现，无第三方依赖。

由 install.bat 注册为 Windows URL Protocol 处理器，处理器定位 mpv 顺序：
  1. 注册表 HKCU\\Software\\Biliver\\MpvPath（install.bat 写入）
  2. PATH 中的 mpv.exe（优先 .exe，避免 mpv.com 弹出控制台）
  3. %APPDATA%\\mpv\\mpv.exe

兼容模式：
  1. URL 直接携带完整参数（如 biliver://mpv?url=...&cid=...）时优先使用 URL 参数。
  2. 某些浏览器（如 Cent Browser）调用外部协议时不传 URL 参数（%1 为空）。
     此时读取剪贴板 payload，若其中的时间戳 t 在 10 秒内写入（新鲜），
     即使 token 无法比对也视为有效，确保一键打开在这些浏览器上同样可用。
"""
import ctypes
import json
import os
import re
import shutil
import subprocess
import sys
import time
import traceback
import urllib.parse

try:
    import winreg
except ImportError:
    winreg = None

PROTOCOL = "biliver"
LOG_FILE = os.path.join(
    os.environ.get("TEMP", os.path.dirname(os.path.abspath(__file__))),
    "biliver_handler.log",
)


def log(message):
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as fh:
            fh.write("[%s] %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), message))
    except Exception:
        pass


def show_error(title, text):
    try:
        user32 = ctypes.windll.user32
        user32.MessageBoxW.argtypes = [
            ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint
        ]
        user32.MessageBoxW.restype = ctypes.c_int
        user32.MessageBoxW(0, text, title, 0x10 | 0x40000)
    except Exception:
        pass


def read_clipboard_text():
    """读取剪贴板文本 (CF_UNICODETEXT)，失败返回 None。"""
    if os.name != "nt":
        return None
    CF_UNICODETEXT = 13
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32

    user32.OpenClipboard.argtypes = [ctypes.c_void_p]
    user32.OpenClipboard.restype = ctypes.c_int
    user32.IsClipboardFormatAvailable.argtypes = [ctypes.c_uint]
    user32.IsClipboardFormatAvailable.restype = ctypes.c_int
    user32.GetClipboardData.argtypes = [ctypes.c_uint]
    user32.GetClipboardData.restype = ctypes.c_void_p
    user32.CloseClipboard.argtypes = []
    user32.CloseClipboard.restype = ctypes.c_int
    kernel32.GlobalLock.argtypes = [ctypes.c_void_p]
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalUnlock.argtypes = [ctypes.c_void_p]
    kernel32.GlobalUnlock.restype = ctypes.c_int

    if not user32.OpenClipboard(0):
        return None
    try:
        if not user32.IsClipboardFormatAvailable(CF_UNICODETEXT):
            return None
        handle = user32.GetClipboardData(CF_UNICODETEXT)
        if not handle:
            return None
        ptr = kernel32.GlobalLock(handle)
        if not ptr:
            return None
        try:
            return ctypes.wstring_at(ptr)
        finally:
            kernel32.GlobalUnlock(handle)
    finally:
        user32.CloseClipboard()


def find_mpv():
    if winreg:
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Biliver") as key:
                try:
                    path, _ = winreg.QueryValueEx(key, "MpvPath")
                    if path and os.path.isfile(path):
                        return path
                except OSError:
                    pass
        except Exception:
            pass

    exe = shutil.which("mpv.exe")
    if exe:
        return exe

    any_mpv = shutil.which("mpv")
    if any_mpv:
        if any_mpv.lower().endswith(".com"):
            sibling = os.path.join(os.path.dirname(any_mpv), "mpv.exe")
            if os.path.isfile(sibling):
                return sibling
        return any_mpv

    default = os.path.join(os.environ.get("APPDATA", ""), "mpv", "mpv.exe")
    if default and os.path.isfile(default):
        return default
    return None


def sanitize_headers(headers):
    """清洗交给 mpv 的 --http-header-fields 头部。

    mpv 按逗号分隔该选项，且无法转义：值内含逗号/引号/换行的头部会被
    切碎成非法请求头（如 B 站 cookie bmg_af_sc={"none":{"on":1,...}}），
    导致 CDN 拒绝请求（HTTP 400）、mpv 静默退出。这里做防御性兜底清洗，
    即使油猴脚本版本较旧（payload 里仍是未清洗的逗号拼接字符串）也能修复。
    """
    if isinstance(headers, list):
        out = []
        for h in headers:
            if not isinstance(h, str):
                continue
            h = h.strip()
            if not h:
                continue
            name, _, value = h.partition(": ")
            if not name:
                continue
            if re.search(r'[\r\n]', value):
                continue
            if name.lower() == "cookie":
                # Cookie 值内含 ';' 合法；剔除含逗号/引号/换行的 cookie 对
                pairs = [
                    p.strip() for p in value.split(";")
                    if p.strip() and not re.search(r'[,;"\r\n]', p)
                ]
                if pairs:
                    out.append("Cookie: " + "; ".join(pairs))
            else:
                # 非 Cookie 头（如 UA 的 "(KHTML, like Gecko)"）：
                # 逗号替换为 ';'，避免被切碎；分号/花括号（JSON 残留）视为坏头
                if re.search(r'[;"{}]', value):
                    continue
                out.append(name + ": " + value.replace(",", ";"))
        return ",".join(out)

    if isinstance(headers, str):
        headers = headers.strip()
        if not headers:
            return ""
        # 旧格式：逗号拼接的字符串。Cookie 段固定出现在 ',User-Agent:' 之前
        # （biliver.js 的固定头部顺序），先在其中按 ';' 拆分剔除坏 cookie 对。
        # 其余部分保持原始书写：mpv 对其余逗号（如 UA 的 ", like Gecko)"）会按
        # HTTP 行折叠规则拼回，不会产生非法头名。
        m = re.search(r"(Cookie:\s*)(.*?)(,User-Agent:)", headers)
        if m:
            pairs = []
            for pair in m.group(2).split(";"):
                pair = pair.strip()
                if not pair:
                    continue
                if re.search(r'[,;"\r\n]', pair):
                    continue
                pairs.append(pair)
            headers = headers[:m.start(2)] + "; ".join(pairs) + headers[m.end(2):]
        return headers

    return ""


def build_mpv_args(payload):
    """根据 payload 构造 mpv 命令行参数（与 biliver.js buildMpvCommand 等价）。"""
    args = [
        "--ytdl=no",
        "--tls-verify=no",
        "--script-opts-append=biliver_enabled=yes",
        # 加载失败时也显示窗口（错误可见），避免 mpv 静默退出导致"点了没反应"
        "--force-window=yes",
    ]
    room_id = payload.get("roomid")
    cid = payload.get("cid")
    if room_id:
        args.append("--script-opts-append=biliver_room_id=%s" % room_id)
        args.extend(["--no-ytdl", "--no-cache", "--hls-bitrate=max"])
    elif cid:
        args.append("--script-opts-append=cid=%s" % cid)

    headers = sanitize_headers(payload.get("headers"))
    if headers:
        args.append("--http-header-fields=" + headers)

    audio = payload.get("audio")
    if audio:
        args.append("--audio-file=" + audio)

    title = payload.get("title")
    if title:
        args.append("--force-media-title=" + title)

    start = payload.get("start")
    if start:
        args.append("--start=%s" % start)

    args.append(payload.get("url", ""))
    return args


def parse_params_from_query(query_string):
    params = urllib.parse.parse_qs(query_string)
    return {key: (values[0] if values else "") for key, values in params.items()}


def main(argv):
    raw_url = argv[1] if len(argv) > 1 else ""
    log("invoked with: %r (argv=%r)" % (raw_url, argv))

    token = ""
    url_params_payload = None
    if raw_url.startswith(PROTOCOL + "://"):
        params = parse_params_from_query(urllib.parse.urlparse(raw_url).query)
        token = params.get("k", "")
        if params.get("url"):
            # 兼容模式：URL 直接携带完整参数
            url_params_payload = params
    else:
        log("URL argument missing/invalid (browser passed empty %%1), relying on clipboard")

    payload = url_params_payload

    # 剪贴板模式：读取 payload（带重试，容忍油猴脚本写入剪贴板的轻微延迟）
    clipboard_text = None
    for _ in range(8):
        clipboard_text = read_clipboard_text()
        if clipboard_text:
            break
        time.sleep(0.25)
    clipboard_data = None
    if clipboard_text:
        try:
            clipboard_data = json.loads(clipboard_text)
        except (ValueError, TypeError):
            clipboard_data = None
            log("clipboard content is not valid JSON")

    if isinstance(clipboard_data, dict) and clipboard_data.get("url"):
        if token and clipboard_data.get("k") == token:
            log("clipboard payload token matched")
            payload = clipboard_data
        elif not payload:
            # 浏览器未传 URL 参数（token 无法比对）时：
            #   - 新版 payload 带时间戳 t：10 秒内写入才视为有效
            #   - 旧版 payload 无时间戳：仅在浏览器确实没传 URL 参数时接受，
            #     保证 Cent 等不传 %1 的浏览器用旧版油猴脚本也能一键打开
            ts = clipboard_data.get("t")
            if isinstance(ts, (int, float)):
                age_ms = (time.time() * 1000) - ts
                if 0 <= age_ms < 10000:
                    log("clipboard payload is fresh (age %dms), using it" % age_ms)
                    payload = clipboard_data
                else:
                    log("clipboard payload is stale (age %dms), rejecting" % age_ms)
            else:
                log("clipboard payload has no timestamp (legacy JS), accepting")
                payload = clipboard_data

    if not payload:
        log("no valid payload")
        show_error(
            "Biliver",
            "未能读取到播放信息。\n\n"
            "请确认刚点击了 Biliver 播放按钮，且点击后没有复制其他内容，然后重试。\n"
            "若仍未生效，请运行 install.bat 完成协议安装。",
        )
        return 1

    mpv_path = find_mpv()
    if not mpv_path:
        log("mpv not found")
        show_error(
            "Biliver",
            "未找到 mpv。\n\n"
            "请将 mpv 所在目录加入系统 PATH，然后重新运行 install.bat。",
        )
        return 1

    args = build_mpv_args(payload)
    log("launching: %s %s" % (mpv_path, " ".join(args)))
    creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    subprocess.Popen([mpv_path] + args, creationflags=creation_flags)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except Exception:
        log(traceback.format_exc())
        show_error("Biliver", "启动失败，请查看日志：%s" % LOG_FILE)
        sys.exit(1)
