local utils = require 'mp.utils'
local msg = require 'mp.msg'
local options = require 'mp.options'

local o = {
    python_path = "python",
    font_size = 36,
    duration = 10,
    opacity = 60, -- 0-100, 100 is opaque
    area = 0.45,
    fontname = "Microsoft YaHei",
    fps_vf = "yes",
    max_pool = 2000, -- 直播弹幕池大小上限（仅作为极端弹幕潮时的内存保护）
}
options.read_options(o, "biliver")

-- 字体可用性处理：确保 libass 不会因找不到字体而反复报错
-- 如果指定字体可能导致性能问题，自动回退到系统安全字体
local function get_safe_fontname()
    local name = o.fontname
    if not name or name == "" then
        return "sans-serif"
    end
    -- 针对 Windows 平台，确保字体名能被 DirectWrite 正确识别
    -- "Microsoft YaHei" 的标准名称可能因系统区域设置而异
    -- 保留用户配置，但通过后续的 sub-fonts-dir 和 log-level 来兜底
    return name
end

-- 设定全局字体属性，让 mpv/libass 能更可靠地找到字体
-- 避免在 ASS 内联样式中重复指定字体导致的查找失败
local safe_fontname = get_safe_fontname()
pcall(function()
    mp.set_property("sub-font", safe_fontname)
end)

-- Windows 平台：将系统字体目录加入字体搜索路径
if package.config:sub(1,1) == '\\' then
    pcall(function()
        local font_dir = os.getenv("WINDIR") or "C:\\Windows"
        font_dir = font_dir .. "\\Fonts"
        mp.set_property("sub-fonts-dir", font_dir)
    end)
end

-- 兼容性处理：将字符串转为布尔值
if type(o.fps_vf) == "string" then
    o.fps_vf = (o.fps_vf == "yes" or o.fps_vf == "true")
end

-- Convert percentage (0-100) to ASS Alpha hex (00-FF, where 00 is opaque)
local function get_ass_alpha(pct)
    local val = tonumber(pct) or 80
    local alpha = math.floor((100 - val) * 2.55)
    if alpha < 0 then alpha = 0 end
    if alpha > 255 then alpha = 255 end
    return string.format("%02X", alpha)
end

local ass_alpha = get_ass_alpha(o.opacity)

local backend_process = nil
local danmu_file = nil
local vod_danmaku_loaded = false

-- 获取或设置 IPC Server
local ipc_server = mp.get_property("input-ipc-server")
if not ipc_server or ipc_server == "" then
    local is_windows = package.config:sub(1,1) == '\\'
    if is_windows then
        ipc_server = "\\\\.\\pipe\\mpv-biliver-" .. math.random(100000, 999999)
    else
        ipc_server = "/tmp/mpv-biliver-" .. math.random(100000, 999999) .. ".sock"
    end
    mp.set_property("input-ipc-server", ipc_server)
end

-- 强制开启 OSD 层级，但关闭内置进度条（避免与 modernz 冲突）
mp.set_property_number("osd-level", 1)
mp.set_property_bool("osd-bar", false)

-- 读取视频像素分辨率 (dw/dh 优先)，失败回退默认值
local function get_video_dims(default_w, default_h)
    local vo_params = mp.get_property_native('video-out-params')
    if not vo_params then
        return default_w, default_h
    end
    local w = vo_params.dw or vo_params.w or default_w
    local h = vo_params.dh or vo_params.h or default_h
    return w, h
end

-- 安全移除 Biliver-FPS 滤镜（先检查是否存在）
local function has_fps_vf()
    local filters = mp.get_property_native("vf")
    if not filters then return false end
    for _, f in ipairs(filters) do
        if f.label == "Biliver-FPS" then return true end
    end
    return false
end


local function safe_remove_fps_vf()
    if not has_fps_vf() then return false end
    pcall(function()
        mp.commandv('vf', 'remove', '@Biliver-FPS')
    end)
    return true
end

-- 帧率优化滤镜：确保弹幕始终以 60fps 渲染
local function update_fps_vf(force)
    if not o.fps_vf then return end

    local has_filter = has_fps_vf()

    -- 直播模式：强制添加补帧滤镜，不等待 container-fps
    if force then
        if not has_filter then
            pcall(function()
                mp.commandv('vf', 'append', '@Biliver-FPS:fps=fps=60:round=near')
            end)
        end
        return
    end

    local video_fps = mp.get_property_number("container-fps")
    local video_speed = mp.get_property_number("speed", 1)
    
    -- container-fps 尚未可用（视频还未加载完成）
    if not video_fps then return end

    -- 低于 59fps 的视频补帧到 60fps（涵盖 24/25/30/50fps）
    -- 倍速 >= 2x 时移除滤镜避免性能问题
    if video_fps < 59 and video_speed < 2.0 then
        if not has_filter then
            local ok, err = pcall(function()
                mp.commandv('vf', 'append', '@Biliver-FPS:fps=fps=60:round=near')
            end)
            if ok then
                msg.info(string.format("已添加 60fps 补帧滤镜 (源: %.1ffps)", video_fps))
            else
                msg.warn("添加补帧滤镜失败: " .. tostring(err))
            end
        end
    else
        if has_filter then
            safe_remove_fps_vf()
            msg.info(string.format("已移除补帧滤镜 (fps=%.1f, speed=%.1fx)", video_fps, video_speed))
        end
    end
end

-- Live danmaku rendering (OSD overlay, zero flicker, 60fps)
local TOP_MARGIN = 10
local travel_dist = 1920 + 1200

local overlay = nil
local dm_pool = {}
local danmaku_received = 0 -- 诊断用累计接收计数
local render_timer = nil
local render_running = false
local saved_msg_level = nil
local danmaku_visible = true
local live_w, live_h = 1920, 1080
local danmaku_speed = travel_dist / o.duration
local track_height = o.font_size + 8
local max_tracks = math.max(1, math.floor((1080 * o.area) / track_height))
local track_until = {}
local render_period = 1 / 60 -- OSD 渲染周期（默认 60Hz，有显示器信息时提升到 120Hz）

-- 依据显示/垂直同步信息调整渲染周期：OSD 更新应快于视频帧率，
-- 否则 Lua 60Hz 定时器与视频帧率之间的拍频会造成周期性"卡一下"
local function refresh_render_period()
    local p = 1 / 60
    local vi = mp.get_property_number("vsync-interval")
    local df = mp.get_property_number("display-fps")
    if vi and vi > 0.001 and vi < 0.05 then
        p = vi / 2
    elseif df and df > 30 and df < 300 then
        p = 1 / df / 2
    end
    render_period = math.max(1 / 120, p)
end
mp.observe_property("display-fps", nil, refresh_render_period)
mp.observe_property("vsync-interval", nil, refresh_render_period)

local function sanitize_text(text)
    return text:gsub("[{}]", ""):gsub("[\r\n]", " ")
end

local function estimate_text_width(text)
    -- 按 UTF-8 字符数估算宽度，避免把多字节字符的每个字节都算作一个字导致宽度高估 3 倍
    local ascii = 0
    local cont = 0
    for i = 1, #text do
        local b = text:byte(i)
        if b < 128 then
            ascii = ascii + 1
        elseif b >= 128 and b < 192 then -- 10xxxxxx 是 UTF-8 连续字节
            cont = cont + 1
        end
    end
    local wide = (#text - cont) - ascii
    return (ascii * 0.6 + wide * 1.05) * o.font_size
end

-- 弹幕时钟：优先跟随视频时间轴 (time-pos)，直播无有效 time-pos 时退回墙钟。
-- 关键：视频卡顿/重同步时画面跳变，若弹幕仍按墙钟走就会与画面产生相对偏移，
-- 表现为"弹幕往后退/快进"。跟随视频时间轴后，画面跳、弹幕同步跳，二者永不失步。
local function danmaku_clock()
    local tp = mp.get_property_number("time-pos")
    if tp and tp > 0 and tp < 1e7 then
        return tp
    end
    return mp.get_time()
end

local function pick_track(text_width)
    local now = danmaku_clock()
    local travel_time = text_width / danmaku_speed + 0.2
    for i = 1, max_tracks do
        if now >= (track_until[i] or 0) then
            track_until[i] = now + travel_time
            return i, now
        end
    end
    local best = 1
    for i = 2, max_tracks do
        if (track_until[i] or 0) < (track_until[best] or 0) then
            best = i
        end
    end
    local effective_start = (track_until[best] or now)
    track_until[best] = effective_start + travel_time
    return best, effective_start
end

local function trim_pool()
    -- 仅在池子超过上限（极端弹幕潮）时丢弃最旧的弹幕，正常情况不会触发
    local n = #dm_pool
    if n <= o.max_pool then return end
    local excess = n - o.max_pool
    local trimmed = {}
    for i = excess + 1, n do
        trimmed[#trimmed + 1] = dm_pool[i]
    end
    dm_pool = trimmed
end

local function render_frame()
    render_timer = nil
    render_running = false
    if not danmaku_visible or not overlay then
        return
    end

    local now = danmaku_clock()
    local alive = {}
    for _, dm in ipairs(dm_pool) do
        -- 每条弹幕的 elapsed 单调非减：即使 mp.get_time() 回退
        -- （直播流时钟重同步等），弹幕也只暂停、绝不后退
        local el = now - dm.born
        if dm.elapsed ~= nil and el < dm.elapsed then
            el = dm.elapsed
        end
        if el < dm.lifespan then
            dm.elapsed = el
            alive[#alive + 1] = dm
        end
        -- 过期弹幕（el >= lifespan）直接移除
    end
    dm_pool = alive
    trim_pool()

    if #dm_pool == 0 then
        overlay.data = ""
        overlay:update()
        return
    end

    local lines = {}
    for _, dm in ipairs(dm_pool) do
        local elapsed = dm.elapsed or 0
        if elapsed < 0 then elapsed = 0 end
        local x = dm.start_x - danmaku_speed * elapsed
        if x < dm.end_x then x = dm.end_x end
        -- 尚未进入屏幕（正在排队 / 时钟回退暂停）的弹幕不参与渲染，减少每帧开销
        if x < dm.start_x then
            lines[#lines + 1] = string.format(
                "{\\an7\\pos(%.1f,%d)\\c%s\\bord0\\shad0\\b1\\fs%d\\fn%s\\alpha&H%s&}%s",
                x, dm.y, dm.color, o.font_size, o.fontname, ass_alpha, dm.text
            )
        end
    end

    overlay.data = (#lines > 0) and table.concat(lines, "\n") or ""
    overlay:update()

    -- 渲染周期：默认 60Hz，有显示/垂直同步信息时提升到 120Hz（见 refresh_render_period）
    render_running = true
    render_timer = mp.add_timeout(render_period, render_frame)
end

local function start_render()
    if not danmaku_visible or not overlay then return end
    if #dm_pool == 0 then return end
    -- 自愈：即使 render_running 标记残留为 true 而定时器已丢失，也重新调度
    if render_running and render_timer then return end
    render_running = true
    render_timer = mp.add_timeout(render_period, render_frame)
end

local function add_danmaku(color, text, y_hint)
    if not overlay then return end
    text = sanitize_text(text)
    if text == "" then return end

    danmaku_received = danmaku_received + 1
    if danmaku_received % 200 == 0 then
        msg.verbose(string.format("已接收 %d 条弹幕，当前池: %d", danmaku_received, #dm_pool))
    end

    local tw = estimate_text_width(text)
    local track, effective_start = pick_track(tw)
    local y_pos = TOP_MARGIN + (track - 1) * track_height

    dm_pool[#dm_pool + 1] = {
        text = text,
        color = color,
        y = y_pos,
        born = effective_start,
        lifespan = o.duration,
        elapsed = nil, -- 单调 elapsed：时钟回退时保持位置，绝不后退
        start_x = live_w,
        end_x = -(travel_dist - live_w),
    }
    trim_pool()

    start_render()
end

local function init_live_osd()
    if overlay then
        overlay:remove()
    end

    live_w, live_h = get_video_dims(1920, 1080)

    travel_dist = live_w + 1200
    danmaku_speed = travel_dist / o.duration
    track_height = o.font_size + 8
    max_tracks = math.max(1, math.floor((live_h * o.area) / track_height))
    track_until = {}
    dm_pool = {}

    if render_timer then
        render_timer:kill()
        render_timer = nil
    end
    render_running = false

    overlay = mp.create_osd_overlay("ass-events")
    overlay.res_x = live_w
    overlay.res_y = live_h
    overlay.data = ""
    overlay:update()
end

mp.register_script_message("biliver-danmaku", add_danmaku)

-- 后端空闲保活探测：Python 端在持久 IPC 连接上定期发送（无操作），
-- 用于检测连接活性，不新增连接、不产生响应回写
mp.register_script_message("biliver-keepalive", function() end)

-- 直播后端进程看护：后端意外退出时自动重启，避免弹幕静默消失
local live_active = false
local live_gen = 0
local live_restart_attempt = 0
local live_restart_delay = 2
local live_backend_started_at = 0

-- 视频分辨率切换（直播流断流重连/画质切换）时，mpv 会把 OSD overlay 等比
-- 缩放到新的视频尺寸：若不处理，全体弹幕会瞬间位移（看起来像"集体回退"）。
-- 这里把 overlay 分辨率 & 现有弹幕按比例迁移到新坐标系，保持相对位置不变。
local function rescale_live_overlay()
    if not overlay or not live_active then return end
    local nw, nh = get_video_dims(live_w, live_h)
    if nw <= 0 or nh <= 0 or (nw == live_w and nh == live_h) then return end

    local old_w, old_h = live_w, live_h
    local sx, sy = nw / old_w, nh / old_h
    local old_speed = danmaku_speed

    -- 先记录每条弹幕在旧坐标系下的当前 x，再等比迁移
    for _, dm in ipairs(dm_pool) do
        dm.y = math.floor(dm.y * sy)
        if dm.elapsed and dm.elapsed > 0 then
            local x_old = dm.start_x - old_speed * dm.elapsed
            dm._x_scaled = x_old * sx
        end
    end

    live_w, live_h = nw, nh
    travel_dist = live_w + 1200
    danmaku_speed = travel_dist / o.duration
    max_tracks = math.max(1, math.floor((live_h * o.area) / track_height))
    overlay.res_x, overlay.res_y = nw, nh

    for _, dm in ipairs(dm_pool) do
        dm.start_x = live_w
        dm.end_x = -(travel_dist - live_w)
        local target_x = dm._x_scaled
        dm._x_scaled = nil
        if target_x and dm.elapsed then
            -- 反推新坐标系下的 elapsed，使 mid-flight 弹幕移到等比例位置
            dm.elapsed = math.max(0, (dm.start_x - target_x) / danmaku_speed)
        end
    end
    msg.info(string.format("视频分辨率变化 %dx%d -> %dx%d，弹幕已等比迁移", old_w, old_h, nw, nh))
end
mp.observe_property("video-out-params", "native", rescale_live_overlay)

local function start_live_backend(room_id)
    if not live_active then return end
    live_gen = live_gen + 1
    local my_gen = live_gen
    local script_dir = mp.get_script_directory() or "."
    local backend_path = utils.join_path(script_dir, "biliver.py")
    live_backend_started_at = mp.get_time()

    msg.info("启动直播弹幕后端: " .. backend_path)
    backend_process = mp.command_native_async({
        name = "subprocess",
        args = {o.python_path, backend_path, "live", room_id, ipc_server, tostring(o.area), tostring(o.font_size), tostring(o.duration), "--width", tostring(live_w), "--height", tostring(live_h)},
        playback_only = false,
    }, function(success, res, err)
        -- 代数不匹配：回调属于已被取代/清理的旧后端，忽略
        if my_gen ~= live_gen then
            return
        end
        backend_process = nil

        local killed_by_us = (res and res.killed_by_us) or false
        local exit_code = (res and res.status) or -1
        if success then
            if exit_code == 0 then
                msg.info("Backend exited normally.")
            else
                msg.warn("Backend exited with code: " .. tostring(exit_code))
            end
        else
            if killed_by_us then
                msg.verbose("Backend was stopped by us (normal).")
            else
                msg.warn("Backend subprocess error: " .. tostring(err or "unknown"))
            end
        end

        -- 看护重启：仅当直播仍活跃且不是我们主动停止时
        if not live_active or killed_by_us then return end

        -- 后端稳定运行超过 60 秒则重置退避计数
        if (mp.get_time() - live_backend_started_at) > 60 then
            live_restart_attempt = 0
            live_restart_delay = 2
        end
        if live_restart_attempt >= 6 then
            msg.error("直播弹幕后端多次崩溃，停止自动重启（请查看 biliver.log 排查）")
            return
        end
        live_restart_attempt = live_restart_attempt + 1
        msg.warn(string.format("后端意外退出，%.0f 秒后自动重启 (第 %d 次)", live_restart_delay, live_restart_attempt))
        mp.add_timeout(live_restart_delay, function()
            if not live_active then return end
            start_live_backend(room_id)
        end)
        live_restart_delay = math.min(live_restart_delay * 2, 30)
    end)
end

-- VOD Danmaku Processing
local function process_vod(target_id)
    if not target_id then return end
    msg.info("Processing VOD danmaku for video: " .. target_id)
    mp.osd_message("Biliver: 正在加载点播弹幕 " .. target_id, 2)
    
    local script_dir = mp.get_script_directory() or "."
    local py_path = utils.join_path(script_dir, "biliver.py")
    local danmaku_dir = os.getenv("TEMP") or "/tmp/"
    
    local dw, dh = get_video_dims(1920, 1080)

    mp.command_native_async({
        name = 'subprocess',
        playback_only = false,
        capture_stdout = true,
        args = {
            o.python_path, py_path, "vod", 
            "-d", danmaku_dir, 
            "-s", dw.."x"..dh, 
            "-fn", o.fontname, 
            "-fs", tostring(o.font_size), 
            "-o", tostring(o.opacity),
            "-a", tostring(o.area),
            "-dur", tostring(o.duration),
            "-r", tostring(target_id)
        }
    }, function(success, res, err)
        if success and res and res.status == 0 then
            local danmu_filename = "danmaku_" .. target_id .. ".ass"
            danmu_file = utils.join_path(danmaku_dir, danmu_filename)
            if utils.file_info(danmu_file) then
                mp.commandv("sub-add", danmu_file, "select", "Bilibili Danmaku")
                vod_danmaku_loaded = true
                update_fps_vf()
                mp.osd_message("Biliver: 点播弹幕加载完成", 2)
                msg.info("VOD danmaku loaded and selected.")
            else
                msg.error("Danmaku file not found at: " .. danmu_file)
                mp.osd_message("Biliver: 弹幕转换失败（未生成文件）", 3)
            end
        else
            msg.error("Danmaku2Ass failed: " .. (err or (res and res.stderr) or "unknown error"))
            mp.osd_message("Biliver: 点播弹幕下载失败", 3)
        end
    end)
end

local function on_start_file()
    local path = mp.get_property("path")
    if not path then return end

    local script_opts = mp.get_property_native("script-opts") or {}
    
    -- 只有当带有 biliver_enabled=yes 或者包含关键 ID 时才触发
    -- 这样即使路径是普通 URL 也能识别出是本插件启动的
    if script_opts.biliver_enabled ~= "yes" and not script_opts.biliver_room_id and not script_opts.cid then
        return
    end
    
    msg.info("Biliver logic triggered for: " .. path)

    -- Cleanup existing backend
    if backend_process then
        msg.verbose("Stopping previous backend process...")
        mp.abort_async_command(backend_process)
        backend_process = nil
    end
    -- 作废旧直播看护状态，避免旧后端回调触发重启
    live_active = false
    live_gen = live_gen + 1
    
    -- 尝试关闭滤镜
    safe_remove_fps_vf()

    -- 1. Check for Live Room
    local room_id = script_opts.biliver_room_id 
                    or string.match(path, "live%.bilibili%.com/(%d+)") 
                    or string.match(path, "^room:(%d+)$")

    if room_id then
        msg.info("Bilibili Live detected: " .. room_id)
        mp.osd_message("Biliver: 正在连接直播弹幕 " .. room_id, 2)
        pcall(function()
            saved_msg_level = mp.get_property("msg-level")
            -- 同时抑制 libass 的字体查找警告，避免反复查字体导致性能开销
            mp.set_property("msg-level", "player=warn,libass=error")
        end)
        init_live_osd()
        update_fps_vf(true)
        live_active = true
        live_restart_attempt = 0
        live_restart_delay = 2
        start_live_backend(tostring(room_id))
        return
    end

    -- 2. Check for VOD (BV/AV/CID)
    local bvid = string.match(path, "bilibili%.com/video/(BV[%w]+)")
    local avid = string.match(path, "bilibili%.com/video/(av%d+)")
    local vod_id = string.match(path, "^vod:(.+)$")
    local target_id = script_opts.cid or bvid or avid or vod_id
    
    if target_id then
        process_vod(target_id)
    end
end

mp.register_event("start-file", on_start_file)

mp.register_event("end-file", function(e)
    if not e then return end
    if e.reason == "stop" or e.reason == "quit" or e.reason == "eof" or e.reason == "error" then
        msg.verbose("end-file: reason=" .. tostring(e.reason))
        -- 先取消看护并作废在途回调，避免清理期间触发后端重启
        live_active = false
        live_gen = live_gen + 1
        if backend_process then
            msg.verbose("end-file: stopping backend process")
            mp.abort_async_command(backend_process)
            backend_process = nil
        end
        safe_remove_fps_vf()
        if danmu_file and utils.file_info(danmu_file) then
            os.remove(danmu_file)
            danmu_file = nil
        end
        vod_danmaku_loaded = false
        if overlay then
            overlay:remove()
            overlay = nil
        end
        if render_timer then
            render_timer:kill()
            render_timer = nil
        end
        render_running = false
        dm_pool = {}
        -- 恢复 msg-level
        pcall(function()
            if saved_msg_level then
                mp.set_property("msg-level", saved_msg_level)
            else
                mp.set_property("msg-level", "")
            end
            saved_msg_level = nil
        end)
        -- 清理时移除全局字体属性设置
        pcall(function()
            mp.set_property("sub-font", "")
            mp.set_property("sub-fonts-dir", "")
        end)
    end
end)

mp.observe_property("speed", nil, update_fps_vf)
-- 监听 container-fps 变化，确保视频加载完成后能正确应用补帧滤镜
mp.observe_property("container-fps", nil, update_fps_vf)

-- Danmaku toggle
local function toggle_danmaku()
    -- VOD mode: toggle subtitle visibility
    if vod_danmaku_loaded then
        local sub_vis = mp.get_property_bool("sub-visibility")
        mp.set_property_bool("sub-visibility", not sub_vis)
        mp.osd_message((not sub_vis) and "弹幕: 开启" or "弹幕: 关闭", 1.5)
        return
    end
    
    -- Live mode: toggle overlay visibility
    danmaku_visible = not danmaku_visible
    if danmaku_visible then
        if overlay then
            overlay.hidden = false
            overlay:update()
        end
        start_render()
    else
        dm_pool = {}
        track_until = {}
        if overlay then
            overlay.hidden = true
            overlay.data = ""
            overlay:update()
        end
        if render_timer then
            render_timer:kill()
            render_timer = nil
        end
        render_running = false
    end
    mp.osd_message(danmaku_visible and "弹幕: 开启" or "弹幕: 关闭", 1.5)
end

mp.add_forced_key_binding("Ctrl+d", "toggle-danmaku", toggle_danmaku)
mp.register_script_message("biliver-toggle", toggle_danmaku)
