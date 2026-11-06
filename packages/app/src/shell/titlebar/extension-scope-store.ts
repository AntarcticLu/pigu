import type { PermissionRule } from "@opencode/client/promise"
import { Schema } from "effect"
import { batch, createEffect, createMemo, createRoot, getOwner } from "solid-js"
import { Persistence } from "@/runtime/persistence/schema"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { useGlobal } from "@/runtime/server/runtime"
import { pathKey } from "@/workspaces/path-key"

export type ScopedSkillInfo = {
  id?: string
  name: string
  description?: string
  path: string
  content?: string
  fromIdeGlobal?: boolean
}

export type CustomMcpRecord = {
  name: string
  type: "local" | "remote"
  command?: string
  url?: string
  enabled: boolean
}

export type CustomPluginRecord = {
  id: string
  name: string
  target: string
  description?: string
  enabled: boolean
}

export type BuiltinLocalAgentPlugin = {
  id: string
  modelID: string
  name: string
  target: string
  description: string
}

export const BUILTIN_LOCAL_AGENT_PLUGINS: ReadonlyArray<BuiltinLocalAgentPlugin> = [
  {
    id: "local:claude",
    modelID: "claude",
    name: "claude (CLI)",
    target: "claude",
    description: "本地 Claude 订阅桥接（调用本机 claude 原生 CLI 工具与会话）",
  },
  {
    id: "local:codex",
    modelID: "codex",
    name: "codex (CLI)",
    target: "codex",
    description: "本地 Codex 订阅桥接（调用本机 codex 原生 CLI 工具与会话）",
  },
  {
    id: "local:agy",
    modelID: "agy",
    name: "agy (桌面端)",
    target: "/Applications/Antigravity.app",
    description: "本地 Antigravity (AGY) 桌面端与 CLI 原生桥接",
  },
  {
    id: "local:deepseek-harness",
    modelID: "deepseek-harness",
    name: "deepseek harness (桌面端)",
    target: "/Applications/DeepSeek Harness.app",
    description: "本地 DeepSeek Harness 桌面端原生运行环境桥接",
  },
  {
    id: "local:workbuddy",
    modelID: "workbuddy",
    name: "workbuddy (CLI)",
    target: "workbuddy",
    description: "本地 WorkBuddy 原生智能体工具桥接",
  },
]

export type CustomSkillRecord = {
  id: string
  name: string
  description: string
  content: string
  path: string
}

const CustomMcpSchema = Persistence.struct({
  name: Schema.String,
  type: Schema.Literals(["local", "remote"]),
  command: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  enabled: Schema.Boolean,
})

const CustomPluginSchema = Persistence.struct({
  id: Schema.String,
  name: Schema.String,
  target: Schema.String,
  description: Schema.optional(Schema.String),
  enabled: Schema.Boolean,
})

const CustomSkillSchema = Persistence.struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  content: Schema.String,
  path: Schema.String,
})

const ExtensionScopeState = Persistence.struct({
  globalSkills: Persistence.record(Schema.Boolean),
  projectSkills: Persistence.record(Persistence.record(Schema.Boolean)),
  projectMcps: Persistence.record(Persistence.record(Schema.Boolean)),
  sessionSkills: Persistence.record(Persistence.record(Schema.Boolean)),
  sessionMcps: Persistence.record(Persistence.record(Schema.Boolean)),
  customMcps: Schema.optional(Persistence.record(CustomMcpSchema)),
  removedMcps: Schema.optional(Persistence.record(Schema.Boolean)),
  customPlugins: Schema.optional(Persistence.record(CustomPluginSchema)),
  removedPlugins: Schema.optional(Persistence.record(Schema.Boolean)),
  customSkills: Schema.optional(Persistence.record(CustomSkillSchema)),
  removedSkills: Schema.optional(Persistence.record(Schema.Boolean)),
})

const ZH_SKILL_DESCRIPTIONS = new Map<string, string>([
  ["agy-customizations", "Antigravity 自定义体系指南：管理与创建 Skill、规则、插件、Hook 与 MCP 服务"],
  ["antigravity-guide", "Antigravity (AGY) 全面指南：涵盖 CLI、IDE、SDK、斜杠命令与快捷键参考"],
  ["automation", "定时与自动化任务向导：设计并创建周期性后台自动化工作流"],
  ["browser", "内置浏览器控制：打开网页、点击与填写表单、截图、检查控制台与网络日志"],
  ["generative_ui", "生成式交互界面：在对话中渲染可视化图表、交互控件与动态 HTML 组件"],
  ["imagegen", "AI 图像生成与编辑：生成或修改位图素材、插画、图标贴图与透明背景抠图"],
  ["migrate-workflows", "工作流迁移工具：将旧版工作流自动扫描并迁移为现代 SKILL.md 技能包"],
  ["openai-docs", "OpenAI 与 Codex 官方文档检索：查询模型定价、API、Responses、Agent 与 SDK 用法"],
  ["opencode", "Pigu / OpenCode 核心参考：架构说明、配置、插件开发、SDK、MCP 与客户端指南"],
  ["permissioned-github", "GitHub 权限与协作指南：在受限环境中规范调用 GitHub CLI 并按需申请权限"],
  ["plugin", "插件管理与打包工具：创建、安装、启用或停用包含技能、规则与 MCP 的插件包"],
  ["plugin-creator", "Codex 插件脚手架：生成插件目录结构、plugin.json 清单与本地插件市场配置"],
  ["report", "问题诊断与反馈：收集环境诊断信息并生成规范的 Issue 报告"],
  ["review-agent", "代码审查专家：对未提交变更、分支差异或指定提交执行只读的缺陷优先审查"],
  ["run-workflow", "多智能体工作流编排：编写并运行并行、流水线与分阶段的动态多 Agent 协作脚本"],
  ["skill-creator", "Skill 技能创建工具：编写或更新具备规范指令与附属资源的专属技能"],
  ["skill-installer", "Skill 技能安装器：从精选列表或 GitHub 仓库一键安装技能到本地目录"],
  ["ui-plugin-navigation", "UI 插件面板导航：在对话中提供快捷入口以打开或切换侧边栏插件面板"],
  ["app-e2e-tests", "桌面与 Web 端 E2E 测试规范：基于 Playwright 的端到端测试编写与防抖指南"],
  ["component-tests", "UI 组件测试规范：基于 Storybook 与 Playwright 的组件交互测试指南"],
  ["effect", "Effect TypeScript 架构规范：服务定义、Layer 依赖注入、Schema 与错误处理最佳实践"],
  ["opencode-dev", "本地开发与调试指南：运行桌面端、TUI 与服务端热重载调试流程"],
  ["rtl-aware-development", "双向文本与国际化布局规范：支持 RTL/LTR 自适应的样式与排版开发指南"],
  ["sample-skill", "示例技能模板：展示标准 SKILL.md 结构与指令编写方式"],
  ["tui-tests", "终端 TUI 渲染测试规范：基于 OpenTUI 的终端界面快照与按键测试指南"],
  ["unit-tests", "单元测试规范：基于 Bun Test 的非 Mock 真实实现测试指南"],
])

export function localizeSkillDescription(skill: { name: string; description?: string }, locale?: string) {
  const isZh = !locale || locale.toLowerCase().startsWith("zh")

  if (isZh) {
    const key = skill.name.trim().toLowerCase()
    const mapped = ZH_SKILL_DESCRIPTIONS.get(key)

    if (mapped) return mapped
  }

  return skill.description ?? ""
}

export function skillScopeKey(skill: ScopedSkillInfo) {
  return skill.id || `${skill.name}:${skill.path}`
}

export function mcpPermissionPrefix(serverName: string) {
  return serverName.replace(/[^a-zA-Z0-9_-]/g, "_").replaceAll(".", "_")
}

export function isProjectLocalSkill(skillPath: string, worktree?: string) {
  if (!worktree || !skillPath || skillPath.startsWith("skill://")) return false
  const normWorktree = pathKey(worktree)
  const normSkill = pathKey(skillPath)

  return normSkill.startsWith(`${normWorktree}/`)
}

export function resolveSkillOrigin(skillPath: string, worktree?: string, fromIdeGlobal?: boolean) {
  if (skillPath.startsWith("custom://")) {
    return {
      label: "自定义",
      isLocal: false,
      class: "bg-purple-500/15 text-purple-600 dark:text-purple-400",
    }
  }

  if (isProjectLocalSkill(skillPath, worktree)) {
    return {
      label: "项目专属",
      isLocal: true,
      class: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400",
    }
  }

  const lower = skillPath.toLowerCase()
  const prefix = fromIdeGlobal ? "IDE · " : ""

  if (lower.includes("/.codex/")) {
    return {
      label: `${prefix}Codex`,
      isLocal: false,
      class: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    }
  }

  if (lower.includes("/.claude/")) {
    return {
      label: `${prefix}Claude`,
      isLocal: false,
      class: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    }
  }

  if (lower.includes("/antigravity/") || lower.includes("/.gemini/")) {
    return {
      label: `${prefix}AGY`,
      isLocal: false,
      class: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
    }
  }

  return {
    label: fromIdeGlobal ? "IDE 全局" : "全局",
    isLocal: false,
    class: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400",
  }
}

/**
 * Provides the local Desktop IDE's global Skills & MCP servers so remote server projects
 * can also inspect, toggle, and use the local IDE's global extensions.
 */
export function useIdeGlobalExtensions() {
  const servers = useServers()
  const global = useGlobal()

  const localCtx = createMemo(() => {
    const conn = servers.list.find((item) => servers.local(item))

    return conn ? global.serverCtx(ServerConnection.key(conn)) : undefined
  })

  createEffect(() => {
    const ctx = localCtx()

    if (!ctx || ctx.sdk.connection.status() !== "connected") return
    const tasks: Promise<unknown>[] = []

    if (ctx.data.location.mcp.server.list() === undefined) {
      tasks.push(ctx.data.location.mcp.server.sync())
    }

    if (ctx.data.location.skill.list() === undefined) {
      tasks.push(ctx.data.location.skill.sync())
    }

    if (tasks.length > 0) {
      void Promise.all(tasks).catch(() => undefined)
    }
  })

  const skills = createMemo<ScopedSkillInfo[]>(() => {
    const ctx = localCtx()

    if (!ctx) return []

    return (ctx.data.location.skill.list() ?? []).map((item) => ({
      ...item,
      fromIdeGlobal: true,
    }))
  })

  const mcps = createMemo(() => {
    const ctx = localCtx()

    if (!ctx) return []

    return ctx.data.location.mcp.server.list() ?? []
  })

  return {
    skills,
    mcps,
  }
}

function createExtensionScopeStore() {
  const [store, setStore] = persisted(
    { ...Persist.global("pigu.extension.scope.v1"), sync: true },
    ExtensionScopeState,
    {
      globalSkills: {},
      projectSkills: {},
      projectMcps: {},
      sessionSkills: {},
      sessionMcps: {},
      customMcps: {},
      removedMcps: {},
      customPlugins: {},
      removedPlugins: {},
      customSkills: {},
      removedSkills: {},
    },
  )

  const customMcps = () => Object.values(store.customMcps ?? {})

  const isMcpRemoved = (name: string) => Boolean(store.removedMcps?.[name])

  const saveCustomMcp = (record: CustomMcpRecord, previousName?: string) => {
    batch(() => {
      if (previousName && previousName !== record.name) {
        const nextCustom = { ...(store.customMcps ?? {}) }
        delete nextCustom[previousName]
        nextCustom[record.name] = record
        setStore("customMcps", nextCustom)
        setStore("removedMcps", { ...(store.removedMcps ?? {}), [previousName]: true, [record.name]: false })

        return
      }

      setStore("customMcps", { ...(store.customMcps ?? {}), [record.name]: record })
      setStore("removedMcps", { ...(store.removedMcps ?? {}), [record.name]: false })
    })
  }

  const removeMcp = (name: string) => {
    batch(() => {
      const nextCustom = { ...(store.customMcps ?? {}) }
      delete nextCustom[name]
      setStore("customMcps", nextCustom)
      setStore("removedMcps", { ...(store.removedMcps ?? {}), [name]: true })
    })
  }

  const customPlugins = () => Object.values(store.customPlugins ?? {})

  const isPluginRemoved = (id: string) => Boolean(store.removedPlugins?.[id])

  const saveCustomPlugin = (record: CustomPluginRecord, previousID?: string) => {
    batch(() => {
      if (previousID && previousID !== record.id) {
        const nextCustom = { ...(store.customPlugins ?? {}) }
        delete nextCustom[previousID]
        nextCustom[record.id] = record
        setStore("customPlugins", nextCustom)
        setStore("removedPlugins", { ...(store.removedPlugins ?? {}), [previousID]: true, [record.id]: false })

        return
      }

      setStore("customPlugins", { ...(store.customPlugins ?? {}), [record.id]: record })
      setStore("removedPlugins", { ...(store.removedPlugins ?? {}), [record.id]: false })
    })
  }

  const removePlugin = (id: string) => {
    batch(() => {
      const nextCustom = { ...(store.customPlugins ?? {}) }
      delete nextCustom[id]
      setStore("customPlugins", nextCustom)
      setStore("removedPlugins", { ...(store.removedPlugins ?? {}), [id]: true })
    })
  }

  const isLocalAgentEnabled = (modelID: string) => {
    const pluginID = `local:${modelID}`

    if (store.removedPlugins?.[pluginID]) return false
    const custom = store.customPlugins?.[pluginID]

    if (custom !== undefined) return custom.enabled

    return true
  }

  const localAgentLabel = (modelID: string, fallbackName: string) => {
    const pluginID = `local:${modelID}`
    const custom = store.customPlugins?.[pluginID]

    if (custom?.name?.trim()) return custom.name.trim()

    return fallbackName
  }

  const customSkills = () => Object.values(store.customSkills ?? {})

  const isSkillRemoved = (skill: ScopedSkillInfo) => {
    const sKey = skillScopeKey(skill)

    return Boolean(store.removedSkills?.[sKey] || store.removedSkills?.[skill.name])
  }

  const saveCustomSkill = (record: CustomSkillRecord, previousKey?: string) => {
    batch(() => {
      const nextCustom = { ...(store.customSkills ?? {}) }

      if (previousKey && previousKey !== record.id) {
        delete nextCustom[previousKey]
        nextCustom[record.id] = record
        setStore("customSkills", nextCustom)
        setStore("removedSkills", { ...(store.removedSkills ?? {}), [previousKey]: true, [record.id]: false })

        return
      }

      nextCustom[record.id] = record
      setStore("customSkills", nextCustom)
      setStore("removedSkills", { ...(store.removedSkills ?? {}), [record.id]: false, [record.name]: false })
    })
  }

  const removeSkill = (skill: ScopedSkillInfo) => {
    const sKey = skillScopeKey(skill)
    batch(() => {
      const nextCustom = { ...(store.customSkills ?? {}) }
      delete nextCustom[sKey]
      delete nextCustom[skill.name]
      setStore("customSkills", nextCustom)
      setStore("removedSkills", { ...(store.removedSkills ?? {}), [sKey]: true, [skill.name]: true })
      setStore("globalSkills", sKey, false)
    })
  }

  const mergeSkills = (discovered: ReadonlyArray<ScopedSkillInfo>): ScopedSkillInfo[] => {
    const byKey = new Map<string, ScopedSkillInfo>()

    for (const item of discovered) {
      if (isSkillRemoved(item)) continue
      byKey.set(skillScopeKey(item), item)
    }

    for (const custom of customSkills()) {
      if (store.removedSkills?.[custom.id]) continue
      byKey.set(custom.id, {
        id: custom.id,
        name: custom.name,
        description: custom.description,
        content: custom.content,
        path: custom.path,
      })
    }

    return Array.from(byKey.values()).toSorted((a, b) => a.name.localeCompare(b.name))
  }

  const isGlobalSkillEnabled = (skill: ScopedSkillInfo) => {
    const sKey = skillScopeKey(skill)
    const explicit = store.globalSkills?.[sKey]

    if (explicit !== undefined) return explicit

    return true
  }

  const setGlobalSkillEnabled = (skill: ScopedSkillInfo, enabled: boolean) => {
    const sKey = skillScopeKey(skill)
    setStore("globalSkills", sKey, enabled)
  }

  const isProjectSkillEnabled = (worktree: string, skill: ScopedSkillInfo) => {
    const pKey = pathKey(worktree)
    const sKey = skillScopeKey(skill)
    const explicit = store.projectSkills[pKey]?.[sKey]

    if (explicit !== undefined) return explicit

    return isGlobalSkillEnabled(skill)
  }

  const setProjectSkillEnabled = (worktree: string, skill: ScopedSkillInfo, enabled: boolean) => {
    const pKey = pathKey(worktree)
    const sKey = skillScopeKey(skill)

    if (!store.projectSkills[pKey]) {
      setStore("projectSkills", pKey, { [sKey]: enabled })

      return
    }

    setStore("projectSkills", pKey, sKey, enabled)
  }

  const setProjectSkillsBatch = (
    worktree: string,
    entries: ReadonlyArray<{ skill: ScopedSkillInfo; enabled: boolean }>,
  ) => {
    const pKey = pathKey(worktree)
    const next = { ...(store.projectSkills[pKey] ?? {}) }

    for (const entry of entries) {
      next[skillScopeKey(entry.skill)] = entry.enabled
    }

    setStore("projectSkills", pKey, next)
  }

  const isProjectMcpEnabled = (worktree: string, mcpName: string, globalConnected: boolean) => {
    const pKey = pathKey(worktree)
    const explicit = store.projectMcps?.[pKey]?.[mcpName]

    if (explicit !== undefined) return explicit

    return globalConnected
  }

  const setProjectMcpEnabled = (worktree: string, mcpName: string, enabled: boolean) => {
    const pKey = pathKey(worktree)

    if (!store.projectMcps?.[pKey]) {
      setStore("projectMcps", pKey, { [mcpName]: enabled })

      return
    }

    setStore("projectMcps", pKey, mcpName, enabled)
  }

  const setProjectMcpsBatch = (
    worktree: string,
    entries: ReadonlyArray<{ name: string; enabled: boolean }>,
  ) => {
    const pKey = pathKey(worktree)
    const next = { ...(store.projectMcps?.[pKey] ?? {}) }

    for (const entry of entries) {
      next[entry.name] = entry.enabled
    }

    setStore("projectMcps", pKey, next)
  }

  const isSessionSkillEnabled = (_sessionID: string | undefined, worktree: string, skill: ScopedSkillInfo) => {
    return isProjectSkillEnabled(worktree, skill)
  }

  const setSessionSkillEnabled = (sessionID: string, skill: ScopedSkillInfo, enabled: boolean) => {
    const sKey = skillScopeKey(skill)

    if (!store.sessionSkills[sessionID]) {
      setStore("sessionSkills", sessionID, { [sKey]: enabled })

      return
    }

    setStore("sessionSkills", sessionID, sKey, enabled)
  }

  const isSessionMcpEnabled = (
    _sessionID: string | undefined,
    mcpName: string,
    projectEnabled: boolean,
    worktree?: string,
  ) => {
    if (worktree) {
      return isProjectMcpEnabled(worktree, mcpName, projectEnabled)
    }

    return projectEnabled
  }

  const setSessionMcpEnabled = (sessionID: string, mcpName: string, enabled: boolean) => {
    if (!store.sessionMcps[sessionID]) {
      setStore("sessionMcps", sessionID, { [mcpName]: enabled })

      return
    }

    setStore("sessionMcps", sessionID, mcpName, enabled)
  }

  const hasSessionCustomOverrides = (sessionID: string | undefined) => {
    if (!sessionID) return false
    const skills = store.sessionSkills[sessionID]
    const mcps = store.sessionMcps[sessionID]

    return (!!skills && Object.keys(skills).length > 0) || (!!mcps && Object.keys(mcps).length > 0)
  }

  const resetSessionOverrides = (sessionID: string) => {
    batch(() => {
      setStore("sessionSkills", sessionID, {})
      setStore("sessionMcps", sessionID, {})
    })
  }

  const migrateProjectScope = (fromWorktree: string, toWorktree: string) => {
    const fromKey = pathKey(fromWorktree)
    const toKey = pathKey(toWorktree)

    if (fromKey === toKey) return

    batch(() => {
      const skills = store.projectSkills[fromKey]

      if (skills) {
        setStore("projectSkills", toKey, { ...skills })
      }

      const mcps = store.projectMcps?.[fromKey]

      if (mcps) {
        setStore("projectMcps", toKey, { ...mcps })
      }
    })
  }

  /**
   * Computes the effective `PermissionRule[]` for a session by merging existing non-extension
   * permission rules with `deny` rules for any Skill or MCP disabled at the Global, Project, or Session tier.
   */
  const buildSessionPermissions = (input: {
    sessionID: string | undefined
    worktree: string
    skills: ReadonlyArray<ScopedSkillInfo>
    mcps: ReadonlyArray<{ name: string; connected: boolean }>
    basePermissions?: ReadonlyArray<PermissionRule>
  }): PermissionRule[] => {
    const knownSkillResources = new Set<string>()

    for (const skill of input.skills) {
      if (skill.id) knownSkillResources.add(skill.id)
      knownSkillResources.add(`*:${skill.name}`)
    }

    const knownMcpActions = new Set(input.mcps.map((mcp) => `${mcpPermissionPrefix(mcp.name)}_*`))

    const preserved = (input.basePermissions ?? []).filter((rule) => {
      if (rule.effect === "deny" && rule.action === "skill" && knownSkillResources.has(rule.resource)) {
        return false
      }

      if (rule.effect === "deny" && rule.resource === "*" && knownMcpActions.has(rule.action)) {
        return false
      }

      return true
    })

    const extensionDenies: PermissionRule[] = []

    for (const skill of input.skills) {
      const enabled = isSessionSkillEnabled(input.sessionID, input.worktree, skill)

      if (!enabled) {
        if (skill.id) {
          extensionDenies.push({
            action: "skill",
            resource: skill.id,
            effect: "deny",
          })
        }

        extensionDenies.push({
          action: "skill",
          resource: `*:${skill.name}`,
          effect: "deny",
        })
      }
    }

    for (const mcp of input.mcps) {
      const projectEnabled = isProjectMcpEnabled(input.worktree, mcp.name, mcp.connected)
      const enabled = isSessionMcpEnabled(input.sessionID, mcp.name, projectEnabled, input.worktree)

      if (!enabled) {
        extensionDenies.push({
          action: `${mcpPermissionPrefix(mcp.name)}_*`,
          resource: "*",
          effect: "deny",
        })
      }
    }

    return [...preserved, ...extensionDenies]
  }

  return {
    customMcps,
    isMcpRemoved,
    saveCustomMcp,
    removeMcp,
    customPlugins,
    isPluginRemoved,
    saveCustomPlugin,
    removePlugin,
    isLocalAgentEnabled,
    localAgentLabel,
    customSkills,
    isSkillRemoved,
    saveCustomSkill,
    removeSkill,
    mergeSkills,
    isGlobalSkillEnabled,
    setGlobalSkillEnabled,
    isProjectSkillEnabled,
    setProjectSkillEnabled,
    setProjectSkillsBatch,
    isProjectMcpEnabled,
    setProjectMcpEnabled,
    setProjectMcpsBatch,
    isSessionSkillEnabled,
    setSessionSkillEnabled,
    isSessionMcpEnabled,
    setSessionMcpEnabled,
    hasSessionCustomOverrides,
    resetSessionOverrides,
    migrateProjectScope,
    buildSessionPermissions,
  }
}

let sharedExtensionScopeStore: ReturnType<typeof createExtensionScopeStore> | undefined

export function useExtensionScopeStore() {
  if (!sharedExtensionScopeStore) {
    sharedExtensionScopeStore = createRoot(() => createExtensionScopeStore(), getOwner() ?? undefined)
  }

  return sharedExtensionScopeStore
}
