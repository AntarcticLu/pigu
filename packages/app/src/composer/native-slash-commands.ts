export type LocalCliEngineKind =
  | "claude"
  | "codex"
  | "agy"
  | "pi"
  | "opencode"
  | "cursor"
  | "grok"
  | "deepseek-harness"
  | "workbuddy"

export type NativeEngineSlashItem = {
  readonly trigger: string
  readonly title: string
  readonly description: string
}

export function resolveLocalCliEngine(
  selection: { readonly providerID: string; readonly modelID: string } | undefined,
): LocalCliEngineKind | undefined {
  if (!selection || selection.providerID !== "local") return undefined
  const slashIndex = selection.modelID.indexOf("/")
  const base = slashIndex >= 0 ? selection.modelID.slice(0, slashIndex) : selection.modelID

  if (base === "codex" || base === "codex-native") return "codex"
  if (base === "agy" || base === "agy-native") return "agy"
  if (base === "pi" || base === "pi-native") return "pi"
  if (base === "opencode" || base === "opencode-native") return "opencode"
  if (base === "cursor" || base === "cursor-agent" || base === "cursor-native") return "cursor"
  if (base === "grok" || base === "grok-cli" || base === "grok-native") return "grok"
  if (base === "deepseek-harness" || base === "dsh") return "deepseek-harness"
  if (base === "workbuddy" || base === "codebuddy") return "workbuddy"
  return "claude"
}

export function nativeCommandBadge(
  engine: LocalCliEngineKind | undefined,
  trigger: string,
  locale: string,
): string | undefined {
  if (!engine) return undefined
  const isZh = locale.toLowerCase().startsWith("zh")

  if (engine === "agy" && (trigger === "compact" || trigger === "goal")) {
    return isZh ? "Antigravity 原生" : "Antigravity native"
  }

  if (
    engine === "claude" &&
    (trigger === "compact" || trigger === "review" || trigger === "init" || trigger === "goal")
  ) {
    return isZh ? "Claude 原生" : "Claude native"
  }

  if (engine === "codex" && (trigger === "compact" || trigger === "review")) {
    return isZh ? "Codex 原生" : "Codex native"
  }

  if (engine === "opencode" && (trigger === "review" || trigger === "init")) {
    return isZh ? "OpenCode 原生" : "OpenCode native"
  }

  return undefined
}

export function nativeEngineSlashItems(
  engine: LocalCliEngineKind | undefined,
  locale: string,
): readonly NativeEngineSlashItem[] {
  if (!engine) return []
  const isZh = locale.toLowerCase().startsWith("zh")

  if (engine === "agy") {
    return [
      {
        trigger: "boost",
        title: "boost",
        description: isZh
          ? "深度思考、多视角战略规划与严格验证 (Antigravity 原生)"
          : "Deep thinking, multi-perspective planning, and verification (Antigravity native)",
      },
      {
        trigger: "plan",
        title: "plan",
        description: isZh
          ? "先生成结构化分步实施计划再执行 (Antigravity 原生)"
          : "Create a step-by-step plan before execution (Antigravity native)",
      },
      {
        trigger: "grill-me",
        title: "grill-me",
        description: isZh
          ? "通过交互式追问对齐架构与设计决策 (Antigravity 原生)"
          : "Interactive interview to align on design decisions (Antigravity native)",
      },
      {
        trigger: "teamwork",
        title: "teamwork",
        description: isZh
          ? "组建多智能体团队并行协作推进复杂项目 (Antigravity 原生)"
          : "Spawn a team of autonomous agents working in parallel (Antigravity native)",
      },
      {
        trigger: "browser",
        title: "browser",
        description: isZh
          ? "委派内置浏览器子代理访问与操作网页应用 (Antigravity 原生)"
          : "Delegate web browsing and UI interaction to browser subagent (Antigravity native)",
      },
      {
        trigger: "learn",
        title: "learn",
        description: isZh
          ? "将本次经验或偏好沉淀为持久化技能规则 (Antigravity 原生)"
          : "Persist learned conventions or workflows for future tasks (Antigravity native)",
      },
      {
        trigger: "schedule",
        title: "schedule",
        description: isZh
          ? "创建定时触发或周期性执行的任务指令 (Antigravity 原生)"
          : "Run an instruction on a recurring schedule or timer (Antigravity native)",
      },
    ]
  }

  if (engine === "claude") {
    return [
      {
        trigger: "security-review",
        title: "security-review",
        description: isZh
          ? "对当前分支代码变更执行专项安全审查 (Claude 原生)"
          : "Run a dedicated security review of current changes (Claude native)",
      },
      {
        trigger: "simplify",
        title: "simplify",
        description: isZh
          ? "审查并精简近期代码改动，提升复用与可读性 (Claude 原生)"
          : "Review changed code for reuse, quality, and simplicity (Claude native)",
      },
      {
        trigger: "deep-research",
        title: "deep-research",
        description: isZh
          ? "对代码库与技术方案开展深度调研 (Claude 原生)"
          : "Conduct in-depth technical and codebase research (Claude native)",
      },
      {
        trigger: "debug",
        title: "debug",
        description: isZh
          ? "系统化定位与排查复杂故障 (Claude 原生)"
          : "Systematically investigate and debug issues (Claude native)",
      },
      {
        trigger: "verify",
        title: "verify",
        description: isZh
          ? "端到端运行检查与测试验证修改正确性 (Claude 原生)"
          : "Verify changes end-to-end with checks and tests (Claude native)",
      },
      {
        trigger: "loop",
        title: "loop",
        description: isZh
          ? "按间隔循环执行巡检或跟进指令 (Claude 原生)"
          : "Run a prompt or slash command on a recurring interval (Claude native)",
      },
      {
        trigger: "insights",
        title: "insights",
        description: isZh
          ? "生成当前工作区会话与工程效率洞察报告 (Claude 原生)"
          : "Analyze sessions and generate workflow insights (Claude native)",
      },
    ]
  }

  return []
}
