# Biliver

Biliver 是一个专为 MPV 播放器设计的 **高性能 Bilibili 弹幕** 插件。

它致力于解决MPV无法显示Bilibili弹幕的问题，通过 Python 异步后端与 60fps 补帧技术，在 MPV 上实现比网页端更丝滑、更纯净的弹幕体验。


## 🛠️ 安装说明

### 1. 准备 Python 环境
确保您的系统已安装 **Python 3.7+**。
在本项目目录下运行以下命令安装依赖：
```powershell
pip install -r requirements.txt
```

### 2. 安装 MPV 插件
1. 将整个 `biliver` 文件夹放入 MPV 的 `scripts` 目录。
2. 确保 `main.lua` 和 `biliver.py` 在同一个目录下。
3. （建议）在 MPV 的 `mpv.conf` 中添加 `watch-later-options-remove=sub-pos` 以防与 ModernZ 等 UI 插件位置冲突。

### 3. 安装浏览器助手
1. 在浏览器中安装 [Tampermonkey](https://www.tampermonkey.net/)。
2. 新建脚本，将本项目中的 `biliverhelper.js` 内容全部复制并保存。

## 🚀 使用方法

1. **浏览器端**：在 B 站视频或直播间点击左下角的 **Biliver 播放图标**。
2. **复制启动**：指令会自动复制到剪贴板。
3. **粘贴运行**：在终端（PowerShell/Cmd）中粘贴并回车即可。

## ⚙️ 弹幕配置 (`biliver.conf`)

在 MPV 的 `script-opts` 文件夹中创建 `biliver.conf`：

| 参数 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `fontname` | `Microsoft YaHei` | 弹幕字体 |
| `font_size` | `32` | 弹幕字体大小 |
| `duration` | `10` | 弹幕飞行时间 (秒)，数值越小速度越快 |
| `opacity` | `80` | 弹幕不透明度 (0-100) |
| `area` | `0.4` | 弹幕占用屏幕高度比例 (0.0-1.0) |
| `fps_vf` | `true` | 是否开启 60fps 弹幕平滑平铺模式 |


---
*Powered by Q3dlaXpoaQ.*
