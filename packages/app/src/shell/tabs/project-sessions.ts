import type { SessionInfo } from "@opencode/client/promise"
import { useGlobal } from "@/runtime/server/runtime"
import { ServerConnection } from "@/runtime/server/registry"
import { useTabs } from "./tabs"

export function createProjectSessionActions() {
  const global = useGlobal()

  const tabs = useTabs()

  return {
    openProjectNewSession(conn: ServerConnection.Any, directory: string) {
      global.serverCtx(ServerConnection.key(conn))?.projects.touch(directory)
      void tabs.newDraft({ server: ServerConnection.key(conn), directory })
    },
    prefetchProjectSession(conn: ServerConnection.Any, session: SessionInfo) {
      const ctx = global.serverCtx(ServerConnection.key(conn))

      if (!ctx) return
      ctx.data.session.remember(session)
      void ctx.data.session.message.sync(session.id).catch(() => undefined)
    },
    openProjectSession(
      conn: ServerConnection.Any,
      directory: string,
      session: SessionInfo,
      options?: { preview?: boolean },
    ) {
      const ctx = global.serverCtx(ServerConnection.key(conn))

      if (!ctx) return
      ctx.data.session.remember(session)
      ctx.projects.touch(directory)
      void ctx.data.session.message.sync(session.id).catch(() => undefined)

      if (options?.preview) {
        tabs.previewSession({ server: ServerConnection.key(conn), sessionId: session.id })

        return
      }

      const tab = tabs.addSessionTab({ server: ServerConnection.key(conn), sessionId: session.id })

      tabs.select(tab)
    },
  }
}
