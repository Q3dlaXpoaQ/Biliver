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
}
options.read_options(o, "biliver")

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

-- 安全移除 Biliver-FPS 滤镜（先检查是否存在）
local function safe_remove_fps_vf()
    local filters = mp.get_property_native("vf")
    if not filters then return end
    for _, f in ipairs(filters) do
        if f.label == "Biliver-FPS" then
            mp.commandv('vf', 'remove', '@Biliver-FPS')
            return true
        end
    end
    return false
end

-- 帧率优化滤镜：确保弹幕始终以 60fps 渲染
local function update_fps_vf()
    if not o.fps_vf then return end
    local video_fps = mp.get_property_number("container-fps")
    local video_speed = mp.get_property_number("speed", 1)
    
    -- container-fps 尚未可用（视频还未加载完成）
    if not video_fps then return end
    
    -- 检查滤镜是否存在
    local filters = mp.get_property_native("vf")
    local has_filter = false
    if filters then
        for _, f in ipairs(filters) do
            if f.label == "Biliver-FPS" then has_filter = true break end
        end
    end

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

-- Danmaku Management State
local danmu_list = {}
local danmu_ov = nil
local danmu_timer = nil

-- Update danmaku positions and render to OSD
local function update_danmaku()
    local now = mp.get_time()
    local ass_table = {}
    local has_active = false
    
    for i = #danmu_list, 1, -1 do
        local dm = danmu_list[i]
        local elapsed = now - dm.start_time
        if elapsed >= o.duration then
            table.remove(danmu_list, i)
        else
            has_active = true
            local x = 1920 - (1920 + 1200) * (elapsed / o.duration)
            -- 干净样式：无描边无阴影
            table.insert(ass_table, string.format("{\\an7\\fn%s\\fs%d\\c%s\\alpha&H%s&\\bord0\\shad0\\b1\\pos(%.1f,%d)}%s", 
                o.fontname, o.font_size, dm.color, ass_alpha, x, dm.y, dm.text))
        end
    end
    
    if has_active then
        if not danmu_ov then
            msg.verbose("Creating OSD overlay")
            danmu_ov = mp.create_osd_overlay("ass-events")
            danmu_ov.res_x = 1920
            danmu_ov.res_y = 1080
            danmu_ov.z = 999
        end
        danmu_ov.data = table.concat(ass_table, "\n")
        danmu_ov:update()
    else
        if danmu_ov then
            msg.verbose("Removing OSD overlay (no active danmaku)")
            danmu_ov:remove()
            danmu_ov = nil
        end
        if danmu_timer then
            msg.verbose("Stopping timer")
            danmu_timer:stop()
            danmu_timer = nil
        end
    end
end

local function add_danmaku(color, text, y)
    -- msg.info("Received: " .. text)
    text = text:gsub("{", ""):gsub("}", ""):gsub("\n", " ")
    y = tonumber(y) or 40
    
    table.insert(danmu_list, {
        color = color,
        text = text,
        y = y,
        start_time = mp.get_time()
    })
    
    if not danmu_timer then
        msg.verbose("Starting timer")
        danmu_timer = mp.add_periodic_timer(1/60, update_danmaku)
    end
end

mp.register_script_message("biliver-danmaku", add_danmaku)

-- VOD Danmaku Processing
local function process_vod(target_id)
    if not target_id then return end
    msg.info("Processing VOD danmaku for video: " .. target_id)
    mp.osd_message("Biliver: 正在加载点播弹幕 " .. target_id, 2)
    
    local script_dir = mp.get_script_directory() or "."
    local py_path = utils.join_path(script_dir, "biliver.py")
    local danmaku_dir = os.getenv("TEMP") or "/tmp/"
    
    local dw, dh = 1920, 1080
    local aspect = mp.get_property_number('width', 16) / mp.get_property_number('height', 9)
    if aspect > dw / dh then dh = math.floor(dw / aspect) else dw = math.floor(dh * aspect) end

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
    
    -- 尝试关闭滤镜
    safe_remove_fps_vf()

    -- 1. Check for Live Room
    local room_id = script_opts.biliver_room_id 
                    or string.match(path, "live%.bilibili%.com/(%d+)") 
                    or string.match(path, "^room:(%d+)$")

    if room_id then
        msg.info("Bilibili Live detected: " .. room_id)
        mp.osd_message("Biliver: 正在连接直播弹幕 " .. room_id, 2)
        update_fps_vf()
        local script_dir = mp.get_script_directory() or "."
        local backend_path = utils.join_path(script_dir, "biliver.py")
        backend_process = mp.command_native_async({
            name = "subprocess",
            args = {o.python_path, backend_path, "live", tostring(room_id), ipc_server, tostring(o.area), tostring(o.font_size), tostring(o.duration)},
            playback_only = false,
        }, function(success, res, err)
            -- subprocess 被 abort 时 success=false 且 res.killed_by_us=true，这是正常行为
            if success then
                local exit_code = (res and res.status) or -1
                if exit_code == 0 then
                    msg.info("Backend exited normally.")
                else
                    msg.warn("Backend exited with code: " .. tostring(exit_code))
                end
            else
                if res and res.killed_by_us then
                    msg.verbose("Backend was stopped by us (normal).")
                else
                    msg.warn("Backend subprocess error: " .. tostring(err or "unknown"))
                end
            end
            backend_process = nil
        end)
        return
    end

    -- 2. Check for VOD (BV/AV/CID)
    local bvid = string.match(path, "bilibili%.com/video/(BV[%w]+)")
    local avid = string.match(path, "bilibili%.com/video/(av%d+)")
    local target_id = script_opts.cid or bvid or avid or (string.match(path, "^vod:(.+)$") and string.match(path, "^vod:(.+)$"))
    
    if target_id then
        process_vod(target_id)
    end
end

mp.register_event("start-file", on_start_file)

mp.register_event("end-file", function(e)
    if not e then return end
    if e.reason == "stop" or e.reason == "quit" or e.reason == "eof" or e.reason == "error" then
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
    end
end)

mp.observe_property("speed", nil, update_fps_vf)
-- 监听 container-fps 变化，确保视频加载完成后能正确应用补帧滤镜
mp.observe_property("container-fps", nil, update_fps_vf)



