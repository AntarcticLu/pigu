import { For, Show, createEffect, createMemo, onCleanup } from "solid-js"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { Switch } from "@opencode/ui/switch"
import { Tooltip } from "@opencode/ui/tooltip"
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
import "@/settings/settings.css"

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
    <Tooltip placement="top" value={`MCP ${activeMcpCount()} · Skill ${activeSkillCount()}`}>
      <Button
        data-action="composer-mcp-skill"
        variant="ghost-muted"
        size="normal"
        class="size-7 shrink-0 !p-0 ![font-weight:440]"
        aria-label={`MCP ${activeMcpCount()} · Skill ${activeSkillCount()}`}
        onMouseDown={(event: MouseEvent) => event.preventDefault()}
        onClick={() =>
          void dialog.show(
            () => <DialogSessionMcpSkills directory={directory()} isLocal={isLocalServer()} />,
            props.model.restoreFocus,
          )
        }
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
          class="size-4 text-v2-icon-icon-muted"
        >
          <path
            d="M3.5 2.5H12.5V13.5H4.5C3.94772 13.5 3.5 13.0523 3.5 12.5V2.5Z"
            stroke="currentColor"
            stroke-linejoin="round"
          />
          <path d="M3.5 11.5H12.5" stroke="currentColor" />
          <path
            d="M8 4.8L8.65 6.15L10 6.8L8.65 7.45L8 8.8L7.35 7.45L6 6.8L7.35 6.15L8 4.8Z"
            fill="currentColor"
          />
        </svg>
      </Button>
    </Tooltip>
  )
}

function DialogSessionMcpSkills(props: { directory: string; isLocal: boolean }) {
  const language = useLanguage()
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
    <Dialog
      size="x-large"
      containerClass="!w-[min(92vw,860px)] !h-[min(80vh,560px)] !rounded-[10px]"
    >
      <DialogHeader>
        <DialogTitleGroup title={language.tr("MCP 与 Skill", "MCP & Skills")} />
      </DialogHeader>

      <DialogBody class="min-h-0 flex-1 px-4 pb-4 pt-0">
        <div class="grid h-full min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-2">
          <div class="flex min-h-0 flex-col overflow-hidden rounded-[8px] bg-v2-background-bg-base shadow-[inset_0_0_0_0.5px_var(--v2-border-border-muted)]">
            <div class="flex shrink-0 items-center justify-between border-b border-v2-border-border-base px-4 py-3">
              <div class="flex items-center gap-2">
                <Icon name="mcp" size="small" class="text-v2-icon-icon-muted" />
                <span class="text-13-medium text-v2-text-text-base">MCP</span>
                <span class="rounded bg-v2-background-bg-layer-02 px-1.5 py-0.5 text-11-regular text-v2-text-text-muted">
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
                    {language.tr("全选", "Select all")}
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
                    {language.tr("清空", "Clear")}
                  </Button>
                </div>
              </Show>
            </div>

            <div
              class="min-h-0 flex-1 overflow-y-auto px-4"
              style={{ "--settings-list-row-padding": "12px" }}
            >
              <Show
                when={mcps().length > 0}
                fallback={
                  <div class="flex h-full items-center justify-center py-12 text-13-regular text-v2-text-text-faint">
                    {language.tr("暂无 MCP 服务", "No MCP servers")}
                  </div>
                }
              >
                <For each={mcps()}>
                  {(mcp) => {
                    const checked = () =>
                      scopeStore.isProjectMcpEnabled(props.directory, mcp.name, mcp.connected)

                    const applyToggle = (next: boolean) => {
                      scopeStore.setProjectMcpEnabled(props.directory, mcp.name, next)

                      if (next && !mcp.connected && !toggleMcp.isPending) {
                        toggleMcp.mutate({ name: mcp.name, enabled: true })
                      }
                    }

                    return (
                      <div
                        class="settings-extension-row !min-h-[48px] cursor-pointer"
                        onClick={(event) => {
                          if (event.target instanceof Element && event.target.closest("[data-component='switch']"))
                            return
                          applyToggle(!checked())
                        }}
                      >
                        <div class="settings-extension-lead min-w-0 flex-1">
                          <span class="settings-mcp-status">
                            <span
                              class="mcp-status-dot"
                              data-status={checked() ? "connected" : "disabled"}
                              aria-hidden="true"
                            />
                          </span>
                          <span
                            class="settings-extension-name truncate"
                            classList={{
                              "text-v2-text-text-base": checked(),
                              "text-v2-text-text-muted": !checked(),
                            }}
                          >
                            {mcp.name}
                          </span>
                        </div>
                        <div class="settings-extension-trailing !min-w-0">
                          <Switch
                            checked={checked()}
                            hideLabel
                            onChange={(next) => applyToggle(next)}
                          >
                            {mcp.name}
                          </Switch>
                        </div>
                      </div>
                    )
                  }}
                </For>
              </Show>
            </div>
          </div>

          <div class="flex min-h-0 flex-col overflow-hidden rounded-[8px] bg-v2-background-bg-base shadow-[inset_0_0_0_0.5px_var(--v2-border-border-muted)]">
            <div class="flex shrink-0 items-center justify-between border-b border-v2-border-border-base px-4 py-3">
              <div class="flex items-center gap-2">
                <Icon name="post-skill" size="small" class="text-v2-icon-icon-muted" />
                <span class="text-13-medium text-v2-text-text-base">Skill</span>
                <span class="rounded bg-v2-background-bg-layer-02 px-1.5 py-0.5 text-11-regular text-v2-text-text-muted">
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
                    {language.tr("全选", "Select all")}
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
                    {language.tr("清空", "Clear")}
                  </Button>
                </div>
              </Show>
            </div>

            <div
              class="min-h-0 flex-1 overflow-y-auto px-4"
              style={{ "--settings-list-row-padding": "12px" }}
            >
              <Show
                when={skills().length > 0}
                fallback={
                  <div class="flex h-full items-center justify-center py-12 text-13-regular text-v2-text-text-faint">
                    {language.tr("暂无可用 Skill", "No skills available")}
                  </div>
                }
              >
                <For each={skills()}>
                  {(skill) => {
                    const checked = () => scopeStore.isProjectSkillEnabled(props.directory, skill)
                    const desc = () => localizeSkillDescription(skill, language.locale())

                    return (
                      <div
                        class="settings-extension-row !min-h-[52px] cursor-pointer"
                        onClick={(event) => {
                          if (event.target instanceof Element && event.target.closest("[data-component='switch']"))
                            return
                          scopeStore.setProjectSkillEnabled(props.directory, skill, !checked())
                        }}
                      >
                        <div class="settings-extension-lead min-w-0 flex-1">
                          <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span
                              class="settings-extension-name truncate"
                              classList={{
                                "text-v2-text-text-base": checked(),
                                "text-v2-text-text-muted": !checked(),
                              }}
                            >
                              {skill.name}
                            </span>
                            <Show when={desc()}>
                              <span class="truncate text-11-regular text-v2-text-text-faint" title={desc()}>
                                {desc()}
                              </span>
                            </Show>
                          </div>
                        </div>
                        <div class="settings-extension-trailing !min-w-0">
                          <Switch
                            checked={checked()}
                            hideLabel
                            onChange={(next) => scopeStore.setProjectSkillEnabled(props.directory, skill, next)}
                          >
                            {skill.name}
                          </Switch>
                        </div>
                      </div>
                    )
                  }}
                </For>
              </Show>
            </div>
          </div>
        </div>
      </DialogBody>
    </Dialog>
  )
}
