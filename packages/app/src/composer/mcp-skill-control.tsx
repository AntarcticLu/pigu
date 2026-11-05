import { For, Show, createEffect, createMemo } from "solid-js"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { Switch } from "@opencode/ui/switch"
import { getFilename } from "@opencode/util/path"
import { useLanguage } from "@/runtime/i18n/language"
import { useData, useServer } from "@/runtime/server/current"
import { useServerSDK } from "@/runtime/server/client"
import { useWorkspaceLocation } from "@/workspaces/location"
import { useMcpToggle } from "@/providers/connect/mcp"
import { useSettingsSurface } from "@/settings/surface"
import { useLayout } from "@/shell/state/layout"
import {
  isProjectLocalSkill,
  localizeSkillDescription,
  resolveSkillOrigin,
  skillScopeKey,
  useExtensionScopeStore,
  useIdeGlobalExtensions,
  type ScopedSkillInfo,
} from "@/shell/titlebar/extension-scope-store"
import type { ComposerModel } from "./model"

export function ComposerMcpSkillControl(props: { model: ComposerModel }) {
  const dialog = useDialog()
  const data = useData()
  const server = useServer()
  const serverSDK = useServerSDK()
  const location = useWorkspaceLocation()
  const layout = useLayout()
  const scopeStore = useExtensionScopeStore()
  const ideGlobal = useIdeGlobalExtensions()

  const directory = () => location().directory
  const isLocalServer = () => server.ctx.isLocal

  const activeSessionID = () => {
    const route = layout.route()

    return route.type === "session" ? route.sessionId : undefined
  }

  createEffect(() => {
    if (serverSDK.connection.status() !== "connected") return
    const ref = { directory: directory() }
    void Promise.all([
      data.location.mcp.server.sync(ref),
      data.location.skill.sync(ref),
    ]).catch(() => undefined)
  })

  const mcps = createMemo(() => {
    const localList = data.location.mcp.server.list({ directory: directory() }) ?? []

    if (isLocalServer()) return localList
    const byName = new Map(ideGlobal.mcps().map((item) => [item.name, item]))

    for (const item of localList) {
      byName.set(item.name, item)
    }

    return Array.from(byName.values())
  })

  const skills = createMemo<ScopedSkillInfo[]>(() => {
    const localList = data.location.skill.list({ directory: directory() }) ?? []
    const extraIde = isLocalServer() ? [] : ideGlobal.skills()
    const byKey = new Map<string, ScopedSkillInfo>()

    for (const item of [...localList, ...extraIde]) {
      const key = skillScopeKey(item)

      if (!byKey.has(key)) byKey.set(key, item)
    }

    return Array.from(byKey.values())
  })

  // Keep backend `session.permissions` synchronized with Global -> Project -> Session MCP & Skill switches
  // so `SessionContext.select` genuinely filters `<available_skills>`, `<mcp_instructions>`, and tool definitions.
  let lastSyncedKey = ""

  createEffect(() => {
    const sessionID = activeSessionID()

    if (!sessionID || serverSDK.connection.status() !== "connected") return
    const currentSession = data.session.get(sessionID)

    if (!currentSession) return

    const nextPermissions = scopeStore.buildSessionPermissions({
      sessionID,
      worktree: directory(),
      skills: skills(),
      mcps: mcps().map((item) => ({
        name: item.name,
        connected: item.status.status !== "disabled",
      })),
      basePermissions: currentSession.permissions,
    })

    const currentJson = JSON.stringify(currentSession.permissions ?? [])
    const nextJson = JSON.stringify(nextPermissions)
    const syncKey = `${sessionID}:${nextJson}`

    if (nextJson === currentJson || syncKey === lastSyncedKey) return
    lastSyncedKey = syncKey

    void serverSDK.api.session
      .update({
        sessionID,
        permissions: nextPermissions,
      })
      .catch(() => undefined)
  })

  const activeMcpCount = () =>
    mcps().filter((mcp) =>
      scopeStore.isSessionMcpEnabled(
        activeSessionID(),
        mcp.name,
        mcp.status.status === "connected",
        directory(),
      ),
    ).length

  const activeSkillCount = () =>
    skills().filter((skill) => scopeStore.isSessionSkillEnabled(activeSessionID(), directory(), skill)).length

  const customized = () => scopeStore.hasSessionCustomOverrides(activeSessionID())

  return (
    <Button
      data-action="composer-mcp-skill"
      variant="ghost-muted"
      size="normal"
      class="shrink-0 gap-1 ![font-weight:440]"
      style={{ height: "28px" }}
      onMouseDown={(event: MouseEvent) => event.preventDefault()}
      onClick={() =>
        void dialog.show(
          () => (
            <DialogSessionMcpSkills
              directory={directory()}
              sessionID={activeSessionID()}
              isLocal={isLocalServer()}
              onInsertSkill={(skill) => {
                dialog.close()
                props.model.insertSkill(skill)
              }}
            />
          ),
          props.model.restoreFocus,
        )
      }
    >
      <Icon name="post-skill" size="small" class="text-v2-icon-icon-muted" />
      <span>
        MCP {activeMcpCount()} · Skill {activeSkillCount()}
      </span>
      <Show when={customized()}>
        <span class="size-1.5 rounded-full bg-indigo-500" title="当前对话已单独定制 MCP / Skill" />
      </Show>
    </Button>
  )
}

function DialogSessionMcpSkills(props: {
  directory: string
  sessionID: string | undefined
  isLocal: boolean
  onInsertSkill: (skill: { id: string; name: string }) => void
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const data = useData()
  const server = useServer()
  const surface = useSettingsSurface()
  const scopeStore = useExtensionScopeStore()
  const ideGlobal = useIdeGlobalExtensions()
  const toggleMcp = useMcpToggle(() => props.directory)

  const projectName = () => getFilename(props.directory) || props.directory

  const mcps = createMemo(() => {
    const localList = data.location.mcp.server.list({ directory: props.directory }) ?? []
    const byName = new Map<string, (typeof localList)[number] & { fromIdeGlobal?: boolean }>()

    if (!props.isLocal) {
      for (const item of ideGlobal.mcps()) {
        byName.set(item.name, { ...item, fromIdeGlobal: true })
      }
    }

    for (const item of localList) {
      byName.set(item.name, item)
    }

    return Array.from(byName.values()).toSorted((a, b) => a.name.localeCompare(b.name))
  })

  const skills = createMemo<ScopedSkillInfo[]>(() => {
    const list = data.location.skill.list({ directory: props.directory }) ?? []
    const extraIde = props.isLocal ? [] : ideGlobal.skills()
    const byKey = new Map<string, ScopedSkillInfo>()

    for (const item of [...list, ...extraIde]) {
      const key = skillScopeKey(item)

      if (!byKey.has(key)) byKey.set(key, item)
    }

    return Array.from(byKey.values()).toSorted((a, b) => {
      const aLocal = isProjectLocalSkill(a.path, props.directory) ? 1 : 0
      const bLocal = isProjectLocalSkill(b.path, props.directory) ? 1 : 0

      if (aLocal !== bLocal) return bLocal - aLocal

      return a.name.localeCompare(b.name)
    })
  })

  const customized = () => scopeStore.hasSessionCustomOverrides(props.sessionID)

  return (
    <Dialog size="large">
      <DialogHeader>
        <DialogTitleGroup
          title="当前对话 MCP & Skill 管理"
          description={
            props.sessionID
              ? `当前项目：${projectName()} · 默认继承该项目的配置，下方开关实时同步至当前对话上下文`
              : `当前项目：${projectName()} · 新建对话草稿将直接调整该项目的默认配置`
          }
        />
      </DialogHeader>

      <DialogBody class="flex max-h-[65vh] flex-col gap-4 overflow-y-auto px-4 py-2">
        <div class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-v2-border-border-muted bg-v2-background-bg-layer-02/50 px-3 py-2 text-[12px]">
          <div class="flex items-center gap-2">
            <span
              class={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                customized()
                  ? "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400"
                  : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
              }`}
            >
              {customized() ? "当前对话已定制" : "继承项目默认"}
            </span>
            <span class="text-v2-text-text-muted">
              全局 → 项目（{projectName()}）→ 当前对话 三级联动
            </span>
          </div>
          <div class="flex items-center gap-2">
            <Show when={props.sessionID && customized()}>
              <button
                type="button"
                class="rounded px-2 py-0.5 text-[11px] font-medium text-indigo-600 hover:bg-indigo-500/10 dark:text-indigo-400"
                onClick={() => props.sessionID && scopeStore.resetSessionOverrides(props.sessionID)}
              >
                恢复继承项目配置
              </button>
            </Show>
            <button
              type="button"
              class="rounded px-2 py-0.5 text-[11px] font-medium text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base"
              onClick={() => {
                dialog.close()
                surface.openProject({ server: server.key, project: props.directory, tab: "extensions" })
              }}
            >
              前往项目级配置 →
            </button>
          </div>
        </div>

        <div class="flex flex-col gap-2">
          <div class="flex items-center justify-between px-1">
            <span class="text-[12px] font-semibold text-v2-text-text-base">
              当前对话 MCP 服务 ({mcps().length})
            </span>
          </div>
          <Show
            when={mcps().length > 0}
            fallback={
              <div class="rounded-md border border-dashed border-v2-border-border-muted px-3 py-2 text-[12px] text-v2-text-text-faint">
                当前项目暂无已配置的 MCP 服务。
              </div>
            }
          >
            <div class="flex flex-col gap-1.5">
              <For each={mcps()}>
                {(mcp) => {
                  const projectEnabled = () =>
                    scopeStore.isProjectMcpEnabled(
                      props.directory,
                      mcp.name,
                      mcp.status.status !== "disabled",
                    )

                  const sessionEnabled = () =>
                    scopeStore.isSessionMcpEnabled(props.sessionID, mcp.name, projectEnabled(), props.directory)

                  return (
                    <div class="flex items-center justify-between gap-2 rounded-md border border-v2-border-border-muted/70 px-3 py-2">
                      <div class="flex min-w-0 flex-1 items-center gap-2">
                        <span
                          class={`size-2 shrink-0 rounded-full ${
                            sessionEnabled() ? "bg-emerald-500" : "bg-zinc-400"
                          }`}
                        />
                        <span class="truncate text-[13px] font-medium text-v2-text-text-base">{mcp.name}</span>
                        <Show when={mcp.fromIdeGlobal}>
                          <span class="shrink-0 rounded bg-zinc-500/15 px-1.5 py-0.5 text-[10px] leading-none font-medium text-zinc-600 dark:text-zinc-400">
                            IDE 全局
                          </span>
                        </Show>
                      </div>
                      <Switch
                        checked={sessionEnabled()}
                        hideLabel
                        onChange={(next) => {
                          if (props.sessionID) {
                            scopeStore.setSessionMcpEnabled(props.sessionID, mcp.name, next)
                          }

                          if (!props.sessionID) {
                            scopeStore.setProjectMcpEnabled(props.directory, mcp.name, next)
                          }

                          if (next && mcp.status.status === "disabled" && !toggleMcp.isPending) {
                            toggleMcp.mutate({ name: mcp.name, enabled: true })
                          }
                        }}
                      >
                        {mcp.name}
                      </Switch>
                    </div>
                  )
                }}
              </For>
            </div>
          </Show>
        </div>

        <div class="flex flex-col gap-2">
          <div class="flex items-center justify-between px-1">
            <span class="text-[12px] font-semibold text-v2-text-text-base">
              当前对话可用 Skill 技能 ({skills().length})
            </span>
            <span class="text-[11px] text-v2-text-text-faint">
              点击「@调用」可直接将该技能插入当前对话输入框
            </span>
          </div>
          <Show
            when={skills().length > 0}
            fallback={
              <div class="rounded-md border border-dashed border-v2-border-border-muted px-3 py-2 text-[12px] text-v2-text-text-faint">
                当前暂无可用 Skill。
              </div>
            }
          >
            <div class="flex flex-col gap-1.5">
              <For each={skills()}>
                {(skill) => {
                  const origin = () => resolveSkillOrigin(skill.path, props.directory, skill.fromIdeGlobal)
                  const enabled = () => scopeStore.isSessionSkillEnabled(props.sessionID, props.directory, skill)
                  const desc = () => localizeSkillDescription(skill, language.locale())

                  return (
                    <div class="flex items-center justify-between gap-3 rounded-md border border-v2-border-border-muted/70 px-3 py-2 hover:bg-v2-overlay-simple-overlay-hover/50">
                      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                        <div class="flex items-center gap-1.5">
                          <span
                            class={`shrink-0 rounded px-1.5 py-0.5 text-[10px] leading-none font-medium ${origin().class}`}
                          >
                            {origin().label}
                          </span>
                          <span
                            class="truncate text-[13px] font-medium"
                            classList={{
                              "text-v2-text-text-base": enabled(),
                              "text-v2-text-text-faint": !enabled(),
                            }}
                          >
                            {skill.name}
                          </span>
                        </div>
                        <Show when={desc()}>
                          <span class="truncate text-[11px] text-v2-text-text-faint" title={desc()}>
                            {desc()}
                          </span>
                        </Show>
                      </div>
                      <div class="flex shrink-0 items-center gap-2">
                        <Show when={skill.id}>
                          {(id) => (
                            <button
                              type="button"
                              class="rounded bg-v2-background-bg-layer-02 px-2 py-1 text-[11px] font-medium text-v2-text-text-base hover:bg-indigo-500/15 hover:text-indigo-600 dark:hover:text-indigo-400"
                              onClick={() => props.onInsertSkill({ id: id(), name: skill.name })}
                            >
                              @调用
                            </button>
                          )}
                        </Show>
                        <Switch
                          checked={enabled()}
                          hideLabel
                          onChange={(next) => {
                            if (props.sessionID) {
                              scopeStore.setSessionSkillEnabled(props.sessionID, skill, next)

                              return
                            }

                            scopeStore.setProjectSkillEnabled(props.directory, skill, next)
                          }}
                        >
                          {skill.name}
                        </Switch>
                      </div>
                    </div>
                  )
                }}
              </For>
            </div>
          </Show>
        </div>
      </DialogBody>

      <DialogFooter>
        <Button variant="contrast" onClick={() => dialog.close()}>
          完成
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
