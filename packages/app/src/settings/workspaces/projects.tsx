import { Show, createEffect, createMemo, createSignal, type Component, type JSX } from "solid-js"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Select } from "@opencode/ui/select"
import { TextInput } from "@opencode/ui/text-input"
import { displayName } from "@opencode/ui/project-avatar"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { useServer } from "@/runtime/server/current"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { showToast } from "@/shell/notifications/toast"
import type { LocalProject } from "@/shell/state/layout"
import { pathKey } from "@/workspaces/path-key"
import { useExtensionScopeStore } from "@/shell/titlebar/extension-scope-store"
import { useArchiveState } from "@/shell/titlebar/archive-store"
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
  const [editingName, setEditingName] = createSignal(false)
  const [pathValue, setPathValue] = createSignal(props.project.worktree)
  const [relocating, setRelocating] = createSignal(false)
  let nameInput: HTMLInputElement | undefined

  createEffect(() => {
    setPathValue(props.project.worktree)
  })

  const startEditingName = () => {
    setEditingName(true)
    requestAnimationFrame(() => {
      nameInput?.focus()
      nameInput?.select()
    })
  }

  const commitName = () => {
    model.saveName()
    setEditingName(false)
  }

  const cancelEditingName = () => {
    model.setStore("name", props.project.name || model.folderName())
    setEditingName(false)
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
    if (!props.isLocal || platform.platform !== "desktop") return

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
      <SettingsRow title="项目名称">
        <Show
          when={editingName()}
          fallback={
            <div class="flex max-w-full items-center gap-1.5">
              <span
                data-action="settings-project-name-display"
                class="max-w-64 truncate text-13-regular text-v2-text-text-base"
              >
                {model.store.name || model.folderName()}
              </span>
              <IconButton
                data-action="settings-project-name-edit"
                variant="ghost-muted"
                size="small"
                icon={<Icon name="edit" size="small" />}
                aria-label="编辑项目名称"
                onClick={startEditingName}
              />
            </div>
          }
        >
          <div class="flex w-64 max-w-full items-center gap-1.5">
            <div class="min-w-0 flex-1">
              <TextInput
                ref={(el) => {
                  nameInput = el
                }}
                data-action="settings-project-name"
                type="text"
                appearance="base"
                value={model.store.name}
                placeholder={model.folderName()}
                aria-label={language.t("project.settings.name.title")}
                onInput={(event) => model.setStore("name", event.currentTarget.value)}
                onBlur={commitName}
                onKeyDown={(event) => {
                  if (event.isComposing || event.keyCode === 229) return

                  if (event.key === "Enter") {
                    event.preventDefault()
                    commitName()

                    return
                  }

                  if (event.key === "Escape") {
                    event.preventDefault()
                    cancelEditingName()
                  }
                }}
              />
            </div>
            <IconButton
              data-action="settings-project-name-confirm"
              variant="ghost-muted"
              size="small"
              icon={<Icon name="check" size="small" />}
              aria-label="保存项目名称"
              onMouseDown={(event) => event.preventDefault()}
              onClick={commitName}
            />
          </div>
        </Show>
      </SettingsRow>

      <SettingsRow title={props.isLocal ? "本地路径" : "远程路径"}>
        <div class="flex max-w-full items-center gap-2">
          <span
            data-action="settings-project-path"
            class="max-w-80 truncate font-mono text-13-regular text-v2-text-text-muted"
            title={pathValue()}
          >
            {pathValue()}
          </span>
          <Show when={props.isLocal && platform.platform === "desktop"}>
            <Button
              data-action="settings-project-path-browse"
              variant="neutral"
              size="small"
              disabled={relocating()}
              onClick={() => void browseDirectory()}
            >
              浏览...
            </Button>
          </Show>
        </div>
      </SettingsRow>
    </SettingsList>
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
            </div>
          )}
        </Show>
      </div>
    </>
  )
}
