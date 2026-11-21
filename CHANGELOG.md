# Changelog

## v1.0.4 (2026-11-21)

### ✨ 交互式沙盒、跨引擎可视长期记忆、设备独立热升级与全协议流式防卡死

- **🧪 右侧内置交互式 Artifacts 沙盒（`sandbox_preview`）与 `pigu-builtin` MCP 桥接**：
  - 桌面端右侧新增实时交互式沙盒面板，原生支持独立 HTML/CSS/JS、React（JSX/TSX + Tailwind CSS + Lucide + Recharts）与 SVG 的即时预览与热更新。
  - 内置 `pigu-builtin` MCP 桥接服务，让本地及远程外部 CLI（`Antigravity`、`Claude Code`、`Codex`、`OpenCode`）与各家 API 模型均可直接调用沙盒预览、长期记忆与内置浏览器工具。
- **🧠 双栏 `.md` 可视化长期记忆（全局偏好 / 项目记忆）**：
  - 输入框底部新增「记忆」可视化管理抽屉，支持按全局（`global`）与项目（`project`）双栏管理 `.md` 记忆文件、单条启用/停用开关、手动编辑及跨引擎自动同步（兼容 `CLAUDE.md`、`AGENTS.md`、`.gemini/GEMINI.md`）。
- **🖥️ 本机与远程 SSH 服务器独立版本显示与一键热升级**：
  - 在「设置 → 模型」设备列表中为本机与每台 SSH 远程服务器分别展示当前 Pigu 版本号，并提供独立的「检查升级 / 升级到 vX.Y.Z / 已是最新 / 网络不通，重试」状态按钮，移除「设置 → 通用」中的冗余版本入口。
  - 修复 Linux 远程服务器运行中二进制热更新的 `Text file busy` 报错及缓存降级问题，升级后无感重连新守护进程。
- **📂 项目与会话动态上浮、远程 `$HOME` 外部会话自愈与手机端全面对齐**：
  - 侧边栏项目与会话按最新活跃时间动态上浮，支持会话置顶（Pin）与新消息自动解档；修复远程用户主目录（如 `/home/<user>`）下外部 CLI 历史会话漏同步与被误清理的问题。
  - 飞书 / 微信 / QQ 手机端同步对齐 `.p`（展示各设备版本号与真实活跃项目排序）、`.c`、`.compact`（显示原生 CLI 压缩来源徽标），并在本地服务重启或升级后自动恢复 SSH 远端设备映射。
- **⚡ 根治 API 模型大补丁/长文本流式「假死」与第三方网关断流死锁**：
  - 开启后端 `session.tool.input.delta` 100ms 批量流式推送与前端半截 JSON 线性解码，为 `patch`（补丁）、`write`、`edit` 及通用工具提供首帧文件名展示、实时跳动 `+行数` 徽标与 `O(N)` 零掉帧流式代码预览，并为底部「工作中」增加秒级计时反馈。
  - AI 协议层新增语义级流式活性检测：忽略 SSE `ping` 空心跳续命，对工具参数与正文流式输出实施 **90 秒**无语义进展自动熔断续写；对 Claude `message_stop` 挂起连接（5 秒）及 OpenAI Chat 兼容网关漏发 `[DONE]`（15 秒）执行平滑收敛正常落盘，彻底杜绝卡死。

---

## v1.0.3 (2026-11-18)

### 🛠️ 外部 CLI 自动压缩误判修复与微信多图稳定增强

- **⚡ 修复本地 / 远程外部 CLI 多步调用误触发外层自动压缩与上下文虚高问题**：
  - 对 `local/*` 外部引擎（`Antigravity`、`Claude Code`、`Codex`、`OpenCode`、`DeepSeek Harness` 等）关闭 Pigu 外层的自动压缩（`auto` / `overflow` / `precompute`），交由各 CLI 自身原生上下文机制管理；手动输入 `/compact` 仍正常调用对应 CLI 的原生压缩。
  - 修正外部 CLI 上下文窗口 Token 统计口径，统一记录该轮最后一步的真实窗口占用（忽略多步工具循环的累加计费 Token 与子代理消息），消除进度环上下文百分比虚高。
- **📱 修复微信控制连续发送多张图片报「执行出错」问题**：
  - 微信通道新增同用户多图与紧随文字的防抖自动合并（`900ms` 聚合窗口），将微信相册多选拆包推送的多张图片合并为单次 AI 请求，同时保持纯文字消息零延迟响应。
  - 支持微信原图 `hd_media` / `media` / `thumb_media` 自动兜底及多候选 AES 密钥校验解密，避免解密异常时误标为 `image/png` 触发图片解码报错。
  - 新增会话级串行准入锁、同名图片自动编号去重、远程带图请求 `120s` 超时放宽，以及超长截图内联超限自动回退至 `mobile-inbox` 磁盘路径读取机制；本地 CLI 同步支持合并连续穿插的多条图片消息。

---

## v1.0.2 (2026-11-18)

### ✨ 原生 CLI 命令直通、Windows 无感调用与 SSH 自动部署修复

- **⚡ 本地 / 远程 CLI 原生 `/compact`、`/review`、`/init`、`/goal` 分流与 `/` 补全**：
  - 选中 `Antigravity (agy)`、`Claude Code (claude)`、`OpenAI Codex (codex)` 时，`/compact` 自动调用各引擎原生原地压缩（保留原会话 ID、附件与子代理状态，并将原生检查点摘要同步回 Pigu 时间线）；API 模型继续使用 Pigu 自身压缩。
  - `/review` 在 Codex 下自动调用原生 `codex exec review` 审查管线，在 Claude Code 下直通原生 `/review`；`/init` 在 Claude Code 下直通生成 `CLAUDE.md`；`/goal` 在 Antigravity 与 Claude Code 下直通原生自主目标模式。
  - 输入框 `/` 补全菜单根据当前所选本地引擎动态提示原生斜杠命令（如 `/boost`、`/plan`、`/teamwork`、`/security-review`、`/simplify` 等）及本地/远端自定义 Skills。
- **🪟 修复 Windows 调用外部 CLI（如 Codex）每次弹出 `cmd` 黑框问题**：
  - 为全部本地引擎调用与移动端命令执行补齐 `windowsHide: true`（`CREATE_NO_WINDOW`），并在 Windows 下自动穿透 `codex.cmd` 直接启动底层原生 `codex.exe`（兼容 npm / pnpm / Scoop），彻底消除控制台弹窗与额外包装进程开销。
- **🖥️ 修复全新 SSH 服务器自动安装 Pigu CLI 时的软链接覆盖失败问题**：
  - 修复远端首次自动部署时 `~/.pigu/bin/pigu` 软链接在同步 shim 过程中产生断链导致误报未安装的问题，并优化自动安装失败提示文案。

---

## v1.0.1 (2026-11-17)

### 🛠️ 应用内一键更新、全端版本对齐与体验修复

- **🔄 应用内网络检测与一键原地更新（「设置 → 通用 → 版本」）**：
  - 自动读取系统代理（支持 Clash / FlClash 系统代理与直连回退），探测 GitHub Release 与安装包下载源连通性，支持显示实时进度并一键原地替换重启更新。
- **🔗 本机与远程 SSH 服务端三向版本自动对齐**：
  - 远端或本机服务版本低于客户端时自动升级（远端无法直连 GitHub 时由本机按精确版本号缓存并流式推送）；服务端版本高于客户端时自动保留高版本运行并提示更新本机客户端，杜绝多端混用反向降级。
- **⚡ 修复 macOS 静置高 CPU 占用问题**：
  - 修复侧边栏存在已收纳项目或外部 CLI 目录会话时触发 `/api/project` 高频刷新死循环的问题，静置 CPU 降至 `0%`。
- **🪟 弹窗与表单界面修复**：
  - 修复「新增 / 编辑供应商」等弹窗固定高度截断、密码框掩码及模型选择器连接入口不一致问题；修复「手机端」与「拓展」内表单输入框宽度未撑满问题。
- **🏪 新增 Microsoft Store 官方商店包构建支持**：
  - 新增 Windows 商店 MSIX/AppX 构建流水线、全尺寸 Pigu 品牌图标与商店托管更新适配。

---

## v1.0.0 (2026-11-16)

### 🚀 Pigu v1.0.0 正式版发布

- **📱 手机端远程办公中枢（飞书 / 个人微信 / 钉钉 / 企业微信 / QQ）**：
  - 支持零公网 IP 长连接接入手机端机器人，支持一句话迁移码跨设备迁移配置与防休眠守护；桌面端「设置 → 手机端」界面极简化重构。
  - 打通 **手机端 ↔ 本机 Pigu ↔ 远程 SSH 服务器 ↔ 远程 AI 引擎** 完整三跳控制链路，支持 `.project`、`.chat`、`.model`、`.history`、`.log`、`.sh`、`.send`、`.access` 团队权限控制及自然语言管家调度。
  - `.p`（设备 → 项目）、`.m`（随当前项目设备自动对齐厂家 → 模型）、`.c`（全量顶层会话）、`.send`（项目文件）全面支持二级编号联动、完整分页（`p2`…）、关键词搜索（`? <词>`）与飞书卡片按钮点选，彻底消除移动端信息截断。
  - 支持手机端直接发现远程非 Git 目录与未打开的外部 CLI 会话，并支持手机与远程 SSH 服务器双向互传文件。
- **🔌 多引擎本地 CLI 深度双向同步与 `/compact` 压缩**：
  - 全面强化 `Antigravity (agy)`、`OpenAI Codex (codex)`、`Claude Code (claude)` 与 `DeepSeek Harness (dsh)`（含 v4 Zstandard 压缩存储）的历史按需加载、跨模型上下文桥接、终端续聊实时同步及会话压缩（`/compact`）。
- **🌐 多厂商云端模型与多模态能力升级**：
  - 扩展多供应商协议兼容路由（OpenAI `/v1/responses`、Chat Completions、Anthropic `/v1/messages`、Gemini 等），修复压缩 SSE 流偶发挂起问题。
  - 支持图片、音频、视频与 Office 文档等多模态输入路由与模型能力自动匹配。
- **🖥️ 任意 SSH 服务器自动部署与离线中转升级**：
  - 支持密码（Askpass）与密钥登录任意 Linux / AutoDL 服务器；远端无法直连 GitHub 时自动由本机下载并流式中转安装，支持按安装包 SHA-256 哈希自动升级远端服务与识别 `nvm` 环境下的 CLI。
- **🪶 全平台安装包大幅瘦身**：
  - 去除桌面端构建包内重复 CLI 二进制与前端 SourceMap，macOS 安装包缩减约 `80 MB`，Windows 便携包缩减约 `200 MB`。

---

## v0.0.1 (2026-11-09)

### 🎉 Pigu 首个预览版本发布

- **一端统管本地全生态 AI 编程 CLI**：
  - 零配置自动识别并集成 `Claude Code (claude)`、`OpenAI Codex (codex)`、`OpenCode (opencode)`、`DeepSeek Harness (dsh)`、`Antigravity (agy)`、`Gemini CLI`、`GitHub Copilot`、`Cursor Agent` 与 `Aider`。
  - 全平台（macOS / Windows / Linux）深度识别各客户端真实在用模型，支持直接发现并接管本机及远端 CLI 会话。
- **同一会话跨引擎丝滑切换（Multi-Engine Model Relay）**：
  - 支持在同一会话中自由切换云端 API（如 `PiguToken`）与本地 CLI 智能体，内置跨引擎上下文自动桥接。
- **满血兼容 DeepSeek Harness (`dsh`) 与「大肥鱼」生态**：
  - 零配置自动识别并同步 `~/.dsh` 下的第三方扩展（`dsh-dafeiyu` 与 `dsh-persona-dafeiyu`）。
- **SSH 远程算力直连与开箱即用 PiguToken**：
  - 内置 `PiguToken` 官方模型通道及全界面中英双语实时切换。
