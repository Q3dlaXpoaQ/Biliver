# Biliver 技术架构文档

面向开发者和 AI 助手的深度参考，描述项目架构、核心算法与数据流。

## 1. 架构总览

三组件协作：**油猴脚本(浏览器) → Lua 脚本(MPV内) → Python 后端(子进程)**

```
┌──────────────┐   MPV指令    ┌────────────┐   IPC管道    ┌──────────────┐
│ biliver.js   │ ──────────► │ main.lua   │ ──────────► │ biliver.py   │
│ (油猴脚本)    │  (剪贴板)    │ (MPV Lua)  │  (JSON+LF)  │ (Python)     │
└──────────────┘             └─────┬──────┘             └──────┬───────┘
                                   │                           │
                            OSD overlay                   WebSocket/HTTP
                            (60fps渲染)                   (弹幕数据源)
                                   │                           │
                                   ▼                           ▼
                             ┌──────────┐              ┌──────────────┐
                             │ MPV 播放器 │              │ Bilibili API │
                             └──────────┘              └──────────────┘
```

**两种弹幕模式：**

| 模式 | 触发条件 | 弹幕获取 | 渲染方式 | 弹幕来源 |
| :--- | :--- | :--- | :--- | :--- |
| **VOD 点播** | URL 含 BV/AV/CID | HTTP → XML → ASS 文件 | MPV 原生字幕 | 历史弹幕 |
| **Live 直播** | URL 含直播间号 | WebSocket 实时接收 | OSD overlay 60fps | 实时弹幕 |

---

## 1.5 一键启动 (biliver:// 协议 + `biliver_handler.py`)

除"复制指令"外，播放按钮可直接拉起 MPV。为避免超长 URL（cookie + 音视频签名链接可达数 KB）被旧浏览器截断，采用**剪贴板接力**：

```
浏览器点击 → payload(JSON, 含 token)写入剪贴板 → 跳转 biliver://mpv?k=<token>
  → 系统调用 biliver_handler.py → 读取剪贴板校验 token → 启动 mpv
```

- `biliver_handler.py`（纯标准库）：解析 URL → 读剪贴板 → `find_mpv()`（注册表 `HKCU\Software\Biliver\MpvPath` → PATH 中 mpv.exe → `%APPDATA%\mpv\mpv.exe`）→ 构造等价参数 → `Popen` 脱离启动；全程写入 `%TEMP%\biliver_handler.log`，失败时弹 MessageBox 错误框
- 由 install.bat 注册 `HKCU\Software\Classes\biliver`（URL Protocol），命令指向 `pythonw.exe` 避免黑框，并顺带把找到的 mpv 路径写入 `HKCU\Software\Biliver\MpvPath`
- JS 通过窗口失焦/页面隐藏启发式（4s 轮询）检测协议是否安装，未安装时提示运行 install.bat
- 处理器同时兼容 `biliver://mpv?url=...` 直接传参（手动测试/回退）
- **剪贴板新鲜度校验**：新版 payload 携带写入时间戳 `t`。对不传 URL 参数（%1 为空）的浏览器（如 Cent Browser）：10 秒内写入的 payload 视为有效；旧版无时间戳的 payload 仅在确认浏览器未传 URL 参数时接受，保证旧油猴脚本同样可一键打开
- **请求头清洗（关键）**：mpv 的 `--http-header-fields` 按逗号分隔且无法转义，值内含逗号/引号的头部会被切碎成非法请求头。两级防护：
  - JS 端（`extractKeyCookies` / `sanitizeHeaderList`）：剔除值含逗号/引号/换行的 cookie 对（如 `bmg_af_sc`），非 Cookie 头（如 UA 的 `(KHTML, like Gecko)`）的逗号归一化为 `;`
  - 处理器端（`sanitize_headers`）：对旧版脚本生成的 payload 做防御性兜底，同样剔除坏 cookie 对
  - 外加 `--force-window=yes`：即使流加载失败也显示 mpv 错误窗口，避免"点击后无任何反应"的静默失败

---

## 2. 油猴脚本 (`biliver.js`)

### 职责
在 B 站页面提取视频/直播流 URL 和认证信息，生成 MPV 启动命令复制到剪贴板。

### 核心流程

```
页面加载 → URL检测 → API获取 aid/cid → 提取CDN流 → 构建MPV指令 → 复制剪贴板
```

### 关键实现

- **SPA 路由适配**: 钩住 `history.pushState/replaceState` + `popstate` + 1.5s 轮询兜底，检测 B 站 SPA 页面切换
- **智能按钮显示**: 直播页直接显示；点播页需先通过 API 拿到 `aid/cid` 后才显示（重试5次，间隔600ms）
- **CDN 提取策略**:
  - 点播: 优先 DASH 流（视频优先 HEVC 编码，音频按 FLAC → Dolby → AAC 顺序选择），fallback 到 FLV/MP4
  - 直播: 优先 `getRoomPlayInfo` DASH 接口，按 `http_stream/flv/AVC` → `http_hls/fmp4(master_url)` → `http_hls/ts` 逐级回退，最后回退旧版 `playUrl` 接口；各方案均把 `qn` 提升到 10000（原画）
- **认证处理**: Cookie 白名单精简（`bili_jct`/`DedeUserID`/`buvid3`/`buvid4`/`bili_ticket` 等关键字段），缺失 `bili_jct` 时从 `localStorage` 补充；Android UA 替换为桌面 UA 避免 B 站拦截；值含逗号/引号/换行的 cookie 对直接剔除（`extractKeyCookies` + `sanitizeHeaderList` 两级清洗，与处理器端兜底对应）
- **防 403**: 指令中携带 `Origin` + `Referer` 头（B 站 CDN 强制校验）
- **状态注入**: 通过 `--script-opts-append` 传递 `biliver_enabled=yes`、`cid`、`biliver_room_id`，Lua 端据此判断是否启用
- **进度同步**: 读取 `<video>.currentTime`，通过 `--start` 参数传递给 MPV
- **一键播放**: 生成 JSON payload（token + 时间戳 `t` + URL + headers + `cid/roomid`）写剪贴板 → 跳转 `biliver://mpv?k=<token>`；`launchViaProtocol` 以窗口失焦/页面隐藏 + 4s 轮询判断启动成功，未注册协议时提示运行 install.bat

### 支持的 URL 模式

| 页面 | 提取方式 |
| :--- | :--- |
| `/video/BVxxx` | BVID → API 获取 aid/cid |
| `/video/avxxx` | AID → API 获取 cid |
| `/bangumi/play/epxxx` | EPID → 番剧 API → aid/cid |
| `/list/*`、`/festival/*` | 自动探测 `__INITIAL_STATE__` → 回退 BV/AV API |
| `live.bilibili.com/xxx` | 房间号直接提取 |

---

## 3. Lua 渲染层 (`main.lua`)

### 职责
弹幕渲染、60fps 补帧滤镜管理、Python 后端进程生命周期、弹幕开关。

### 3.1 启动检测 (`on_start_file`)

脚本加载时即完成环境初始化：

- **全局字体兜底**: `sub-font` 设为配置字体，Windows 下把 `C:\Windows\Fonts` 加入 `sub-fonts-dir`，避免 libass 反复查找字体导致性能开销
- **OSD 策略**: `osd-level=1` + `osd-bar=false`（不干扰 ModernZ 等 UI）；直播模式再抑制 `msg-level=player=warn,libass=error`

```
start-file 事件
  ├─ script-opts 中无 biliver 标记 → 忽略（普通视频）
  ├─ 含 biliver_room_id → 直播模式
  │     ├─ init_live_osd()     创建 OSD overlay
  │     ├─ update_fps_vf(true) 强制补帧
  │     └─ 启动 biliver.py live 子进程
  └─ 含 cid / BV / AV → 点播模式
        └─ 启动 biliver.py vod 子进程 → 生成 ASS → sub-add 加载
```

（路径亦可直接带 `room:` / `vod:` 前缀，或从 URL 中正则提取直播间号 / BV / AV。）

### 3.2 直播弹幕渲染（核心）

使用 `mp.create_osd_overlay("ass-events")` 实现 **零闪烁** 渲染：

```
overlay.data = 每行一个ASS事件, \n 分隔
overlay:update()  →  原子替换整个覆盖层, 无闪烁

每条弹幕 = {\an7\pos(x,y)\c&HBBGGRR&\bord0\shad0\b1\fs36\fn字体\alpha&HAA&}文字
```

**渲染循环:**

```
add_danmaku(color, text)
  ├─ pick_track(text_width) → 分配轨道 + 计算出生时间
  ├─ 存入 dm_pool (弹幕对象: text, color, y, born, lifespan, elapsed, start_x, end_x)
  └─ start_render()
       └─ mp.add_timeout(render_period, render_frame)  ← 链式调度 (60~120fps)
            ├─ 清理过期弹幕 (elapsed 单调非减，elapsed ≥ lifespan → 移除)
            ├─ trim_pool() 超出 max_pool 上限时丢弃最旧条目
            ├─ 逐条计算 x = start_x - speed * elapsed
            ├─ 排队/暂挂中的弹幕 (x ≥ start_x) 不生成 ASS 行，减少每帧开销
            ├─ 拼接 ASS 字符串
            └─ overlay:update()
```

**关键设计:**
- `mp.add_timeout(render_period, ...)` 递归调用；`render_period` 依据 `vsync-interval` / `display-fps` 自适应（默认 60Hz，有信息时提升到 120Hz），避免 Lua 定时器与视频帧率的拍频造成周期性卡顿
- **弹幕时钟跟随视频时间轴**：优先使用 `time-pos`（缺失/无效时退回墙钟 `mp.get_time()`）。视频卡顿/重同步时画面跳变，弹幕与其同步跳变，二者永不产生相对"回退/快进"偏移
- 每条弹幕独立维护**单调非减的 `elapsed`**：即使时钟回退，弹幕也只暂停、绝不后退
- **分辨率切换等比迁移**：监听 `video-out-params`，直播流断流重连/画质切换改变画面大小时，overlay 分辨率与在途弹幕按比例迁移到新坐标系，避免全体弹幕瞬间位移
- 弹幕池 (`dm_pool`) 自动 GC：每帧清除过期弹幕，空池时停止渲染循环
- 弹幕池上限 `max_pool`：仅在极端弹幕潮（超过上限）时丢弃最旧条目，正常情况不触发（`trim_pool`）

### 3.3 轨道分配算法 (`pick_track`)

```
pick_track(text_width):
  travel_time = text_width / speed + 0.2   // 文字通过时间 + 安全余量

  1. 遍历所有轨道, 找首个空闲轨道 (now >= track_until[i])
     → 立即使用, 返回 (track, now)

  2. 全部忙碌 → 找最早空闲的轨道 (min track_until)
     → effective_start = track_until[best]  // 排队等待前车离开
     → born = effective_start               // 延迟"出生"
     → 弹幕在等待期间 elapsed < 0, x 在右边缘外(不可见)
     → 彻底消除重叠
```

### 3.4 60fps 补帧滤镜

```lua
-- 视频 < 59fps 且倍速 < 2x 时挂载
mp.commandv('vf', 'append', '@Biliver-FPS:fps=fps=60:round=near')
-- 直播模式: 强制挂载 (container-fps 可能不可用)
-- 倍速 ≥ 2x: 自动移除 (避免性能问题)
-- 监听 container-fps 和 speed 属性动态调整
```

### 3.5 弹幕开关

- VOD: 切换 `sub-visibility` (MPV 原生字幕)
- Live: 切换 `overlay.hidden` + 暂停/恢复渲染循环；隐藏时同步清空弹幕池与轨道状态（`dm_pool` / `track_until`）

---

## 4. Python 后端 (`biliver.py`)

### 职责
弹幕协议解析、轨道计算、IPC 通信、ASS 文件生成。

### 4.1 直播模式

```
BLiveClient
  ├─ init_room()     → API 获取真实房间号 + 弹幕服务器配置
  ├─ ws_connect()    → 连接 wss:// 弹幕服务器（握手超时 10s / 接收超时 60s；断开后 2 秒自动重连，轮换 host_server_list，连接成功即重置重试计数）
  ├─ AUTH 认证       → 发送 {uid, roomid, protover:3, key}
  ├─ 心跳包          → 每 25s 发送空心跳 (ver=1, op=2)，发送失败重试 3 次再放弃（避免单次网络抖动杀死心跳）
  ├─ 数据包解析      → 处理 Brotli/Zlib 压缩 → JSON 解析（单条弹幕处理失败只丢弃该条，不中断整帧解析）
  └─ handler 回调    → 提取 DANMU_MSG → 颜色转换（类型兜底）→ IPC 发送
       └─ 长弹幕 (splits 分片) → 逐片渲染，避免被截断

DanmakuManager
  ├─ find_track()    → 轨道碰撞检测 (与 Lua 端算法一致)
  └─ cleanup_tracks() → 定期清理过期轨道时间戳

IPC 通信（持久连接）
  ├─ IpcWriter 持久命名管道连接（连接失败重试 3 次；写失败重连一次再试，仍失败则丢弃，避免队列卡死）
  ├─ ipc_worker 协程 + asyncio.Queue + 专用线程池（阻塞写入不卡事件循环；弹幕写入与探测互不争抢线程）
  ├─ 空闲保活：队列空闲 15s 时在持久连接上写 script-message biliver-keepalive（Lua 端空操作，
  │   不新增连接、不产生响应回写 → 不与 mpv 单客户端命名管道互相干扰，也不会填充管道读缓冲）
  ├─ 队列积压 (>1000) → 丢弃最旧 30%（硬上限 2000）
  └─ 协议: JSON {"command": ["script-message", "biliver-danmaku", color, text, y_hint]}

Lua 端看护（main.lua）
  ├─ 后端意外退出（非 killed_by_us 且直播仍活跃）→ 指数退避自动重启（2s→30s，上限 6 次）
  ├─ 后端稳定运行 >60s 自动重置退避计数；代数 (live_gen) 防止旧回调误触发重启
  └─ end-file 先置 live_active=false 再清理，杜绝清理期间竞态重启
```

### 4.2 点播模式

```
run_vod(target_id):
  ├─ BV/AV → API 获取 CID
  ├─ HTTP 下载 XML 弹幕 (自动检测 gzip/zlib/raw deflate)
  ├─ 按时间排序 + 轨道分配（复用 DanmakuManager.find_track，以弹幕时间戳为时钟源模拟时间流逝）
  └─ 生成 ASS 字幕文件
       ├─ 滚动弹幕 (mode 1,6): \move(start_x, y, end_x, y)，轨道与 Lua 端算法一致
       ├─ 顶部弹幕 (mode 5):   \an8\pos(center, y)，随机轨道
       └─ 底部弹幕 (mode 4):   \an2\pos(center, y)
       固定弹幕 (mode 4/5) 显示时长 = duration / 2
```

### 4.3 Bilibili 弹幕协议

```
包头: 16字节 (big-endian)
  [pack_len:4][raw_header_size:2][ver:2][operation:4][seq:4]

operation:
  7 = AUTH (认证)
  2 = HEARTBEAT (心跳)
  3 = HEARTBEAT_REPLY
  5 = SEND_MSG_REPLY (弹幕消息)

ver:
  0 = NORMAL (明文JSON)
  2 = ZLIB 压缩
  3 = BROTLI 压缩

弹幕消息: cmd="DANMU_MSG", info[0][3]=颜色, info[1]=文字
```

### 4.4 IPC 通信协议

```
传输层: 命名管道 (Windows: \\.\pipe\mpv-biliver-XXXXX)
        Unix Socket (Linux/macOS: /tmp/mpv-biliver-XXXXX.sock)
        由 IpcWriter 维持持久连接（避免每条弹幕重建连接的开销），断线自动重连

格式: 每行一个 JSON 命令 + \n

Python → MPV:
  {"command": ["script-message", "biliver-danmaku", "&HBBGGRR&", "弹幕文字", "y坐标"]}

Lua 端接收:
  mp.register_script_message("biliver-danmaku", add_danmaku)
```

---

## 5. 数据流总览

```
用户点击播放图标
    │
    ▼
biliver.js 提取 CDN URL + 认证信息 + CID/房间号
    │
    ▼
生成 MPV 指令 → 复制到剪贴板
    │
    ▼ (用户粘贴执行)
MPV 启动，加载 main.lua
    │
    ├─ VOD: main.lua 启动 biliver.py vod
    │         biliver.py 下载弹幕 → 生成 ASS → 退出
    │         main.lua 加载 ASS 字幕 → MPV 原生渲染
    │
    └─ Live: main.lua 创建 OSD overlay + 强制补帧
              main.lua 启动 biliver.py live
              biliver.py WebSocket 接收弹幕（断线自动重连）→ 持久 IPC 管道发送
              main.lua 接收 → 轨道分配 → 60fps OSD 渲染
```

---

## 6. 清理与退出

`end-file` 事件触发时：
1. 终止 Python 子进程 (`mp.abort_async_command`)
2. 移除补帧滤镜 (`vf remove @Biliver-FPS`)
3. 删除临时 ASS 文件 (VOD)
4. 销毁 OSD overlay (Live)
5. 停止渲染循环，清空弹幕池
6. 恢复 MPV `msg-level` 设置

---

## 7. 方法索引

### `main.lua`

| 方法 | 作用 |
| :--- | :--- |
| `on_start_file()` | 入口: 检测直播/点播，启动后端 |
| `init_live_osd()` | 创建 OSD overlay，初始化渲染环境 |
| `add_danmaku(color, text)` | 接收弹幕 → 分配轨道 → 加入渲染池 |
| `pick_track(text_width)` | 轨道碰撞检测 + 排队机制 |
| `render_frame()` | OSD 渲染 (60~120Hz 自适应，elapsed 单调防回退): 清理过期 → 计算位置 → ASS → overlay:update() |
| `start_render()` | 启动渲染循环 |
| `trim_pool()` | 弹幕池上限保护 (超出 `max_pool` 丢弃最旧条目) |
| `update_fps_vf(force)` | 动态 60fps 补帧滤镜管理 |
| `has_fps_vf()` | 检查补帧滤镜是否已挂载 |
| `safe_remove_fps_vf()` | 安全移除补帧滤镜 |
| `get_video_dims()` | 读取视频像素分辨率 (video-out-params, dw/dh 优先) |
| `toggle_danmaku()` | 弹幕显示/隐藏切换 |
| `start_live_backend(room_id)` | 启动直播后端子进程；意外退出时指数退避自动重启（看护） |
| `process_vod(target_id)` | 点播: 启动 Python 转换 + 加载 ASS |
| `sanitize_text(text)` | 清理弹幕文本 (移除 `{}` `\n`) |
| `estimate_text_width(text)` | 按 UTF-8 编码计数估算文字宽度 (ASCII=0.6x, CJK=1.05x) |

### `biliver.py`

| 类/方法 | 作用 |
| :--- | :--- |
| `BLiveClient` | WebSocket 直播弹幕客户端（断开自动重连） |
| `BLiveClient.init_room()` | API 获取真实房间号 + 弹幕服务器配置 |
| `BLiveClient.run()` | 连接 + 认证 + 心跳 + 接收消息循环（持续重连直到 stop_event） |
| `BLiveClient._p_ws(data)` | 数据包解压 (Brotli/Zlib) + JSON 解析 |
| `DanmakuManager` | 弹幕轨道管理器 |
| `DanmakuManager.find_track(text)` | 轨道分配与碰撞规避 |
| `DanmakuManager.cleanup_tracks()` | 清理过期轨道时间戳 |
| `IpcWriter` | 持久 IPC 写入连接（连接重试 3 次；写失败重连一次再试） |
| `ipc_worker(queue, writer, executor, shutdown_event)` | 异步 IPC 写入协程（专用线程池；空闲 15s 写 keepalive 保活；连续 20 次连接失败触发退出） |
| `cleanup_queue(queue)` | 队列积压时丢弃最旧消息 |
| `send_mpv_async(queue, cmd)` | 非阻塞 IPC 发送 (队列 >1000 丢弃 30%，硬上限 2000) |
| `run_live(room_id, ipc_path, ...)` | 直播模式入口（含长弹幕 splits 分片处理、心跳/超时加固） |
| `run_vod(target_id, ...)` | 点播模式入口: XML → ASS |

---

## 8. 渲染方案演进

| 方案 | 问题 | 状态 |
| :--- | :--- | :--- |
| ASS 文件 + `sub-reload` (0.1s) | 严重闪烁 | ❌ 废弃 |
| ASS 文件 + `sub-reload` (0.5s/1.5s) | 闪烁减轻，弹幕从中间出现 | ❌ 废弃 |
| `osd-ass-1` ~ `osd-ass-9` 属性 | 当前 MPV 版本不显示 | ❌ 废弃 |
| `mp.set_osd_ass` 多 `\pos` | 所有文字渲染在同一位置 | ❌ 废弃 |
| `mp.set_osd_ass` + `\N` 分隔 | 无法多位置独立渲染 | ❌ 废弃 |
| **`mp.create_osd_overlay("ass-events")`** | **零闪烁，每行独立 ASS 事件** | ✅ 当前 |
