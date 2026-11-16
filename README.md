<div align="center">
  <img src="packages/desktop/icons/prod/icon.png" width="88" height="88" alt="Pigu Logo" />
  <h1>Pigu</h1>
  <p><strong>新一代多引擎 AI 编程桌面工作台与远控智能体中枢</strong></p>
  <p>
    <a href="https://github.com/AntarcticLu/pigu/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/AntarcticLu/pigu?style=flat-square&label=release&color=f97316" /></a>
    <a href="https://github.com/AntarcticLu/pigu/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/AntarcticLu/pigu?style=flat-square&color=eab308" /></a>
    <a href="https://github.com/AntarcticLu/pigu/blob/dev/LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-3b82f6?style=flat-square" /></a>
    <img alt="Platforms" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-10b981?style=flat-square" />
  </p>
</div>

---

## 📦 下载与安装

### 1. 安装包直接下载（[GitHub Releases](https://github.com/AntarcticLu/pigu/releases/latest)）

| 操作系统 | 架构说明 | 直接下载链接 | 安装与启动方式 |
| :--- | :--- | :--- | :--- |
| **macOS (Apple Silicon)** | `M1 / M2 / M3 / M4` | [**`pigu-darwin-arm64.tar.gz`**](https://github.com/AntarcticLu/pigu/releases/latest/download/pigu-darwin-arm64.tar.gz) | 解压后将 `Pigu.app` 拖入「应用程序」，或用下方一行命令自动安装 |
| **macOS (Intel)** | `x86_64` | [**`pigu-darwin-x64.tar.gz`**](https://github.com/AntarcticLu/pigu/releases/latest/download/pigu-darwin-x64.tar.gz) | 同上 |
| **Windows (免安装便携版)** | `Windows 10 / 11 (x64)` | [**`pigu-windows-x64.zip`**](https://github.com/AntarcticLu/pigu/releases/latest/download/pigu-windows-x64.zip) | 解压到任意目录，双击 **`Pigu.exe`** 即用（命令行位于 `bin\pigu.cmd`） |
| **Linux / 算力服务器** | `x86_64` | [**`pigu-linux-x64.tar.gz`**](https://github.com/AntarcticLu/pigu/releases/latest/download/pigu-linux-x64.tar.gz) | 单文件 CLI 服务端，支持下方命令安装或由桌面端通过 SSH 自动部署 |
| **Linux (ARM64)** | `aarch64 / arm64` | [**`pigu-linux-arm64.tar.gz`**](https://github.com/AntarcticLu/pigu/releases/latest/download/pigu-linux-arm64.tar.gz) | 同上 |

### 2. macOS / Linux 一行命令安装与升级

在 macOS 终端（自动安装 `/Applications/Pigu.app` 桌面端 + `pigu` 命令行）或 Linux / AutoDL 服务器终端运行：

```bash
curl -fsSL https://raw.githubusercontent.com/AntarcticLu/pigu/dev/install | bash
```

- **启动桌面端（macOS）**：在「应用程序（Applications）」中打开 **Pigu**。
- **使用命令行**：终端执行 `pigu`（首次安装后请新开终端或运行 `exec $SHELL`）。
- **无损升级**：再次运行同一条命令（Windows 直接解压覆盖原目录）即可完成升级，所有供应商配置、机器人绑定与历史会话自动保留。
- **远程服务器免手动安装**：若要远控 AutoDL 或任意 Linux 服务器，无需提前登录服务器安装——直接在桌面端添加 SSH 连接，Pigu 会自动检测并完成远端部署与升级（即使远端无法直连 GitHub 也可由本机自动中转）。

---

## ✨ 功能介绍

- **🔌 本地多引擎 CLI 零配置双向接管**
  自动识别并实时同步本机已安装的 **Claude Code (`claude`)**、**OpenAI Codex (`codex`)**、**DeepSeek Harness (`dsh`)**、**Antigravity (`agy`)**、**OpenCode**、**Gemini CLI**、**Cursor** 等工具的历史项目、会话与在用模型。无论在 Pigu 桌面端还是原终端继续对话均双向实时同步，并完整支持原生与本地上下文压缩（`/compact`）。
- **🔄 同一会话跨厂商 / 跨引擎无损混排**
  支持在同一条会话中随时切换「云端 API 模型（内置 **PiguToken** 官方通道，同时兼容 OpenAI / Anthropic / Google / DeepSeek 及任意自定义中转接口）」与「本地 CLI 引擎」。内置跨引擎上下文自动桥接，换模型不丢记忆，支持思考深度档位（`low` / `medium` / `high` / `max`）及图片、音频、文档多模态输入。
- **📱 手机端全链路远程办公（飞书 / 微信 / 钉钉 / 企业微信 / QQ）**
  无需公网 IP 与内网穿透，在「设置 → 手机端」一键接入聊天机器人。出门在外直接用手机与本机或远程 SSH 服务器上的 AI 对话、通过自然语言管家或快捷指令（`.project`、`.chat`、`.model`、`.sh`、`.send`）切换项目与模型、执行服务器命令、将远端生成的文件发回手机，内置防电脑休眠守护与静默进度推送。
- **🖥️ 任意 SSH 远程服务器直连与算力托管**
  支持密码或密钥连接 AutoDL 及任意 Linux 服务器，自动同步本机云端模型配置、按版本哈希自动升级远端服务，像操作本地文件夹一样浏览远端目录、接管服务器上的 `Codex` / `Claude` 会话并操作远程终端。
- **🐟 原生兼容 DeepSeek Harness 与「大肥鱼」生态**
  即插即用识别 `~/.dsh` 下的 `dsh-dafeiyu` 桌面宠物伴侣与 `dsh-persona-dafeiyu` 人设插件，支持可视化一键启停，并可为其自由切换任意高性价比模型。
- **🧩 统一拓展中枢与双语工作台**
  一处可视化管理全局与项目级 **MCP 服务**、**Skills 技能包** 及 **本地插件**，内置代码 Diff 审查、Office 文档与多格式文件预览、亮/暗主题与中/英双语切换。

---

## 📈 Star History

<div align="center">
  <a href="https://star-history.com/#AntarcticLu/pigu&Date">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=AntarcticLu/pigu&type=Date&theme=dark" />
      <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=AntarcticLu/pigu&type=Date" />
      <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=AntarcticLu/pigu&type=Date" />
    </picture>
  </a>
</div>
