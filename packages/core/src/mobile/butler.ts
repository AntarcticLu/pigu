import { Option, Schema } from "effect"

export const MobileButlerActionType = Schema.Literals([
  "switch_project",
  "open_project",
  "switch_session",
  "new_session",
  "switch_model",
  "send_file",
])
export type MobileButlerActionType = typeof MobileButlerActionType.Type

export const MobileButlerActionSchema = Schema.Struct({
  type: MobileButlerActionType,
  target: Schema.optional(Schema.String),
  effort: Schema.optional(Schema.String),
  followUpPrompt: Schema.optional(Schema.String),
})
export type MobileButlerAction = typeof MobileButlerActionSchema.Type

const decodeMobileButlerAction = Schema.decodeUnknownOption(Schema.fromJsonString(MobileButlerActionSchema))

const ACTION_TAG_GLOBAL_RE = /<pigu-mobile-action>\s*([\s\S]*?)\s*<\/pigu-mobile-action>/gi

const mobileTurnContexts = new Map<string, string>()

export function setMobileTurnContext(sessionID: string, systemPrompt: string): void {
  mobileTurnContexts.set(sessionID, systemPrompt)
}

export function clearMobileTurnContext(sessionID: string): void {
  mobileTurnContexts.delete(sessionID)
}

export function getMobileTurnContext(sessionID: string): string | undefined {
  return mobileTurnContexts.get(sessionID)
}

export function extractMobileButlerActions(rawText: string): {
  readonly cleanText: string
  readonly actions: readonly MobileButlerAction[]
} {
  if (!rawText.includes("<pigu-mobile-action>")) {
    return { cleanText: rawText.trim(), actions: [] }
  }
  const actions: MobileButlerAction[] = []
  const stripped = rawText.replace(ACTION_TAG_GLOBAL_RE, (_full, jsonBody: string) => {
    const parsed = Option.getOrUndefined(decodeMobileButlerAction(jsonBody.trim()))
    if (parsed) {
      actions.push(parsed)
    }
    return ""
  })
  return {
    cleanText: stripped.replace(/\n{3,}/g, "\n\n").trim(),
    actions,
  }
}

export interface MobileButlerSnapshot {
  readonly platform: string
  readonly currentProject: {
    readonly name: string
    readonly serverLabel: string
    readonly directory: string
  }
  readonly currentSession: {
    readonly id: string
    readonly title: string
  }
  readonly currentModel: string
  readonly projects: readonly {
    readonly index: number
    readonly name: string
    readonly serverLabel: string
    readonly directory: string
    readonly isCurrent: boolean
  }[]
  readonly sessions: readonly {
    readonly index: number
    readonly id: string
    readonly title: string
    readonly modelLabel: string
    readonly isCurrent: boolean
  }[]
  readonly sampleModels: readonly string[]
}

export function buildMobileButlerSystemPrompt(snapshot: MobileButlerSnapshot): string {
  const projectLines =
    snapshot.projects.length > 0
      ? snapshot.projects
          .map(
            (p) =>
              `  - #${p.index} ${p.name} (${p.serverLabel})${p.isCurrent ? " [当前]" : ""} — ${p.directory}`,
          )
          .join("\n")
      : "  - (暂无项目)"

  const sessionLines =
    snapshot.sessions.length > 0
      ? snapshot.sessions
          .map(
            (s) =>
              `  - #${s.index} ${s.title}${s.isCurrent ? " [当前]" : ""} (${s.modelLabel})`,
          )
          .join("\n")
      : "  - (暂无会话)"

  const modelHint =
    snapshot.sampleModels.length > 0
      ? snapshot.sampleModels.slice(0, 12).join(", ")
      : "按当前已连接的提供商模型"

  return [
    "# Pigu 手机端智能管家上下文",
    `用户当前正在通过手机端（${snapshot.platform}）与你对话。`,
    `- 当前绑定项目：${snapshot.currentProject.name} (${snapshot.currentProject.serverLabel}) — \`${snapshot.currentProject.directory}\``,
    `- 当前绑定会话：${snapshot.currentSession.title} (\`${snapshot.currentSession.id.slice(0, 12)}\`)`,
    `- 当前对话模型：${snapshot.currentModel}`,
    "",
    "## 可切换的项目列表",
    projectLines,
    "",
    "## 当前项目下的会话列表",
    sessionLines,
    "",
    `## 部分可用模型示例：${modelHint}`,
    "",
    "## 自然语言切换项目 / 会话 / 模型与发送文件规则",
    "1. 如果用户只是正常聊天、写代码、提问，或者询问「现在有哪些项目/会话/模型」，请直接自然回答，**绝对不要**输出任何 `<pigu-mobile-action>` 标签。",
    "2. 当用户明确要求**切换项目**、**打开新目录**、**切换会话**、**新建会话**或**更换模型/推理强度**时：",
    "   - 先用简短自然的中文回复用户（例如「好的，正在为你切换到 pigu 项目。」），不要在当前错误的目录里提前执行文件工具；",
    "   - 在回复的最末尾追加动作标签（系统会自动隐藏该标签并真正完成切换）：",
    '     `<pigu-mobile-action>{"type":"动作类型","target":"目标编号或名称","followUpPrompt":"可选的后续任务"}</pigu-mobile-action>`',
    "3. 当用户要求**把电脑上的图片、截图或文件发送到手机**（例如「把 package.json 发给我」「帮我画张架构图发到手机上」「把刚才生成的报告发我」）时：",
    "   - 如果目标文件尚不存在或需要先查找路径，请先正常调用工具生成或定位该文件；",
    "   - 然后在最终回复的末尾追加文件投递标签（支持同时追加多个标签发送多个文件）：",
    '     `<pigu-mobile-action>{"type":"send_file","target":"相对项目目录的文件路径或绝对路径"}</pigu-mobile-action>`',
    "4. 支持的 `type`：",
    '   - `"switch_project"`：`target` 优先填项目名称（如 `"pigu"`）或编号（如 `"1"`）',
    '   - `"open_project"`：`target` 填目录路径（如 `"~/code/my-app"`）',
    '   - `"switch_session"`：`target` 优先填会话标题或当前项目下的会话编号（如 `"2"`）',
    '   - `"new_session"`：`target` 填新会话标题（无标题可传 `""`）',
    '   - `"switch_model"`：`target` 填模型名或 `provider/model`（如 `"gemini-3-flash"`），可选 `"effort": "low"|"medium"|"high"|"max"|"default"`',
    '   - `"send_file"`：`target` 填要发到用户手机上的图片或文件路径（如 `"README.md"` 或 `"/tmp/screenshot.png"`）',
    "5. 复合指令接力（`followUpPrompt`）：如果用户在一句话里既要求切换又要求在新环境做事（例如「帮我切到 pigu 项目把 package.json 发给我」或「新建一个会话帮我写个贪吃蛇」），请把后续要做的请求原样放进 `followUpPrompt` 字段，系统切换完成后会立即在新会话中自动执行它。",
    "6. 交互式需求问答（`question` 工具）：手机端已完整支持 `question` 工具并会主动弹窗通知用户手机。当需求存在关键歧义、或需要在多个方案中由用户拍板时，可直接调用 `question` 工具列出清晰选项（把最推荐项放在第一个并标注 `(Recommended)`），用户点选或回复后会自动恢复你的执行。",
  ].join("\n")
}
