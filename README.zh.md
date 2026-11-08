<div align="center">
  <h1>🍑 Pigu (屁股)</h1>
  <p><strong>新一代多引擎 AI 编程桌面工作台与智能体中枢</strong></p>
  <p>
    <a href="https://github.com/AntarcticLu/pigu/releases"><img alt="Release" src="https://img.shields.io/github/v/release/AntarcticLu/pigu?style=flat-square&label=version" /></a>
    <a href="https://github.com/AntarcticLu/pigu/blob/dev/LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
    <a href="README.zh.md">简体中文</a> | <a href="README.md">English</a>
  </p>
</div>

---

## ✨ 为什么选择 Pigu？（核心优势）

在 AI 编程时代，开发者电脑上往往同时装着 **Claude Code**、**Codex**、**OpenCode**、**DeepSeek Harness (`dsh`)**、**Antigravity** 等多个命令行工具，还要管理多个云端 API 渠道与远程 GPU 服务器。**Pigu** 将它们统一收归到一个极速、现代的原生桌面端与 CLI 中枢：

### 1. 🔌 一端统管：无缝集成并接管所有主流 AI 编程 CLI
- **零配置自动探测**：启动即自动识别本机已安装的 **Claude Code (`claude`)**、**OpenAI Codex (`codex`)**、**OpenCode (`opencode`)**、**DeepSeek Harness (`dsh`)**、**Antigravity (`agy`)**、**Gemini CLI (`gemini`)**、**GitHub Copilot**、**Cursor Agent** 与 **Aider**。
- **终端会话随时接管（Session Takeover）**：你在终端黑框里聊到一半的 `opencode` / `claude` / `codex` / `dsh` 会话，打开 Pigu 桌面端即可实时发现并一键接管到图形界面继续对话，历史上下文分毫无损。

### 2. 🔄 同一会话跨引擎混排：换脑不失忆
- **多模型接力编程**：在同一个会话窗口里，你可以第 1 轮用高性价比的 **PiguToken (`gemini-3.8-flash`)** 快速生成项目脚手架，第 2 轮无缝切换到本地 **Claude Code** 深度重构，第 3 轮切给 **Codex** 补齐单元测试。
- **内联上下文自动桥接（Inline Context Bridging）**：无论是「云端 API ⇄ 本地 CLI」还是「不同本地 CLI 引擎互切」，Pigu 会自动提取并注入前序对话与代码修改摘要，彻底解决跨工具切换时的“失忆”痛点。
- **智能思考档位（Effort Variants）**：自动将模型的 `low / medium / high / max` 思考深度聚合为输入框底部的档位切换器，模型列表清爽直观。

### 3. 🐟 满血兼容 DeepSeek Harness (`dsh`) 与「大肥鱼」生态
- **零操作即插即用**：只要你的电脑安装了 `dsh` 及第三方拓展（如爆火的桌面宠物伴侣 **大肥鱼 `dsh-dafeiyu`** 与 **大肥鱼人设 `dsh-persona-dafeiyu`**），打开 Pigu 无需任何配置即可直接唤醒桌面大肥鱼伴侣，实时联动「思考、干活、完成、报错」动画状态，并以地道的大肥鱼傲娇人设陪你写代码。
- **给 DSH 插件自由换模型**：打破原版模型绑定限制，在 Pigu 中可以一键为 `dsh` 和大肥鱼切换任意你配置的云端/自定义模型（例如 `PiguToken / gemini-3.8-flash`），兼顾满血插件体验与极低 Token 成本。
- **智能去冗余**：自动过滤 `dsh` 内置冗余的 Office 套件，只保留你真正需要的第三方精品插件，并在「设置 -> 拓展 -> 插件」中支持可视化一键启停。

### 4. 🖥️ SSH 远程算力一键直连与自动托管
- **AutoDL / 远程 Linux 开发机直连**：在「设置 -> 模型与服务器」中填入 SSH 连接信息，即可像操作本地文件夹一样打开远端服务器目录。
- **远端零门槛自动部署**：连接 SSH 后自动检测并在远端引导部署 `pigu` 后台服务，自动将本机配置好的云端模型（如 `PiguToken`）与密钥同步至远端，在侧边栏与模型选择器中通过远程徽章清晰区分「本机」与「远程算力」环境。

### 5. ⚡ 开箱即用的 PiguToken 与全生态拓展
- **内置 PiguToken 官方通道**：填入 API Key 即可一键拉取最新高性价比模型列表，同时支持接入任意 OpenAI / Anthropic / Gemini 兼容格式的自定义服务商。
- **可视化 MCP 与 Skills 管理**：支持全局与项目级 **MCP (Model Context Protocol)** 服务、**Skills 技能包** 及 **本地 CLI 插件** 的统一开关管理，支持全界面中/英双语一键切换。

---

## 📦 安装与更新

### macOS & Linux（一行命令安装 / 更新）

打开终端运行以下命令，脚本会自动识别系统架构（Apple Silicon `arm64` / Intel `x64` / Linux `x64` & `arm64`），从 GitHub Releases 下载最新预编译包并完成安装：

```bash
curl -fsSL https://raw.githubusercontent.com/AntarcticLu/pigu/dev/install | bash
```

> **如何更新？** 再次运行上面同一条命令即可自动下载新版本并覆盖旧版程序。你的所有账号凭证、模型配置与历史对话均安全保存在 `~/.config/opencode` 与 `~/.local/share/opencode` 中，更新绝不丢失数据。

### Windows（免安装便携压缩包）

1. 前往 [GitHub Releases](https://github.com/AntarcticLu/pigu/releases) 页面下载最新版本的 **`pigu-windows-x64.zip`**。
2. 解压到任意目录，双击运行 `Pigu.exe` 即可使用（内置完整 CLI 与桌面端）。
3. **更新方式**：下载新版 `.zip` 解压覆盖原目录即可，用户配置与会话数据独立保存在系统 `%APPDATA%\opencode` 与 `%LOCALAPPDATA%\opencode` 目录中，完全不受影响。

---

## 🛠️ 本地开发与构建

```bash
# 1. 安装依赖
bun install

# 2. 启动 Pigu 桌面端开发环境
bun run dev:desktop

# 3. 启动 Pigu CLI
bun run pigu

# 4. 代码检查与类型校验
bun run check
```

---

## 📄 开源协议

本项目基于 [MIT License](./LICENSE) 开源。
