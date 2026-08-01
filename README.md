# Biliver

MPV 播放器的 **Bilibili 弹幕插件** — 支持 VOD 点播 + 直播实时弹幕，60fps 零闪烁渲染。

```
浏览器点击 → 剪贴板指令 → MPV 拉流 → Python 取弹幕 → Lua OSD 渲染
```

## 特性

- **点播弹幕**: 下载历史弹幕 → ASS 字幕 → MPV 原生加载
- **直播弹幕**: WebSocket 实时接收 → OSD overlay 60fps 渲染（零闪烁）
- **60fps 补帧**: 低帧率视频自动补帧，弹幕始终丝滑
- **轨道碰撞检测**: 弹幕不重叠，满载时排队等待
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
2. 复制 `main.lua` + `biliver.py` → `scripts/biliver/`
3. 复制 `biliver.conf` → `script-opts/`
4. 检查 Python 依赖并自动安装

手动安装：将 `main.lua` 和 `biliver.py` 放入 MPV 的 `scripts/biliver/` 目录，`biliver.conf` 放入 `script-opts/` 目录。

### 3. 安装油猴脚本

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)
2. 打开 `biliver.js`，复制全部内容，新建用户脚本粘贴保存

### 4. 使用

1. 在 B 站视频或直播间点击左下角 **播放图标**
2. 命令行粘贴执行生成的 MPV 指令
3. `Ctrl+D` 切换弹幕显示/隐藏

> **建议**: 在 `mpv.conf` 中添加 `watch-later-options-remove=sub-pos` 避免与 ModernZ 等 UI 冲突

## 弹幕配置 (`biliver.conf`)

放置在 MPV 的 `script-opts/` 目录下：

| 参数 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `fontname` | `Microsoft YaHei` | 弹幕字体 |
| `font_size` | `36` | 字体大小 (px) |
| `duration` | `10` | 飞行时间 (秒)，越小越快 |
| `opacity` | `60` | 不透明度 (0-100) |
| `area` | `0.45` | 占屏幕高度比例 (0.0-1.0) |
| `fps_vf` | `yes` | 60fps 补帧滤镜 |
| `python_path` | `python` | Python 解释器路径 |

## 快捷键

| 快捷键 | 功能 |
| :--- | :--- |
| `Ctrl+D` | 切换弹幕显示/隐藏 |

## 文件结构

```
Biliver/
├── main.lua          # Lua 前端 — OSD 渲染 + 进程管理 + 补帧
├── biliver.py        # Python 后端 — 弹幕获取 + 协议解析 + IPC
├── biliver.js        # 油猴脚本 — 网页端 CDN 提取 + 指令生成
├── biliver.conf      # 用户配置
├── install.bat       # Windows 安装入口
├── README.md         # 使用说明
└── Description.md    # 技术架构文档
```

---
*Powered by Q3dlaXpoaQ.*
