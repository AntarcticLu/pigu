import { For, Show, createEffect, createMemo, createSignal, type Component, type JSX } from "solid-js"
import { Button } from "@opencode/ui/button"
import { Select } from "@opencode/ui/select"
import { Switch } from "@opencode/ui/switch"
import { TextInput } from "@opencode/ui/text-input"
import { displayName } from "@opencode/ui/project-avatar"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { useData, useServer } from "@/runtime/server/current"
import { useServerSDK } from "@/runtime/server/client"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { showToast } from "@/shell/notifications/toast"
import type { LocalProject } from "@/shell/state/layout"
import { pathKey } from "@/workspaces/path-key"
import {
  isProjectLocalSkill,
  localizeSkillDescription,
  resolveSkillOrigin,
  skillScopeKey,
  useExtensionScopeStore,
  useIdeGlobalExtensions,
  type ScopedSkillInfo,
} from "@/shell/titlebar/extension-scope-store"
import { useArchiveState } from "@/shell/titlebar/archive-store"
import { useSettingsSurface } from "../surface"
import { SettingsList } from "../list"
import { SettingsRow } from "../row"
import { createEditProjectModel } from "./project-model"
import "@/settings/settings.css"
import "./project.css"

function ProjectBasicInfoSection(props: {
  project: LocalProject
  server: ServerConnection.Any
  isLocal: boolean
  onRelocated: (project: LocalProject) => void
}) {
  const language = useLanguage()
  const platform = usePlatform()
  const context = useServer().ctx
  const scopeStore = useExtensionScopeStore()
  const model = createEditProjectModel({ project: props.project, server: props.server })
  const [pathValue, setPathValue] = createSignal(props.project.worktree)
  const [relocating, setRelocating] = createSignal(false)

  createEffect(() => {
    setPathValue(props.project.worktree)
  })

  const pathChanged = () => {
    const trimmed = pathValue().trim()

    return trimmed.length > 0 && pathKey(trimmed) !== pathKey(props.project.worktree)
  }

  const applyNewPath = async (rawTarget: string) => {
    const nextDir = rawTarget.trim()

    if (!nextDir || pathKey(nextDir) === pathKey(props.project.worktree) || relocating()) return
    setRelocating(true)

    const customName = model.store.name.trim()
    const oldWorktree = props.project.worktree
    const added = await context.projects.add(nextDir)
    setRelocating(false)

    if (!added) return

    scopeStore.migrateProjectScope(oldWorktree, added.worktree)

    if (customName && customName !== model.folderName()) {
      if (added.id && added.id !== "global") {
        await context.sdk.api.project
          .update({ projectID: added.id, name: customName })
          .then((updated) => context.sync.project.update(updated))
          .catch(() => undefined)
      }

      if (!added.id || added.id === "global") {
        context.sync.project.meta(added.worktree, { name: customName })
      }
    }

    context.projects.hide(props.project)
    props.onRelocated(added)
    showToast({
      variant: "success",
      title: "项目路径已更新",
      description: added.worktree,
    })
  }

  const browseDirectory = async () => {
    if (!props.isLocal || !platform.openDirectoryPickerDialog) return

    const result = await platform.openDirectoryPickerDialog({
      title: "选择项目文件夹",
      multiple: false,
    })

    const picked = Array.isArray(result) ? result[0] : result

    if (!picked) return
    setPathValue(picked)
    await applyNewPath(picked)
  }

  return (
    <SettingsList>
      <SettingsRow title="项目名称" description="在左侧边栏展示的项目名称，可直接修改">
        <div class="w-64 max-w-full">
          <TextInput
            data-action="settings-project-name"
            type="text"
            appearance="base"
            value={model.store.name}
            placeholder={model.folderName()}
            aria-label={language.t("project.settings.name.title")}
            onInput={(event) => model.setStore("name", event.currentTarget.value)}
            onBlur={model.saveName}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur()
            }}
          />
        </div>
      </SettingsRow>

      <SettingsRow
        title={props.isLocal ? "本地路径" : "远程路径"}
        description="该项目对应的工作区目录路径，支持直接编辑或重新选择目录"
      >
        <div class="flex w-96 max-w-full items-center gap-1.5">
          <div class="min-w-0 flex-1">
            <TextInput
              data-action="settings-project-path"
              type="text"
              appearance="base"
              value={pathValue()}
              disabled={relocating()}
              placeholder="/path/to/project"
              aria-label="项目路径"
              onInput={(event) => setPathValue(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && pathChanged()) {
                  void applyNewPath(pathValue())
                }
              }}
            />
          </div>
          <Show when={pathChanged()}>
            <Button
              variant="secondary"
              size="small"
              disabled={relocating()}
              onClick={() => void applyNewPath(pathValue())}
            >
              保存
            </Button>
          </Show>
          <Show when={props.isLocal && !!platform.openDirectoryPickerDialog}>
            <Button variant="ghost-muted" size="small" disabled={relocating()} onClick={() => void browseDirectory()}>
              浏览...
            </Button>
          </Show>
        </div>
      </SettingsRow>
    </SettingsList>
  )
}

function SingleProjectExtensions(props: { project: LocalProject; isLocal: boolean }) {
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const data = useData()
  const surface = useSettingsSurface()
  const scopeStore = useExtensionScopeStore()
  const ideGlobal = useIdeGlobalExtensions()

  createEffect(() => {
    if (serverSDK.connection.status() !== "connected") return
    const ref = { directory: props.project.worktree }
    void Promise.all([
      data.location.mcp.server.sync(),
      data.location.skill.sync(),
      data.location.mcp.server.sync(ref),
      data.location.skill.sync(ref),
    ]).catch(() => undefined)
  })

  const globalMcpSet = createMemo(() => {
    const names = new Set((data.location.mcp.server.list() ?? []).map((server) => server.name))

    if (!props.isLocal) {
      for (const item of ideGlobal.mcps()) {
        names.add(item.name)
      }
    }

    return names
  })

  const mcps = createMemo(() => {
    const projectList = data.location.mcp.server.list({ directory: props.project.worktree }) ?? []
    const globalList = data.location.mcp.server.list() ?? []
    const byName = new Map<string, (typeof globalList)[number] & { fromIdeGlobal?: boolean }>()

    if (!props.isLocal) {
      for (const item of ideGlobal.mcps()) {
        byName.set(item.name, { ...item, fromIdeGlobal: true })
      }
    }

    for (const item of globalList) {
      byName.set(item.name, item)
    }

    for (const item of projectList) {
      byName.set(item.name, item)
    }

    return Array.from(byName.values()).toSorted((a, b) => a.name.localeCompare(b.name))
  })

  const skills = createMemo<ScopedSkillInfo[]>(() => {
    const projectList = data.location.skill.list({ directory: props.project.worktree }) ?? []
    const globalList = data.location.skill.list() ?? []
    const ideList = props.isLocal ? [] : ideGlobal.skills()
    const byKey = new Map<string, ScopedSkillInfo>()

    for (const item of [...projectList, ...globalList, ...ideList]) {
      const key = skillScopeKey(item)

      if (!byKey.has(key)) {
        byKey.set(key, item)
      }
    }

    return Array.from(byKey.values()).toSorted((a, b) => {
      const aLocal = isProjectLocalSkill(a.path, props.project.worktree) ? 1 : 0
      const bLocal = isProjectLocalSkill(b.path, props.project.worktree) ? 1 : 0

      if (aLocal !== bLocal) return bLocal - aLocal

      return a.name.localeCompare(b.name)
    })
  })

  const enabledMcpCount = () =>
    mcps().filter((item) =>
      scopeStore.isProjectMcpEnabled(props.project.worktree, item.name, item.status.status !== "disabled"),
    ).length

  const enabledSkillCount = () =>
    skills().filter((item) => scopeStore.isProjectSkillEnabled(props.project.worktree, item)).length

  return (
    <div class="flex flex-col gap-5">
      <div class="flex flex-col gap-2">
        <div class="flex items-center justify-between px-1">
          <div class="flex items-center gap-2">
            <span class="text-[13px] font-semibold text-v2-text-text-base">该项目 MCP 服务</span>
            <span class="rounded bg-v2-background-bg-layer-02 px-1.5 py-0.5 text-[11px] font-medium text-v2-text-text-muted">
              已启用 {enabledMcpCount()} / {mcps().length}
            </span>
          </div>
          <Button variant="ghost-muted" size="small" onClick={() => surface.open("extensions")}>
            管理全局扩展
          </Button>
        </div>

        <Show
          when={mcps().length > 0}
          fallback={
            <div class="rounded-lg border border-dashed border-v2-border-border-muted px-4 py-3 text-[12px] text-v2-text-text-faint">
              当前项目暂无已配置的 MCP 服务。可在「设置 → MCP 与扩展」中添加或配置。
            </div>
          }
        >
          <SettingsList variant="catalog">
            <For each={mcps()}>
              {(mcp) => {
                const isProjectOnly = () => !globalMcpSet().has(mcp.name)

                const enabled = () =>
                  scopeStore.isProjectMcpEnabled(props.project.worktree, mcp.name, mcp.status.status !== "disabled")

                return (
                  <div class="settings-extension-row">
                    <div class="settings-extension-lead min-w-0 flex-1">
                      <span
                        class={`size-2 shrink-0 rounded-full ${
                          enabled() && mcp.status.status === "connected"
                            ? "bg-emerald-500"
                            : mcp.status.status === "failed"
                              ? "bg-red-500"
                              : "bg-zinc-400"
                        }`}
                      />
                      <span class="settings-extension-name truncate">{mcp.name}</span>
                      <span
                        class={`shrink-0 rounded px-1.5 py-0.5 text-[10px] leading-none font-medium ${
                          isProjectOnly()
                            ? "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400"
                            : "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400"
                        }`}
                      >
                        {isProjectOnly() ? "项目专属" : mcp.fromIdeGlobal ? "IDE 全局" : "全局共享"}
                      </span>
                    </div>
                    <Switch
                      checked={enabled()}
                      hideLabel
                      onChange={(next) => scopeStore.setProjectMcpEnabled(props.project.worktree, mcp.name, next)}
                    >
                      {mcp.name}
                    </Switch>
                  </div>
                )
              }}
            </For>
          </SettingsList>
        </Show>
      </div>

      <div class="flex flex-col gap-2">
        <div class="flex flex-wrap items-center justify-between gap-2 px-1">
          <div class="flex items-center gap-2">
            <span class="text-[13px] font-semibold text-v2-text-text-base">该项目 Skill 技能</span>
            <span class="rounded bg-v2-background-bg-layer-02 px-1.5 py-0.5 text-[11px] font-medium text-v2-text-text-muted">
              已启用 {enabledSkillCount()} / {skills().length}
            </span>
          </div>
          <Show when={skills().length > 0}>
            <div class="flex items-center gap-1">
              <Button
                variant="ghost-muted"
                size="small"
                onClick={() =>
                  scopeStore.setProjectSkillsBatch(
                    props.project.worktree,
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
                    props.project.worktree,
                    skills().map((skill) => ({ skill, enabled: false })),
                  )
                }
              >
                清空
              </Button>
            </div>
          </Show>
        </div>

        <Show
          when={skills().length > 0}
          fallback={
            <div class="rounded-lg border border-dashed border-v2-border-border-muted px-4 py-3 text-[12px] text-v2-text-text-faint">
              未检测到可用 Skill。
            </div>
          }
        >
          <SettingsList variant="catalog">
            <For each={skills()}>
              {(skill) => {
                const origin = () => resolveSkillOrigin(skill.path, props.project.worktree, skill.fromIdeGlobal)
                const enabled = () => scopeStore.isProjectSkillEnabled(props.project.worktree, skill)
                const desc = () => localizeSkillDescription(skill, language.locale())

                return (
                  <div class="settings-extension-row">
                    <div class="settings-extension-lead min-w-0 flex-1">
                      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                        <div class="flex items-center gap-2">
                          <span
                            class="settings-extension-name truncate"
                            classList={{
                              "text-v2-text-text-base": enabled(),
                              "text-v2-text-text-faint": !enabled(),
                            }}
                          >
                            {skill.name}
                          </span>
                          <span
                            class={`shrink-0 rounded px-1.5 py-0.5 text-[10px] leading-none font-medium ${origin().class}`}
                          >
                            {origin().label}
                          </span>
                        </div>
                        <Show when={desc()}>
                          <span class="truncate text-11-regular text-v2-text-text-faint" title={desc()}>
                            {desc()}
                          </span>
                        </Show>
                      </div>
                    </div>
                    <Switch
                      checked={enabled()}
                      hideLabel
                      onChange={(next) => scopeStore.setProjectSkillEnabled(props.project.worktree, skill, next)}
                    >
                      {skill.name}
                    </Switch>
                  </div>
                )
              }}
            </For>
          </SettingsList>
        </Show>
      </div>
    </div>
  )
}

export const SettingsProjects: Component<{
  server: ServerConnection.Any
  active: boolean
  selectedWorktree?: string
  onOpenProject: (project: LocalProject) => void
  headerAction?: JSX.Element
}> = (props) => {
  const context = useServer().ctx
  const servers = useServers()
  const archive = useArchiveState()

  const projects = createMemo(() =>
    context.projects.unique().toSorted((a, b) => {
      const aArchived = archive.isProjectArchived(a.worktree, 1, 0) ? 1 : 0
      const bArchived = archive.isProjectArchived(b.worktree, 1, 0) ? 1 : 0

      if (aArchived !== bArchived) return aArchived - bArchived

      return (b.time.active ?? 0) - (a.time.active ?? 0)
    }),
  )

  const currentProject = createMemo(() => {
    const list = projects()
    const target = props.selectedWorktree

    if (target) {
      const found = list.find((item) => pathKey(item.worktree) === pathKey(target))

      if (found) return found
    }

    return list[0]
  })

  const isLocalServer = () => servers.local(props.server)

  return (
    <>
      <div class="settings-tab-header">
        <div class="settings-tab-header-row">
          <div class="flex min-w-0 items-center gap-2">
            <h2 class="settings-tab-title">项目配置</h2>
            <Show when={currentProject()}>
              <span
                class={`shrink-0 rounded px-1.5 py-0.5 text-[10px] leading-none font-medium ${
                  isLocalServer()
                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                }`}
              >
                {isLocalServer() ? "本地项目" : "远程项目"}
              </span>
            </Show>
          </div>

          <div class="settings-tab-header-actions flex items-center gap-2">
            <Show when={projects().length > 1}>
              <Select
                options={projects()}
                current={currentProject()}
                value={(item) => item.worktree}
                label={(item) => displayName(item)}
                placement="bottom-end"
                gutter={6}
                onSelect={(item) => item && props.onOpenProject(item)}
              />
            </Show>
            {props.headerAction}
          </div>
        </div>
      </div>

      <div class="settings-tab-body">
        <Show
          when={currentProject()}
          keyed
          fallback={
            <div class="py-12 text-center text-v2-text-text-muted text-13-regular">
              暂无项目，可在左侧边栏点击「项目 +」添加本地项目目录
            </div>
          }
        >
          {(project) => (
            <div class="flex flex-col gap-6">
              <ProjectBasicInfoSection
                project={project}
                server={props.server}
                isLocal={isLocalServer()}
                onRelocated={props.onOpenProject}
              />

              <SingleProjectExtensions project={project} isLocal={isLocalServer()} />
            </div>
          )}
        </Show>
      </div>
    </>
  )
}
