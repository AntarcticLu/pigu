# 隐私政策 / Privacy Policy

**应用名称 / Application:** Pigu  
**发布者 / Publisher:** AntarcticaLu  
**生效与更新日期 / Last Updated:** 2026-11-17

---

## 中文说明（Chinese）

### 1. 概述
**Pigu**（由 **AntarcticaLu** 开发与发布）是一款本地优先的 AI 编程桌面工作台与远程开发辅助工具。我们高度重视您的隐私安全：**Pigu 不会收集、上传、存储、出售或向开发者共享您的任何个人身份信息（PII）、对话内容、代码仓库数据或使用遥测数据。**

### 2. 本地数据存储
您在使用 Pigu 过程中产生的所有配置与数据均**仅保存在您自己的本地设备中**（Windows 位于 `%APPDATA%\opencode` 与 `%LOCALAPPDATA%\opencode`；macOS / Linux 位于 `~/.config/opencode` 与 `~/.local/share/opencode`），包括但不限于：
- 您自行填写的模型供应商 API 密钥与访问凭证；
- 您自行配置的远程 SSH 服务器连接信息与聊天机器人凭证；
- 本地会话记录、项目路径索引与界面偏好设置。

开发者没有任何后台服务器用于收集或读取上述本地数据。您可以随时在本地目录或应用设置中查看、修改或彻底删除这些数据。

### 3. 网络访问说明
本应用声明联网权限（`internetClient`）仅用于在**您主动发起或配置**的情况下直接连接目标服务：
- 向您所选的第三方 AI 模型接口发送对话请求并接收响应；
- 连接您自行配置的 SSH 远程服务器或即时通讯机器人接口；
- 检查或获取公开的应用版本发布信息（对于通过 Microsoft Store 安装的版本，应用更新完全由 Microsoft Store 托管完成）。

上述由您自行接入的第三方服务各自受其对应的隐私政策约束，数据在您的设备与目标服务端之间直接传输，不会经过开发者的任何收集服务器。

### 4. 儿童隐私
本产品面向开发者与通用办公技术用户，不会收集任何年龄段用户（包括儿童）的个人信息。

### 5. 政策更新与联系方式
如本隐私政策发生变更，我们将在本页面同步更新并标注最新修订日期。若您对本隐私政策有任何疑问或建议，请通过 GitHub 仓库与我们联系：
- https://github.com/AntarcticLu/pigu/issues

---

## English Version

### 1. Overview
**Pigu** (developed and published by **AntarcticaLu**) is a local-first AI coding desktop workbench and remote development assistant. We take your privacy seriously: **Pigu does not collect, transmit to the publisher, store on publisher servers, sell, or share any personally identifiable information (PII), source code, conversation contents, or usage telemetry.**

### 2. Local Data Storage
All configurations and user data created while using Pigu are stored **strictly locally on your own device** (`%APPDATA%\opencode` and `%LOCALAPPDATA%\opencode` on Windows; `~/.config/opencode` and `~/.local/share/opencode` on macOS and Linux), including:
- API keys and credentials for AI model providers that you configure;
- SSH server connection settings and messaging bot credentials that you configure;
- Local session history, workspace preferences, and UI settings.

AntarcticaLu operates no telemetry or data-collection servers that access this local data. You may inspect, modify, or permanently delete these files from your device at any time.

### 3. Network Access (`internetClient`)
Network capabilities declared by Pigu are used solely to perform direct, user-initiated connections to endpoints configured by you:
- Sending prompts to and receiving responses directly from the AI model provider APIs you configure;
- Connecting directly to SSH servers or messaging bot APIs you configure;
- Checking public release information on GitHub (when installed via Microsoft Store, application updates are managed directly by Microsoft Store).

Any third-party services you choose to connect to are governed by their own respective privacy policies. Your data travels directly between your device and your configured endpoints without passing through any publisher data-collection service.

### 4. Children's Privacy
Pigu does not collect personal information from anyone, including children under the age of 13.

### 5. Changes & Contact Us
Any updates to this Privacy Policy will be posted at this URL with an updated revision date. If you have any questions regarding privacy, please contact us via GitHub Issues:
- https://github.com/AntarcticLu/pigu/issues
