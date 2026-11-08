# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.0.x   | :white_check_mark: |

## Credential & Data Isolation

- **Pigu** stores all user API keys, OAuth tokens, SSH server configurations, and session history strictly in your local OS user directories (`~/.config/opencode` and `~/.local/share/opencode` on macOS/Linux, `%APPDATA%\opencode` and `%LOCALAPPDATA%\opencode` on Windows).
- Application packages and release builds never bundle user credentials or session databases.

## Reporting a Vulnerability

If you discover a security vulnerability in Pigu, please report it via [GitHub Security Advisories](https://github.com/AntarcticLu/pigu/security/advisories) or open a private issue on [GitHub](https://github.com/AntarcticLu/pigu/issues).
