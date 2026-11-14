import { Schema } from "effect"
import { useQueryClient } from "@tanstack/solid-query"
import type { SessionInfo } from "@opencode/client/promise"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { displayName } from "@opencode/ui/project-avatar"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { ServerConnection } from "@/runtime/server/registry"
import { isServerUnauthorized } from "@/runtime/server/health-machine"
import { useGlobal } from "@/runtime/server/runtime"
import { errorMessage } from "@/shell/layout/helpers"
import { showToast } from "@/shell/notifications/toast"
import type { LocalProject } from "@/shell/state/layout"
import { createProjectSessionActions } from "@/shell/tabs/project-sessions"
import { useTabs } from "@/shell/tabs/tabs"
import { useArchiveState } from "@/shell/titlebar/archive-store"
import { notifySessionTabsRemoved } from "@/shell/titlebar/session-events"
import { pathKey } from "@/workspaces/path-key"
import { useRevealProject } from "./reveal"

export function createProjectActions() {
  const platform = usePlatform()

  const dialog = useDialog()

  const language = useLanguage()

  const global = useGlobal()

  const sessions = createProjectSessionActions()

  const tabs = useTabs()

  const archive = useArchiveState()

  const queryClient = useQueryClient()

  const revealProject = useRevealProject()

  function editServer(conn: ServerConnection.Http, onSave?: (saved: ServerConnection.Http) => void) {
    void import("@/servers/connect/dialog").then(({ DialogServer }) => {
      void dialog.show(() => <DialogServer mode="edit" server={conn} onSave={onSave} />)
    })
  }

  // Resume the requested action with the saved connection after an expired HTTP pairing or plugin sign-in.
  function authenticate(conn: ServerConnection.Any, onConnected?: (conn: ServerConnection.Any) => void) {
    if (conn.type !== "http" || !isServerUnauthorized(global.servers.health[ServerConnection.key(conn)]))
      return ServerConnection.authenticate(conn, () => onConnected?.(conn))
    editServer(conn, onConnected)

    return true
  }

  const directories = (project: LocalProject) => [project.worktree, ...(project.sandboxes ?? [])]

  return {
    authenticate,
    editServer,
    openNewSession(conn: ServerConnection.Any, directory: string) {
      if (authenticate(conn, (next) => sessions.openProjectNewSession(next, directory))) return
      sessions.openProjectNewSession(conn, directory)
    },
    canImportSession: !!platform.openAttachmentPickerDialog,
    importSession(conn: ServerConnection.Any, project: LocalProject) {
      if (!platform.openAttachmentPickerDialog) return
      void platform
        .openAttachmentPickerDialog(
          { title: language.t("command.session.import"), accept: ["application/json"], extensions: ["json"] },
          async (file) => {
            const data = await Schema.decodeUnknownPromise(
              Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
            )(await file.text())

            const ctx = global.serverCtx(ServerConnection.key(conn))

            if (!ctx) throw new Error(language.t("common.requestFailed"))
            const api = ctx.sdk.api.experimental.session

            // SAFETY: the import endpoint validates the transcript, including exports written by earlier releases.
            const imported = await api.import({ ...data, location: { directory: project.worktree } } as Parameters<
              typeof api.import
            >[0])

            sessions.openProjectSession(conn, project.worktree, imported)
          },
        )
        .catch((cause: unknown) => {
          showToast({
            title: language.t("common.requestFailed"),
            description: errorMessage(cause, language.t("common.requestFailed")),
          })
        })
    },
    edit(conn: ServerConnection.Any, project: LocalProject) {
      void import("@/settings/workspaces/projects").then(({ DialogEditProject }) => {
        void dialog.show(() => <DialogEditProject server={conn} project={project} />)
      })
    },
    hasUnread(conn: ServerConnection.Any, project: LocalProject) {
      const notification = global.serverCtx(ServerConnection.key(conn))?.notification

      return !!notification && directories(project).some((directory) => notification.project.hasUnread(directory))
    },
    clearNotifications(conn: ServerConnection.Any, project: LocalProject) {
      const notification = global.serverCtx(ServerConnection.key(conn))?.notification

      directories(project).forEach((directory) => notification?.project.markViewed(directory))
    },
    hide: (conn: ServerConnection.Any, project: LocalProject) =>
      global.serverCtx(ServerConnection.key(conn))?.projects.hide(project),
    remove(conn: ServerConnection.Any, project: LocalProject, onDeleted?: () => void) {
      const name = displayName(project)
      void dialog.show(() => (
        <Dialog fit>
          <DialogHeader hideClose>
            <DialogTitleGroup
              title={language.tr("删除项目", "Delete project")}
              description={language.tr(
                `确定从 Pigu 中移除项目“${name}”及其会话记录吗？磁盘上的项目源代码文件不会被删除。`,
                `Remove project "${name}" and its session history from Pigu? Source files on disk will not be deleted.`,
              )}
            />
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" autofocus onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              data-action="project-delete-confirm"
              onClick={() => {
                const server = ServerConnection.key(conn)
                const ctx = global.serverCtx(server)
                const dirs = directories(project)
                const dirKeys = new Set(dirs.map(pathKey))
                dialog.close()

                dirs.forEach((dir) => archive.setProjectDeleted(dir, true))

                for (let index = tabs.store.length - 1; index >= 0; index--) {
                  const tab = tabs.store[index]

                  if (!tab || tab.type !== "draft" || tab.server !== server) continue

                  if (dirKeys.has(pathKey(tab.directory))) tabs.removeTab(index)
                }

                const cachedSessions = queryClient.getQueryData<SessionInfo[]>(["home-sessions", conn]) ?? []
                const localSessions = ctx?.data.session.list() ?? []
                const matchesProject = (session: SessionInfo) =>
                  (Boolean(project.id) && session.projectID === project.id) ||
                  dirKeys.has(pathKey(session.location.directory))

                const sessionIDs = Array.from(
                  new Set([...cachedSessions, ...localSessions].filter(matchesProject).map((session) => session.id)),
                )

                queryClient.setQueryData<SessionInfo[]>(["home-sessions", conn], (list) =>
                  list?.filter((session) => !matchesProject(session)),
                )

                if (sessionIDs.length > 0) {
                  notifySessionTabsRemoved({ server, directory: project.worktree, sessionIDs })
                }

                ctx?.projects.hide(project)
                onDeleted?.()

                if (!ctx) return

                const remoteRemove =
                  project.id && project.id !== "global"
                    ? ctx.sdk.api.experimental.project.remove({ projectID: project.id }).catch(() =>
                        Promise.allSettled(sessionIDs.map((id) => ctx.data.session.remove(id))),
                      )
                    : Promise.allSettled(sessionIDs.map((id) => ctx.data.session.remove(id)))

                void remoteRemove
                  .then(() => {
                    showToast({
                      variant: "success",
                      title: language.tr("项目已移除", "Project removed"),
                      description: project.worktree,
                    })
                  })
                  .catch((cause: unknown) => {
                    showToast({
                      title: language.t("common.requestFailed"),
                      description: errorMessage(cause, language.t("common.requestFailed")),
                    })
                  })
                  .finally(() => {
                    void ctx.sync.project.refresh().catch(() => undefined)
                    void queryClient.invalidateQueries({ queryKey: ["home-sessions", conn], exact: true })
                  })
              }}
            >
              {language.tr("删除项目", "Delete project")}
            </Button>
          </DialogFooter>
        </Dialog>
      ))
    },
    canReveal: revealProject.available,
    reveal: revealProject.reveal,
  }
}
