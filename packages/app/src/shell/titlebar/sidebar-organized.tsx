import { Schema } from "effect"
import { createEffect, createMemo, Show, onCleanup, type Accessor, type JSX } from "solid-js"
import { Key } from "@solid-primitives/keyed"
import { createStore } from "solid-js/store"
import { useQuery } from "@tanstack/solid-query"
import { DragDropProvider, PointerSensor } from "@dnd-kit/solid"
import { isSortable, useSortable } from "@dnd-kit/solid/sortable"
import { Accessibility, Feedback, PointerActivationConstraints } from "@dnd-kit/dom"
import { RestrictToVerticalAxis } from "@dnd-kit/abstract/modifiers"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Menu } from "@opencode/ui/menu"
import { ScrollView } from "@opencode/ui/scroll-view"
import { displayName } from "@opencode/ui/project-avatar"
import { homeSessionsQuery } from "@/home/sessions/queries"
import { createProjectActions } from "@/home/projects/actions"
import { addProjects } from "@/home/projects/add"
import { ProjectMenuItems } from "@/home/projects/menu"
import { buildHomeSessionRecords } from "@/home/sessions/records"
import { arrayMove } from "@/runtime/array-move"
import { useLanguage } from "@/runtime/i18n/language"
import { Persistence } from "@/runtime/persistence/schema"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { useGlobal, useServerCtx } from "@/runtime/server/runtime"
import type { Project } from "@/runtime/server/types"
import { ProjectIcon } from "@/shell/layout/project-icon"
import { homeProjectDirectories } from "@/shell/layout/helpers"
import { useLayout } from "@/shell/state/layout"
import { createProjectSessionActions } from "@/shell/tabs/project-sessions"
import { useTabs, type Tab } from "@/shell/tabs/tabs"
import { pathKey } from "@/workspaces/path-key"
import { useDirectoryPicker } from "@/workspaces/selection/picker"
import "./tab-nav.css"
import { ProjectSessionRow } from "./project-session-row"
import { createSidebarSessionActivity, mergeSidebarSessions } from "./sidebar-sessions"
import { useArchiveState } from "./archive-store"
import { useExtensionScopeStore } from "./extension-scope-store"

const SidebarState = Persistence.struct({
  projectsCollapsed: Schema.Boolean,
  expanded: Persistence.record(Schema.Boolean),
  order: Persistence.record(Schema.mutable(Schema.Array(Schema.String))),
})

export function SidebarOrganized(props: {
  currentTab: Tab | undefined
  children: (highlightActive: Accessor<boolean>, onNavigate: () => void) => JSX.Element
}) {
  const language = useLanguage()

  const tabs = useTabs()

  const global = useGlobal()

  const activity = createSidebarSessionActivity()

  createEffect(() => {
    global.servers.list().forEach((conn) => {
      const server = ServerConnection.key(conn)

      const ctx = global.serverCtx(server)

      if (!ctx) return
      onCleanup(
        ctx.data.listen(({ details: event }) => {
          const updated = activity.update(server, event)

          if (!updated) return
          const preview = tabs.preview()

          if (
            preview?.server === server &&
            (preview.sessionId === updated.data.sessionID ||
              preview.sessionId === ctx.data.session.root(updated.data.sessionID))
          )
            tabs.keepPreview()
        }),
      )
    })
  })

  const [local, setLocal] = createStore<{
    projectSession: { server: ServerConnection.Key; sessionId: string } | undefined
    thumbTrack: HTMLDivElement | undefined
    hoverTarget: HTMLDivElement | undefined
  }>({ projectSession: undefined, thumbTrack: undefined, hoverTarget: undefined })

  const selectTabs = () => setLocal("projectSession", undefined)

  const projectSelected = () => {
    const tab = props.currentTab

    return (
      tab?.type === "session" &&
      tab.server === local.projectSession?.server &&
      tab.sessionId === local.projectSession?.sessionId
    )
  }

  const [state, setState, , ready] = persisted(Persist.global("sidebar.organize"), SidebarState, {
    projectsCollapsed: false,
    expanded: {},
    order: {},
  })

  const servers = useServers()

  const layout = useLayout()

  const pickDirectory = useDirectoryPicker()

  const archive = useArchiveState()

  const activeConnection = createMemo(
    () =>
      servers.visible.find(
        (conn) => ServerConnection.key(conn) === (props.currentTab?.server ?? layout.home.selection().server),
      ) ?? servers.visible[0],
  )

  const isOpenTab = (server: ServerConnection.Key, sessionId: string) =>
    tabs.store.some((tab) => tab.type === "session" && tab.server === server && tab.sessionId === sessionId)

  return (
    <div
      ref={(element) => setLocal("hoverTarget", element)}
      class="relative flex min-h-0 flex-1 flex-col [app-region:no-drag]"
    >
      <div
        ref={(element) => setLocal("thumbTrack", element)}
        class="pointer-events-none absolute inset-y-0 z-10 w-3"
        style={{
          "inset-inline-end": "calc(-1 * (var(--sidebar-inset-end, 3px) + var(--shell-inline-inset, 8px)))",
        }}
      />
      <ScrollView class="min-h-0 flex-1" thumbContainer={local.thumbTrack} thumbHoverTarget={local.hoverTarget}>
        <div class="flex flex-col gap-3">
          <section class="flex shrink-0 flex-col gap-2">
            <div class="flex h-6 w-full shrink-0 items-center justify-between gap-1 px-1">
              <button
                type="button"
                class="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-[6px] px-1 text-start text-[13px] leading-4 font-medium text-v2-text-text-muted hover:text-v2-text-text-base focus-visible:outline-none focus-visible:bg-v2-overlay-simple-overlay-hover"
                aria-expanded={!state.projectsCollapsed}
                onClick={() => setState("projectsCollapsed", (value) => !value)}
              >
                <span class="min-w-0 truncate">项目</span>
                <Icon
                  name="fill-triangle-down"
                  size="small"
                  class="shrink-0 text-v2-icon-icon-muted transition-transform"
                  classList={{ "-rotate-90 rtl:rotate-90": state.projectsCollapsed }}
                />
              </button>
              <Show when={activeConnection()}>
                {(conn) => (
                  <IconButton
                    icon={<Icon name="plus" size="small" />}
                    variant="ghost-muted"
                    size="small"
                    aria-label="添加项目"
                    title="添加项目"
                    onClick={() => {
                      const ctx = global.serverCtx(ServerConnection.key(conn()))

                      if (!ctx) return
                      pickDirectory({
                        server: conn(),
                        title: language.t("command.project.open"),
                        multiple: true,
                        onSelect: (result) => {
                          const directories = homeProjectDirectories(result)
                          void addProjects(ctx, directories).then((project) => {
                            if (project) archive.setProjectArchived(project.worktree, false)
                          })
                        },
                      })
                    }}
                  />
                )}
              </Show>
            </div>
            <Show when={!state.projectsCollapsed}>
              <div class="flex min-w-0 flex-col gap-1">
                <ProjectList
                  currentTab={props.currentTab}
                  lastActivity={activity.get}
                  isOpenTab={isOpenTab}
                  highlightActive={true}
                  onSelect={(session) => setLocal("projectSession", session)}
                  state={state}
                  ready={ready()}
                  onExpand={(key, next) => setState("expanded", key, next)}
                  onReorder={(server, ids) => setState("order", server, ids)}
                />
              </div>
            </Show>
          </section>
          <div class="hidden">
            {/* The hidden strip still owns tab keyboard shortcuts. */}
            {props.children(() => !projectSelected(), selectTabs)}
          </div>
        </div>
      </ScrollView>
    </div>
  )
}

function ProjectList(props: {
  currentTab: Tab | undefined
  lastActivity: (server: ServerConnection.Key, sessionId: string) => number | undefined
  isOpenTab: (server: ServerConnection.Key, sessionId: string) => boolean
  highlightActive: boolean
  onSelect: (session: { server: ServerConnection.Key; sessionId: string }) => void
  state: typeof SidebarState.Type
  ready: boolean
  onExpand: (key: string, next: boolean) => void
  onReorder: (server: string, ids: string[]) => void
}) {
  const servers = useServers()

  const layout = useLayout()

  const actions = createProjectSessionActions()

  const projectActions = createProjectActions()

  const archive = useArchiveState()

  const scopeStore = useExtensionScopeStore()

  const [local, setLocal] = createStore<{
    showAll: boolean
    showArchivedProjects: boolean
    showArchivedSessions: Record<string, boolean>
    sessionLimits: Record<string, number>
  }>({
    showAll: false,
    showArchivedProjects: false,
    showArchivedSessions: {},
    sessionLimits: {},
  })

  const connection = createMemo(
    () =>
      servers.visible.find(
        (conn) => ServerConnection.key(conn) === (props.currentTab?.server ?? layout.home.selection().server),
      ) ?? servers.visible[0],
  )

  const ctx = useServerCtx(connection)

  const server = () => {
    const conn = connection()

    return conn ? ServerConnection.key(conn) : undefined
  }

  const allProjects = createMemo(() => ctx()?.projects.unique() ?? [])

  const sessions = useQuery(() => ({
    ...homeSessionsQuery(connection(), ctx()),
    enabled: ctx()?.sdk.connection.status() === "connected",
  }))

  createEffect(() => {
    const current = ctx()
    const list = sessions.data?.()

    if (!current || !list || list.length === 0) return
    const known = new Set(current.projects.list().map((project) => project.id))

    if (list.some((session) => !known.has(session.projectID))) {
      void current.sync.project.refresh()
    }
  })

  const records = createMemo(() => {
    const current = ctx()

    if (!current) return []

    return buildHomeSessionRecords({
      sessions: () =>
        current.data.session
          .apply(
            mergeSidebarSessions(sessions.isPending ? [] : (sessions.data?.() ?? []), current.data.session.list(), (id) =>
              props.lastActivity(ServerConnection.key(current.sdk.server), id),
            ),
            { activity: false },
          )
          .filter((session) =>
            scopeStore.isSessionSourceEnabled(String(session.metadata?.source ?? ""), session.location.directory),
          ),
      projects: allProjects,
      projectDirectories: () => undefined,
      resolveProject: current.projects.forSession,
    })
  })

  const grouped = createMemo(() => Map.groupBy(records(), (record) => pathKey(record.project.worktree)))

  const sortedAllProjects = createMemo(() => {
    const list = allProjects()
    const map = grouped()

    return list.toSorted((a, b) => {
      const aSessions = map.get(pathKey(a.worktree)) ?? []
      const bSessions = map.get(pathKey(b.worktree)) ?? []
      const aHas = aSessions.length > 0 ? 1 : 0
      const bHas = bSessions.length > 0 ? 1 : 0

      if (aHas !== bHas) return bHas - aHas

      const aLatest = aSessions[0]?.session.time.updated ?? a.time.active ?? 0
      const bLatest = bSessions[0]?.session.time.updated ?? b.time.active ?? 0

      return bLatest - aLatest
    })
  })

  const projects = createMemo(() => {
    const map = grouped()

    return sortedAllProjects().filter((project, idx) => {
      const count = (map.get(pathKey(project.worktree)) ?? []).length

      return !archive.isProjectArchived(project.worktree, count, idx)
    })
  })

  const archivedProjects = createMemo(() => {
    const map = grouped()

    return sortedAllProjects().filter((project, idx) => {
      const count = (map.get(pathKey(project.worktree)) ?? []).length

      return archive.isProjectArchived(project.worktree, count, idx)
    })
  })

  const visible = () => (local.showAll ? projects() : projects().slice(0, 15))

  const renderProjectItem = (
    conn: Accessor<ServerConnection.Any>,
    project: Accessor<Project>,
    index: Accessor<number>,
    archivedProject: boolean,
  ) => {
    const key = () => `${server()}:${project().id}`

    const projectSessions = () => grouped().get(pathKey(project().worktree)) ?? []

    const shownSessions = () =>
      projectSessions().filter(
        (record, idx) => !archive.isSessionArchived(record.session, idx, projectSessions().length),
      )

    const archivedSessions = () =>
      projectSessions().filter((record, idx) =>
        archive.isSessionArchived(record.session, idx, projectSessions().length),
      )

    const limit = () => local.sessionLimits[key()] ?? 6

    const isExpanded = () =>
      props.state.expanded[key()] ??
      ((!archivedProject && index() < 3 && shownSessions().length > 0) ||
        projectSessions().some(
          (record) => props.currentTab?.type === "session" && props.currentTab.sessionId === record.session.id,
        ))

    return (
      <ProjectRow
        project={project()}
        server={conn()}
        isLocal={servers.local(conn())}
        sessionCount={shownSessions().length || projectSessions().length}
        actions={projectActions}
        index={index()}
        archived={archivedProject}
        expanded={isExpanded()}
        onToggleArchive={() => archive.setProjectArchived(project().worktree, !archivedProject)}
        onToggle={() => {
          const next = !isExpanded()

          if (!next) setLocal("sessionLimits", key(), 6)
          props.onExpand(key(), next)
        }}
      >
        <Key
          each={shownSessions().slice(0, limit())}
          by={(record) => record.session.id}
          fallback={<div class="ps-8 pe-2 py-1.5 text-12-regular text-v2-text-text-faint">暂无会话</div>}
        >
          {(record) => (
            <ProjectSessionRow
              server={ServerConnection.key(conn())}
              session={record().session}
              openTab={props.isOpenTab(ServerConnection.key(conn()), record().session.id)}
              active={
                props.highlightActive &&
                props.currentTab?.type === "session" &&
                props.currentTab.server === ServerConnection.key(conn()) &&
                props.currentTab.sessionId === record().session.id
              }
              archived={false}
              onToggleArchive={() => archive.setSessionArchived(record().session.id, true)}
              onOpen={() => {
                props.onSelect({
                  server: ServerConnection.key(conn()),
                  sessionId: record().session.id,
                })
                actions.openProjectSession(conn(), project().worktree, record().session, { preview: true })
              }}
            />
          )}
        </Key>
        <Show when={shownSessions().length > limit()}>
          <Button
            variant="ghost-muted"
            size="small"
            class="ms-[23px] self-start"
            onClick={() => setLocal("sessionLimits", key(), (value) => (value ?? 6) + 6)}
          >
            展开更多 ({shownSessions().length - limit()})
          </Button>
        </Show>
        <Show when={archivedSessions().length > 0}>
          <div class="mt-0.5 flex flex-col gap-0.5">
            <button
              type="button"
              class="flex h-6 items-center gap-1 rounded-[5px] ps-8 pe-2 text-start text-[11px] text-v2-text-text-faint hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-muted"
              onClick={() => setLocal("showArchivedSessions", key(), (value) => !value)}
            >
              <Icon
                name="fill-triangle-down"
                size="small"
                class="shrink-0 text-v2-icon-icon-faint transition-transform"
                classList={{ "-rotate-90 rtl:rotate-90": !local.showArchivedSessions[key()] }}
              />
              <span>已收纳会话 ({archivedSessions().length})</span>
            </button>
            <Show when={local.showArchivedSessions[key()]}>
              <div class="flex flex-col gap-[2px] opacity-80">
                <Key each={archivedSessions()} by={(record) => record.session.id}>
                  {(record) => (
                    <ProjectSessionRow
                      server={ServerConnection.key(conn())}
                      session={record().session}
                      openTab={props.isOpenTab(ServerConnection.key(conn()), record().session.id)}
                      active={
                        props.highlightActive &&
                        props.currentTab?.type === "session" &&
                        props.currentTab.server === ServerConnection.key(conn()) &&
                        props.currentTab.sessionId === record().session.id
                      }
                      archived={true}
                      onToggleArchive={() => archive.setSessionArchived(record().session.id, false)}
                      onOpen={() => {
                        props.onSelect({
                          server: ServerConnection.key(conn()),
                          sessionId: record().session.id,
                        })
                        actions.openProjectSession(conn(), project().worktree, record().session, {
                          preview: true,
                        })
                      }}
                    />
                  )}
                </Key>
              </div>
            </Show>
          </div>
        </Show>
      </ProjectRow>
    )
  }

  return (
    <>
      <Show when={connection()}>
        {(conn) => (
          <>
            <DragDropProvider
              sensors={[
                PointerSensor.configure({
                  activationConstraints: [new PointerActivationConstraints.Distance({ value: 4 })],
                  preventActivation: (event) =>
                    event.target instanceof Element && !!event.target.closest("[data-project-action]"),
                }),
              ]}
              modifiers={[RestrictToVerticalAxis]}
              plugins={(defaults) => [
                ...defaults.filter((plugin) => plugin !== Accessibility),
                Feedback.configure({ dropAnimation: null }),
              ]}
              onDragEnd={(event) => {
                const source = event.operation.source

                if (event.canceled || !isSortable(source) || source.initialIndex === source.index) return
                props.onReorder(
                  ServerConnection.key(conn()),
                  arrayMove(
                    projects().map((project) => project.id),
                    source.initialIndex,
                    source.index,
                  ),
                )
              }}
            >
              <Key each={visible()} by={(project) => `${ServerConnection.key(conn())}:${project.id}`}>
                {(project, index) => renderProjectItem(conn, project, index, false)}
              </Key>
            </DragDropProvider>
            <Show when={archivedProjects().length > 0}>
              <div class="mt-1 flex flex-col gap-1 border-t border-v2-border-border-muted/60 pt-1.5">
                <div class="flex items-center px-1">
                  <button
                    type="button"
                    class="flex h-6 flex-1 items-center gap-1.5 rounded-[6px] px-1 text-start text-[12px] font-medium text-v2-text-text-faint hover:text-v2-text-text-muted"
                    onClick={() => setLocal("showArchivedProjects", (value) => !value)}
                  >
                    <Icon
                      name="fill-triangle-down"
                      size="small"
                      class="shrink-0 text-v2-icon-icon-faint transition-transform"
                      classList={{ "-rotate-90 rtl:rotate-90": !local.showArchivedProjects }}
                    />
                    <span>已收纳项目 ({archivedProjects().length})</span>
                  </button>
                </div>
                <Show when={local.showArchivedProjects}>
                  <div class="flex flex-col gap-0.5 ps-1 opacity-85">
                    <Key
                      each={archivedProjects()}
                      by={(project) => `${ServerConnection.key(conn())}:archived:${project.id}`}
                    >
                      {(project, index) => renderProjectItem(conn, project, index, true)}
                    </Key>
                  </div>
                </Show>
              </div>
            </Show>
          </>
        )}
      </Show>
    </>
  )
}

function SortableProjectContainer(props: { id: string; index: number; enabled: boolean; children: JSX.Element }) {
  if (!props.enabled) {
    return <div class="relative shrink-0">{props.children}</div>
  }

  const sortable = useSortable({
    get id() {
      return props.id
    },
    get index() {
      return props.index
    },
  })

  return (
    <div ref={sortable.ref} class="relative shrink-0">
      {props.children}
    </div>
  )
}

function ProjectRow(props: {
  project: Project
  server: ServerConnection.Any
  isLocal: boolean
  sessionCount: number
  actions: ReturnType<typeof createProjectActions>
  index: number
  archived?: boolean
  expanded: boolean
  onToggleArchive: () => void
  onToggle: () => void
  children: JSX.Element
}) {
  const language = useLanguage()

  const [menu, setMenu] = createStore({ open: false })

  return (
    <SortableProjectContainer id={props.project.id} index={props.index} enabled={!props.archived}>
      <div
        class="group/project relative flex h-7 min-w-0 shrink-0 items-center rounded-[6px] pe-1 hover:bg-v2-overlay-simple-overlay-hover has-[:focus-visible]:bg-v2-overlay-simple-overlay-hover"
        onContextMenu={(event) => {
          event.preventDefault()
          setMenu("open", true)
        }}
        onKeyDown={(event) => {
          if (event.key !== "ContextMenu" && (event.key !== "F10" || !event.shiftKey)) return
          event.preventDefault()
          setMenu("open", true)
        }}
      >
        <button
          type="button"
          class="flex h-full min-w-0 flex-1 shrink-0 cursor-default items-center gap-1.5 rounded-[6px] bg-transparent px-2 text-start text-[13px] leading-[var(--line-height-compact)] text-v2-text-text-muted [font-weight:500] transition-colors duration-[120ms] ease-in-out group-hover/project:text-v2-text-text-base focus-visible:text-v2-text-text-base focus-visible:outline-none"
          aria-expanded={props.expanded}
          title={props.project.worktree}
          onClick={props.onToggle}
        >
          <span class="flex size-4 shrink-0 items-center justify-center">
            <ProjectIcon project={props.project} />
          </span>
          <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap" dir="auto">
            {displayName(props.project)}
          </span>
          <span
            class={`shrink-0 rounded px-1 py-0.5 text-[10px] leading-none font-medium ${
              props.isLocal
                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "bg-blue-500/10 text-blue-600 dark:text-blue-400"
            }`}
          >
            {props.isLocal ? "本地" : "远程"}
          </span>
          <Show when={props.sessionCount > 0}>
            <span class="shrink-0 text-[11px] text-v2-text-text-faint group-hover/project:hidden">
              {props.sessionCount}
            </span>
          </Show>
        </button>
        <span
          data-project-action
          data-menu={menu.open}
          class="hover-reveal flex shrink-0 items-center gap-1 group-hover/project:opacity-100 focus-within:opacity-100 data-[menu=true]:opacity-100"
        >
          <Menu
            gutter={6}
            modal={false}
            placement="bottom-end"
            open={menu.open}
            onOpenChange={(open) => setMenu("open", open)}
          >
            <Menu.Trigger
              as={IconButton}
              variant="ghost-muted"
              size="small"
              icon={<Icon name="outline-dots" />}
              aria-label={language.t("common.moreOptions")}
            />
            <Menu.Portal>
              <Menu.Content>
                <ProjectMenuItems
                  server={props.server}
                  project={props.project}
                  unread={props.actions.hasUnread(props.server, props.project)}
                  archived={props.archived}
                  canImportSession={props.actions.canImportSession}
                  canRevealProject={props.actions.canReveal}
                  onOpenProjectNewSession={props.actions.openNewSession}
                  onImportSession={props.actions.importSession}
                  onEditProject={props.actions.edit}
                  onRevealProject={props.actions.reveal}
                  onClearNotifications={props.actions.clearNotifications}
                  onHideProject={() => props.onToggleArchive()}
                />
              </Menu.Content>
            </Menu.Portal>
          </Menu>
          <IconButton
            icon={<Icon name="plus" size="small" />}
            variant="ghost-muted"
            size="small"
            aria-label={language.t("command.session.new")}
            onClick={() => props.actions.openNewSession(props.server, props.project.worktree)}
          />
        </span>
      </div>
      <Show when={props.expanded}>
        <div data-project-action class="flex flex-col gap-[3px] pb-1">
          {props.children}
        </div>
      </Show>
    </SortableProjectContainer>
  )
}
