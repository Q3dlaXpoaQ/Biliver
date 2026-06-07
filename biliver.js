// ==UserScript==
// @name                    Biliver Helper
// @name:zh-CN              Biliver 助手
// @namespace               https://github.com/biliver
// @version                 1.0.0
// @license                 MIT
// @description             Extract Bilibili video/live CDN links and copy MPV command to clipboard
// @description:zh-CN       提取B站视频/直播 CDN 链接并一键复制 MPV 指令到剪贴板
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

  // 关键的 B 站认证 cookie
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
    "CURRENT_FNVAL", // 当前功能值
  ];

  const cookies = [];
  const cookiePairs = cookieString.split(";");

  for (const pair of cookiePairs) {
    const trimmed = pair.trim();
    if (!trimmed) continue;

    const [name, value] = trimmed.split("=");
    if (name && value) {
      const cookieName = name.trim();
      // 如果是关键 cookie 或者不是临时性 cookie，则保留
      if (
        keyCookies.includes(cookieName) ||
        (!cookieName.includes("temp") && !cookieName.includes("session"))
      ) {
        cookies.push(`${cookieName}=${value}`);
      }
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

  // 只添加必要的头，避免 400 错误
  headers.push("Accept: */*");
  headers.push("Accept-Language: zh-CN,zh;q=0.9,en;q=0.8");
  headers.push("Connection: keep-alive");

  // 直播流需要额外的安全头
  if (media.roomid) {
    headers.push("Accept-Encoding: gzip, deflate, br");
    headers.push("Cache-Control: no-cache");
  }

  return headers;
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
  // 与 web player 使用相同接口，获取多质量/编码/协议的流信息
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

    // 1a) 首选: http_stream → flv → AVC (最高画质 + 无HEVC解码问题)
    for (const s of playurl.stream) {
      if (s.protocol_name !== "http_stream") continue;
      for (const fmt of s.format || []) {
        if (fmt.format_name !== "flv") continue;
        // 选 AVC (最兼容), 避免 HEVC/AV1 解码问题
        const avcCodec = (fmt.codec || []).find(c => c.codec_name === "avc");
        if (avcCodec?.url_info?.[0]) {
          const host = avcCodec.url_info[0].host;
          const base = avcCodec.base_url;
          const extra = avcCodec.url_info[0].extra;
          // 将 qn 提升到 10000 (原画)
          const flvUrl = host + base + extra.replace(/qn=\d+/, "qn=10000");
          return { video: flvUrl, roomid, headers: { Cookie: cookie } };
        }
      }
    }

    // 1b) 回退: http_hls → fmp4 → master_url (m3u8 多码率自适应)
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

    // 1c) http_hls.ts 作为最后保险
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

    throw new Error("未找到可用的直播流");
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
  if (typeof GM_setClipboard !== "undefined") {
    GM_setClipboard(text);
  } else {
    navigator.clipboard.writeText(text);
  }
}

// ===================== 主逻辑 =====================
async function handleClick() {
  const pageUrl = location.href;
  const isLive = pageUrl.includes("live.bilibili.com");

  showToast(isLive ? "正在解析直播流..." : "正在解析视频...", 6000);

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
          console.warn(`第 ${attempt + 1} 次尝试失败:`, e);
          if (attempt < MAX_TRY_COUNT - 1) await sleep(RETRY_INTERVAL);
        }
      }
      if (!info?.aid || !info?.cid) throw new Error("无法获取视频信息");

      // 优先 dash（支持高分辨率 + 分离音频）
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
      media.cookie = document.cookie;
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
    showToast("✅ MPV 指令已复制到剪贴板");

    // 暂停网页播放器
    try {
      document.querySelectorAll("video").forEach((v) => v.pause());
    } catch (_) {}
  } catch (err) {
    console.error("Biliver Helper Error:", err);
    showToast("❌ " + err.message, 5000);
  }
}

// ===================== 按钮 UI =====================
function showButton() {
  if (document.getElementById("biliver-btn")) return; // 防止重复
  const btn = document.createElement("div");
  btn.id = "biliver-btn";
  Object.assign(btn.style, {
    position: "fixed",
    bottom: "80px",
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
  btn.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
  btn.title = "在 MPV 中播放";
  btn.addEventListener("mouseenter", () => {
    btn.style.transform = "scale(1.15)";
    btn.style.boxShadow = "0 4px 20px rgba(0,161,214,0.6)";
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.transform = "scale(1)";
    btn.style.boxShadow = "0 2px 12px rgba(0,161,214,0.4)";
  });
  btn.addEventListener("click", handleClick);
  document.body.appendChild(btn);
  // 淡入动画
  requestAnimationFrame(() => {
    btn.style.opacity = "1";
  });
}

function hideButton() {
  const btn = document.getElementById("biliver-btn");
  if (btn) btn.remove();
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
    hideButton();
    return;
  }

  // 直播页面直接显示按钮（直播流随时可用）
  if (url.includes("live.bilibili.com")) {
    showButton();
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
        showButton();
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
    hideButton();
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
