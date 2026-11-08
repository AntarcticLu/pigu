# Changelog

## v0.0.1 (2026-11-08)

### 🎉 Pigu 首个正式版本发布

- **一端统管本地全生态 AI 编程 CLI**：
  - 零配置自动识别并集成 `Claude Code (claude)`、`OpenAI Codex (codex)`、`OpenCode (opencode)`、`DeepSeek Harness (dsh)`、`Antigravity (agy)`、`Gemini CLI`、`GitHub Copilot`、`Cursor Agent` 与 `Aider`。
  - 支持直接发现并无缝接管本机及远端终端创建的活跃 CLI 会话。
- **同一会话跨引擎丝滑切换（Multi-Engine Model Relay）**：
  - 支持在同一会话中自由切换云端 API（如 `PiguToken`）与本地 CLI 智能体。
  - 内置跨引擎上下文自动桥接（Inline Context Bridging），切换模型不丢失前序对话与代码修改历史。
  - 自动聚合模型思考深度档位（`low` / `medium` / `high` / `max`）。
- **满血兼容 DeepSeek Harness (`dsh`) 与「大肥鱼」生态**：
  - 零配置自动识别并同步 `~/.dsh` 下的第三方扩展（如桌面宠物伴侣 `dsh-dafeiyu` 与人设插件 `dsh-persona-dafeiyu`），自动过滤冗余内置 Office 组件。
  - 支持在「设置 -> 拓展 -> 插件」中可视化一键启停 `DSH 插件`，启动即自动唤醒桌面大肥鱼伴侣。
  - 支持为 `dsh` 和大肥鱼动态切换任意已配置的云端或自定义模型（如 `PiguToken / gemini-3.8-flash`）。
- **SSH 远程算力直连与自动托管**：
  - 支持连接 AutoDL 及远程 Linux 服务器，自动引导部署远端 `pigu` 服务并同步本地云端提供商配置。
  - 侧边栏与模型选择器支持直观展示「本机」与远程服务器徽章。
- **开箱即用 PiguToken 与全界面中英双语**：
  - 内置 `PiguToken` 官方模型通道及自定义提供商管理，支持一键刷新模型列表与中英双语实时切换。
