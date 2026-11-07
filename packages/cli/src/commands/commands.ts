import { Argument, Flag, GlobalFlag } from "effect/cli"
import { Schema } from "effect"
import { CliFlag } from "../framework/flag"
import { Spec } from "../framework/spec"
import { Updater } from "../services/updater"

export const PrintLogs = GlobalFlag.Setting("print-logs")({
  flag: Flag.Boolean("print-logs").pipe(
    Flag.withDescription("将日志输出到 stderr（服务端日志需搭配 --standalone）"),
    Flag.withDefault(false),
  ),
})

export const Standalone = GlobalFlag.Setting("standalone")({
  flag: Flag.Boolean("standalone").pipe(
    Flag.withDescription("使用独立内嵌服务运行，不连接后台服务"),
    Flag.withDefault(false),
  ),
})

export const Server = GlobalFlag.Setting("server")({
  flag: Flag.String("server").pipe(
    Flag.withDescription("连接到指定的服务端 URL，而非本地后台服务"),
    Flag.optional,
  ),
})

const ServerFlags = [Standalone, Server] as const

declare const OPENCODE_CLI_NAME: string | undefined

const ServerParams = {
  standalone: Standalone.flag,
  server: Server.flag,
}

const PermissionParams = {
  auto: Flag.Boolean("auto").pipe(
    Flag.withDescription("自动批准未显式拒绝的工具权限请求"),
    Flag.withDefault(false),
  ),
  yolo: Flag.Boolean("yolo").pipe(Flag.withDefault(false), Flag.withHidden),
  dangerouslySkipPermissions: Flag.Boolean("dangerously-skip-permissions").pipe(
    Flag.withDefault(false),
    Flag.withHidden,
  ),
}

const Root = Spec.make(typeof OPENCODE_CLI_NAME === "string" ? OPENCODE_CLI_NAME : "pigu", {
  description: "Pigu 命令行与终端交互界面",
  params: {
    ...ServerParams,
    ...PermissionParams,
    directory: Argument.String("directory").pipe(
      Argument.withDescription("启动 Pigu 的工作目录"),
      Argument.optional,
    ),
    continue: Flag.Boolean("continue").pipe(
      Flag.withAlias("c"),
      Flag.withDescription("继续上一次会话"),
      Flag.withDefault(false),
    ),
    session: Flag.String("session").pipe(
      Flag.withAlias("s"),
      Flag.withDescription("继续指定 ID 的会话（若不存在则新建）"),
      Flag.optional,
    ),
    prompt: Flag.String("prompt").pipe(Flag.withDescription("启动后自动发送的提示词"), Flag.optional),
  },
  commands: [
    Spec.make("upgrade", {
      hidden: true,
      description: "Upgrade Pigu to the latest or a specific version",
      aliases: ["update"],
      params: {
        target: Argument.String("target").pipe(
          Argument.withDescription("Version to upgrade to (with or without a leading v)"),
          Argument.optional,
        ),
        method: Flag.Literals("method", Updater.methods).pipe(
          Flag.withAlias("m"),
          Flag.withDescription("Installation method to use"),
          Flag.optional,
        ),
      },
    }),
    Spec.make("uninstall", {
      hidden: true,
      description: "Uninstall Pigu, keeping session data, configuration, and state",
      params: {
        dryRun: Flag.Boolean("dry-run").pipe(
          Flag.withDescription("Show what would be removed without removing"),
          Flag.withDefault(false),
        ),
        force: Flag.Boolean("force").pipe(
          Flag.withAlias("f"),
          Flag.withDescription("Skip confirmation prompts"),
          Flag.withDefault(false),
        ),
      },
    }),
    Spec.make("acp", {
      hidden: true,
      description: "Start an Agent Client Protocol server",
      params: {
        login: Flag.Boolean("login").pipe(
          Flag.withDescription("Run auth login instead of starting the server"),
          Flag.withDefault(false),
        ),
      },
    }),
    Spec.make("api", {
      hidden: true,
      description: "Make a request to the running server",
      globalFlags: ServerFlags,
      params: {
        request: Argument.String("operation | method path").pipe(
          Argument.withDescription("OpenAPI operation ID, or an HTTP method followed by a path"),
          Argument.variadic({ min: 1, max: 2 }),
        ),
        data: Flag.String("data").pipe(Flag.withAlias("d"), Flag.withDescription("Request body"), Flag.optional),
        header: Flag.String("header").pipe(
          Flag.withAlias("H"),
          Flag.withDescription("Request header in name:value form"),
          Flag.atMost(100),
        ),
        param: Flag.KeyValuePair("param").pipe(Flag.withDescription("OpenAPI path or query parameter"), Flag.optional),
      },
    }),
    Spec.make("debug", {
      hidden: true,
      description: "Debugging and troubleshooting tools",
      commands: [
        Spec.make("agents", { description: "List all agents", globalFlags: ServerFlags }),
        Spec.make("config", { description: "List configuration sources", globalFlags: ServerFlags }),
        Spec.make("heap-dump", {
          description: "Write a heap snapshot of the running server and print its path",
          globalFlags: [Server],
          params: {
            directory: Flag.String("directory").pipe(
              Flag.withDescription("Directory to write the snapshot into instead of the server's log directory"),
              Flag.optional,
            ),
          },
        }),
        Spec.make("paths", {
          description: "Show global paths (data, config, cache, state)",
          params: {
            name: Argument.Literals("name", [
              "db",
              "home",
              "data",
              "config",
              "cache",
              "state",
              "tmp",
              "bin",
              "log",
              "repos",
            ]).pipe(
              Argument.withDescription(
                "Print only one path: db, home, data, config, cache, state, tmp, bin, log, repos",
              ),
              Argument.optional,
            ),
          },
        }),
      ],
    }),
    Spec.make("auth", {
      hidden: true,
      description: "manage integrations and credentials",
      globalFlags: ServerFlags,
      commands: [
        Spec.make("list", {
          description: "list integrations and credentials",
          params: {
            format: Flag.Literals("format", ["default", "json"]).pipe(
              Flag.withDescription("Output format"),
              Flag.withDefault("default"),
            ),
          },
        }),
        Spec.make("login", {
          description: "connect an integration",
          params: {
            target: Argument.String("target").pipe(
              Argument.withDescription("Integration ID, name, or well-known provider URL"),
              Argument.optional,
            ),
            url: Flag.String("url").pipe(
              Flag.withDescription("API Base URL (e.g. https://api.openai.com/v1)"),
              Flag.optional,
            ),
            key: Flag.String("key").pipe(Flag.withDescription("API key"), Flag.optional),
            method: Flag.String("method").pipe(Flag.withDescription("Authentication method ID"), Flag.optional),
            answer: Flag.String("answer").pipe(
              Flag.withDescription("Provider form answer (key=value; repeat for multiple fields)"),
              Flag.atMost(100),
            ),
          },
        }),
        Spec.make("logout", {
          description: "log out of a saved account",
          params: {
            target: Argument.String("target").pipe(
              Argument.withDescription("Integration ID or name"),
              Argument.optional,
            ),
            credential: Argument.String("credential").pipe(
              Argument.withDescription("Credential ID or label (opens an account picker when omitted)"),
              Argument.optional,
            ),
          },
        }),
        Spec.make("export", {
          description: "print stored credentials, including secrets, as JSON",
          params: {
            target: Argument.String("target").pipe(
              Argument.withDescription("Integration ID or name (exports every integration when omitted)"),
              Argument.optional,
            ),
          },
        }),
        Spec.make("import", {
          description: "import credentials exported by auth export",
          params: {
            file: Argument.String("file").pipe(
              Argument.withDescription("JSON file to import (reads stdin when omitted)"),
              Argument.optional,
            ),
          },
        }),
        Spec.make("switch", {
          description: "switch the active account for an integration",
          params: {
            target: Argument.String("target").pipe(
              Argument.withDescription("Integration ID or name"),
              Argument.optional,
            ),
            credential: Argument.String("credential").pipe(
              Argument.withDescription("Credential ID or label (opens an account picker when omitted)"),
              Argument.optional,
            ),
          },
        }),
      ],
    }),
    Spec.make("mcp", {
      description: "管理 MCP（模型上下文协议）服务器",
      commands: [
        Spec.make("list", {
          description: "列出已配置的 MCP 服务器及其连接状态",
          globalFlags: ServerFlags,
        }),
        Spec.make("add", {
          description: "向配置中添加 MCP 服务器",
          params: {
            name: Argument.String("name").pipe(Argument.withDescription("MCP 服务器名称")),
            command: Argument.String("command").pipe(
              Argument.withDescription("本地 MCP 服务器的启动命令与参数（在 -- 之后传入）"),
              Argument.variadic({ min: 0 }),
            ),
            url: Flag.String("url").pipe(Flag.withDescription("远程 MCP 服务器的 URL"), Flag.optional),
            header: Flag.KeyValuePair("header").pipe(
              Flag.withDescription("远程服务器的 HTTP 请求头（格式：name=value）"),
              Flag.optional,
            ),
            env: Flag.KeyValuePair("env").pipe(
              Flag.withDescription("本地服务器的环境变量（格式：name=value）"),
              Flag.optional,
            ),
            global: Flag.Boolean("global").pipe(
              Flag.withDescription("写入全局配置而非当前项目配置"),
              Flag.withDefault(false),
            ),
          },
        }),
        Spec.make("auth", {
          hidden: true,
          description: "Authenticate with an OAuth-capable remote MCP server",
          globalFlags: ServerFlags,
          params: {
            name: Argument.String("name").pipe(Argument.withDescription("Name of the MCP server"), Argument.optional),
          },
        }),
        Spec.make("logout", {
          hidden: true,
          description: "Remove stored OAuth credentials for an MCP server",
          globalFlags: ServerFlags,
          params: { name: Argument.String("name").pipe(Argument.withDescription("Name of the MCP server")) },
        }),
      ],
    }),
    Spec.make("plugin", {
      description: "管理拓展插件",
      commands: [
        Spec.make("list", {
          description: "列出已安装的插件",
          globalFlags: ServerFlags,
          params: {
            builtin: Flag.Boolean("builtin").pipe(
              Flag.withDescription("包含内置服务端插件"),
              Flag.withDefault(false),
            ),
          },
        }),
        Spec.make("add", {
          description: "安装插件并添加到全局配置",
          params: {
            package: Argument.String("package").pipe(Argument.withDescription("npm 包名或 Git 仓库地址")),
          },
        }),
        Spec.make("check", {
          hidden: true,
          description: "Check package plugins for updates",
          globalFlags: ServerFlags,
          params: {
            target: Argument.String("target").pipe(
              Argument.withDescription("Configured package target"),
              Argument.optional,
            ),
          },
        }),
        Spec.make("update", {
          hidden: true,
          description: "Update package plugins",
          globalFlags: ServerFlags,
          params: {
            target: Argument.String("target").pipe(
              Argument.withDescription("Configured package target; omit to update all outdated plugins"),
              Argument.optional,
            ),
          },
        }),
        Spec.make("remove", {
          description: "从全局配置中移除插件",
          params: {
            package: Argument.String("package").pipe(Argument.withDescription("已配置的插件包名")),
          },
        }),
      ],
    }),
    Spec.make("config", {
      description: "配置自定义 API 地址（Base URL）与 API Key",
      globalFlags: ServerFlags,
      params: {
        url: Flag.String("url").pipe(
          Flag.withDescription("API Base URL（例如 https://api.openai.com/v1）"),
          Flag.optional,
        ),
        key: Flag.String("key").pipe(Flag.withDescription("API 密钥（API Key）"), Flag.optional),
      },
    }),
    Spec.make("models", {
      description: "列出所有可用模型",
      globalFlags: ServerFlags,
    }),
    Spec.make("stats", {
      hidden: true,
      description: "Show shareable usage statistics",
      globalFlags: ServerFlags,
      params: {
        days: Flag.Int("days").pipe(
          Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
          Flag.withDescription("Show the last N days; 0 means today"),
          Flag.optional,
        ),
        year: Flag.Int("year").pipe(
          Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1970, maximum: 9_999 }))),
          Flag.withDescription("Show a calendar year"),
          Flag.optional,
        ),
        all: Flag.Boolean("all").pipe(Flag.withDescription("Show lifetime statistics"), Flag.withDefault(false)),
        project: Flag.String("project").pipe(
          Flag.withDescription('Filter by project ID, or use "." for the current project'),
          Flag.optional,
        ),
        models: Flag.Boolean("models").pipe(Flag.withDescription("Show model usage"), Flag.withDefault(false)),
        tools: Flag.Boolean("tools").pipe(Flag.withDescription("Show tool reliability"), Flag.withDefault(false)),
        cost: Flag.Boolean("cost").pipe(Flag.withDescription("Show cost and token details"), Flag.withDefault(false)),
        full: Flag.Boolean("full").pipe(Flag.withDescription("Show every detailed section"), Flag.withDefault(false)),
        limit: Flag.Int("limit").pipe(
          Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
          Flag.withDescription("Number of rows in detailed sections"),
          Flag.withDefault(5),
        ),
        json: Flag.Boolean("json").pipe(Flag.withDescription("Output statistics as JSON"), Flag.withDefault(false)),
      },
    }),
    Spec.make("mini", {
      hidden: true,
      description: "Start the minimal interactive interface",
      globalFlags: ServerFlags,
      params: {
        continue: Flag.Boolean("continue").pipe(
          Flag.withAlias("c"),
          Flag.withDescription("Continue the last session"),
          Flag.withDefault(false),
        ),
        session: Flag.String("session").pipe(
          Flag.withAlias("s"),
          Flag.withDescription("Session ID to continue, or to create if it does not exist"),
          Flag.optional,
        ),
        fork: Flag.Boolean("fork").pipe(
          Flag.withDescription("Fork the session when continuing"),
          Flag.withDefault(false),
        ),
        replay: Flag.Boolean("replay").pipe(
          Flag.withDescription("Restore session history on resume and resize (disable with --no-replay)"),
          Flag.optional,
        ),
        replayLimit: Flag.Int("replay-limit").pipe(
          Flag.withDescription("Limit replay to the newest N messages (default: 200)"),
          Flag.optional,
        ),
        model: Flag.String("model").pipe(
          Flag.withAlias("m"),
          Flag.withDescription("Model to use in the format provider/model"),
          Flag.optional,
        ),
        agent: Flag.String("agent").pipe(Flag.withDescription("Agent to use"), Flag.optional),
        prompt: Flag.String("prompt").pipe(Flag.withDescription("Prompt to use"), Flag.optional),
        demo: Flag.Boolean("demo").pipe(Flag.withDefault(false), Flag.withHidden),
      },
    }),
    Spec.make("run", {
      description: "单次发送消息并运行 Pigu",
      globalFlags: ServerFlags,
      params: {
        message: Argument.String("message").pipe(
          Argument.withDescription("要发送的消息内容"),
          Argument.variadic({ min: 0 }),
        ),
        continue: Flag.Boolean("continue").pipe(
          Flag.withAlias("c"),
          Flag.withDescription("继续上一次会话"),
          Flag.withDefault(false),
        ),
        session: Flag.String("session").pipe(
          Flag.withAlias("s"),
          Flag.withDescription("继续或创建指定 ID 的会话"),
          Flag.optional,
        ),
        fork: Flag.Boolean("fork").pipe(
          Flag.withDescription("继续前派生（Fork）该会话"),
          Flag.withDefault(false),
        ),
        worktree: CliFlag.optionalValue("worktree", "name").pipe(
          Flag.withAlias("w"),
          Flag.withDescription("在新的 Git Worktree 中启动会话"),
        ),
        model: Flag.String("model").pipe(
          Flag.withAlias("m"),
          Flag.withDescription("指定使用的模型（格式：provider/model#variant）"),
          Flag.optional,
        ),
        agent: Flag.String("agent").pipe(Flag.withDescription("指定使用的智能体"), Flag.optional),
        format: Flag.Literals("format", ["default", "json"]).pipe(
          Flag.withDescription("输出格式"),
          Flag.withDefault("default"),
        ),
        file: Flag.String("file").pipe(
          Flag.withAlias("f"),
          Flag.withDescription("附加到消息中的文件"),
          Flag.atMost(100),
        ),
        title: Flag.String("title").pipe(Flag.withDescription("会话标题"), Flag.optional),
        archived: Flag.Boolean("archived").pipe(
          Flag.withDescription("创建后自动归档会话"),
          Flag.withDefault(false),
        ),
        thinking: Flag.Boolean("thinking").pipe(Flag.withDescription("显示思考过程"), Flag.withDefault(false)),
        ...PermissionParams,
      },
    }),
    Spec.make("session", {
      description: "管理会话（列表、删除、导入、导出）",
      globalFlags: ServerFlags,
      commands: [
        Spec.make("list", {
          description: "列出当前项目的会话（按最新排序）",
          params: {
            maxCount: Flag.Int("max-count").pipe(
              Flag.withAlias("n"),
              Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
              Flag.withDescription("限制显示的最近会话数量（默认：100）"),
              Flag.optional,
            ),
            format: Flag.Literals("format", ["table", "json"]).pipe(
              Flag.withDescription("输出格式"),
              Flag.withDefault("table"),
            ),
          },
        }),
        Spec.make("delete", {
          description: "删除指定会话及其子会话",
          params: {
            sessionID: Argument.String("sessionID").pipe(Argument.withDescription("要删除的会话 ID")),
          },
        }),
        Spec.make("export", {
          description: "将会话数据导出为 JSON",
          params: {
            session: Argument.String("session").pipe(
              Argument.withDescription("要导出的会话 ID"),
              Argument.optional,
            ),
            sanitize: Flag.Boolean("sanitize").pipe(
              Flag.withDescription("脱敏对话与文件中的敏感数据"),
              Flag.withDefault(false),
            ),
          },
        }),
        Spec.make("import", {
          description: "从 JSON 文件或 URL 导入会话数据",
          params: {
            file: Argument.String("file").pipe(Argument.withDescription("要导入的 JSON 文件路径或 URL")),
            directory: Flag.String("directory").pipe(
              Flag.withDescription("导入会话所属的项目目录"),
              Flag.optional,
            ),
          },
        }),
      ],
    }),
    Spec.make("service", {
      description: "管理本地后台服务",
      commands: [
        Spec.make("start", { description: "启动后台服务" }),
        Spec.make("restart", { description: "重启后台服务" }),
        Spec.make("status", { description: "查看后台服务状态" }),
        Spec.make("stop", { description: "停止后台服务" }),
        Spec.make("get", {
          description: "读取后台服务配置项",
          params: {
            key: Argument.String("key").pipe(Argument.withDescription("服务配置项或环境变量"), Argument.optional),
            name: Argument.String("name").pipe(
              Argument.withDescription("环境变量名"),
              Argument.optional,
            ),
          },
        }),
        Spec.make("set", {
          description: "设置后台服务配置项",
          params: {
            key: Argument.String("key").pipe(Argument.withDescription("服务配置项或环境变量")),
            value: Argument.String("value").pipe(
              Argument.withDescription("配置值或环境变量名"),
            ),
            nestedValue: Argument.String("env-value").pipe(
              Argument.withDescription("环境变量值"),
              Argument.optional,
            ),
          },
        }),
        Spec.make("unset", {
          description: "重置后台服务配置项",
          params: {
            key: Argument.String("key").pipe(Argument.withDescription("服务配置项或环境变量")),
            name: Argument.String("name").pipe(
              Argument.withDescription("环境变量名"),
              Argument.optional,
            ),
          },
        }),
      ],
    }),
    Spec.make("reload", {
      hidden: true,
      description: "Reload configuration",
      globalFlags: ServerFlags,
    }),
    Spec.make("pair", {
      hidden: true,
      description: "Print one-time links to connect a browser or app",
      params: {
        url: Flag.String("url").pipe(
          Flag.withDescription("Use an external HTTP(S) server URL in pairing links"),
          Flag.mapTryCatch(
            (value) => {
              const url = new URL(value)
              if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
                throw new Error("Invalid pairing URL")
              return url.href.replace(/\/+$/, "")
            },
            () => "Expected an HTTP(S) server URL without credentials, query parameters, or a fragment",
          ),
          Flag.optional,
        ),
        remote: Flag.Boolean("remote").pipe(
          Flag.withDescription(
            "Pair through the OpenTunnel remote address, enabling remote access if needed (exposes the server to the internet)",
          ),
          Flag.withDefault(false),
        ),
        yes: Flag.Boolean("yes").pipe(
          Flag.withAlias("y"),
          Flag.withDescription(
            "Accept exposing the server to the internet when --remote enables remote access for the first time (required without an interactive terminal)",
          ),
          Flag.withDefault(false),
        ),
      },
    }),
    Spec.make("serve", {
      description: "启动 Pigu API 服务进程",
      params: {
        hostname: Flag.String("hostname").pipe(Flag.optional),
        port: Flag.Int("port").pipe(Flag.optional),
        cors: Flag.String("cors").pipe(
          Flag.withSchema(Schema.NonEmptyString),
          Flag.withDescription("额外允许的 CORS 源（可重复指定）"),
          Flag.atLeast(0),
        ),
        service: Flag.Boolean("service").pipe(Flag.withDefault(false)),
        stdio: Flag.Boolean("stdio").pipe(Flag.withDefault(false)),
      },
    }),
  ],
})

export const Commands = Root
