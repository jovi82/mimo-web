# mimo-web · MiMoCode 手机/局域网网页端

把电脑上的 **MiMoCode（mimo CLI）** 开到局域网里：手机、平板、别的电脑，
在浏览器打开一个地址，就能直接对着电脑上的项目目录聊天改文件、敲终端、
让 mimo 读图改代码 —— 所有设备看到的是**同一份本地文件**，不存在"同步"问题。

> 像豆包的手机端 / 电脑端一样，只不过"云端"就是你自己的这台电脑。

---

## ✨ 功能

| 页面 | 能干什么 |
|------|----------|
| **对话** | 和 mimo 聊天，它直接读写当前项目目录里的文件（`mimo run` 流式输出） |
| **终端** | 完整的网页终端（xterm.js + node-pty），拖选文字可 **🔊 朗读 / 📋 复制** |
| **文件** | 浏览项目目录，一键"让 mimo 改这个文件夹"、下载文件 |
| **项目切换** | 顶部下拉选择预设文件夹，或输入任意路径，切换后终端/对话/文件全部跟着换 |
| **手机拍照/贴文字** | 对话页的 📷 拍照 / 🖼 图片 / ✍️ 文字 → 存进项目 `inbox/`，并自动让 mimo 处理 |
| **语音朗读（TTS）** | 基于小米 MiMo TTS，终端选中内容和聊天回复都能读出来 |

---

## 📱 截图

**手机端**（430px 窄屏，项目栏默认折叠）：

![手机端](docs/screenshots/phone.png)

**桌面端**（900px，展开的项目切换栏）：

![桌面端](docs/screenshots/desktop.png)

---

## 🚀 快速开始

### 环境要求

- Node.js ≥ 18（需要 `fetch`）
- Windows / macOS / Linux（终端用 `cmd.exe`，其他系统用 `$SHELL`）
- 已安装并登录 [MiMoCode CLI](https://platform.xiaomimimo.com)（即 `mimo` 命令）

### 安装

```bash
git clone <你的仓库地址>
cd mimo-web
npm install
```

### 启动

**方式一（推荐，Windows）**：双击 `启动网页终端.bat`

**方式二（命令行）**：

```bash
# 指定要"挂载"的项目目录
set PROJECT_DIR=D:\website\my-project     # Windows
# export PROJECT_DIR=/path/to/project      # macOS / Linux

npm start
```

启动后会打印：

```
local:   http://127.0.0.1:7681
phone:   http://192.168.x.x:7681
project: D:\website\my-project
```

### 手机怎么访问

1. 手机和电脑连**同一个 WiFi**
2. 手机浏览器打开上面打印的 `http://192.168.x.x:7681`
3. 默认进「对话」页，直接说：`看看 inbox 里我刚拍的照片，帮我整理成 markdown`

> Windows 首次启动 bat 会自动加防火墙放行（端口 7681）。没弹出来时用管理员身份运行一次 bat。

---

## ⚙️ 配置

### 项目目录

三种方式，任选其一：

1. **网页里切换**（最方便）：顶部 `📁 项目 ▾` → 选预设或输入路径 → 「切换项目」
2. **环境变量**：`PROJECT_DIR=D:\路径`
3. **持久化**：切换一次后会写入 `projects.json`，下次启动自动沿用

`projects.example.json` 是示例，复制成 `projects.json` 后改成你的路径即可。

### 预设文件夹

编辑 `projects.json`：

```json
{
  "active": "",
  "presets": [
    { "name": "股票系统", "path": "G:\\website\\StockTrading" },
    { "name": "我的笔记", "path": "D:\\notes" }
  ]
}
```

### 语音朗读（可选）

没有密钥时朗读按钮会提示"未配置"，其余功能不受影响。

1. 去 [小米 MiMo 开放平台](https://platform.xiaomimimo.com) 创建一个 `sk-` 开头的 API Key
2. 在本目录新建 `tts.config.json`：

```json
{
  "key": "sk-你的密钥",
  "model": "mimo-v2.5-tts",
  "voice": "mimo_default",
  "format": "mp3"
}
```

可用音色：`mimo_default` `default_zh` `default_en` `Mia` `Chloe` `Milo` `Dean`

> ⚠️ `tts.config.json` 已被 `.gitignore` 忽略，**不会**被提交。

### 环境变量一览

| 变量 | 默认 | 说明 |
|------|------|------|
| `PROJECT_DIR` | 当前目录 | 启动时挂载的项目目录 |
| `PORT` | `7681` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址（局域网可访问） |
| `MIMO_CMD` | `mimo` | 终端里启动的命令 |
| `MIMO_BIN` | 自动探测 | mimo CLI 的 bin 路径（对话页用） |
| `MIMO_INBOX` | `inbox` | 手机上传的落盘子目录 |
| `MAX_UPLOAD_MB` | `50` | 单文件上传上限 |
| `CHAT_TIMEOUT_MS` | `600000` | 对话超时（10 分钟） |

---

## 🔌 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/status` | 当前项目路径 |
| GET | `/api/files?path=` | 列目录（限定在项目内） |
| GET | `/api/download?path=` | 下载文件（限定在项目内） |
| POST | `/api/chat` | 与 mimo 对话，NDJSON 流式返回 |
| GET | `/api/chat-status` | mimo CLI 是否可用 |
| POST | `/api/project` | 切换项目目录 `{ "path": "..." }` |
| GET | `/api/projects` | 预设列表与当前目录 |
| POST | `/api/ingest` | 手机上传（multipart 或 `{ "text": "..." }`）→ `inbox/` |
| POST | `/api/tts` | 文字转语音，返回 `audio/mpeg` |
| GET | `/api/tts-config` | 语音配置 |
| WS | `/` | 终端流（`{"type":"input"}` / `{"type":"resize"}`） |

---

## 🔒 安全提示（请务必阅读）

这个项目的设计前提是 **可信的家庭/办公局域网**：

1. **没有登录鉴权** —— 连到同一 WiFi 的设备都能打开终端、执行任意命令。
2. **不要暴露到公网** —— 不要做端口映射、不要放进云服务器裸奔。
3. 已做的防护：
   - 所有文件读写用 `safeJoin` 限定在项目目录内，防路径穿越；
   - WebSocket 与写操作校验 `Origin`，挡住恶意网页跨站驱动你的终端；
   - API Key 走 `.gitignore`，不进版本库。
4. 只在家里/公司内网用，或者用完关掉。

---

## ⚠️ 免责声明与商标

- 本项目是**独立的第三方开源工具**，**不是**小米 / MiMo 官方项目，
  与 Xiaomi MiMo 没有任何隶属、合作或背书关系。
- 文中出现的 **MiMo、Xiaomi、小米** 等名称与商标归其权利人所有，
  仅用于说明"本工具调用了哪个服务"，不代表官方立场。
- 语音合成等在线能力通过你**自己的** API Key 调用小米 MiMo 开放平台，
  请遵守其[用户协议](https://platform.xiaomimimo.com/docs/terms/user-agreement)
  与计费规则；本项目不捆绑、不分发任何小米的模型或代码。

---

## ❓ 常见问题

**Q：手机上打开是白屏？**
确认和电脑在同一个 WiFi，且电脑防火墙已放行 7681 端口（用 bat 启动会自动加规则）。

**Q：对话页提示"未找到 mimo CLI"？**
设置环境变量 `MIMO_BIN` 指向 mimo 的 bin 脚本路径，或确认 `mimo` 已在 `PATH` 里。

**Q：切换项目后终端断了？**
正常。切换会结束当前终端和进行中的对话，页面会自动重连并进入新目录。

**Q：拍的照片存在哪？**
`<当前项目>/inbox/`，上传成功后会自动把处理指令发给 mimo。

**Q：朗读没声音？**
先看 `tts.config.json` 是否配好密钥；再确认浏览器没静音（iOS Safari 需要先有一次用户点击才能出声）。

---

## 📄 License

MIT —— 可自由使用、修改、分发。
