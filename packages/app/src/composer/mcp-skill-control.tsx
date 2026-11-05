import { For, Show, createEffect, createMemo, onCleanup } from "solid-js"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { useLanguage } from "@/runtime/i18n/language"
import { useData, useServer } from "@/runtime/server/current"
import { useServerSDK } from "@/runtime/server/client"
import { useWorkspaceLocation } from "@/workspaces/location"
import { useMcpToggle } from "@/providers/connect/mcp"
import { useLayout } from "@/shell/state/layout"
import {
  isProjectLocalSkill,
  localizeSkillDescription,
  skillScopeKey,
  useExtensionScopeStore,
  useIdeGlobalExtensions,
  type ScopedSkillInfo,
} from "@/shell/titlebar/extension-scope-store"
import type { ComposerModel } from "./model"

type McpPickerItem = {
  name: string
  connected: boolean
}

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
    const tasks: Promise<unknown>[] = []

    if (data.location.mcp.server.list(ref) === undefined) {
      tasks.push(data.location.mcp.server.sync(ref))
    }

    if (data.location.skill.list(ref) === undefined) {
      tasks.push(data.location.skill.sync(ref))
    }

    if (tasks.length > 0) {
      void Promise.all(tasks).catch(() => undefined)
    }
  })

  const mcps = createMemo<McpPickerItem[]>(() => {
    const localList = (data.location.mcp.server.list({ directory: directory() }) ?? []).filter(
      (item) => !scopeStore.isMcpRemoved(item.name),
    )

    const byName = new Map<string, McpPickerItem>()

    if (!isLocalServer()) {
      for (const item of ideGlobal.mcps()) {
        if (scopeStore.isMcpRemoved(item.name)) continue
        byName.set(item.name, {
          name: item.name,
          connected: item.status.status !== "disabled",
        })
      }
    }

    for (const item of localList) {
      byName.set(item.name, {
        name: item.name,
        connected: item.status.status !== "disabled",
      })
    }

    for (const custom of scopeStore.customMcps()) {
      if (scopeStore.isMcpRemoved(custom.name) || byName.has(custom.name)) continue
      byName.set(custom.name, {
        name: custom.name,
        connected: custom.enabled,
      })
    }

    return Array.from(byName.values()).toSorted((a, b) => a.name.localeCompare(b.name))
  })

  const skills = createMemo<ScopedSkillInfo[]>(() => {
    const localList = data.location.skill.list({ directory: directory() }) ?? []
    const extraIde = isLocalServer() ? [] : ideGlobal.skills()
    const byKey = new Map<string, ScopedSkillInfo>()

    for (const item of [...localList, ...extraIde]) {
      const key = skillScopeKey(item)

      if (!byKey.has(key)) byKey.set(key, item)
    }

    return scopeStore.mergeSkills(Array.from(byKey.values()))
  })

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
      mcps: mcps(),
      basePermissions: currentSession.permissions,
    })

    const currentJson = JSON.stringify(currentSession.permissions ?? [])
    const nextJson = JSON.stringify(nextPermissions)
    const syncKey = `${sessionID}:${nextJson}`

    if (nextJson === currentJson || syncKey === lastSyncedKey) return

    const timer = setTimeout(() => {
      lastSyncedKey = syncKey
      void serverSDK.api.session
        .update({
          sessionID,
          permissions: nextPermissions,
        })
        .catch(() => undefined)
    }, 300)

    onCleanup(() => clearTimeout(timer))
  })

  const activeMcpCount = () =>
    mcps().filter((mcp) => scopeStore.isProjectMcpEnabled(directory(), mcp.name, mcp.connected)).length

  const activeSkillCount = () =>
    skills().filter((skill) => scopeStore.isProjectSkillEnabled(directory(), skill)).length

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
          () => <DialogSessionMcpSkills directory={directory()} isLocal={isLocalServer()} />,
          props.model.restoreFocus,
        )
      }
    >
      <Icon name="post-skill" size="small" class="text-v2-icon-icon-muted" />
      <span>
        MCP {activeMcpCount()} · Skill {activeSkillCount()}
      </span>
    </Button>
  )
}

function DialogSessionMcpSkills(props: { directory: string; isLocal: boolean }) {
  const language = useLanguage()
  const dialog = useDialog()
  const data = useData()
  const scopeStore = useExtensionScopeStore()
  const ideGlobal = useIdeGlobalExtensions()
  const toggleMcp = useMcpToggle(() => props.directory)

  const mcps = createMemo<McpPickerItem[]>(() => {
    const localList = data.location.mcp.server.list({ directory: props.directory }) ?? []
    const byName = new Map<string, McpPickerItem>()

    if (!props.isLocal) {
      for (const item of ideGlobal.mcps()) {
        if (scopeStore.isMcpRemoved(item.name)) continue
        byName.set(item.name, {
          name: item.name,
          connected: item.status.status !== "disabled",
        })
      }
    }

    for (const item of localList) {
      if (scopeStore.isMcpRemoved(item.name)) continue
      byName.set(item.name, {
        name: item.name,
        connected: item.status.status !== "disabled",
      })
    }

    for (const custom of scopeStore.customMcps()) {
      if (scopeStore.isMcpRemoved(custom.name) || byName.has(custom.name)) continue
      byName.set(custom.name, {
        name: custom.name,
        connected: custom.enabled,
      })
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

    return scopeStore.mergeSkills(Array.from(byKey.values())).toSorted((a, b) => {
      const aLocal = isProjectLocalSkill(a.path, props.directory) ? 1 : 0
      const bLocal = isProjectLocalSkill(b.path, props.directory) ? 1 : 0

      if (aLocal !== bLocal) return bLocal - aLocal

      return a.name.localeCompare(b.name)
    })
  })

  const enabledMcpCount = () =>
    mcps().filter((item) => scopeStore.isProjectMcpEnabled(props.directory, item.name, item.connected)).length

  const enabledSkillCount = () =>
    skills().filter((item) => scopeStore.isProjectSkillEnabled(props.directory, item)).length

  return (
    <Dialog size="large">
      <DialogHeader>
        <DialogTitleGroup title="选择 MCP 与 Skill" />
      </DialogHeader>

      <DialogBody class="px-4 py-2">
        <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div class="flex min-w-0 flex-col gap-2">
            <div class="flex items-center justify-between px-1">
              <div class="flex items-center gap-1.5">
                <span class="text-[13px] font-semibold text-v2-text-text-base">MCP</span>
                <span class="rounded bg-v2-background-bg-layer-02 px-1.5 py-0.5 text-[11px] font-medium text-v2-text-text-muted">
                  {enabledMcpCount()} / {mcps().length}
                </span>
              </div>
              <Show when={mcps().length > 0}>
                <div class="flex items-center gap-1">
                  <Button
                    variant="ghost-muted"
                    size="small"
                    onClick={() =>
                      scopeStore.setProjectMcpsBatch(
                        props.directory,
                        mcps().map((item) => ({ name: item.name, enabled: true })),
                      )
                    }
                  >
                    全选
                  </Button>
                  <Button
                    variant="ghost-muted"
                    size="small"
                    onClick={() =>
                      scopeStore.setProjectMcpsBatch(
                        props.directory,
                        mcps().map((item) => ({ name: item.name, enabled: false })),
                      )
                    }
                  >
                    清空
                  </Button>
                </div>
              </Show>
            </div>

            <div class="flex max-h-[52vh] flex-col gap-1 overflow-y-auto rounded-lg border border-v2-border-border-muted p-1.5">
              <Show
                when={mcps().length > 0}
                fallback={
                  <div class="px-3 py-8 text-center text-[12px] text-v2-text-text-faint">
                    暂无 MCP 服务
                  </div>
                }
              >
                <For each={mcps()}>
                  {(mcp) => {
                    const checked = () =>
                      scopeStore.isProjectMcpEnabled(props.directory, mcp.name, mcp.connected)

                    const handleToggle = () => {
                      const next = !checked()
                      scopeStore.setProjectMcpEnabled(props.directory, mcp.name, next)

                      if (next && !mcp.connected && !toggleMcp.isPending) {
                        toggleMcp.mutate({ name: mcp.name, enabled: true })
                      }
                    }

                    return (
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={checked()}
                        class="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-v2-overlay-simple-overlay-hover"
                        onClick={handleToggle}
                      >
                        <span
                          class={`flex size-4 shrink-0 items-center justify-center rounded border transition-colors ${
                            checked()
                              ? "border-v2-interactive-bg-accent-base bg-v2-interactive-bg-accent-base text-white"
                              : "border-v2-border-border-strong bg-transparent"
                          }`}
                        >
                          <Show when={checked()}>
                            <Icon name="check" size="small" />
                          </Show>
                        </span>
                        <span
                          class="min-w-0 flex-1 truncate text-[13px] font-medium"
                          classList={{
                            "text-v2-text-text-base": checked(),
                            "text-v2-text-text-muted": !checked(),
                          }}
                        >
                          {mcp.name}
                        </span>
                      </button>
                    )
                  }}
                </For>
              </Show>
            </div>
          </div>

          <div class="flex min-w-0 flex-col gap-2">
            <div class="flex items-center justify-between px-1">
              <div class="flex items-center gap-1.5">
                <span class="text-[13px] font-semibold text-v2-text-text-base">Skill</span>
                <span class="rounded bg-v2-background-bg-layer-02 px-1.5 py-0.5 text-[11px] font-medium text-v2-text-text-muted">
                  {enabledSkillCount()} / {skills().length}
                </span>
              </div>
              <Show when={skills().length > 0}>
                <div class="flex items-center gap-1">
                  <Button
                    variant="ghost-muted"
                    size="small"
                    onClick={() =>
                      scopeStore.setProjectSkillsBatch(
                        props.directory,
                        skills().map((skill) => ({ skill, enabled: true })),
                      )
                    }
                  >
                    全选
                  </Button>
                  <Button
                    variant="ghost-muted"
                    size="small"
                    onClick={() =>
                      scopeStore.setProjectSkillsBatch(
                        props.directory,
                        skills().map((skill) => ({ skill, enabled: false })),
                      )
                    }
                  >
                    清空
                  </Button>
                </div>
              </Show>
            </div>

            <div class="flex max-h-[52vh] flex-col gap-1 overflow-y-auto rounded-lg border border-v2-border-border-muted p-1.5">
              <Show
                when={skills().length > 0}
                fallback={
                  <div class="px-3 py-8 text-center text-[12px] text-v2-text-text-faint">
                    暂无可用 Skill
                  </div>
                }
              >
                <For each={skills()}>
                  {(skill) => {
                    const checked = () => scopeStore.isProjectSkillEnabled(props.directory, skill)
                    const desc = () => localizeSkillDescription(skill, language.locale())

                    return (
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={checked()}
                        class="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-v2-overlay-simple-overlay-hover"
                        onClick={() => scopeStore.setProjectSkillEnabled(props.directory, skill, !checked())}
                      >
                        <span
                          class={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border transition-colors ${
                            checked()
                              ? "border-v2-interactive-bg-accent-base bg-v2-interactive-bg-accent-base text-white"
                              : "border-v2-border-border-strong bg-transparent"
                          }`}
                        >
                          <Show when={checked()}>
                            <Icon name="check" size="small" />
                          </Show>
                        </span>
                        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span
                            class="truncate text-[13px] font-medium"
                            classList={{
                              "text-v2-text-text-base": checked(),
                              "text-v2-text-text-muted": !checked(),
                            }}
                          >
                            {skill.name}
                          </span>
                          <Show when={desc()}>
                            <span class="truncate text-[11px] text-v2-text-text-faint" title={desc()}>
                              {desc()}
                            </span>
                          </Show>
                        </div>
                      </button>
                    )
                  }}
                </For>
              </Show>
            </div>
          </div>
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
