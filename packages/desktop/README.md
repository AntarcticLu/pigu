# Pigu Desktop

The **Pigu** Desktop app, built with Electron.

## Highlights

- **Multi-Engine AI Coding Hub**: Unified interface for local CLI agents (`claude`, `codex`, `opencode`, `dsh`, `agy`, `gemini`, `cursor`, `aider`) and cloud API providers (`PiguToken`, custom OpenAI/Anthropic/Gemini endpoints).
- **In-Session Model Relay**: Switch between API models and local CLI agents mid-conversation with automatic inline context bridging.
- **Zero-Config DeepSeek Harness (`dsh`) & BigFish (`dsh-dafeiyu`) Integration**: Automatically discovers third-party DSH plugins, drives the native desktop companion pet, and lets you swap any model into DSH.
- **Remote SSH Workspaces**: Connect to AutoDL or remote Linux servers over SSH with automatic remote `pigu` service bootstrapping and cloud provider credential sync.

## Development

```bash
bun install
bun dev
```

## Build & Package

```bash
bun run build && bun run pack
```
