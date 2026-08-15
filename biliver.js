// ==UserScript==
// @name                    Biliver Helper
// @name:zh-CN              Biliver 助手
// @namespace               https://github.com/biliver
// @version                 1.2.0
// @license                 MIT
// @description             Extract Bilibili video/live CDN links and copy MPV command to clipboard
// @description:zh-CN       提取B站视频/直播 CDN 链接并一键复制MPV 指令到剪贴板
// @author                  Biliver
// @match                   https://www.bilibili.com/video/*
// @match                   https://www.bilibili.com/bangumi/play/*
// @match                   https://www.bilibili.com/list/*
// @match                   https://www.bilibili.com/festival/*
// @match                   https://live.bilibili.com/*
// @grant                   GM_setClipboard
// @run-at                  document-idle
// ==/UserScript==

"use strict";

// ===================== 配置 =====================
const CONFIG = {
  bilibili: {
    preferredQuality: "127", // 最高画质
    preferredCodec: "12", // HEVC
    preferredSubtitle: "off",
  },
  bilibiliLive: {
    preferredQuality: "10000", // 原画
    preferredCodec: "12", // HEVC (0=AVC, 12=HEVC, 13=AV1)
    preferredLine: "0",
  },
};

const MAX_TRY_COUNT = 5;
const RETRY_INTERVAL = 600;

// ===================== 工具函数 =====================
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function showToast(message, duration = 3000) {
  let toast = document.getElementById("biliver-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "biliver-toast";
    Object.assign(toast.style, {
      position: "fixed",
      top: "20px",
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: "999999999",
      padding: "10px 24px",
      borderRadius: "8px",
      background: "rgba(0,0,0,0.82)",
      color: "#fff",
      fontSize: "14px",
      fontFamily: "system-ui, sans-serif",
      letterSpacing: "0.5px",
      transition: "opacity 0.4s",
      opacity: "0",
      pointerEvents: "none",
    });
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.display = "block";
  requestAnimationFrame(() => {
    toast.style.opacity = "1";
  });
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => {
      toast.style.display = "none";
    }, 400);
  }, duration);
}

// ===================== 增强请求头工具 =====================
function getSafeUA() {
  const original = navigator.userAgent;
  // B站拦截含 Android/stagefright 的UA，替换为桌面端UA
  if (/Android|stagefright/i.test(original)) {
    return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  }
  return original;
}

function extractKeyCookies(cookieString) {
  if (!cookieString) return "";

  // 关键且 B 站认为必要的 cookie
  const keyCookies = [
    "bili_jct", // CSRF token
    "DedeUserID", // 用户ID
    "DedeUserID__ckMd5", // 用户ID哈希
    "buvid3", // 设备ID
    "buvid4", // 设备ID v4
    "buvid_fp", // 设备指纹
    "LIVE_BUVID", // 直播设备ID
    "bp_t_offset", // 时间偏移
    "sid", // 会话ID
    "bili_ticket", // 登录票据
    "bili_ticket_expires", // 票据过期时间
    "CURRENT_FNVAL", // 当前功能版本
  ];

  const cookies = [];
  const cookiePairs = cookieString.split(";");

  for (const pair of cookiePairs) {
    const trimmed = pair.trim();
    if (!trimmed) continue;

    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const cookieName = trimmed.slice(0, eq).trim();
    const cookieValue = trimmed.slice(eq + 1).trim();
    if (!cookieValue) continue;

    // 关键：mpv 的 --http-header-fields 按逗号分隔头部，Cookie 值若含逗号/引号/换行
    // （如 B 站下发的 bmg_af_sc={"none":{"on":1,"def":"i1.hdslb.com"},...}）会被
    // 切碎成非法请求头（如 "def: i1.hdslb.com}"），导致 CDN 拒绝请求（HTTP 400）
    // 而 mpv 静默退出。此类 cookie 必须剔除，否则一键打开在部分浏览器上失效。
    if (/[,;"\r\n]/.test(cookieValue)) continue;

    // 如果是关键 cookie 或者不是临时性 cookie，则保留
    if (
      keyCookies.includes(cookieName) ||
      (!cookieName.includes("temp") && !cookieName.includes("session"))
    ) {
      cookies.push(`${cookieName}=${cookieValue}`);
    }
  }

  return cookies.join("; ");
}

function enhanceCookieString(cookieString) {
  if (!cookieString) return "";

  // 如果缺少 CSRF token，尝试从 localStorage 或其他地方获取
  if (!cookieString.includes("bili_jct")) {
    try {
      const csrfToken =
        localStorage.getItem("bili_jct") || sessionStorage.getItem("bili_jct");
      if (csrfToken) {
        cookieString += `; bili_jct=${csrfToken}`;
      }
    } catch (_) {}
  }

  return extractKeyCookies(cookieString);
}

function buildEnhancedHeaders(media) {
  const headers = [];

  // 基础头
  if (media.origin) headers.push(`Origin: ${media.origin}`);
  if (media.referer) headers.push(`Referer: ${media.referer}`);

  // 处理 cookie - 确保格式正确
  if (media.cookie) {
    const enhancedCookie = enhanceCookieString(media.cookie);
    if (enhancedCookie) {
      headers.push(`Cookie: ${enhancedCookie}`);
    }
  }

  if (media.userAgent) headers.push(`User-Agent: ${media.userAgent}`);

  // 只添加必要的头，避免 400 错误。
  // 注意：这些头最终会进入 mpv 的 --http-header-fields（按逗号分隔），
  // 因此值内不能含逗号（q= 权重、多值 Accept-Encoding 都会破坏解析）。
  headers.push("Accept: */*");
  headers.push("Accept-Language: zh-CN");
  headers.push("Connection: keep-alive");

  // 直播流需要额外的安全头（值均不含逗号）
  if (media.roomid) {
    headers.push("Accept-Encoding: gzip");
    headers.push("Cache-Control: no-cache");
  }

  return headers;
}

// mpv 的 --http-header-fields 按逗号分隔头部，且无法转义：
// 值内含逗号/引号/换行的头部会被切碎成非法请求头（HTTP 400）。
// 所有最终交给 mpv 的头部列表必须经过此清洗（防御性兜底）：
//   - Cookie 头：按 ';' 拆对，剔除值含逗号/引号/换行的 cookie 对
//     （如 bmg_af_sc={"none":{"on":1,...}}）；';' 本身合法，予以保留
//   - 非 Cookie 头（如 UA 的 "(KHTML, like Gecko)"）：逗号替换为 ';'
function sanitizeHeaderList(headers) {
  const out = [];
  for (const h of headers || []) {
    if (typeof h !== "string") continue;
    const s = h.trim();
    if (!s) continue;
    const idx = s.indexOf(":");
    if (idx <= 0) continue;
    const name = s.slice(0, idx).trim();
    let value = s.slice(idx + 1).trim();
    if (/[\r\n]/.test(value)) continue;
    if (name.toLowerCase() === "cookie") {
      const pairs = value
        .split(";")
        .map((p) => p.trim())
        .filter((p) => p && !/[,;"\r\n]/.test(p));
      if (pairs.length) out.push("Cookie: " + pairs.join("; "));
    } else {
      out.push(name + ": " + value.replace(/,/g, ";"));
    }
  }
  return out;
}

// ===================== Bilibili 视频解析 =====================
async function fetchJSON(url) {
  const res = await fetch(url, { method: "GET", credentials: "include" });
  return res.json();
}

async function getVideoInfoByBvid(pageUrl) {
  const bvMatch = pageUrl.match(/BV([0-9a-zA-Z]+)/);
  const avMatch = pageUrl.match(/av(\d+)/);
  const param = bvMatch
    ? `bvid=${bvMatch[1]}`
    : avMatch
      ? `aid=${avMatch[1]}`
      : null;
  if (!param) throw new Error("找不到 BV/AV 号");

  const resp = await fetchJSON(
    `https://api.bilibili.com/x/web-interface/view?${param}`,
  );
  if (!resp?.data) throw new Error("视频信息获取失败（可能需要登录）");
  let { aid, cid, title } = resp.data;

  // 分P
  const pMatch = pageUrl.match(/[?&]p=([^&]+)/);
  if (pMatch && resp.data.pages?.length > 1) {
    const page = resp.data.pages[parseInt(pMatch[1]) - 1];
    if (page) {
      cid = page.cid;
      title = page.part;
    }
  }
  return { aid, cid, title };
}

async function getVideoInfoByEpid(pageUrl) {
  let epid;
  const epMatch = pageUrl.match(/ep(\d+)/);
  if (epMatch) {
    epid = epMatch[1];
  } else {
    // 尝试从 DOM 中查找
    const selectors = [
      "ep-item cursor visited",
      "ep-item cursor",
      "numberListItem_select__WgCVr",
      "imageListItem_wrap__o28QW",
    ];
    for (const cls of selectors) {
      const el = document.getElementsByClassName(cls)[0];
      if (el) {
        const a = el.querySelector("a");
        if (a) {
          const m = a.href.match(/ep(\d+)/);
          if (m) {
            epid = m[1];
            break;
          }
        }
      }
    }
    if (!epid) {
      const el = document.querySelector(
        ".squirtle-pagelist-select-item.active",
      );
      if (el) epid = el.dataset.value;
    }
  }
  if (!epid) throw new Error("找不到 epid");

  const resp = await fetchJSON(
    `https://api.bilibili.com/pgc/view/web/season?ep_id=${epid}`,
  );
  const sections = [
    ...(resp.result.section || []),
    { episodes: resp.result.episodes },
  ];
  for (let i = sections.length - 1; i >= 0; i--) {
    for (const ep of sections[i].episodes) {
      if (ep.id == epid)
        return { aid: ep.aid, cid: ep.cid, title: ep.share_copy };
    }
  }
  throw new Error("未找到对应剧集");
}

async function getVideoInfoAuto(pageUrl) {
  try {
    // eslint-disable-next-line no-undef
    const state =
      typeof __INITIAL_STATE__ !== "undefined" ? __INITIAL_STATE__ : null;
    if (state) {
      const info = state.epInfo || state.videoData || state.videoInfo;
      if (info && info.aid && info.cid) {
        let cid = info.cid;
        if (state.p && state.p > 1) cid = state.cidMap[info.aid].cids[state.p];
        return { aid: info.aid, cid, title: info.title };
      }
    }
  } catch (_) {
    /* fallback */
  }
  return null;
}

async function getDash(aid, cid) {
  const codecid = CONFIG.bilibili.preferredCodec;
  const quality = CONFIG.bilibili.preferredQuality;
  const url = `https://api.bilibili.com/x/player/playurl?qn=120&otype=json&fourk=1&fnver=0&fnval=4048&avid=${aid}&cid=${cid}`;
  const resp = await fetchJSON(url);
  if (!resp.data) throw new Error("需要登录或大会员");
  const dash = resp.data.dash;
  if (!dash) return null;

  let audio;
  if (dash.flac?.audio) audio = dash.flac.audio.baseUrl;
  else if (dash.dolby?.audio?.[0]) audio = dash.dolby.audio[0].base_url;
  else if (dash.audio?.[0]) audio = dash.audio[0].baseUrl;

  if (!dash.video || dash.video.length === 0) return null;

  let i = 0;
  while (i < dash.video.length && dash.video[i].id > quality) i++;
  if (i >= dash.video.length) i = dash.video.length - 1;

  let video = dash.video[i].baseUrl;
  const id = dash.video[i].id;
  while (i < dash.video.length) {
    if (dash.video[i].id !== id) break;
    if (dash.video[i].codecid == codecid) {
      video = dash.video[i].baseUrl;
      break;
    }
    i++;
  }
  return { video, audio };
}

async function getFlvOrMP4(aid, cid) {
  const url = `https://api.bilibili.com/x/player/playurl?qn=120&otype=json&fourk=1&fnver=0&fnval=128&avid=${aid}&cid=${cid}`;
  const resp = await fetchJSON(url);
  if (!resp.data || !resp.data.durl || !resp.data.durl[0])
    throw new Error("获取 FLV/MP4 地址失败");
  return resp.data.durl[0].url;
}

// ===================== Bilibili 直播解析 =====================
async function getLiveStreamUrl(pageUrl, retryCount = 0) {
  const roomMatch = pageUrl.match(
    /(?:roomid=|blanc\/|live\.bilibili\.com\/)(\d+)/,
  );
  if (!roomMatch) throw new Error("找不到直播间 ID");
  const roomid = roomMatch[1];

  // ---- 1. DASH API: getRoomPlayInfo ----
  // 获取 web player 使用相同接口，获取多质量/编码/协议的流信息
  try {
    const cookie = enhanceCookieString(document.cookie);
    const headers = {
      "User-Agent": getSafeUA(),
      Origin: "https://live.bilibili.com",
      Referer: `https://live.bilibili.com/${roomid}`,
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      ...(cookie && { Cookie: cookie }),
    };

    const params = new URLSearchParams({
      room_id: roomid,
      protocol: "0,1", // 0=FLV, 1=DASH
      format: "0,1,2", // 0=FLV, 1=TS, 2=M4S(fmp4)
      codec: "0,1,2",  // 0=AVC, 1=HEVC, 2=AV1
      qn: "10000",
      platform: "web",
    });

    const resp = await fetch(
      `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?${params}`,
      { method: "GET", headers, credentials: "include" },
    );

    if (!resp.ok) throw new Error(`API 请求失败: ${resp.status}`);

    const data = await resp.json();
    const playurl = data?.data?.playurl_info?.playurl;
    if (!playurl?.stream?.length) throw new Error("直播流信息为空");

    // 1a) 首选 http_stream 格式 flv 格式 AVC (最高画质 + 无HEVC解码问题)
    for (const s of playurl.stream) {
      if (s.protocol_name !== "http_stream") continue;
      for (const fmt of s.format || []) {
        if (fmt.format_name !== "flv") continue;
        // 优先 AVC (最兼容), 避免 HEVC/AV1 解码问题
        const avcCodec = (fmt.codec || []).find(c => c.codec_name === "avc");
        if (avcCodec?.url_info?.[0]) {
          const host = avcCodec.url_info[0].host;
          const base = avcCodec.base_url;
          const extra = avcCodec.url_info[0].extra;
          // 将 qn 提升至 10000 (原画)
          const flvUrl = host + base + extra.replace(/qn=\d+/, "qn=10000");
          return { video: flvUrl, roomid, headers: { Cookie: cookie } };
        }
      }
    }

    // 1b) 回退: http_hls 格式 fmp4 的 master_url (m3u8 多码率自适应)
    for (const s of playurl.stream) {
      if (s.protocol_name !== "http_hls") continue;
      for (const fmt of s.format || []) {
        if (fmt.format_name !== "fmp4") continue;
        if (!fmt.master_url) continue;
        let masterUrl = fmt.master_url;
        masterUrl = masterUrl.replace(/qn=\d+/, "qn=10000");
        masterUrl += (masterUrl.includes("?") ? "&" : "?") + "codec=0";
        return { video: masterUrl, roomid, headers: { Cookie: cookie } };
      }
    }

    // 1c) http_hls.ts 作为最后保底方案
    for (const s of playurl.stream) {
      if (s.protocol_name !== "http_hls") continue;
      for (const fmt of s.format || []) {
        if (fmt.format_name !== "ts") continue;
        const avcCodec = (fmt.codec || []).find(c => c.codec_name === "avc");
        if (avcCodec?.url_info?.[0]) {
          const host = avcCodec.url_info[0].host;
          const base = avcCodec.base_url;
          const extra = avcCodec.url_info[0].extra;
          return { video: host + base + extra.replace(/qn=\d+/, "qn=10000"), roomid, headers: { Cookie: cookie } };
        }
      }
    }

    throw new Error("未找到可用的直播间");
  } catch (e) {
    // 继续走回退流程
    console.warn("DASH API 失败，回退到 playUrl:", e);
  }

  // ---- 2. 回退：旧版 playUrl API ----
  const quality = CONFIG.bilibiliLive.preferredQuality;
  const legacyUrl = new URL(
    `https://api.live.bilibili.com/room/v1/Room/playUrl`,
  );
  legacyUrl.searchParams.set("quality", quality);
  legacyUrl.searchParams.set("cid", roomid);
  legacyUrl.searchParams.set("platform", "web");
  legacyUrl.searchParams.set("t", Date.now());

  const cookie = enhanceCookieString(document.cookie);
  const headers = {
    "User-Agent": getSafeUA(),
    Origin: "https://live.bilibili.com",
    Referer: `https://live.bilibili.com/${roomid}`,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    Connection: "keep-alive",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
    ...(cookie && { Cookie: cookie }),
  };

  try {
    const resp = await fetch(legacyUrl.toString(), {
      method: "GET",
      headers,
      credentials: "include",
    });

    if (!resp.ok) {
      if (resp.status === 403 && retryCount < 2) {
        showToast("遇到 403 错误，正在重试...", 2000);
        await sleep(1000);
        return getLiveStreamUrl(pageUrl, retryCount + 1);
      }
      throw new Error(`请求失败: ${resp.status} ${resp.statusText}`);
    }

    const data = await resp.json();
    if (!data?.data?.durl) {
      throw new Error("无法获取直播流地址（可能未开播或需要登录）");
    }

    const durls = data.data.durl;
    const line = parseInt(CONFIG.bilibiliLive.preferredLine);
    const durl =
      line >= 0 && line < durls.length
        ? durls[line]
        : durls[durls.length - 1];
    if (!durl) throw new Error("未找到有效的直播流线路");

    return { video: durl.url, roomid, headers };
  } catch (error) {
    if (error.message.includes("403") && retryCount < 2) {
      showToast("遇到网络错误，正在重试...", 2000);
      await sleep(2000);
      return getLiveStreamUrl(pageUrl, retryCount + 1);
    }
    throw error;
  }
}

// ===================== MPV 指令构建 =====================
function buildMpvCommand(media) {
  let headers;
  if (media.roomid) {
    headers = buildEnhancedHeaders(media);

    const hasOrigin = headers.some((h) => h.startsWith("Origin:"));
    const hasReferer = headers.some((h) => h.startsWith("Referer:"));
    const hasUserAgent = headers.some((h) => h.startsWith("User-Agent:"));

    if (!hasOrigin) headers.push("Origin: https://live.bilibili.com");
    if (!hasReferer) headers.push("Referer: https://live.bilibili.com/");
    if (!hasUserAgent) headers.push(`User-Agent: ${getSafeUA()}`);

    headers = headers.filter((h) => h.trim());
  } else {
    headers = [
      media.origin && `Origin: ${media.origin}`,
      media.referer && `Referer: ${media.referer}`,
      media.cookie && `Cookie: ${media.cookie}`,
      media.userAgent && `User-Agent: ${media.userAgent}`,
      "Accept: */*",
      "Accept-Language: zh-CN",
      "Connection: keep-alive",
    ].filter(Boolean);
  }

  // 清洗头部：剔除值含逗号/引号/换行的头部（mpv 逗号分隔限制）
  headers = sanitizeHeaderList(headers);

  const args = [
    "mpv",
    `"${media.video}"`,
    media.audio ? `--audio-file="${media.audio}"` : "",
    headers.length > 0 ? `--http-header-fields="${headers.join(",")}"` : "",
    "--ytdl=no",
    "--tls-verify=no",
    media.cid ? `--script-opts-append="cid=${media.cid}"` : "",
    '--script-opts-append="biliver_enabled=yes"',
    media.roomid
      ? `--script-opts-append=biliver_room_id=${media.roomid} --no-ytdl --no-cache --hls-bitrate=max`
      : "",
    media.title ? `--force-media-title="${media.title}"` : "",
    media.time ? `--start="${media.time}"` : "",
  ];
  return args.filter(Boolean).join(" ");
}

function copyToClipboard(text) {
  // 任何剪贴板写入失败都不应阻断后续的一键启动流程（launchViaProtocol）
  try {
    if (typeof GM_setClipboard !== "undefined") {
      GM_setClipboard(text);
      return;
    }
  } catch (_) {
    // 回退到 Clipboard API
  }
  try {
    const p = navigator.clipboard.writeText(text);
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch (_) {
    // 静默失败：处理器会提示"未能读取到播放信息"
  }
}

// ===================== 主逻辑 =====================
async function handleClick() {
  const pageUrl = location.href;
  const isLive = pageUrl.includes("live.bilibili.com");

  showToast(isLive ? "正在解析直播间..." : "正在解析视频...", 6000);

  try {
    const media = {
      video: undefined,
      audio: undefined,
      title: undefined,
      origin: undefined,
      referer: undefined,
      cookie: undefined,
      userAgent: undefined,
      cid: undefined,
      roomid: undefined,
      time: undefined,
    };

    if (isLive) {
      const result = await getLiveStreamUrl(pageUrl);
      media.video = result.video;
      media.audio = result.audio;
      media.roomid = result.roomid;
      media.origin = "https://live.bilibili.com";
      media.referer = `https://live.bilibili.com/${result.roomid}`;
      media.cookie = result.headers?.Cookie || document.cookie;
      media.userAgent = getSafeUA();
    } else {
      // ---- 点播模式 ----
      let info;
      for (let attempt = 0; attempt < MAX_TRY_COUNT; attempt++) {
        try {
          if (pageUrl.includes("/bangumi/play/")) {
            info = await getVideoInfoByEpid(pageUrl);
          } else if (pageUrl.includes("/video/")) {
            info = await getVideoInfoByBvid(pageUrl);
          } else {
            info = await getVideoInfoAuto(pageUrl);
            if (!info) info = await getVideoInfoByBvid(pageUrl);
          }
          if (info?.aid && info?.cid) break;
        } catch (e) {
          console.warn(`第${attempt + 1} 次尝试失败`, e);
          if (attempt < MAX_TRY_COUNT - 1) await sleep(RETRY_INTERVAL);
        }
      }
      if (!info?.aid || !info?.cid) throw new Error("无法获取视频信息");

      // 优先 dash（支持高分辨率 + 分离音频流）
      const dash = await getDash(info.aid, info.cid);
      if (dash) {
        media.video = dash.video;
        media.audio = dash.audio;
      } else {
        media.video = await getFlvOrMP4(info.aid, info.cid);
      }
      media.cid = info.cid;
      media.title = info.title || document.title;
      media.origin = "https://www.bilibili.com";
      media.referer = "https://www.bilibili.com/";
      media.cookie = enhanceCookieString(document.cookie);
      media.userAgent = navigator.userAgent;

      // 尝试获取播放进度
      try {
        const v = document.querySelector("video");
        if (v && v.currentTime > 5) media.time = Math.floor(v.currentTime);
      } catch (_) {}
    }

    if (!media.video) throw new Error("解析失败：未获取到视频地址");

    const cmd = buildMpvCommand(media);
    copyToClipboard(cmd);
    showToast("MPV 指令已复制到剪贴板");

    // 暂停网页播放器
    try {
      document.querySelectorAll("video").forEach((v) => v.pause());
    } catch (_) {}
  } catch (err) {
    console.error("Biliver Helper Error:", err);
    showToast("错误: " + err.message, 5000);
  }
}

async function handlePlayClick() {
  const pageUrl = location.href;
  const isLive = pageUrl.includes("live.bilibili.com");

  showToast(isLive ? "正在解析直播间..." : "正在解析视频...", 6000);

  try {
    const media = {
      video: undefined,
      audio: undefined,
      title: undefined,
      origin: undefined,
      referer: undefined,
      cookie: undefined,
      userAgent: undefined,
      cid: undefined,
      roomid: undefined,
      time: undefined,
    };

    if (isLive) {
      const result = await getLiveStreamUrl(pageUrl);
      media.video = result.video;
      media.audio = result.audio;
      media.roomid = result.roomid;
      media.origin = "https://live.bilibili.com";
      media.referer = `https://live.bilibili.com/${result.roomid}`;
      media.cookie = result.headers?.Cookie || document.cookie;
      media.userAgent = getSafeUA();
    } else {
      let info;
      for (let attempt = 0; attempt < MAX_TRY_COUNT; attempt++) {
        try {
          if (pageUrl.includes("/bangumi/play/")) {
            info = await getVideoInfoByEpid(pageUrl);
          } else if (pageUrl.includes("/video/")) {
            info = await getVideoInfoByBvid(pageUrl);
          } else {
            info = await getVideoInfoAuto(pageUrl);
            if (!info) info = await getVideoInfoByBvid(pageUrl);
          }
          if (info?.aid && info?.cid) break;
        } catch (e) {
          console.warn(`第${attempt + 1} 次尝试失败`, e);
          if (attempt < MAX_TRY_COUNT - 1) await sleep(RETRY_INTERVAL);
        }
      }
      if (!info?.aid || !info?.cid) throw new Error("无法获取视频信息");

      const dash = await getDash(info.aid, info.cid);
      if (dash) {
        media.video = dash.video;
        media.audio = dash.audio;
      } else {
        media.video = await getFlvOrMP4(info.aid, info.cid);
      }
      media.cid = info.cid;
      media.title = info.title || document.title;
      media.origin = "https://www.bilibili.com";
      media.referer = "https://www.bilibili.com/";
      media.cookie = enhanceCookieString(document.cookie);
      media.userAgent = navigator.userAgent;

      try {
        const v = document.querySelector("video");
        if (v && v.currentTime > 5) media.time = Math.floor(v.currentTime);
      } catch (_) {}
    }

    if (!media.video) throw new Error("解析失败：未获取到视频地址");

    // 一键播放：payload（含 cookie 等）写入剪贴板，协议 URL 只携带短 token，
    // 避免长 URL 被旧浏览器截断（cookie + 音视频签名 URL 可达数 KB）。
    const token =
      Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    const payload = {
      k: token,
      t: Date.now(),
      url: media.video,
      audio: media.audio || "",
      headers: buildHeaderString(media),
      cid: media.cid || "",
      roomid: media.roomid || "",
      title: media.title || "",
      start: media.time || "",
    };
    copyToClipboard(JSON.stringify(payload));
    showToast("正在启动 MPV...请勿复制其他内容", 3000);
    launchViaProtocol(token);

    try {
      document.querySelectorAll("video").forEach((v) => v.pause());
    } catch (_) {}
  } catch (err) {
    console.error("Biliver Play Error:", err);
    showToast("错误: " + err.message, 5000);
  }
}

function buildHeaderString(media) {
  const headers = [];
  if (media.roomid) {
    headers.push(...buildEnhancedHeaders(media));
    if (!headers.some((h) => h.startsWith("Origin:"))) headers.push("Origin: https://live.bilibili.com");
    if (!headers.some((h) => h.startsWith("Referer:"))) headers.push("Referer: https://live.bilibili.com/");
    if (!headers.some((h) => h.startsWith("User-Agent:"))) headers.push(`User-Agent: ${getSafeUA()}`);
    headers.push("Accept: */*");
    headers.push("Accept-Language: zh-CN");
    headers.push("Connection: keep-alive");
  } else {
    headers.push(media.origin ? `Origin: ${media.origin}` : "");
    headers.push(media.referer ? `Referer: ${media.referer}` : "");
    headers.push(media.cookie ? `Cookie: ${media.cookie}` : "");
    headers.push(media.userAgent ? `User-Agent: ${media.userAgent}` : "");
    headers.push("Accept: */*");
    headers.push("Accept-Language: zh-CN");
    headers.push("Connection: keep-alive");
  }
  // 清洗头部：剔除值含逗号/引号/换行的头部（mpv 逗号分隔限制）
  return sanitizeHeaderList(headers).join(",");
}

// ===================== 一键启动 MPV =====================
function launchViaProtocol(token) {
  // 检测逻辑：协议注册成功时，浏览器会弹“打开 Biliver？”确认框，用户确认后
  // pythonw + mpv 启动（约 0.5~2s），mpv 窗口出现时浏览器必然失焦。
  // 因此轮询 document.hasFocus() 是最可靠信号；窗口失焦即视为已启动。
  // 检测窗口给到 4s，覆盖冷启动与慢确认，避免 1.5s 竞态导致的误报。
  const CHECK_MS = 4000;
  const start = Date.now();
  let opened = false;
  const markOpened = () => {
    opened = true;
  };
  window.addEventListener("blur", markOpened);
  const onVisibility = () => {
    if (document.hidden) markOpened();
  };
  document.addEventListener("visibilitychange", onVisibility);

  try {
    window.location.href = "biliver://mpv?k=" + token;
  } catch (_) {
    // 某些浏览器对未知协议导航可能抛错，交由轮询判定
  }

  const timer = setInterval(() => {
    if (!document.hasFocus()) markOpened();
    if (opened || Date.now() - start >= CHECK_MS) {
      clearInterval(timer);
      window.removeEventListener("blur", markOpened);
      document.removeEventListener("visibilitychange", onVisibility);
      if (!opened) {
        showToast(
          "MPV 未打开？请确认已运行 install.bat 注册 biliver:// 协议；或改用复制指令按钮",
          5000,
        );
      }
    }
  }, 150);
}

// ===================== 按钮 UI =====================
function showButtons() {
  if (document.getElementById("biliver-play-btn")) return;
  
  // Play button - opens video in MPV via biliver:// protocol
  const playBtn = document.createElement("div");
  playBtn.id = "biliver-play-btn";
  Object.assign(playBtn.style, {
    position: "fixed",
    bottom: "136px",
    left: "16px",
    zIndex: "999999",
    width: "44px",
    height: "44px",
    borderRadius: "50%",
    background: "linear-gradient(135deg, #00a1d6, #00b5e5)",
    boxShadow: "0 2px 12px rgba(0,161,214,0.4)",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "transform 0.2s, box-shadow 0.2s, opacity 0.3s",
    userSelect: "none",
    opacity: "0",
  });
  playBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
  playBtn.title = "在 MPV 中播放";
  playBtn.addEventListener("mouseenter", () => {
    playBtn.style.transform = "scale(1.15)";
    playBtn.style.boxShadow = "0 4px 20px rgba(0,161,214,0.6)";
  });
  playBtn.addEventListener("mouseleave", () => {
    playBtn.style.transform = "scale(1)";
    playBtn.style.boxShadow = "0 2px 12px rgba(0,161,214,0.4)";
  });
  playBtn.addEventListener("click", handlePlayClick);
  document.body.appendChild(playBtn);

  // Copy button - copies MPV command to clipboard
  const copyBtn = document.createElement("div");
  copyBtn.id = "biliver-copy-btn";
  Object.assign(copyBtn.style, {
    position: "fixed",
    bottom: "80px",
    left: "16px",
    zIndex: "999999",
    width: "44px",
    height: "44px",
    borderRadius: "50%",
    background: "linear-gradient(135deg, #6c5ce7, #a29bfe)",
    boxShadow: "0 2px 12px rgba(108,92,231,0.4)",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "transform 0.2s, box-shadow 0.2s, opacity 0.3s",
    userSelect: "none",
    opacity: "0",
  });
  copyBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
  copyBtn.title = "复制 MPV 指令";
  copyBtn.addEventListener("mouseenter", () => {
    copyBtn.style.transform = "scale(1.15)";
    copyBtn.style.boxShadow = "0 4px 20px rgba(108,92,231,0.6)";
  });
  copyBtn.addEventListener("mouseleave", () => {
    copyBtn.style.transform = "scale(1)";
    copyBtn.style.boxShadow = "0 2px 12px rgba(108,92,231,0.4)";
  });
  copyBtn.addEventListener("click", handleClick);
  document.body.appendChild(copyBtn);

  // Fade in animation
  requestAnimationFrame(() => {
    playBtn.style.opacity = "1";
    copyBtn.style.opacity = "1";
  });
}

function hideButtons() {
  const playBtn = document.getElementById("biliver-play-btn");
  const copyBtn = document.getElementById("biliver-copy-btn");
  if (playBtn) playBtn.remove();
  if (copyBtn) copyBtn.remove();
}

// ===================== 页面检测 =====================
const BILIBILI_PATTERNS = [
  /bilibili\.com\/video\//,
  /bilibili\.com\/bangumi\/play\//,
  /bilibili\.com\/list\//,
  /bilibili\.com\/festival\//,
  /live\.bilibili\.com\/\d+/,
];

function isBilibiliPage(url) {
  return BILIBILI_PATTERNS.some((re) => re.test(url));
}

async function detectAndShow() {
  const url = location.href;
  if (!isBilibiliPage(url)) {
    hideButtons();
    return;
  }

  // 直播页面直接显示按钮（直播流随时可用）
  if (url.includes("live.bilibili.com")) {
    showButtons();
    return;
  }

  // 点播页面：等待视频信息可用后再显示
  for (let i = 0; i < MAX_TRY_COUNT; i++) {
    try {
      let info;
      if (url.includes("/bangumi/play/")) {
        info = await getVideoInfoByEpid(url);
      } else {
        info = await getVideoInfoAuto(url);
        if (!info) info = await getVideoInfoByBvid(url);
      }
      if (info?.aid && info?.cid) {
        showButtons();
        return;
      }
    } catch (_) {}
    await sleep(RETRY_INTERVAL);
  }
  // 重试完毕仍失败，不显示按钮
}

// ===================== SPA 导航监听 =====================
let _lastUrl = location.href;

function onUrlChange() {
  const newUrl = location.href;
  if (newUrl !== _lastUrl) {
    _lastUrl = newUrl;
    hideButtons();
    detectAndShow();
  }
}

// Bilibili 是 SPA，用 pushState/popstate + 轮询 兜底
const _origPushState = history.pushState;
history.pushState = function (...args) {
  _origPushState.apply(this, args);
  onUrlChange();
};
const _origReplaceState = history.replaceState;
history.replaceState = function (...args) {
  _origReplaceState.apply(this, args);
  onUrlChange();
};
window.addEventListener("popstate", onUrlChange);
// 轮询兜底（某些场景 pushState 可能被其他脚本覆盖）
setInterval(onUrlChange, 1500);

// ===================== 入口 =====================
detectAndShow();
