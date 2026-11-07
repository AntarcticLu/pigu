import { Icon } from "@opencode/ui/icon"
import { Switch } from "@opencode/ui/switch"
import { Tabs } from "@opencode/ui/tabs"
import { Button } from "@opencode/ui/button"
import { displayName } from "@opencode/ui/project-avatar"
import { useQuery } from "@tanstack/solid-query"
import {
  type Component,
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  onCleanup,
  type JSX,
} from "solid-js"
import { getFilename } from "@opencode/util/path"
import { useLanguage } from "@/runtime/i18n/language"
import { useMcpToggle } from "@/providers/connect/mcp"
import { useWorkspaceLocation } from "@/workspaces/location"
import { useServerSDK } from "@/runtime/server/client"
import { useData } from "@/runtime/server/current"
import { pluginLabels } from "@/providers/catalog/plugin"
import type { LocalProject } from "@/shell/state/layout"
import { ProjectIcon } from "@/shell/layout/project-icon"
import {
  isProjectLocalSkill,
  resolveSkillOrigin,
  skillScopeKey,
  useExtensionScopeStore,
  type ScopedSkillInfo,
} from "@/shell/titlebar/extension-scope-store"
import { useSettingsSurface } from "../surface"
import { ProjectFolderMissing } from "./project-folder-missing"
import { configuredLanguageServers } from "./project-lsp"
import { SettingsList } from "@/settings/list"
import "./project.css"

const ExtensionCard: Component<{ children: JSX.Element }> = (props) => (
  <SettingsList variant="catalog">{props.children}</SettingsList>
)

const ExtensionRow: Component<{
  icon: "mcp" | "cube" | "post-skill" | "code"
  name: JSX.Element
  description?: JSX.Element
  children?: JSX.Element
}> = (props) => (
  <div class="settings-extension-row project-settings-extension-row">
    <div class="settings-extension-lead">
      <Icon name={props.icon} class="project-settings-extension-row-icon" />
      <div class="project-settings-extension-row-copy">
        <span class="project-settings-extension-row-name settings-extension-name flex items-center gap-2">
          {props.name}
        </span>
        <Show when={props.description}>
          <span class="project-settings-extension-row-description">{props.description}</span>
        </Show>
      </div>
    </div>
    {props.children}
  </div>
)

const ProjectLanguageServers: Component = () => {
  const language = useLanguage()
  const server = useServerSDK()
  const location = useWorkspaceLocation()

  const config = useQuery(() => ({
    queryKey: [server.scope, "settings-project-language-servers", location().directory],
    enabled: server.connection.status() === "connected",
    queryFn: () => server.api.config.get({ location: { directory: location().directory } }),
  }))

  const configured = createMemo(() =>
    configuredLanguageServers(config.isPending || config.isError ? [] : (config.data ?? [])),
  )

  const empty = () => !config.isPending && !config.isError && configured().servers.length === 0
  onCleanup(
    server.event.on("config.updated", (event) => {
      if (event.location && event.location.directory !== location().directory) return
      void config.refetch()
    }),
  )

  return (
    <div class="project-settings-extension-section">
      <div class="project-settings-extension-section-header">
        <div class="project-settings-extension-section-copy">
          <span>
            {language.t(
              empty()
                ? configured().disabled
                  ? "project.settings.extensions.lsp.disabled.title"
                  : "project.settings.extensions.lsp.empty.title"
                : "project.settings.extensions.lsp.configured",
            )}
          </span>
          <Show when={empty()}>
            <span class="project-settings-extension-empty-description">
              {language.t(
                configured().disabled
                  ? "project.settings.extensions.lsp.disabled.description"
                  : "project.settings.extensions.lsp.empty.description",
              )}
            </span>
          </Show>
        </div>
        <span>{language.t("project.settings.extensions.lsp.description")}</span>
      </div>
      <Show
        when={!config.isPending}
        fallback={<p class="project-settings-extension-empty-description">{language.t("common.loading")}</p>}
      >
        <Show
          when={!config.isError}
          fallback={
            <div class="project-settings-extension-section-copy" role="status">
              <span class="project-settings-extension-empty-description">
                {language.t("project.settings.extensions.lsp.loadFailed")}
              </span>
              <Button variant="ghost-muted" onClick={() => void config.refetch()}>
                {language.t("project.settings.extensions.lsp.retry")}
              </Button>
            </div>
          }
        >
          <Show when={configured().servers.length > 0}>
            <ExtensionCard>
              <For each={configured().servers}>
                {(item) => (
                  <ExtensionRow
                    icon="code"
                    name={item.name}
                    description={item.extensions.length ? <bdi dir="ltr">{item.extensions.join(", ")}</bdi> : undefined}
                  >
                    <span class="project-settings-extension-row-status">
                      {language.t(
                        item.disabled
                          ? "project.settings.extensions.lsp.status.disabled"
                          : "project.settings.extensions.lsp.status.enabled",
                      )}
                    </span>
                  </ExtensionRow>
                )}
              </For>
            </ExtensionCard>
          </Show>
        </Show>
      </Show>
    </div>
  )
}

export const ProjectSettingsExtensions: Component<{
  project?: LocalProject
  subtab?: "mcps" | "plugins" | "skills" | "lsps"
  onSubtab: (value: "mcps" | "plugins" | "skills" | "lsps") => void
}> = (props) => {
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const directorySDK = useWorkspaceLocation()
  const data = useData()
  const surface = useSettingsSurface()
  const scopeStore = useExtensionScopeStore()
  const toggleMcp = useMcpToggle(() => directorySDK().directory)

  const directory = () => directorySDK().directory

  const projectTitle = () =>
    props.project ? displayName(props.project) : getFilename(directory()) || directory()

  createEffect(() => {
    if (serverSDK.connection.status() !== "connected") return
    const ref = { directory: directory() }
    void Promise.all([
      data.location.mcp.server.sync(),
      data.location.skill.sync(),
      data.location.mcp.server.sync(ref),
      data.location.skill.sync(ref),
    ]).catch(() => undefined)
  })

  const globalMcpSet = createMemo(
    () => new Set((data.location.mcp.server.list() ?? []).map((server) => server.name)),
  )

  const allMcps = createMemo(() => {
    const projectList = data.location.mcp.server.list({ directory: directory() }) ?? []
    const globalList = data.location.mcp.server.list() ?? []
    const byName = new Map(globalList.map((item) => [item.name, item]))

    for (const item of projectList) {
      byName.set(item.name, item)
    }

    return Array.from(byName.values()).toSorted((a, b) => a.name.localeCompare(b.name))
  })

  const [globalPluginList] = createResource(
    () => serverSDK.connection.status() === "connected",
    () =>
      serverSDK.api.plugin
        .list()
        .then((result) => result.data)
        .catch(() => []),
    { initialValue: [] },
  )

  const [projectPluginList] = createResource(
    () => (serverSDK.connection.status() === "connected" ? directory() : undefined),
    (dir) =>
      serverSDK.api.plugin
        .list({ location: { directory: dir } })
        .then((result) => result.data)
        .catch(() => []),
    { initialValue: [] },
  )

  const allPlugins = createMemo(() => {
    const set = new Set([
      ...pluginLabels(projectPluginList.latest ?? []),
      ...pluginLabels(globalPluginList.latest ?? []),
    ])

    return Array.from(set)
  })

  const allSkills = createMemo<ScopedSkillInfo[]>(() => {
    const projectList = data.location.skill.list({ directory: directory() }) ?? []
    const globalList = data.location.skill.list() ?? []
    const byKey = new Map<string, ScopedSkillInfo>()

    for (const item of [...projectList, ...globalList]) {
      const key = skillScopeKey(item)

      if (!byKey.has(key)) byKey.set(key, item)
    }

    return Array.from(byKey.values()).toSorted((a, b) => {
      const aLocal = isProjectLocalSkill(a.path, directory()) ? 1 : 0
      const bLocal = isProjectLocalSkill(b.path, directory()) ? 1 : 0

      if (aLocal !== bLocal) return bLocal - aLocal

      return a.name.localeCompare(b.name)
    })
  })

  const enabledSkillCount = () =>
    allSkills().filter((item) => scopeStore.isProjectSkillEnabled(directory(), item)).length

  const enabledMcpCount = () =>
    allMcps().filter((item) => item.status.status === "connected").length

  return (
    <>
      <div class="settings-tab-header">
        <div class="settings-tab-header-row">
          <div class="flex min-w-0 items-center gap-3">
            <Show when={props.project}>
              {(project) => (
                <ProjectIcon
                  project={project()}
                  class="!size-8 shrink-0 [&_[data-slot=project-avatar-surface]]:!rounded-[6px] [&_[data-slot=project-avatar-surface]]:!text-[16px]"
                />
              )}
            </Show>
            <div class="flex min-w-0 flex-col gap-1">
              <div class="flex items-center gap-2">
                <h2 class="settings-tab-title truncate">{projectTitle()}</h2>
                <span class="rounded bg-v2-background-bg-layer-02 px-2 py-0.5 text-[11px] font-medium text-v2-text-text-muted">
                  {language.tr("项目专属扩展配置", "Project extensions")}
                </span>
              </div>
              <span class="truncate font-mono text-11-regular text-v2-text-text-muted">{directory()}</span>
            </div>
          </div>
          <div class="settings-tab-header-actions">
            <Button variant="ghost-muted" size="small" onClick={() => surface.open("extensions")}>
              {language.tr("前往全局 MCP 与扩展库", "Open global extensions")}
            </Button>
          </div>
        </div>
      </div>

      <div class="settings-tab-body">
        <ProjectFolderMissing />
        <Tabs
          variant="pill"
          value={props.subtab ?? "skills"}
          onChange={(value) => {
            if (value === "mcps" || value === "plugins" || value === "skills" || value === "lsps") props.onSubtab(value)
          }}
          class="project-settings-extension-tabs settings-subtabs"
        >
          <Tabs.List>
            <Tabs.Trigger value="skills">
              Skills ({enabledSkillCount()}/{allSkills().length})
            </Tabs.Trigger>
            <Tabs.Trigger value="mcps">
              MCPs ({enabledMcpCount()}/{allMcps().length})
            </Tabs.Trigger>
          </Tabs.List>

          <Tabs.Content value="skills">
            <div class="project-settings-extension-section">
              <div class="project-settings-extension-section-header">
                <div class="project-settings-extension-section-copy">
                  <span>
                    {language.tr(
                      `当前项目可用的 Skill 技能（已启用 ${enabledSkillCount()} / ${allSkills().length}）`,
                      `Skills available in this project (${enabledSkillCount()} / ${allSkills().length} enabled)`,
                    )}
                  </span>
                  <span class="project-settings-extension-empty-description">
                    {language.tr(
                      "可为当前项目单独开关项目内或全局继承（Codex / Claude / AGY）的 Skill，对话中默认继承此处配置。",
                      "Enable or disable project-local and inherited global skills (Codex / Claude / AGY) for this project.",
                    )}
                  </span>
                </div>
                <Show when={allSkills().length > 0}>
                  <div class="flex items-center gap-1.5">
                    <Button
                      variant="ghost-muted"
                      size="small"
                      onClick={() =>
                        scopeStore.setProjectSkillsBatch(
                          directory(),
                          allSkills().map((skill) => ({
                            skill,
                            enabled: isProjectLocalSkill(skill.path, directory()),
                          })),
                        )
                      }
                    >
                      {language.tr("仅启用项目专属", "Project only")}
                    </Button>
                    <Button
                      variant="ghost-muted"
                      size="small"
                      onClick={() =>
                        scopeStore.setProjectSkillsBatch(
                          directory(),
                          allSkills().map((skill) => ({ skill, enabled: true })),
                        )
                      }
                    >
                      {language.tr("全部启用", "Enable all")}
                    </Button>
                    <Button
                      variant="ghost-muted"
                      size="small"
                      onClick={() =>
                        scopeStore.setProjectSkillsBatch(
                          directory(),
                          allSkills().map((skill) => ({ skill, enabled: false })),
                        )
                      }
                    >
                      {language.tr("全部关闭", "Disable all")}
                    </Button>
                  </div>
                </Show>
              </div>
              <Show when={allSkills().length > 0}>
                <ExtensionCard>
                  <For each={allSkills()}>
                    {(item) => {
                      const origin = () => resolveSkillOrigin(item.path, directory())
                      const enabled = () => scopeStore.isProjectSkillEnabled(directory(), item)

                      return (
                        <ExtensionRow
                          icon="post-skill"
                          name={
                            <>
                              <span>{item.name}</span>
                              <span
                                class={`rounded px-1.5 py-0.5 text-[10px] leading-none font-medium ${origin().class}`}
                              >
                                {origin().label}
                              </span>
                            </>
                          }
                          description={item.description}
                        >
                          <Switch
                            checked={enabled()}
                            hideLabel
                            onChange={(next) => scopeStore.setProjectSkillEnabled(directory(), item, next)}
                          >
                            {item.name}
                          </Switch>
                        </ExtensionRow>
                      )
                    }}
                  </For>
                </ExtensionCard>
              </Show>
            </div>
          </Tabs.Content>

          <Tabs.Content value="mcps">
            <div class="project-settings-extension-section">
              <div class="project-settings-extension-section-header">
                <div class="project-settings-extension-section-copy">
                  <span>
                    {allMcps().length === 0
                      ? language.t("project.settings.extensions.empty.mcps.title")
                      : language.tr(
                          `当前项目可用的 MCP 服务（已连接 ${enabledMcpCount()} / ${allMcps().length}）`,
                          `MCP servers available in this project (${enabledMcpCount()} / ${allMcps().length} connected)`,
                        )}
                  </span>
                  <span class="project-settings-extension-empty-description">
                    {language.tr(
                      "按项目独立控制 MCP 服务连接状态，不同项目之间互不干扰。",
                      "Control MCP server connections independently per project.",
                    )}
                  </span>
                </div>
                <span>{language.t("settings.extensions.manageConfig")}</span>
              </div>
              <Show when={allMcps().length > 0}>
                <ExtensionCard>
                  <For each={allMcps()}>
                    {(item) => {
                      const isProjectOnly = () => !globalMcpSet().has(item.name)

                      return (
                        <ExtensionRow
                          icon="mcp"
                          name={
                            <>
                              <span>{item.name}</span>
                              <span
                                class={`rounded px-1.5 py-0.5 text-[10px] leading-none font-medium ${
                                  isProjectOnly()
                                    ? "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400"
                                    : "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400"
                                }`}
                              >
                                {isProjectOnly() ? language.tr("项目专属", "Project") : language.tr("全局共享", "Global")}
                              </span>
                            </>
                          }
                        >
                          <Switch
                            checked={item.status.status !== "disabled"}
                            disabled={toggleMcp.isPending}
                            hideLabel
                            onChange={(enabled) => {
                              if (toggleMcp.isPending) return
                              toggleMcp.mutate({ name: item.name, enabled })
                            }}
                          >
                            {item.name}
                          </Switch>
                        </ExtensionRow>
                      )
                    }}
                  </For>
                </ExtensionCard>
              </Show>
            </div>
          </Tabs.Content>

          <Tabs.Content value="plugins">
            <div class="project-settings-extension-section">
              <Show
                when={allPlugins().length > 0}
                fallback={
                  <div class="project-settings-extension-section-header">
                    <div class="project-settings-extension-section-copy">
                      <span>{language.t("project.settings.extensions.empty.plugins.title")}</span>
                      <span class="project-settings-extension-empty-description">
                        {language.t("project.settings.extensions.empty.plugins.description")}
                      </span>
                    </div>
                  </div>
                }
              >
                <ExtensionCard>
                  <For each={allPlugins()}>{(name) => <ExtensionRow icon="cube" name={name} />}</For>
                </ExtensionCard>
              </Show>
            </div>
          </Tabs.Content>

          <Tabs.Content value="lsps">
            <ProjectLanguageServers />
          </Tabs.Content>
        </Tabs>
      </div>
    </>
  )
}
