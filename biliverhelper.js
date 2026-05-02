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

'use strict';

// ===================== 配置 =====================
const CONFIG = {
    bilibili: {
        preferredQuality: '127',   // 最高画质
        preferredCodec: '12',      // HEVC
        preferredSubtitle: 'off',
    },
    bilibiliLive: {
        preferredQuality: '4',     // 原画
        preferredLine: '0',
    },
};

const MAX_TRY_COUNT = 5;
const RETRY_INTERVAL = 600;

// ===================== 工具函数 =====================
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function showToast(message, duration = 3000) {
    let toast = document.getElementById('biliver-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'biliver-toast';
        Object.assign(toast.style, {
            position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%)',
            zIndex: '999999999', padding: '10px 24px', borderRadius: '8px',
            background: 'rgba(0,0,0,0.82)', color: '#fff', fontSize: '14px',
            fontFamily: 'system-ui, sans-serif', letterSpacing: '0.5px',
            transition: 'opacity 0.4s', opacity: '0', pointerEvents: 'none',
        });
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.style.display = 'block';
    requestAnimationFrame(() => { toast.style.opacity = '1'; });
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => { toast.style.display = 'none'; }, 400);
    }, duration);
}

// ===================== Bilibili 视频解析 =====================
async function fetchJSON(url) {
    const res = await fetch(url, { method: 'GET', credentials: 'include' });
    return res.json();
}

async function getVideoInfoByBvid(pageUrl) {
    let param;
    const bvMatch = pageUrl.match(/BV([0-9a-zA-Z]+)/);
    if (bvMatch) {
        param = `bvid=${bvMatch[1]}`;
    } else {
        const avMatch = pageUrl.match(/av(\d+)/);
        if (avMatch) param = `aid=${avMatch[1]}`;
    }
    if (!param) throw new Error('找不到 BV/AV 号');

    const resp = await fetchJSON(`https://api.bilibili.com/x/web-interface/view?${param}`);
    if (!resp?.data) throw new Error('视频信息获取失败（可能需要登录）');
    let { aid, cid, title } = resp.data;

    // 分P
    const pMatch = pageUrl.match(/[?&]p=([^&]+)/);
    if (pMatch && resp.data.pages?.length > 1) {
        const page = resp.data.pages[parseInt(pMatch[1]) - 1];
        if (page) { cid = page.cid; title = page.part; }
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
            'ep-item cursor visited', 'ep-item cursor',
            'numberListItem_select__WgCVr', 'imageListItem_wrap__o28QW',
        ];
        for (const cls of selectors) {
            const el = document.getElementsByClassName(cls)[0];
            if (el) {
                const a = el.querySelector('a');
                if (a) { const m = a.href.match(/ep(\d+)/); if (m) { epid = m[1]; break; } }
            }
        }
        if (!epid) {
            const el = document.querySelector('.squirtle-pagelist-select-item.active');
            if (el) epid = el.dataset.value;
        }
    }
    if (!epid) throw new Error('找不到 epid');

    const resp = await fetchJSON(`https://api.bilibili.com/pgc/view/web/season?ep_id=${epid}`);
    const sections = [...(resp.result.section || []), { episodes: resp.result.episodes }];
    for (let i = sections.length - 1; i >= 0; i--) {
        for (const ep of sections[i].episodes) {
            if (ep.id == epid) return { aid: ep.aid, cid: ep.cid, title: ep.share_copy };
        }
    }
    throw new Error('未找到对应剧集');
}

async function getVideoInfoAuto(pageUrl) {
    try {
        // eslint-disable-next-line no-undef
        const state = typeof __INITIAL_STATE__ !== 'undefined' ? __INITIAL_STATE__ : null;
        if (state) {
            const info = state.epInfo || state.videoData || state.videoInfo;
            if (info && info.aid && info.cid) {
                let cid = info.cid;
                if (state.p && state.p > 1) cid = state.cidMap[info.aid].cids[state.p];
                return { aid: info.aid, cid, title: info.title };
            }
        }
    } catch (_) { /* fallback */ }
    return null;
}

async function getDash(aid, cid) {
    const codecid = CONFIG.bilibili.preferredCodec;
    const quality = CONFIG.bilibili.preferredQuality;
    const url = `https://api.bilibili.com/x/player/playurl?qn=120&otype=json&fourk=1&fnver=0&fnval=4048&avid=${aid}&cid=${cid}`;
    const resp = await fetchJSON(url);
    if (!resp.data) throw new Error('需要登录或大会员');
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
        if (dash.video[i].codecid == codecid) { video = dash.video[i].baseUrl; break; }
        i++;
    }
    return { video, audio };
}

async function getFlvOrMP4(aid, cid) {
    const url = `https://api.bilibili.com/x/player/playurl?qn=120&otype=json&fourk=1&fnver=0&fnval=128&avid=${aid}&cid=${cid}`;
    const resp = await fetchJSON(url);
    if (!resp.data || !resp.data.durl || !resp.data.durl[0]) throw new Error('获取 FLV/MP4 地址失败');
    return resp.data.durl[0].url;
}

// ===================== Bilibili 直播解析 =====================
async function getLiveStreamUrl(pageUrl) {
    const roomMatch = pageUrl.match(/(?:roomid=|blanc\/|live\.bilibili\.com\/)(\d+)/);
    if (!roomMatch) throw new Error('找不到直播间 ID');
    const roomid = roomMatch[1];
    const quality = CONFIG.bilibiliLive.preferredQuality;
    const url = `https://api.live.bilibili.com/room/v1/Room/playUrl?quality=${quality}&cid=${roomid}`;
    const resp = await fetchJSON(url);
    if (!resp?.data?.durl) throw new Error('无法获取直播流地址（可能未开播或需要登录）');
    const durls = resp.data.durl;
    const line = parseInt(CONFIG.bilibiliLive.preferredLine);
    const durl = (line >= 0 && line < durls.length) ? durls[line] : durls[durls.length - 1];
    if (!durl) throw new Error('未找到有效的直播流线路');
    return { video: durl.url, roomid };
}

// ===================== MPV 指令构建 =====================
function buildMpvCommand(media) {
    const args = [
        'mpv',
        `"${media.video}"`,
        media.audio ? `--audio-file="${media.audio}"` : '',
        media.origin ? `--http-header-fields="Origin: ${media.origin}"` : '',
        media.referer ? `--http-header-fields="Referer: ${media.referer}"` : '',
        media.cookie ? `--http-header-fields="Cookie: ${media.cookie}"` : '',
        media.userAgent ? `--user-agent="${media.userAgent}"` : '',
        media.cid ? `--script-opts-append="cid=${media.cid}"` : '',
        '--script-opts-append="biliver_enabled=yes"',
        media.roomid ? `--script-opts-append=biliver_room_id=${media.roomid}` : '',
        media.title ? `--force-media-title="${media.title}"` : '',
        media.time ? `--start="${media.time}"` : '',
    ];
    return args.filter(Boolean).join(' ');
}

function copyToClipboard(text) {
    if (typeof GM_setClipboard !== 'undefined') {
        GM_setClipboard(text);
    } else {
        navigator.clipboard.writeText(text);
    }
}

// ===================== 主逻辑 =====================
async function handleClick() {
    const pageUrl = location.href;
    const isLive = pageUrl.includes('live.bilibili.com');

    showToast(isLive ? '正在解析直播流...' : '正在解析视频...', 6000);

    try {
        const media = {
            video: undefined, audio: undefined, title: undefined,
            origin: undefined, referer: undefined, cookie: undefined, userAgent: undefined,
            cid: undefined, roomid: undefined, time: undefined,
        };

        if (isLive) {
            // ---- 直播模式 ----
            const result = await getLiveStreamUrl(pageUrl);
            media.video = result.video;
            media.roomid = result.roomid;
            media.origin = 'https://live.bilibili.com';
            media.referer = 'https://live.bilibili.com/';
            media.cookie = document.cookie;
            media.userAgent = navigator.userAgent;
        } else {
            // ---- 点播模式 ----
            let info;
            for (let attempt = 0; attempt < MAX_TRY_COUNT; attempt++) {
                try {
                    if (pageUrl.includes('/bangumi/play/')) {
                        info = await getVideoInfoByEpid(pageUrl);
                    } else if (pageUrl.includes('/video/')) {
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
            if (!info?.aid || !info?.cid) throw new Error('无法获取视频信息');

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
            media.origin = 'https://www.bilibili.com';
            media.referer = 'https://www.bilibili.com/';
            media.cookie = document.cookie;
            media.userAgent = navigator.userAgent;

            // 尝试获取播放进度
            try {
                const v = document.querySelector('video');
                if (v && v.currentTime > 5) media.time = Math.floor(v.currentTime);
            } catch (_) {}
        }

        if (!media.video) throw new Error('解析失败：未获取到视频地址');

        const cmd = buildMpvCommand(media);
        copyToClipboard(cmd);
        showToast('✅ MPV 指令已复制到剪贴板');

        // 暂停网页播放器
        try { document.querySelectorAll('video').forEach(v => v.pause()); } catch (_) {}

    } catch (err) {
        console.error('Biliver Helper Error:', err);
        showToast('❌ ' + err.message, 5000);
    }
}

// ===================== 按钮 UI =====================
function showButton() {
    if (document.getElementById('biliver-btn')) return; // 防止重复
    const btn = document.createElement('div');
    btn.id = 'biliver-btn';
    Object.assign(btn.style, {
        position: 'fixed', bottom: '80px', left: '16px', zIndex: '999999',
        width: '44px', height: '44px', borderRadius: '50%',
        background: 'linear-gradient(135deg, #00a1d6, #00b5e5)',
        boxShadow: '0 2px 12px rgba(0,161,214,0.4)',
        cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'transform 0.2s, box-shadow 0.2s, opacity 0.3s', userSelect: 'none',
        opacity: '0',
    });
    btn.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
    btn.title = '在 MPV 中播放';
    btn.addEventListener('mouseenter', () => {
        btn.style.transform = 'scale(1.15)';
        btn.style.boxShadow = '0 4px 20px rgba(0,161,214,0.6)';
    });
    btn.addEventListener('mouseleave', () => {
        btn.style.transform = 'scale(1)';
        btn.style.boxShadow = '0 2px 12px rgba(0,161,214,0.4)';
    });
    btn.addEventListener('click', handleClick);
    document.body.appendChild(btn);
    // 淡入动画
    requestAnimationFrame(() => { btn.style.opacity = '1'; });
}

function hideButton() {
    const btn = document.getElementById('biliver-btn');
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
    return BILIBILI_PATTERNS.some(re => re.test(url));
}

async function detectAndShow() {
    const url = location.href;
    if (!isBilibiliPage(url)) {
        hideButton();
        return;
    }

    // 直播页面直接显示按钮（直播流随时可用）
    if (url.includes('live.bilibili.com')) {
        showButton();
        return;
    }

    // 点播页面：等待视频信息可用后再显示
    for (let i = 0; i < MAX_TRY_COUNT; i++) {
        try {
            let info;
            if (url.includes('/bangumi/play/')) {
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
window.addEventListener('popstate', onUrlChange);
// 轮询兜底（某些场景 pushState 可能被其他脚本覆盖）
setInterval(onUrlChange, 1500);

// ===================== 入口 =====================
detectAndShow();
