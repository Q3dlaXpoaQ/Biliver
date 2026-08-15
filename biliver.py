# -*- coding: utf-8 -*-
import argparse
import asyncio
import concurrent.futures
import json
import logging
import os
import random
import signal
import struct
import sys
import time
import traceback
import xml.etree.cElementTree as ET
import zlib
from typing import NamedTuple, Optional
from urllib import request

try:
    import aiohttp
except ImportError:
    print(" 'aiohttp' not found, please run 'pip install aiohttp'")
    sys.exit(1)

try:
    import brotli
except ImportError:
    print(" 'brotli' not found, please run 'pip install brotli'")
    sys.exit(1)

log_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "biliver.log")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    handlers=[logging.FileHandler(log_path, encoding="utf-8")],
)
logger = logging.getLogger("biliver")


def _setup_console_handler(level):
    # 控制台（stdout → mpv 控制台）输出：默认 WARNING 级，--verbose 时 DEBUG 级
    ch = logging.StreamHandler()
    ch.setLevel(level)
    ch.setFormatter(logging.Formatter("%(asctime)s - %(levelname)s - %(message)s"))
    logger.addHandler(ch)


# --- 1. 协议定义 ---
class Operation:
    HEARTBEAT = 2
    HEARTBEAT_REPLY = 3
    SEND_MSG_REPLY = 5
    AUTH = 7
    AUTH_REPLY = 8


class ProtoVer:
    NORMAL = 0
    ZLIB = 2
    BROTLI = 3


HEADER_STRUCT = struct.Struct(">IHHII")
HeaderTuple = NamedTuple(
    "HeaderTuple",
    [
        ("pack_len", int),
        ("raw_header_size", int),
        ("ver", int),
        ("operation", int),
        ("seq", int),
    ],
)


# --- 2. 核心客户端 ---
class BLiveClient:
    ROOM_INIT_URL = "https://api.live.bilibili.com/room/v1/Room/mobileRoomInit"
    DANMAKU_SERVER_CONF_URL = "https://api.live.bilibili.com/room/v1/Danmu/getConf"

    def __init__(self, room_id, session):
        self._tmp_room_id = room_id
        self._room_id = None
        self._session = session
        self._websocket = None
        self._is_running = False
        self.handler = None

    async def init_room(self):
        h = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Referer": "https://www.bilibili.com/",
        }
        try:
            req_timeout = aiohttp.ClientTimeout(total=15, connect=10)
            async with self._session.get(
                self.ROOM_INIT_URL, params={"id": self._tmp_room_id}, headers=h, timeout=req_timeout
            ) as res:
                d = await res.json(content_type=None)
                if d.get("code") != 0:
                    raise Exception(f"房号解析失败: {d.get('message')}")
                self._room_id = d["data"]["room_id"]

            params = {"room_id": self._room_id, "platform": "pc", "player": "web"}
            async with self._session.get(
                self.DANMAKU_SERVER_CONF_URL, params=params, headers=h, timeout=req_timeout
            ) as res:
                d = await res.json(content_type=None)
                if d.get("code") != 0:
                    raise Exception(f"获取配置失败: {d.get('message')}")
                self._host_server_list = d["data"]["host_server_list"]
                self._host_server_token = d["data"]["token"]
            return True
        except Exception as e:
            logger.error(f"初始化房间失败: {e}")
            return False

    async def run(self, stop_event=None):
        # 持续重连，直到被显式停止；stop_event 用于响应 mpv 退出
        self._is_running = True
        retry = 0
        while self._is_running:
            if stop_event is not None and stop_event.is_set():
                break

            if not await self.init_room():
                await asyncio.sleep(2)
                retry += 1
                continue

            try:
                host = self._host_server_list[retry % len(self._host_server_list)]
                url = f"wss://{host['host']}:{host.get('wss_port', 443)}/sub"
                logger.info(f"正在连接弹幕服务器: {url}")
                # 握手超时 10s；接收超时 60s（B 站心跳回复约 30s 一次，60s 足够宽松）。
                # 旧版默认 90s/300s 会让"连接看似存活实则静默"的窗口过长
                async with self._session.ws_connect(
                    url, timeout=10, receive_timeout=60
                ) as ws:
                    self._websocket = ws
                    auth = {
                        "uid": 0,
                        "roomid": self._room_id,
                        "protover": 3,
                        "platform": "web",
                        "type": 2,
                        "key": self._host_server_token,
                    }
                    await ws.send_bytes(self._make_p(auth, Operation.AUTH))
                    hb_task = asyncio.create_task(self._hb())
                    logger.info("连接成功，正在接收弹幕...")
                    retry = 0  # 连接成功后重置重试计数
                    try:
                        async for m in ws:
                            if stop_event is not None and stop_event.is_set():
                                break
                            if m.type == aiohttp.WSMsgType.BINARY:
                                await self._p_ws(m.data)
                            elif m.type == aiohttp.WSMsgType.CLOSE:
                                logger.warning("服务器请求关闭连接")
                                break
                            elif m.type == aiohttp.WSMsgType.CLOSED:
                                logger.warning("连接已关闭")
                                break
                            elif m.type == aiohttp.WSMsgType.ERROR:
                                logger.error(f"WebSocket 错误: {ws.exception()}")
                                break
                    finally:
                        hb_task.cancel()
                        try:
                            await hb_task
                        except asyncio.CancelledError:
                            pass
            except asyncio.CancelledError:
                logger.info("连接任务被取消")
                self._is_running = False
                break
            except Exception as e:
                logger.error(f"网络连接异常: {e}")

            if self._is_running and (stop_event is None or not stop_event.is_set()):
                logger.info("2秒后尝试重连...")
                self._websocket = None
                await asyncio.sleep(2)
                retry += 1

    def stop(self):
        self._is_running = False

    async def _hb(self):
        failures = 0
        while self._is_running and self._websocket:
            try:
                # Bilibili 心跳包，body 为空即可，ver 设为 1
                await self._websocket.send_bytes(
                    HEADER_STRUCT.pack(
                        HEADER_STRUCT.size,
                        HEADER_STRUCT.size,
                        1,
                        Operation.HEARTBEAT,
                        1,
                    )
                )
                # logger.debug("已发送心跳包")
                failures = 0
                await asyncio.sleep(25)
            except asyncio.CancelledError:
                break
            except Exception as e:
                # 单次发送失败不应杀死心跳协程：短暂抖动后重试，
                # 连续失败才放弃（等待服务端超时断开后走重连流程）
                failures += 1
                logger.warning(f"心跳发送失败(第 {failures} 次): {e}")
                if failures >= 3:
                    logger.error("心跳连续失败，放弃心跳，等待服务器断开后重连")
                    break
                await asyncio.sleep(1)

    def _make_p(self, d, op):
        b = json.dumps(d).encode("utf-8")
        return (
            HEADER_STRUCT.pack(
                HEADER_STRUCT.size + len(b), HEADER_STRUCT.size, 1, op, 1
            )
            + b
        )

    async def _p_ws(self, d):
        o = 0
        while o < len(d):
            try:
                h = HeaderTuple(*HEADER_STRUCT.unpack_from(d, o))
                if h.pack_len < HEADER_STRUCT.size or h.raw_header_size < HEADER_STRUCT.size:
                    logger.warning(f"无效包头: pack_len={h.pack_len}, header_size={h.raw_header_size}")
                    break
                b = d[o + h.raw_header_size : o + h.pack_len]
                if h.ver == ProtoVer.BROTLI:
                    await self._p_ws(brotli.decompress(b))
                elif h.ver == ProtoVer.ZLIB:
                    await self._p_ws(zlib.decompress(b))
                elif h.operation == Operation.SEND_MSG_REPLY:
                    try:
                        p = json.loads(b.decode("utf-8"))
                        if p.get("cmd", "").startswith("DANMU_MSG") and self.handler:
                            try:
                                # logger.debug(f"收到弹幕: {p['info'][1]}")
                                self.handler(p["info"])
                            except Exception as e:
                                # 单条弹幕处理失败只丢弃该条，绝不能中断本帧其余分包的解析
                                logger.debug(f"弹幕回调处理失败: {e}")
                    except (json.JSONDecodeError, KeyError, IndexError, UnicodeDecodeError, TypeError) as e:
                        logger.debug(f"解析弹幕消息失败: {e}")
                o += h.pack_len
            except (struct.error, zlib.error) as e:
                logger.warning(f"解析数据包异常: {e}")
                break
            except Exception as e:
                logger.error(f"处理 WebSocket 数据异常: {e}")
                break


# --- 3. 轨道与异步 IPC ---
class DanmakuManager:
    def __init__(self, w=1920, h=1080, area=0.5, fs=36.0, dur=10.0):
        self.w, self.h, self.area, self.fs = w, h, area, fs
        # 减小行间距以容纳更多轨道
        self.th = fs + 8
        self.max_t = max(1, int((h * area) // self.th))
        self.tracks = {}
        self.dur = dur
        # 弹幕总行程 = 屏幕宽 + 预估最大文字宽度(~1200px)
        self.travel = w + 1200
        # 与 Lua 端统一速度：travel / duration
        self.v = self.travel / self.dur
    
    def cleanup_tracks(self):
        """清理过期的轨道时间戳，防止内存泄漏"""
        now = time.monotonic()
        # 清理超过显示时间2倍的过期条目
        expired_threshold = now - (self.dur * 2)
        self.tracks = {k: v for k, v in self.tracks.items() if v > expired_threshold}
        # logger.debug(f"清理过期轨道，当前轨道数: {len(self.tracks)}")

    def find_track(self, text, now=None):
        if now is None:
            now = time.monotonic()
        # 改进的宽度估算
        tw = sum(0.6 if ord(c) < 128 else 1.05 for c in text) * self.fs

        # 寻找首个完全空闲的轨道，命中即返回
        for i in range(self.max_t):
            if now >= self.tracks.get(i, 0):
                # 记录尾部离开屏幕右边缘的时间
                self.tracks[i] = now + (tw / self.v) + 0.2
                return i

        # 如果全部轨道都有弹幕，寻找最快空出的轨道（减少重叠感）
        oldest = min(range(self.max_t), key=lambda i: self.tracks.get(i, 0))
        # 强制占用并更新时间，防止下一条弹幕立即又挤入同一条
        self.tracks[oldest] = max(now, self.tracks.get(oldest, 0)) + (tw / self.v) + 0.2
        return oldest


class IpcWriter:
    # 对 mpv IPC 通道的持久化写入连接，避免每条弹幕都重建连接

    def __init__(self, path):
        self.path = path
        self._file = None
        self.last_write_ok = time.monotonic()  # 最近一次成功写入的时间

    def connect(self):
        # 建立连接（阻塞操作，请在 executor 中调用）
        self.close()
        for attempt in range(3):
            try:
                self._file = open(self.path, "w", encoding="utf-8", buffering=1)
                self.last_write_ok = time.monotonic()
                logger.info(f"IPC 连接成功: {self.path}")
                return True
            except OSError as e:
                logger.warning(f"IPC 连接失败(第 {attempt + 1} 次): {e}")
                self._file = None
                if attempt < 2:
                    time.sleep(0.5)
        return False

    def write(self, cmd):
        # 写入一条命令（阻塞操作，请在 executor 中调用）
        if self._file is None:
            return False
        try:
            self._file.write(json.dumps({"command": cmd}) + "\n")
            self._file.flush()
            self.last_write_ok = time.monotonic()
            return True
        except (OSError, ValueError) as e:
            logger.error(f"IPC 写入失败: {e}")
            self.close()
            return False

    def close(self):
        if self._file is not None:
            try:
                self._file.close()
            except OSError:
                pass
        self._file = None

    @property
    def alive(self):
        return self._file is not None


# 空闲保活写入的命令：Lua 端注册了同名 script-message（空操作），
# 不会产生响应回写，避免填充 mpv 管道读缓冲。
KEEPALIVE_CMD = ["script-message", "biliver-keepalive"]
KEEPALIVE_SENTINEL = object()


async def ipc_worker(queue, writer, executor, shutdown_event, keepalive_interval=15.0):
    # 持久连接写入协程：使用专用线程池（与旧版共用默认 executor 不同），
    # 弹幕写入与任何其他阻塞任务互不争抢线程。
    loop = asyncio.get_running_loop()
    connect_failures = 0
    while True:
        try:
            item = await asyncio.wait_for(queue.get(), timeout=keepalive_interval)
            took_item = True
        except asyncio.TimeoutError:
            item = KEEPALIVE_SENTINEL
            took_item = False

        try:
            if not writer.alive:
                if await loop.run_in_executor(executor, writer.connect):
                    connect_failures = 0
                else:
                    connect_failures += 1
                    if connect_failures >= 20:
                        logger.error("IPC 持续无法连接（mpv 可能已退出），后端退出")
                        shutdown_event.set()
                        return
                    await asyncio.sleep(0.5)
                    continue

            if item is KEEPALIVE_SENTINEL:
                # 空闲保活：在持久连接上写无操作命令，检测连接活性且不新增连接
                item = KEEPALIVE_CMD
                if not await loop.run_in_executor(executor, writer.write, item):
                    logger.warning("空闲保活写入失败，尝试重连")
                    await loop.run_in_executor(executor, writer.connect)
            else:
                if not await loop.run_in_executor(executor, writer.write, item):
                    # 写失败：重连一次再试，仍失败则丢弃（避免队列卡死）
                    if await loop.run_in_executor(executor, writer.connect):
                        await loop.run_in_executor(executor, writer.write, item)
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"IPC Worker 异常: {e}")
            await asyncio.sleep(0.5)
        finally:
            if took_item:
                queue.task_done()


def cleanup_queue(queue):
    # 队列积压时丢弃最旧的弹幕，防止延迟持续增大
    if queue.qsize() > 1000:
        cleanup_size = max(100, int(queue.qsize() * 0.3))
        for _ in range(cleanup_size):
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:
                break
        logger.warning(f"清理了 {cleanup_size} 条积压弹幕，当前队列大小: {queue.qsize()}")


def send_mpv_async(queue, cmd):
    # 持久连接下队列极少积压；仅在极端情况下兜底丢弃最旧消息
    if queue.qsize() >= 1500:
        cleanup_queue(queue)
    if queue.qsize() < 2000:
        queue.put_nowait(cmd)
    else:
        logger.warning("IPC 队列已满，丢弃弹幕")


# --- 4. 点播与入口 ---
def run_vod(target_id, directory, size_str, font, fontsize, opacity_pct, area, duration=10.0):
    cid = target_id
    if target_id.startswith("BV") or target_id.lower().startswith("av"):
        t, v = (
            ("aid", target_id[2:])
            if target_id.lower().startswith("av")
            else ("bvid", target_id)
        )
        try:
            with request.urlopen(
                request.Request(
                    f"https://api.bilibili.com/x/web-interface/view?{t}={v}",
                    headers={"User-Agent": "Mozilla/5.0"},
                ),
                timeout=15,
            ) as res:
                d = json.loads(res.read().decode("utf-8"))
                if d.get("code") == 0:
                    cid = str(d["data"]["cid"])
                    logger.info(f"已获取视频 {target_id} 的 CID: {cid}")
                else:
                    logger.error(f"获取 CID API 返回错误: code={d.get('code')}, msg={d.get('message')}")
                    return
        except Exception as e:
            logger.error(f"获取 CID 失败: {e}")
            return
    try:
        url = f"https://comment.bilibili.com/{cid}.xml"
        with request.urlopen(
            request.Request(url, headers={"User-Agent": "Mozilla/5.0"}),
            timeout=15,
        ) as res:
            raw = res.read()
            # 自动检测 gzip/zlib/raw deflate 格式
            try:
                data = zlib.decompress(raw, zlib.MAX_WBITS | 32).decode("utf-8", "ignore")
            except zlib.error:
                # 如果 wbits|32 失败，尝试 raw deflate
                try:
                    data = zlib.decompress(raw, -zlib.MAX_WBITS).decode("utf-8", "ignore")
                except zlib.error:
                    # 可能未压缩
                    data = raw.decode("utf-8", "ignore")

        root = ET.fromstring(data)

        # 校验分辨率格式
        try:
            w, h = map(int, size_str.split("x"))
            if w <= 0 or h <= 0:
                raise ValueError
        except (ValueError, AttributeError):
            logger.warning(f"无效的分辨率 '{size_str}'，使用默认 1920x1080")
            w, h = 1920, 1080

        dm = DanmakuManager(w=w, h=h, area=area, fs=fontsize, dur=duration)
        alpha = f"{int((100 - float(opacity_pct)) * 2.55):02x}"
        # 干净样式：无描边无阴影、对齐 7
        ass_path = os.path.join(directory, f"danmaku_{target_id}.ass")
        with open(ass_path, "w", encoding="utf-8") as f:
            f.write(
                f"[Script Info]\nPlayResX: {w}\nPlayResY: {h}\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginV, Encoding\nStyle: Default, {font}, {fontsize}, &H{alpha}FFFFFF, &H00000000, &H00000000, 1, 1, 0, 0, 7, 0, 1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
            )
            # 按时间排序以正确计算轨道
            danmakus = []
            for d in root.findall("d"):
                p_attr = d.attrib.get("p")
                if not p_attr:
                    continue
                p = p_attr.split(",")
                if len(p) < 4:
                    continue
                try:
                    danmakus.append(
                        {
                            "t": float(p[0]),
                            "mode": int(p[1]),
                            "col": int(p[3]),
                            "msg": (d.text or "").replace("{", "").replace("}", ""),
                        }
                    )
                except (ValueError, IndexError) as e:
                    logger.debug(f"跳过无效弹幕: {e}")
                    continue
            danmakus.sort(key=lambda x: x["t"])

            written = 0
            for d in danmakus:
                t_s, mode, col, msg = d["t"], d["mode"], d["col"], d["msg"]
                if not msg.strip():
                    continue
                c_ass = f"&H{col & 0xFF:02x}{(col >> 8) & 0xFF:02x}{(col >> 16) & 0xFF:02x}&"
                ts = lambda x: (
                    f"{int(x // 3600)}:{int((x % 3600) // 60):02}:{int(x % 60):02}.{int((x * 100) % 100):02}"
                )
                if mode in (1, 6):  # 滚动弹幕
                    # 借用 DanmakuManager 的轨道计算逻辑
                    # 注意：VOD 的时间是固定的，我们需要模拟时间流逝
                    # 这里简化处理：将 DanmakuManager 的 time.monotonic() 替换为弹幕的相对时间
                    y_pos = 40 + dm.find_track(msg, now=t_s) * dm.th
                    # move 终点 = -(travel - w) 确保文字完全离开左边缘，与轨道速度一致
                    move_end_x = -(dm.travel - w)
                    eff = f"\\move({w}, {y_pos}, {move_end_x}, {y_pos})"
                    f.write(
                        f"Dialogue: 0,{ts(t_s)},{ts(t_s + duration)},Default,,0,0,0,,{{{eff}\\c{c_ass}\\alpha&H{alpha}&}}{msg}\n"
                    )
                    written += 1
                elif mode in (4, 5):  # 顶部/底部弹幕
                    y_pos = (
                        40 + (random.randint(0, dm.max_t - 1) * dm.th)
                        if mode == 5
                        else (h - 80 - random.randint(0, 5) * dm.th)
                    )
                    eff = (
                        f"\\an8\\pos({w / 2}, {y_pos})"
                        if mode == 5
                        else f"\\an2\\pos({w / 2}, {y_pos})"
                    )
                    # 固定弹幕显示时长 = duration 的一半
                    f.write(
                        f"Dialogue: 0,{ts(t_s)},{ts(t_s + duration / 2)},Default,,0,0,0,,{{{eff}\\c{c_ass}\\alpha&H{alpha}&}}{msg}\n"
                    )
                    written += 1
        logger.info(f"点播弹幕转换完成: 共 {written} 条弹幕 -> {ass_path}")
    except ET.ParseError as e:
        logger.error(f"XML 解析失败: {e}")
    except Exception:
        logger.error(f"点播转换失败: {traceback.format_exc()}")


async def run_live(room_id, ipc_path, area, fs, duration=10.0, w=1920, h=1080):
    # 轨道布局由 Lua 端负责，Python 端只负责接收并转发弹幕
    writer = IpcWriter(ipc_path)
    ipc_queue = asyncio.Queue()
    # 专用 IPC 线程池：写入与任何阻塞操作互不争抢线程，
    # 避免弹幕稀疏时其他任务占满默认线程池导致写入饿死
    ipc_executor = concurrent.futures.ThreadPoolExecutor(
        max_workers=2, thread_name_prefix="biliver-ipc"
    )

    # 用于优雅关闭（mpv 退出时 Lua 端 abort 子进程；IPC 长期不可用时 ipc_worker 触发）
    shutdown_event = asyncio.Event()

    worker_task = asyncio.create_task(
        ipc_worker(ipc_queue, writer, ipc_executor, shutdown_event)
    )

    def _signal_handler():
        logger.info("收到终止信号，正在关闭...")
        shutdown_event.set()

    # 注册信号处理（仅 Unix，Windows 下 signal 不支持 asyncio 集成，改用 try/except）
    loop = asyncio.get_running_loop()
    if sys.platform != "win32":
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, _signal_handler)

    def handle_danmaku(info):
        try:
            color_raw = info[0][3]
            text = info[1]
        except (IndexError, KeyError, TypeError):
            return
        try:
            # B 站颜色字段通常为 int，个别消息可能为字符串，做类型兜底
            color = int(color_raw)
        except (TypeError, ValueError):
            color = 0xFFFFFF
        try:
            # 新版协议的长弹幕以 splits 分片下发，逐片渲染避免被截断
            extra = (
                info[0][15]
                if len(info[0]) > 15 and isinstance(info[0][15], dict)
                else {}
            )
            splits = extra.get("splits") or []
            texts = [s for s in splits if s and s.strip()] if splits else [text]
            color_arg = (
                f"&H{color & 0xFF:02x}{(color >> 8) & 0xFF:02x}"
                f"{(color >> 16) & 0xFF:02x}&"
            )
            for t in texts:
                send_mpv_async(ipc_queue, [
                    "script-message",
                    "biliver-danmaku",
                    color_arg,
                    t,
                    "0",
                ])
        except Exception as e:
            logger.debug(f"处理弹幕消息异常: {e}")

    try:
        # 注意：不要在 session 上设 total 超时 —— aiohttp 的 total 可能与
        # WebSocket 接收超时互相干扰导致周期性断连。连接/接收超时改为：
        #   握手指令 -> ws_connect(timeout=10)；消息接收 -> receive_timeout=60
        #   init_room 的 HTTP 请求 -> 逐请求 total=15
        async with aiohttp.ClientSession() as session:
            client = BLiveClient(room_id, session)
            client.handler = handle_danmaku
            await client.run(stop_event=shutdown_event)
    finally:
        worker_task.cancel()
        try:
            await worker_task
        except asyncio.CancelledError:
            pass
        # 非阻塞关闭线程池：正常场景线程很快自行结束；
        # 阻塞中的 connect 由进程退出兜底，避免等待挂死
        ipc_executor.shutdown(wait=False, cancel_futures=True)
        writer.close()
        logger.info("Live 模式已退出")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Biliver Backend")
    subparsers = parser.add_subparsers(dest="mode", help="运行模式")

    # 点播模式 (VOD)
    vod_parser = subparsers.add_parser("vod", help="点播弹幕转换")
    vod_parser.add_argument("-r", "--id", required=True, help="视频 ID (BV/AV/CID)")
    vod_parser.add_argument("-d", "--dir", default="./", help="临时文件目录")
    vod_parser.add_argument(
        "-s", "--size", default="1920x1080", help="分辨率 (如 1920x1080)"
    )
    vod_parser.add_argument("-fn", "--font", default="sans-serif", help="字体名称")
    vod_parser.add_argument(
        "-fs", "--fontsize", type=float, default=37.0, help="字体大小"
    )
    vod_parser.add_argument("-o", "--opacity", default="80", help="透明度 (0-100)")
    vod_parser.add_argument(
        "-a", "--area", type=float, default=0.5, help="显示区域比例 (0.0-1.0)"
    )
    vod_parser.add_argument(
        "-dur", "--duration", type=float, default=10.0, help="弹幕滚动时长（秒）"
    )

    # 直播模式 (Live)
    live_parser = subparsers.add_parser("live", help="直播弹幕实时渲染")
    live_parser.add_argument("room_id", type=int, help="直播间 ID")
    live_parser.add_argument("ipc_path", help="IPC 管道路径")
    live_parser.add_argument("area", type=float, help="显示区域比例")
    live_parser.add_argument("fontsize", type=float, help="字体大小")
    live_parser.add_argument("duration", type=float, help="弹幕滚动时长（秒）")
    live_parser.add_argument("--width", type=int, default=1920, help="视频宽度")
    live_parser.add_argument("--height", type=int, default=1080, help="视频高度")
    live_parser.add_argument(
        "-v", "--verbose", action="store_true", help="输出 DEBUG 级日志（或设置环境变量 BILIVER_DEBUG=1）"
    )

    args = parser.parse_args()

    if os.environ.get("BILIVER_DEBUG"):
        args.verbose = True
    if args.verbose:
        logger.setLevel(logging.DEBUG)
        _setup_console_handler(logging.DEBUG)
    else:
        # 默认在 mpv 控制台输出 WARNING+（重连/IPC 失败等关键事件），方便排查
        _setup_console_handler(logging.WARNING)

    if args.mode == "vod":
        run_vod(
            args.id,
            args.dir,
            args.size,
            args.font,
            args.fontsize,
            args.opacity,
            args.area,
            args.duration,
        )
    elif args.mode == "live":
        try:
            asyncio.run(run_live(args.room_id, args.ipc_path, args.area, args.fontsize, args.duration, args.width, args.height))
        except KeyboardInterrupt:
            logger.info("用户中断")
    else:
        parser.print_help()
