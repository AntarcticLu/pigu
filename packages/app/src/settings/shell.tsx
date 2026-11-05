import { Tabs } from "@opencode/ui/tabs"
import { useDialog } from "@opencode/ui/context/dialog"
import { createEffect, createMemo, For, on, onCleanup, onMount, Show, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { useTabs } from "@/shell/tabs/tabs"
import { useGlobal, useServerCtx } from "@/runtime/server/runtime"
import { ServerConnection } from "@/runtime/server/registry"
import { DialogServer } from "@/servers/connect/dialog"
import { SettingsGeneral } from "./general/general"
import { SettingsAppearance } from "./appearance/appearance"
import { SettingsExperimental } from "./experimental/experimental"
import { SettingsKeybinds } from "./keybinds/keybinds"
import { SettingsNotifications } from "./notifications/notifications"
import { SettingsProviders } from "./providers/providers"
import { SettingsModels } from "./models/models"
import { SettingsServerGeneral, SettingsServerList } from "./servers/servers"
import { SettingsServerSwitcher } from "./servers/switcher"
import { SettingsServerUnavailable } from "./servers/unavailable"
import { settingsServerReachable, useSettingsServers, useSettingsServersLoaded } from "./servers/inventory"
import { SettingsWorkspaces } from "./workspaces/workspaces"
import { SettingsProjects } from "./workspaces/projects"
import { SettingsExtensions } from "./providers/extensions"
import { SettingsAbout } from "./about/about"
import { SettingsServerDataScope } from "./server-scope"
import { SettingsNavigation, type SettingsNavGroup } from "./navigation"
import { useSettingsSurface } from "./surface"
import { settingsViewRedirect, type SettingsRootTab } from "./route"
import { pageIcons } from "./pages"
import { revealSettingsSearch } from "./search-reveal"
import { PluginSettingsPages } from "@/runtime/plugin/settings-page-view"
import "@/settings/settings.css"

const rootClientTabs = [
  { value: "general", icon: pageIcons.general, label: "通用与外观" },
  { value: "shortcuts", icon: pageIcons.shortcuts, label: "快捷键" },
] as const

const serverTabs = [
  { value: "models", icon: pageIcons.models, label: "API 与模型" },
  { value: "extensions", icon: pageIcons.extensions, label: "MCP 与扩展" },
  { value: "projects", icon: pageIcons.projects, label: "项目" },
] as const

// The heading of each per-server page, which its unreachable state keeps.
const serverPages = {
  providers: { title: "settings.providers.title", description: "settings.providers.description" },
  models: { title: "settings.models.title", description: "settings.models.description" },
  extensions: { title: "settings.tab.extensions", description: "settings.extensions.description" },
  projects: { title: "settings.projects.title", description: "settings.projects.description" },
  workspaces: { title: "settings.tab.workspaces", description: "settings.workspaces.description" },
} as const

export function SettingsScreen() {
  const surface = useSettingsSurface()
  const dialog = useDialog()
  const servers = useSettingsServers()
  const loaded = useSettingsServersLoaded()
  let root: HTMLDivElement | undefined
  let viewType = surface.view().type
  let activation = 0

  onMount(() => root?.focus({ preventScroll: true }))
  createEffect(() => {
    const next = surface.view().type

    if (next === viewType) return
    viewType = next
    queueMicrotask(() => {
      const target =
        surface.search.state.query.trim() && surface.search.state.expanded
          ? root?.querySelector<HTMLInputElement>(".settings-search input")
          : root

      target?.focus({ preventScroll: true })
    })
  })

  createEffect(
    on(
      () => [surface.view(), surface.search.state.selected] as const,
      ([view, selected]) => {
        if (
          !root ||
          !selected ||
          !view.searchActivation ||
          view.searchActivation !== surface.search.state.activation ||
          view.searchActivation === activation
        )
          return
        activation = view.searchActivation
        onCleanup(revealSettingsSearch(root, view))
      },
    ),
  )

  createEffect(() => {
    const next = settingsViewRedirect({
      view: surface.view(),
      loaded: loaded(),
      servers: servers().map((item) => ({
        key: item.key,
        connected: !!item.connection,
        starting: item.source?.entry.state === "starting",
      })),
    })

    if (next) surface.replace(next)
  })

  return (
    <div
      ref={root}
      data-testid="settings-screen"
      class="settings-screen"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented || dialog.active) return
        event.preventDefault()

        if (surface.view().type !== "root" && surface.search.back()) return

        if (surface.search.state.query.trim()) {
          surface.search.clear()

          return
        }

        surface.back()
      }}
    >
      <RootSettings />
    </div>
  )
}

function RootSettings() {
  const language = useLanguage()
  const dialog = useDialog()
  const surface = useSettingsSurface()
  const global = useGlobal()
  const inventory = useSettingsServers()

  const [state, setState] = createStore<{ worktreeFilterReset: number; modelProvider: string | undefined }>({
    worktreeFilterReset: 0,
    modelProvider: undefined,
  })

  const multiple = createMemo(() => inventory().length > 1)

  // The selected server while its pages can load; an unreachable one shows its pages' unavailable state instead.
  const reachable = createMemo(() => {
    const entry = surface.server()

    return entry && settingsServerReachable(entry, global.servers.health[entry.key]) ? entry.connection : undefined
  })

  const activeDirectory = useSettingsDirectory(reachable)

  const activeTab = () => {
    const view = surface.view()

    return view.type === "project" ? "projects" : view.tab
  }

  const selectedProjectWorktree = () => {
    const view = surface.view()

    return view.type === "project" ? view.project : activeDirectory()
  }

  createEffect(() => {
    const view = surface.view()

    if (view.type !== "root") return

    if (view.tab === "providers") {
      surface.open("models")

      return
    }

    if (view.tab === "workspaces") {
      surface.open("projects")

      return
    }

    if (
      view.tab === "appearance" ||
      view.tab === "notifications" ||
      view.tab === "experimental" ||
      view.tab === "about"
    ) {
      surface.open("general")
    }
  })

  const selectServer = (server: ServerConnection.Any) => surface.selectServer(ServerConnection.key(server))

  const addServer = () => void dialog.push(() => <DialogServer mode="add" onSave={selectServer} />)

  const groups = createMemo<SettingsNavGroup[]>(() => [
    {
      items: serverTabs.map((item) => ({
        ...item,
      })),
    },
    {
      items: [
        ...rootClientTabs.map((item) => ({ ...item })),
        {
          value: "servers",
          icon: pageIcons.servers,
          label: "服务器 / SSH",
        },
      ],
    },
  ])

  const change = (value: string) => {
    if (value === "workspaces") setState("worktreeFilterReset", (current) => current + 1)
    surface.select(value)
  }

  return (
    <SettingsNavigation
      value={activeTab()}
      groups={groups()}
      backLabel={language.t("settings.backToApp")}
      onBack={() => surface.close()}
      onChange={change}
    >
      <Tabs.Content value="general" class="settings-panel">
        <SettingsGeneral />
      </Tabs.Content>
      <Tabs.Content value="appearance" class="settings-panel">
        <SettingsAppearance />
      </Tabs.Content>
      <Tabs.Content value="notifications" class="settings-panel">
        <SettingsNotifications />
      </Tabs.Content>
      <Tabs.Content value="shortcuts" class="settings-panel">
        <SettingsKeybinds active={activeTab() === "shortcuts"} />
      </Tabs.Content>
      <PluginSettingsPages />
      <Tabs.Content value="experimental" class="settings-panel">
        <SettingsExperimental />
      </Tabs.Content>
      <Tabs.Content value="about" class="settings-panel settings-about">
        <SettingsAbout active={activeTab() === "about"} />
      </Tabs.Content>
      <Show
        when={reachable()}
        keyed
        fallback={
          <Show when={surface.server()}>
            {(entry) => (
              <For each={serverTabs}>
                {(item) => (
                  <Tabs.Content value={item.value} class="settings-panel">
                    <SettingsServerUnavailable
                      entry={entry()}
                      title={language.t(serverPages[item.value].title)}
                      description={language.t(serverPages[item.value].description)}
                      headerAction={<SettingsServerSwitcher />}
                      onManage={() => surface.openServers(entry().key)}
                      onServerChange={selectServer}
                    />
                  </Tabs.Content>
                )}
              </For>
            )}
          </Show>
        }
      >
        {(server) => (
          <SettingsServerDataScope server={server}>
            <Tabs.Content value="providers" class="settings-panel">
              <SettingsProviders
                directory={undefined}
                headerAction={<SettingsServerSwitcher />}
                onSelectProvider={(providerID) => {
                  setState("modelProvider", providerID)
                  surface.select("models")
                }}
              />
            </Tabs.Content>
            <Tabs.Content value="models" class="settings-panel">
              <SettingsModels
                active={activeTab() === "models"}
                provider={state.modelProvider}
                headerAction={<SettingsServerSwitcher />}
                onReveal={() => setState("modelProvider", undefined)}
              />
            </Tabs.Content>
            <Tabs.Content value="extensions" class="settings-panel">
              <SettingsExtensions
                directory={activeDirectory()}
                subtab={surface.view().subtab}
                headerAction={<SettingsServerSwitcher />}
                onSubtab={(value) => surface.subtab(value)}
              />
            </Tabs.Content>
            <Tabs.Content value="projects" class="settings-panel">
              <SettingsProjects
                server={server}
                active={activeTab() === "projects"}
                selectedWorktree={selectedProjectWorktree()}
                headerAction={<SettingsServerSwitcher />}
                onOpenProject={(project) =>
                  surface.openProject({
                    server: ServerConnection.key(server),
                    project: project.worktree,
                  })
                }
              />
            </Tabs.Content>
            <Tabs.Content value="workspaces" class="settings-panel">
              <SettingsWorkspaces
                activeDirectory={activeDirectory()}
                resetProjectFilter={() => state.worktreeFilterReset}
                headerAction={<SettingsServerSwitcher />}
              />
            </Tabs.Content>
          </SettingsServerDataScope>
        )}
      </Show>
      <Tabs.Content value="servers" class="settings-panel">
        <Show
          when={multiple() ? undefined : inventory()[0]}
          fallback={
            <SettingsServerList
              servers={inventory()}
              selected={surface.server()?.key}
              onAddServer={addServer}
              onServerChange={selectServer}
            />
          }
        >
          {(entry) => <SettingsServerGeneral entry={entry()} onAddServer={addServer} />}
        </Show>
      </Tabs.Content>
    </SettingsNavigation>
  )
}

function useSettingsDirectory(server: Accessor<ServerConnection.Any | undefined>) {
  const surface = useSettingsSurface()
  const tabs = useTabs()
  const serverCtx = useServerCtx(server)

  return createMemo(() => {
    const current = server()

    if (!current) return undefined
    const key = ServerConnection.key(current)
    const route = surface.route()

    if (route.type === "session" && route.server === key)
      return serverCtx()?.data.session.get(route.sessionId)?.location.directory

    if (route.type !== "draft") return undefined
    const draft = tabs.store.find((item) => item.type === "draft" && item.draftID === route.draftID)

    return draft?.type === "draft" && draft.server === key ? draft.directory : undefined
  })
}
