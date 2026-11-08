# Contributing to Pigu (屁股)

感谢关注并为 **Pigu** 贡献代码！

## 开发环境要求

Pigu 需要 **Bun 1.3+**。在仓库根目录执行：

```bash
# 安装依赖
bun install

# 启动 Pigu 桌面端开发环境
bun run dev:desktop

# 启动 Pigu CLI
bun run pigu
```

## 核心包结构

- `packages/schema`: 共享协议与存储 Schema 定义
- `packages/core`: 核心运行时、多引擎本地 CLI 调度（Claude Code / Codex / OpenCode / DeepSeek Harness & 大肥鱼 / Antigravity 等）与会话持久化
- `packages/protocol`: 公共 API 定义
- `packages/server`: 本地与远程 HTTP / WebSocket 服务端
- `packages/client`: 自动生成的 TypeScript 客户端 SDK
- `packages/cli`: `pigu` 命令行入口与后台服务管理
- `packages/app`: 桌面端与 Web 端共享前端界面
- `packages/desktop`: Electron 原生桌面端与 SSH 远程连接管理
- `packages/plugin`: 插件扩展接口

## 代码检查与测试

提交前请在受影响的包目录下运行类型检查和单元测试：

```bash
cd packages/core
bun typecheck
bun run test
```

或者在根目录运行完整检查：

```bash
bun run check
```

## 提交规范 (Commits & PRs)

请使用 Conventional Commits 格式：`type(scope): summary`，支持的 `type` 包括 `feat`、`fix`、`docs`、`chore`、`refactor` 和 `test`。
