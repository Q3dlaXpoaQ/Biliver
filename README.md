# Biliver

MPV 播放器的 **Bilibili 弹幕插件** — 支持 VOD 点播 + 直播实时弹幕，60fps 零闪烁渲染。

```
浏览器点击 → 剪贴板指令 → MPV 拉流 → Python 取弹幕 → Lua OSD 渲染
```

## 特性

- **点播弹幕**: 下载历史弹幕 → ASS 字幕 → MPV 原生加载
- **直播弹幕**: WebSocket 实时接收 → OSD overlay 60fps 渲染（零闪烁）
- **直播断线重连**: 弹幕服务器断开后自动重连，弹幕不中断
- **长弹幕分片渲染**: 新版协议的长弹幕按分片逐条渲染，不被截断
- **60fps 补帧**: 低帧率视频自动补帧，弹幕始终丝滑
- **轨道碰撞检测**: 弹幕不重叠，满载时排队等待
- **弹幕池上限保护**: 极端弹幕潮时丢弃最旧弹幕，防止内存膨胀
- **同步播放进度**: 油猴脚本自动同步网页播放进度到 MPV
- **一键安装**: PowerShell 安装器，自动检测 MPV/Python 环境

## 快速开始

### 1. 安装依赖

- **Python 3.7+** + `aiohttp` `brotli`（安装器自动检测）
- **MPV** 播放器（加入系统 PATH）
- **Tampermonkey** 浏览器扩展

### 2. 安装插件

双击 `install.bat`（Windows），安装器会：
1. 自动检测 MPV 配置目录
2. 复制 `main.lua` + `biliver.py` + `biliver_handler.py` → `scripts/biliver/`
3. 复制 `biliver.conf` → `script-opts/`
4. （可选）注册 `biliver://` 协议，实现点击播放图标直接打开 MPV
5. 检查 Python 依赖并自动安装

常用参数：`install.bat -Silent`（静默安装）／`-NoProtocol`（跳过协议注册）／`-UseMirror`（改用清华镜像安装依赖）／`-NoBackup`（覆盖时不备份旧文件）／`install.bat <MPV目录>`（直接指定 MPV 配置目录）。

手动安装：将 `main.lua`、`biliver.py`、`biliver_handler.py` 放入 MPV 的 `scripts/biliver/` 目录，`biliver.conf` 放入 `script-opts/` 目录。注意手动安装不会注册 `biliver://` 协议，一键打开需运行一次 `install.bat`（或手动在注册表中配置 `HKCU\Software\Classes\biliver`）。

### 3. 安装油猴脚本

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)
2. 打开 `biliver.js`，复制全部内容，新建用户脚本粘贴保存

### 4. 使用

在 B 站视频或直播间点击左下角两个圆形按钮：

- **蓝色播放图标** → **一键打开 MPV**（需要已注册 `biliver://` 协议，运行一次 install.bat 即可）
- **紫色复制图标** → 复制 MPV 指令，粘贴到命令行手动执行（回退方案）

一键播放的实现：脚本把播放参数（含登录 cookie、音视频签名 URL）写入剪贴板，协议 URL 仅携带一个短 token，由 `biliver_handler.py` 读取并校验后启动 MPV —— 彻底规避旧浏览器对超长 URL 的参数截断问题。处理器全程写入 `%TEMP%\biliver_handler.log`，播放无反应时可查看该日志定位问题。

> **已知坑（v1.2.0 修复）**: mpv 的 `--http-header-fields` 按逗号分隔且无法转义。B 站下发的 `bmg_af_sc={"none":{"on":1,...}}` 等 JSON cookie 值含逗号/引号，以及 UA 中的 `(KHTML, like Gecko)`，都会被切碎成非法请求头导致 CDN 返回 400、mpv 静默退出（表现为"点了没反应"）。脚本与处理器都会自动剔除坏 cookie 对、并把其他头值的逗号归一化为 `;`；处理器同时加入 `--force-window=yes`，即使加载失败也会弹出 mpv 错误窗口而非无影无踪。若你的浏览器曾出现"Edge 能用、换浏览器不能用"，多半就是这类 cookie 的差异所致，升级脚本 + 处理器即可。

> **注意**: 若浏览器提示"未检测到 biliver:// 协议"，请运行一次 `install.bat` 完成协议注册；安装时也可以选择跳过协议注册（仅保留复制指令方式）。

### 5. 卸载

双击 `uninstall.bat`（Windows），会：
1. 移除 `biliver://` 协议注册与 `HKCU\Software\Biliver` 配置
2. 询问是否删除 MPV 配置目录中的插件文件（`scripts\biliver\`、`script-opts\biliver.conf`）

常用参数：`uninstall.bat -Silent`（仅移除注册）／`uninstall.bat -Silent -RemoveFiles`（静默移除注册+插件文件）／`-KeepFiles`（保留插件文件）。油猴脚本需在浏览器 Tampermonkey 中手动删除。

> **建议**: 在 `mpv.conf` 中添加 `watch-later-options-remove=sub-pos` 避免与 ModernZ 等 UI 冲突

## 弹幕配置 (`biliver.conf`)

放置在 MPV 的 `script-opts/` 目录下：

| 参数 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `fontname` | `Microsoft YaHei` | 弹幕字体 |
| `font_size` | `36` | 字体大小 (px) |
| `duration` | `13` | 飞行时间 (秒)，越小越快 |
| `opacity` | `60` | 不透明度 (0-100) |
| `area` | `0.45` | 占屏幕高度比例 (0.0-1.0) |
| `fps_vf` | `yes` | 60fps 补帧滤镜 |
| `outline` | `2` | 弹幕描边宽度(px)，浅色背景看不清时加大；`0` 关闭 |
| `shadow` | `1` | 弹幕阴影宽度(px)，`0` 关闭 |
| `python_path` | `python` | Python 解释器路径 |
| `max_pool` | `1000` | 直播弹幕池大小上限（仅极端弹幕潮时兜底，超出丢弃最旧条目） |

## 故障排查

直播弹幕不显示 / 中途消失时，按以下顺序定位：

1. **后端日志** `biliver.log`（与 `biliver.py` 同目录）：查看 WebSocket 重连、IPC 写入失败、心跳异常。
2. **mpv 控制台**：以 `--msg-level=biliver=trace` 启动，可看到 Lua 端事件（后端启动/退出/重启、弹幕接收计数）。
3. **协议处理器日志** `%TEMP%\biliver_handler.log`：一键打开无反应时查看。

浅色/白色背景视频弹幕看不清时：调大 `outline`（建议 2-4），或在 `biliver.conf` 中提高 `opacity`。

设置环境变量 `BILIVER_DEBUG=1`（或给后端进程加 `--verbose`）可输出 DEBUG 级日志到 `biliver.log` 与 mpv 控制台。

后端意外退出时 mpv 会自动重启后端（指数退避，最多 6 次，稳定运行 60s 后重置）；若持续失败，请结合上述日志排查。

## 快捷键

| 快捷键 | 功能 |
| :--- | :--- |
| `Ctrl+D` | 切换弹幕显示/隐藏 |

## 文件结构

```
Biliver/
├── main.lua              # Lua 前端 — OSD 渲染 + 进程管理 + 补帧
├── biliver.py            # Python 后端 — 弹幕获取 + 协议解析 + IPC
├── biliver_handler.py    # 协议处理器 — biliver:// 一键启动 MPV (剪贴板接力)
├── biliver.js            # 油猴脚本 — 网页端 CDN 提取 + 指令生成
├── biliver.conf          # 用户配置
├── install.bat           # Windows 安装入口 (含 biliver:// 协议注册)
├── uninstall.bat         # Windows 卸载入口 (移除协议注册与插件文件)
├── README.md             # 使用说明
└── Description.md        # 技术架构文档
```

---
*Powered by Q3dlaXpoaQ.*
