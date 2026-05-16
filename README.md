# Biliver

Biliver 是一个专为 MPV 播放器设计的 **高性能 Bilibili 弹幕** 插件。

通过 Python 异步后端 + Lua OSD 覆盖层渲染，在 MPV 上实现 **丝滑** 的弹幕体验。



## 安装说明

### 1. 准备 Python 环境
确保系统已安装 **Python 3.7+**，在项目目录下安装依赖：
```powershell
pip install -r requirements.txt
```

### 2. 安装 MPV 插件
1. 将 `main.lua` 和 `biliver.py` 放入 MPV 的 `scripts` 目录（确保两者在同一目录）
2. （建议）在 `mpv.conf` 中添加 `watch-later-options-remove=sub-pos` 避免与 ModernZ 等 UI 冲突
3. 将 MPV 可执行文件路径加入系统环境变量

### 3. 安装浏览器助手
1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展
2. 打开 `biliver.js`，复制全部内容，新建用户脚本粘贴保存

## 使用方法

1. 在 B 站视频或直播间点击左下角的 **Biliver 播放图标**
2. 打开命令行，粘贴并执行生成的 MPV 启动指令

## 弹幕配置 (`biliver.conf`)

在 MPV 的 `script-opts` 目录下创建 `biliver.conf`：

| 参数 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `fontname` | `Microsoft YaHei` | 弹幕字体 |
| `font_size` | `36` | 弹幕字体大小 (像素) |
| `duration` | `10` | 弹幕飞行时间 (秒)，越小越快 |
| `opacity` | `60` | 弹幕不透明度 (0-100)，100 为完全不透明 |
| `area` | `0.45` | 弹幕占用屏幕高度比例 (0.0-1.0) |
| `fps_vf` | `yes` | 是否开启 60fps 弹幕平滑补帧 |
| `python_path` | `python` | Python 解释器路径 |

示例 (`script-opts/biliver.conf`)：
```
fontname=Microsoft YaHei
font_size=36
duration=10
opacity=60
area=0.45
fps_vf=yes
```

## 快捷键

| 快捷键 | 功能 |
| :--- | :--- |
| `Ctrl+D` | 切换弹幕显示/隐藏 |

## 文件结构

```
Biliver/
├── main.lua              # MPV Lua 脚本（弹幕渲染 + 进程管理）
├── biliver.py            # Python 后端（弹幕获取 + 协议解析）
├── biliver.js            # Tampermonkey 油猴脚本（网页端助手）
├── requirements.txt      # Python 依赖
├── README.md             # 使用说明
└── Description.md        # 技术架构文档
```

---
*Powered by Q3dlaXpoaQ.*
