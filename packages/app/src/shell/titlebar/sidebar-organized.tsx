import { Schema } from "effect"
import type { SessionInfo } from "@opencode/client/promise"
import { createEffect, createMemo, For, Show, onCleanup, untrack, type Accessor, type JSX } from "solid-js"
import { Key } from "@solid-primitives/keyed"
import { createStore } from "solid-js/store"
import { useQueries, useQueryClient } from "@tanstack/solid-query"
import { ActivityRing } from "@opencode/ui/activity-ring"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Menu } from "@opencode/ui/menu"
import { prefersReducedMotion } from "@opencode/ui/motion"
import { ScrollView } from "@opencode/ui/scroll-view"
import { displayName } from "@opencode/ui/project-avatar"
import { homeSessionsQuery } from "@/home/sessions/queries"
import { createProjectActions } from "@/home/projects/actions"
import { addProjects } from "@/home/projects/add"
import { ProjectMenuItems } from "@/home/projects/menu"
import { buildHomeSessionRecords, type HomeSessionRecord } from "@/home/sessions/records"
import { tr, useLanguage } from "@/runtime/i18n/language"
import { Persistence } from "@/runtime/persistence/schema"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { ServerConnection, serverName, useServers } from "@/runtime/server/registry"
import { useGlobal, type ServerCtx } from "@/runtime/server/runtime"
import type { Project } from "@/runtime/server/types"
import { ProjectIcon } from "@/shell/layout/project-icon"
import { sessionBusy, sessionRequests } from "@/shell/layout/project-avatar-state"
import { homeProjectDirectories } from "@/shell/layout/helpers"
import { projectSettingsKey, useSettings } from "@/settings/model"
import { useLayout } from "@/shell/state/layout"
import { createProjectSessionActions } from "@/shell/tabs/project-sessions"
import { useTabs, type Tab } from "@/shell/tabs/tabs"
import { pathKey } from "@/workspaces/path-key"
import { useDirectoryPicker } from "@/workspaces/selection/picker"
import "./tab-nav.css"
import { usePinState } from "./pin-store"
import { ProjectSessionRow } from "./project-session-row"
import {
  createSidebarSessionActivity,
  isSidebarCompletionOrAttentionEvent,
  mergeSidebarSessions,
} from "./sidebar-sessions"
import { isIntrinsicArchivedProject, useArchiveState } from "./archive-store"
import { useExtensionScopeStore } from "./extension-scope-store"

const EXTERNAL_SYNC_INTERVAL_MS = 8_000

const SidebarState = Persistence.struct({
  projectsCollapsed: Schema.Boolean,
  expanded: Persistence.record(Schema.Boolean),
  order: Persistence.record(Schema.mutable(Schema.Array(Schema.String))),
})

type UnifiedProjectEntry = {
  readonly key: string
  readonly serverKey: ServerConnection.Key
  readonly conn: ServerConnection.Any
  readonly ctx: ServerCtx
  readonly isLocal: boolean
  readonly project: Project
  readonly sessions: HomeSessionRecord[]
  readonly pending: boolean
  readonly latestTimestamp: number
  readonly hasAttention: boolean
  readonly collapsedAlert: "attention" | "working" | "unread" | undefined
}

export function SidebarOrganized(props: {
  currentTab: Tab | undefined
  children: (highlightActive: Accessor<boolean>, onNavigate: () => void) => JSX.Element
}) {
  const language = useLanguage()
  const tabs = useTabs()
  const global = useGlobal()
  const servers = useServers()
  const layout = useLayout()
  const settings = useSettings()
  const queryClient = useQueryClient()
  const pickDirectory = useDirectoryPicker()
  const actions = createProjectSessionActions()
  const projectActions = createProjectActions()
  const archive = useArchiveState()
  const scopeStore = useExtensionScopeStore()
  const pins = usePinState()
  const activity = createSidebarSessionActivity()

  const [state, setState] = persisted(Persist.global("sidebar.organize"), SidebarState, {
    projectsCollapsed: false,
    expanded: {},
    order: {},
  })

  const [local, setLocal] = createStore<{
    projectSession: { server: ServerConnection.Key; sessionId: string } | undefined
    thumbTrack: HTMLDivElement | undefined
    hoverTarget: HTMLDivElement | undefined
    showAll: boolean
    showArchivedProjects: boolean
    showArchivedSessions: Record<string, boolean>
    sessionLimits: Record<string, number>
  }>({
    projectSession: undefined,
    thumbTrack: undefined,
    hoverTarget: undefined,
    showAll: false,
    showArchivedProjects: false,
    showArchivedSessions: {},
    sessionLimits: {},
  })

  const selectTabs = () => setLocal("projectSession", undefined)

  const projectSelected = () => {
    const tab = props.currentTab

    return (
      tab?.type === "session" &&
      tab.server === local.projectSession?.server &&
      tab.sessionId === local.projectSession?.sessionId
    )
  }

  const connections = createMemo(() =>
    servers.visible.flatMap((conn) => {
      const serverKey = ServerConnection.key(conn)
      const ctx = global.serverCtx(serverKey)
      return ctx ? [{ conn, serverKey, ctx, isLocal: servers.local(conn) }] : []
    }),
  )

  // Listen for live session events across all connected servers (Local + SSH) so started, waiting, and completed
  // sessions immediately advance both their own position and their parent project's position to #1.
  createEffect(() => {
    const invalidateTimers = new Map<string, ReturnType<typeof setTimeout>>()
    onCleanup(() => {
      invalidateTimers.forEach((timer) => clearTimeout(timer))
      invalidateTimers.clear()
    })

    const scheduleIndexRefresh = (conn: ServerConnection.Any, key: string) => {
      const existing = invalidateTimers.get(key)
      if (existing !== undefined) clearTimeout(existing)
      invalidateTimers.set(
        key,
        setTimeout(() => {
          invalidateTimers.delete(key)
          void queryClient.invalidateQueries({ queryKey: ["home-sessions", conn], exact: true })
        }, 350),
      )
    }

    connections().forEach((item) => {
      const server = item.serverKey
      const ctx = item.ctx

      onCleanup(
        ctx.data.listen(({ details: event }) => {
          const updated = activity.update(
            server,
            event,
            "sessionID" in event.data && typeof event.data.sessionID === "string"
              ? ctx.data.session.root(event.data.sessionID)
              : event.type === "form.created"
                ? ctx.data.session.root(event.data.form.sessionID)
                : undefined,
          )

          if (!updated) return
          const rootID = ctx.data.session.root(updated.sessionID)

          // Ensure brand-new or unloaded background sessions (e.g. from Mobile IM or subagents) load into the store immediately.
          if (!ctx.data.session.get(rootID)) {
            void ctx.data.session.sync(rootID).catch(() => undefined)
          }

          // When a session finishes or pauses waiting on the user, auto-expand its project and unarchive if soft-archived
          // so the completed/waiting session is immediately visible at the top of the sidebar.
          if (isSidebarCompletionOrAttentionEvent(event)) {
            const known = ctx.data.session.get(rootID)
            const proj = known ? ctx.projects.forSession(known) : undefined
            if (proj) {
              setState("expanded", `${server}:${proj.id}`, true)
            }
          }

          if (
            isSidebarCompletionOrAttentionEvent(event) ||
            event.type === "session.created" ||
            event.type === "session.moved"
          ) {
            scheduleIndexRefresh(item.conn, server)
          }

          const preview = tabs.preview()
          if (preview?.server === server && (preview.sessionId === updated.sessionID || preview.sessionId === rootID)) {
            tabs.keepPreview()
          }
        }),
      )
    })
  })

  const sessionQueries = useQueries(() => ({
    queries: connections().map((item) => ({
      ...homeSessionsQuery(item.conn, item.ctx),
      enabled: item.ctx.sdk.connection.status() === "connected",
      // Periodically sync external CLI sessions (claude, codex, agy, dsh) running in standalone terminals so completed
      // external sessions also float their session and project to the top automatically.
      refetchInterval: () =>
        typeof document === "undefined" || !document.hidden ? EXTERNAL_SYNC_INTERVAL_MS : false,
    })),
  }))

  const attemptedProjectRefresh = new WeakMap<object, Set<string>>()

  createEffect(() => {
    connections().forEach((item, index) => {
      const current = item.ctx
      const list = sessionQueries[index]?.data?.()
      if (!current.sync.project.ready() || !list || list.length === 0) return

      const attempted = attemptedProjectRefresh.get(current) ?? new Set<string>()
      attemptedProjectRefresh.set(current, attempted)
      const known = new Set(untrack(() => current.projects.list()).map((project) => project.id))
      const missing = list.flatMap((session) =>
        !known.has(session.projectID) && !attempted.has(session.projectID) ? [session.projectID] : [],
      )
      if (missing.length === 0) return
      missing.forEach((id) => attempted.add(id))
      void current.sync.project.refresh()
    })
  })

  const allProjectEntries = createMemo<UnifiedProjectEntry[]>(() =>
    connections().flatMap((item, idx) => {
      const current = item.ctx
      const server = item.serverKey
      const query = sessionQueries[idx]
      const pending = Boolean(query?.isPending)

      const serverProjects = current.projects
        .unique()
        .filter((project) => !archive.isProjectDeleted(project.worktree))

      const sessionRank = (session: SessionInfo): number => {
        const projKey = projectSettingsKey(current.sdk.scope, session.projectID)
        const reqs = sessionRequests(current, session.id, true, settings.permissions.autoApproves(projKey))
        if (reqs.permission || reqs.form) return 0
        if (pins.isPinned(server, session.id)) return 1
        return 2
      }

      const isSessionBusy = (session: SessionInfo): boolean =>
        sessionBusy(current.data, session.id) ||
        current.data.session
          .list()
          .some((child) => current.data.session.root(child.id) === session.id && sessionBusy(current.data, child.id))

      const records = buildHomeSessionRecords({
        sessions: () =>
          current.data.session
            .apply(
              mergeSidebarSessions(
                pending ? [] : (query?.data?.() ?? []),
                current.data.session.list(),
                (id) => activity.get(server, id),
              ),
              { activity: false },
            )
            .filter(
              (session) =>
                !archive.isProjectDeleted(session.location.directory) &&
                scopeStore.isSessionSourceEnabled(String(session.metadata?.source ?? ""), session.location.directory),
            ),
        projects: () => serverProjects,
        projectDirectories: () => undefined,
        resolveProject: current.projects.forSession,
      })

      const grouped = Map.groupBy(records, (record) => pathKey(record.project.worktree))

      return serverProjects.map((project): UnifiedProjectEntry => {
        const rawSessions = grouped.get(pathKey(project.worktree)) ?? []
        const sortedSessions = rawSessions.toSorted((a, b) => {
          const rankDiff = sessionRank(a.session) - sessionRank(b.session)
          if (rankDiff !== 0) return rankDiff
          if (sessionRank(a.session) === 1) {
            const pinDiff =
              (pins.pinnedTimestamp(server, b.session.id) ?? 0) -
              (pins.pinnedTimestamp(server, a.session.id) ?? 0)
            if (pinDiff !== 0) return pinDiff
          }
          return (b.session.time.updated ?? 0) - (a.session.time.updated ?? 0)
        })

        const maxSessionTime = rawSessions.reduce(
          (max, rec) => Math.max(max, rec.session.time.updated ?? 0),
          0,
        )
        const latestTimestamp = Math.max(maxSessionTime, project.time.active ?? 0)
        const hasAttention = sortedSessions.some((rec) => sessionRank(rec.session) === 0)
        const hasWorking = sortedSessions.some((rec) => isSessionBusy(rec.session))
        const hasUnread = sortedSessions.some((rec) =>
          current.notification.session.unread(rec.session.id, rec.session),
        )

        const collapsedAlert: "attention" | "working" | "unread" | undefined = hasAttention
          ? "attention"
          : hasWorking
            ? "working"
            : hasUnread
              ? "unread"
              : undefined

        return {
          key: `${server}:${project.id}`,
          serverKey: server,
          conn: item.conn,
          ctx: current,
          isLocal: item.isLocal,
          project,
          sessions: sortedSessions,
          pending,
          latestTimestamp,
          hasAttention,
          collapsedAlert,
        }
      })
    }),
  )

  const sortedProjectEntries = createMemo(() =>
    allProjectEntries().toSorted((a, b) => {
      if (a.hasAttention !== b.hasAttention) return a.hasAttention ? -1 : 1
      const aHas = a.pending ? 1 : a.sessions.length > 0 ? 1 : 0
      const bHas = b.pending ? 1 : b.sessions.length > 0 ? 1 : 0
      if (aHas !== bHas) return bHas - aHas
      if (b.latestTimestamp !== a.latestTimestamp) return b.latestTimestamp - a.latestTimestamp
      return a.key.localeCompare(b.key)
    }),
  )

  const partitionedProjects = createMemo(() => {
    const active: UnifiedProjectEntry[] = []
    const archived: UnifiedProjectEntry[] = []
    let activeRank = 0

    sortedProjectEntries().forEach((entry) => {
      const count = entry.sessions.length
      const effectiveCount = entry.pending ? Math.max(count, 1) : count
      const intrinsic = isIntrinsicArchivedProject(entry.project.worktree, effectiveCount)
      const rank = intrinsic ? 999 : activeRank
      if (!intrinsic) activeRank += 1
      if (!entry.hasAttention && archive.isProjectArchived(entry.project.worktree, effectiveCount, rank)) {
        archived.push(entry)
        return
      }
      active.push(entry)
    })

    return { active, archived }
  })

  const visibleProjects = () =>
    local.showAll ? partitionedProjects().active : partitionedProjects().active.slice(0, 15)
  const archivedProjects = () => partitionedProjects().archived

  // Smooth FLIP glide when a project or session moves up on activity/completion.
  let previousTops = new Map<string, number>()

  createEffect(() => {
    const orderSignature = visibleProjects()
      .map((entry) => `${entry.key}[${entry.sessions.slice(0, 6).map((s) => s.session.id).join(",")}]`)
      .join("|")
    void orderSignature

    const container = local.hoverTarget
    if (!container) return

    const before = previousTops
    requestAnimationFrame(() => {
      const nextTops = new Map<string, number>()
      const scroller = container.querySelector<HTMLElement>("[data-scrollable]")
      const containerTop = container.getBoundingClientRect().top
      const scrollTop = scroller?.scrollTop ?? 0
      const nodes = container.querySelectorAll<HTMLElement>("[data-sidebar-flip-key]")
      nodes.forEach((node) => {
        const flipKey = node.dataset.sidebarFlipKey
        if (!flipKey) return
        const logicalTop = node.getBoundingClientRect().top - containerTop + scrollTop
        nextTops.set(flipKey, logicalTop)
        if (prefersReducedMotion()) return
        const prevTop = before.get(flipKey)
        if (prevTop === undefined) return
        const delta = prevTop - logicalTop
        if (Math.abs(delta) < 4 || Math.abs(delta) > 600) return
        node.animate([{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }], {
          duration: 200,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        })
      })
      previousTops = nextTops
    })
  })

  const activeConnection = createMemo(
    () =>
      servers.visible.find(
        (conn) => ServerConnection.key(conn) === (props.currentTab?.server ?? layout.home.selection().server),
      ) ?? servers.visible[0],
  )

  const isOpenTab = (server: ServerConnection.Key, sessionId: string) =>
    tabs.store.some((tab) => tab.type === "session" && tab.server === server && tab.sessionId === sessionId)

  const openAddProject = (conn: ServerConnection.Any) => {
    const key = ServerConnection.key(conn)
    const ctx = global.serverCtx(key)

    if (!ctx) return
    pickDirectory({
      server: conn,
      title: language.t("command.project.open"),
      multiple: true,
      onSelect: (result) => {
        const directories = homeProjectDirectories(result)
        directories.forEach((directory) => archive.setProjectArchived(directory, false))
        void addProjects(ctx, directories).then((project) => {
          if (project) archive.setProjectArchived(project.worktree, false)
        })

        if (directories[0]) void tabs.newDraft({ server: key, directory: directories[0] })
      },
    })
  }

  const renderProjectEntry = (
    entry: Accessor<UnifiedProjectEntry>,
    index: Accessor<number>,
    archivedProject: boolean,
  ) => {
    const key = () => entry().key

    const shownSessions = () =>
      entry().sessions.filter(
        (record, idx) =>
          pins.isPinned(entry().serverKey, record.session.id) ||
          !archive.isSessionArchived(record.session, idx, entry().sessions.length),
      )

    const archivedSessions = () =>
      entry().sessions.filter(
        (record, idx) =>
          !pins.isPinned(entry().serverKey, record.session.id) &&
          archive.isSessionArchived(record.session, idx, entry().sessions.length),
      )

    const limit = () => local.sessionLimits[key()] ?? 12

    const isExpanded = () =>
      state.expanded[key()] ??
      ((!archivedProject && index() < 3 && shownSessions().length > 0) ||
        entry().sessions.some(
          (record) =>
            props.currentTab?.type === "session" &&
            props.currentTab.server === entry().serverKey &&
            props.currentTab.sessionId === record.session.id,
        ))

    return (
      <ProjectRow
        flipKey={`proj:${key()}`}
        project={entry().project}
        server={entry().conn}
        isLocal={entry().isLocal}
        sessionCount={shownSessions().length || entry().sessions.length}
        alert={!isExpanded() ? entry().collapsedAlert : undefined}
        actions={projectActions}
        archived={archivedProject}
        expanded={isExpanded()}
        onToggleArchive={() => archive.setProjectArchived(entry().project.worktree, !archivedProject)}
        onToggle={() => {
          const next = !isExpanded()
          if (!next) setLocal("sessionLimits", key(), 12)
          setState("expanded", key(), next)
        }}
      >
        <Key
          each={shownSessions().slice(0, limit())}
          by={(record) => record.session.id}
          fallback={
            <div class="ps-8 pe-2 py-1.5 text-12-regular text-v2-text-text-faint">{tr("暂无会话", "No sessions")}</div>
          }
        >
          {(record) => (
            <div data-sidebar-flip-key={`ses:${entry().serverKey}:${record().session.id}`}>
              <ProjectSessionRow
                server={entry().serverKey}
                session={record().session}
                openTab={isOpenTab(entry().serverKey, record().session.id)}
                active={
                  props.currentTab?.type === "session" &&
                  props.currentTab.server === entry().serverKey &&
                  props.currentTab.sessionId === record().session.id
                }
                archived={false}
                onToggleArchive={() => archive.setSessionArchived(record().session.id, true)}
                onOpen={() => {
                  setLocal("projectSession", {
                    server: entry().serverKey,
                    sessionId: record().session.id,
                  })
                  actions.openProjectSession(entry().conn, entry().project.worktree, record().session, {
                    preview: true,
                  })
                }}
              />
            </div>
          )}
        </Key>
        <Show when={shownSessions().length > limit()}>
          <Button
            variant="ghost-muted"
            size="small"
            class="ms-[23px] self-start"
            onClick={() => setLocal("sessionLimits", key(), (value) => (value ?? 12) + 12)}
          >
            {tr("展开更多", "Show more")} ({shownSessions().length - limit()})
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
              <span>
                {tr("已收纳会话", "Archived sessions")} ({archivedSessions().length})
              </span>
            </button>
            <Show when={local.showArchivedSessions[key()]}>
              <div class="flex flex-col gap-[2px] opacity-80">
                <Key each={archivedSessions()} by={(record) => record.session.id}>
                  {(record) => (
                    <ProjectSessionRow
                      server={entry().serverKey}
                      session={record().session}
                      openTab={isOpenTab(entry().serverKey, record().session.id)}
                      active={
                        props.currentTab?.type === "session" &&
                        props.currentTab.server === entry().serverKey &&
                        props.currentTab.sessionId === record().session.id
                      }
                      archived={true}
                      onToggleArchive={() => archive.setSessionArchived(record().session.id, false)}
                      onOpen={() => {
                        setLocal("projectSession", {
                          server: entry().serverKey,
                          sessionId: record().session.id,
                        })
                        actions.openProjectSession(entry().conn, entry().project.worktree, record().session, {
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
                <span class="min-w-0 truncate">{tr("项目", "Projects")}</span>
                <Icon
                  name="fill-triangle-down"
                  size="small"
                  class="shrink-0 text-v2-icon-icon-muted transition-transform"
                  classList={{ "-rotate-90 rtl:rotate-90": state.projectsCollapsed }}
                />
              </button>
              <Show
                when={servers.visible.length > 1}
                fallback={
                  <Show when={activeConnection()}>
                    {(conn) => (
                      <IconButton
                        icon={<Icon name="plus" size="small" />}
                        variant="ghost-muted"
                        size="small"
                        aria-label={tr("添加项目", "Add project")}
                        title={tr("添加项目", "Add project")}
                        onClick={() => openAddProject(conn())}
                      />
                    )}
                  </Show>
                }
              >
                <Menu gutter={6} modal={false} placement="bottom-end">
                  <Menu.Trigger
                    as={IconButton}
                    icon={<Icon name="plus" size="small" />}
                    variant="ghost-muted"
                    size="small"
                    aria-label={tr("添加项目", "Add project")}
                    title={tr("添加项目", "Add project")}
                  />
                  <Menu.Portal>
                    <Menu.Content>
                      <For each={servers.visible}>
                        {(conn) => (
                          <Menu.Item onSelect={() => openAddProject(conn)}>
                            {servers.local(conn)
                              ? tr("添加本地项目", "Add local project")
                              : tr(
                                  `在 ${serverName(conn) || "远程服务器"} 上打开项目`,
                                  `Open project on ${serverName(conn) || "remote server"}`,
                                )}
                          </Menu.Item>
                        )}
                      </For>
                    </Menu.Content>
                  </Menu.Portal>
                </Menu>
              </Show>
            </div>
            <Show when={!state.projectsCollapsed}>
              <div class="flex min-w-0 flex-col gap-0.5">
                <Key each={visibleProjects()} by={(entry) => entry.key}>
                  {(entry, index) => renderProjectEntry(entry, index, false)}
                </Key>
                <Show when={!local.showAll && partitionedProjects().active.length > 15}>
                  <Button
                    variant="ghost-muted"
                    size="small"
                    class="ms-2 self-start"
                    onClick={() => setLocal("showAll", true)}
                  >
                    {tr("显示全部项目", "Show all projects")} ({partitionedProjects().active.length - 15})
                  </Button>
                </Show>
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
                        <span>
                          {tr("已收纳项目", "Archived projects")} ({archivedProjects().length})
                        </span>
                      </button>
                    </div>
                    <Show when={local.showArchivedProjects}>
                      <div class="flex flex-col gap-0.5 ps-1 opacity-85">
                        <Key each={archivedProjects()} by={(entry) => `archived:${entry.key}`}>
                          {(entry, index) => renderProjectEntry(entry, index, true)}
                        </Key>
                      </div>
                    </Show>
                  </div>
                </Show>
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

function ProjectRow(props: {
  flipKey?: string
  project: Project
  server: ServerConnection.Any
  isLocal: boolean
  sessionCount: number
  alert?: "attention" | "working" | "unread"
  actions: ReturnType<typeof createProjectActions>
  archived?: boolean
  expanded: boolean
  onToggleArchive: () => void
  onToggle: () => void
  children: JSX.Element
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const [menu, setMenu] = createStore({ open: false })

  return (
    <div data-sidebar-flip-key={props.flipKey} class="relative shrink-0">
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
          title={
            props.isLocal
              ? props.project.worktree
              : `${tr("远程", "Remote")} · ${serverName(props.server) || tr("远程", "Remote")}: ${props.project.worktree}`
          }
          onClick={props.onToggle}
        >
          <span class="flex size-4 shrink-0 items-center justify-center">
            <ProjectIcon project={props.project} />
          </span>
          <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap" dir="auto">
            {displayName(props.project)}
          </span>
          <Show when={props.alert}>
            {(alert) => (
              <span class="flex shrink-0 items-center justify-center">
                <Show when={alert() !== "working"} fallback={<ActivityRing class="shrink-0" />}>
                  <span
                    class="size-2 shrink-0 rounded-full"
                    classList={{
                      "animate-pulse bg-amber-500": alert() === "attention",
                      "bg-blue-500": alert() === "unread",
                    }}
                  />
                </Show>
              </span>
            )}
          </Show>
          <span
            class={`max-w-[84px] shrink-0 truncate rounded px-1 py-0.5 text-[10px] leading-none font-medium ${
              props.isLocal
                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "bg-blue-500/10 text-blue-600 dark:text-blue-400"
            }`}
          >
            {props.isLocal ? tr("本地", "Local") : serverName(props.server) || tr("远程", "Remote")}
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
              <Menu.Content
                onCloseAutoFocus={(event) => {
                  if (dialog.active) event.preventDefault()
                }}
              >
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
                  onDeleteProject={props.actions.remove}
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
    </div>
  )
}
