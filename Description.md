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
  - 点播: 优先 DASH 流（音画分离，支持4K/HDR/FLAC），fallback 到 FLV/MP4
  - 直播: `playUrl` 接口获取原画流
- **认证处理**: 精简 Cookie（仅保留关键认证字段），Android UA 替换为桌面 UA 避免 B 站拦截
- **防 403**: 指令中携带 `Origin` + `Referer` 头（B 站 CDN 强制校验）
- **状态注入**: 通过 `--script-opts-append` 传递 `biliver_enabled=yes`、`cid`、`biliver_room_id`，Lua 端据此判断是否启用
- **进度同步**: 读取 `<video>.currentTime`，通过 `--start` 参数传递给 MPV

### 支持的 URL 模式

| 页面 | 提取方式 |
| :--- | :--- |
| `/video/BVxxx` | BVID → API 获取 aid/cid |
| `/video/avxxx` | AID → API 获取 cid |
| `/bangumi/play/epxxx` | EPID → 番剧 API → aid/cid |
| `live.bilibili.com/xxx` | 房间号直接提取 |

---

## 3. Lua 渲染层 (`main.lua`)

### 职责
弹幕渲染、60fps 补帧滤镜管理、Python 后端进程生命周期、弹幕开关。

### 3.1 启动检测 (`on_start_file`)

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

### 3.2 直播弹幕渲染（核心）

使用 `mp.create_osd_overlay("ass-events")` 实现 **零闪烁** 渲染：

```
overlay.data = 每行一个ASS事件, \n 分隔
overlay:update()  →  原子替换整个覆盖层, 无闪烁

每条弹幕 = {\an7\pos(x,y)\c&HBBGGRR&\bord0\shad0\fs36\fn字体\alpha&HAA&}文字
```

**渲染循环:**

```
add_danmaku(color, text)
  ├─ pick_track(text_width) → 分配轨道 + 计算出生时间
  ├─ 存入 dm_pool (弹幕对象: text, color, y, born, lifespan, start_x, end_x)
  └─ start_render()
       └─ mp.add_timeout(0, render_frame)  ← 60fps 链式调度
            ├─ now = mp.get_time()
            ├─ 清理过期弹幕 (now - born > lifespan)
            ├─ 逐条计算 x = start_x - speed * elapsed
            ├─ 拼接 ASS 字符串
            └─ overlay:update()
```

**关键设计:**
- `mp.add_timeout(0, ...)` 递归调用 → 每 MPV 帧回调一次 → 60fps
- `mp.get_time()` 单调时钟 → 直播无 `time-pos`，需独立时间驱动
- 弹幕池 (`dm_pool`) 自动 GC：每帧清除过期弹幕，空池时停止渲染循环

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
- Live: 切换 `overlay.hidden` + 暂停/恢复渲染循环

---

## 4. Python 后端 (`biliver.py`)

### 职责
弹幕协议解析、轨道计算、IPC 通信、ASS 文件生成。

### 4.1 直播模式

```
BLiveClient
  ├─ init_room()     → API 获取真实房间号 + 弹幕服务器配置
  ├─ ws_connect()    → 连接 wss:// 弹幕服务器
  ├─ AUTH 认证       → 发送 {uid, roomid, protover:3, key}
  ├─ 心跳包          → 每 25s 发送空心跳 (ver=1, op=2)
  ├─ 数据包解析      → 处理 Brotli/Zlib 压缩 → JSON 解析
  └─ handler 回调    → 提取 DANMU_MSG → 颜色转换 → IPC 发送

DanmakuManager
  ├─ find_track()    → 轨道碰撞检测 (与 Lua 端算法一致)
  ├─ cleanup_tracks() → 定期清理过期轨道时间戳

IPC 通信
  ├─ 异步队列 (asyncio.Queue) + 独立写入线程
  ├─ 队列满载 (>180) → 丢弃最旧 30% 消息
  ├─ IPC 断线监控 → 7s 无响应自动退出
  └─ 协议: JSON {"command": ["script-message", "biliver-danmaku", color, text, y_hint]}
```

### 4.2 点播模式

```
run_vod(target_id):
  ├─ BV/AV → API 获取 CID
  ├─ HTTP 下载 XML 弹幕 (自动处理 gzip/zlib/raw deflate)
  ├─ DanmakuManager 预计算所有弹幕轨道
  └─ 生成 ASS 字幕文件
       ├─ 滚动弹幕 (mode 1,6): \move(start_x, y, end_x, y)
       ├─ 顶部弹幕 (mode 5):   \an8\pos(center, y)
       └─ 底部弹幕 (mode 4):   \an2\pos(center, y)
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
              biliver.py WebSocket 接收弹幕 → IPC 管道发送
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
| `render_frame()` | 60fps 渲染: 计算位置 → ASS → overlay:update() |
| `start_render()` | 启动渲染循环 |
| `update_fps_vf(force)` | 动态 60fps 补帧滤镜管理 |
| `safe_remove_fps_vf()` | 安全移除补帧滤镜 |
| `toggle_danmaku()` | 弹幕显示/隐藏切换 |
| `process_vod(target_id)` | 点播: 启动 Python 转换 + 加载 ASS |
| `sanitize_text(text)` | 清理弹幕文本 (移除 `{}` `\n`) |
| `estimate_text_width(text)` | 估算文字像素宽度 (ASCII=0.6x, CJK=1.05x) |

### `biliver.py`

| 类/方法 | 作用 |
| :--- | :--- |
| `BLiveClient` | WebSocket 直播弹幕客户端 |
| `BLiveClient.init_room()` | API 获取真实房间号 + 弹幕服务器配置 |
| `BLiveClient.run()` | 连接 + 认证 + 心跳 + 接收消息循环 |
| `BLiveClient._p_ws(data)` | 数据包解压 (Brotli/Zlib) + JSON 解析 |
| `DanmakuManager` | 弹幕轨道管理器 |
| `DanmakuManager.find_track(text)` | 轨道分配与碰撞规避 |
| `DanmakuManager.cleanup_tracks()` | 清理过期轨道时间戳 |
| `run_live(room_id, ipc_path, ...)` | 直播模式入口 |
| `run_vod(target_id, ...)` | 点播模式入口: XML → ASS |
| `ipc_worker(queue, path)` | 异步 IPC 写入协程 |
| `send_mpv_async(queue, cmd)` | 非阻塞 IPC 发送 (队列满时丢弃旧消息) |
| `connection_monitor(ipc_path)` | IPC 断线监控 (7s 超时自动退出) |

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
