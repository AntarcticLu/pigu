import { Schema } from "effect"
import { batch } from "solid-js"
import { Persistence } from "@/runtime/persistence/schema"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { pathKey } from "@/workspaces/path-key"
import { getFilename } from "@opencode/util/path"
import type { SessionInfo } from "@opencode/client/promise"
import { sessionLabel } from "@/session/title"

const ArchiveState = Persistence.struct({
  projectStatus: Persistence.record(Schema.Literals(["shown", "archived", "deleted"])),
  sessionStatus: Persistence.record(Schema.Literals(["shown", "archived"])),
})

const TEMP_FOLDER_PATTERNS = [
  /^temp$/i,
  /^temp[_-]/i,
  /[_-]temp$/i,
  /^tmp$/i,
  /^tmp[_-]/i,
  /^test_temp$/i,
  /^t$/i,
  /^\./,
]

const TRIVIAL_SESSION_TITLES = new Set([
  "hi",
  "hello",
  "ping",
  "test",
  "你好",
  "respond to greeting",
  "say 'claude code is working!' and nothing else.",
])

export function isIntrinsicArchivedProject(worktree: string, sessionCount: number) {
  const name = getFilename(worktree) || worktree
  const normalized = pathKey(worktree)
  const lower = normalized.toLowerCase()

  if (sessionCount === 0) return true

  return (
    lower === "/" ||
    lower === "/users" ||
    lower === "/home" ||
    lower === "/volumes" ||
    /^[a-z]:\/?$/i.test(lower) ||
    /^[a-z]:\/users$/i.test(lower) ||
    TEMP_FOLDER_PATTERNS.some((pattern) => pattern.test(name))
  )
}

export function isDefaultArchivedProject(worktree: string, sessionCount: number, rankWithSessions: number) {
  if (isIntrinsicArchivedProject(worktree, sessionCount)) return true

  return rankWithSessions >= 12
}

export function isDefaultArchivedSession(session: SessionInfo, indexInProject: number, totalInProject = 1) {
  if (totalInProject <= 3) return false

  const title = sessionLabel(session).trim().toLowerCase()
  const durationMs = Math.max(0, session.time.updated - session.time.created)

  if (TRIVIAL_SESSION_TITLES.has(title) && durationMs < 60_000) return true

  return indexInProject >= 12
}

export function useArchiveState() {
  const [archiveStore, setArchiveStore] = persisted(
    { ...Persist.global("pigu.archive.v1"), sync: true },
    ArchiveState,
    {
      projectStatus: {},
      sessionStatus: {},
    },
  )

  const isProjectDeleted = (worktree: string) => {
    const key = pathKey(worktree)

    return archiveStore.projectStatus[key] === "deleted"
  }

  const setProjectDeleted = (worktree: string, deleted: boolean) => {
    const key = pathKey(worktree)
    setArchiveStore("projectStatus", key, deleted ? "deleted" : "shown")
  }

  const isProjectArchived = (worktree: string, sessionCount = 0, rankWithSessions = 0) => {
    const key = pathKey(worktree)
    const explicit = archiveStore.projectStatus[key]

    if (explicit === "shown") return false

    if (explicit === "archived") return true

    if (explicit === "deleted") return false

    return isDefaultArchivedProject(worktree, sessionCount, rankWithSessions)
  }

  const setProjectArchived = (worktree: string, archived: boolean) => {
    const key = pathKey(worktree)
    setArchiveStore("projectStatus", key, archived ? "archived" : "shown")
  }

  const isSessionArchived = (session: SessionInfo, indexInProject = 0, totalInProject = 1) => {
    const explicit = archiveStore.sessionStatus[session.id]

    if (explicit === "shown") return false

    if (explicit === "archived") return true

    return isDefaultArchivedSession(session, indexInProject, totalInProject)
  }

  const setSessionArchived = (sessionID: string, archived: boolean) => {
    setArchiveStore("sessionStatus", sessionID, archived ? "archived" : "shown")
  }

  const setSessionsArchived = (sessionIDs: ReadonlyArray<string>, archived: boolean) => {
    const next = archived ? ("archived" as const) : ("shown" as const)
    batch(() => {
      for (const id of sessionIDs) {
        setArchiveStore("sessionStatus", id, next)
      }
    })
  }

  const resetProjectDefaults = () => {
    setArchiveStore("projectStatus", {})
  }

  return {
    isProjectDeleted,
    setProjectDeleted,
    isProjectArchived,
    setProjectArchived,
    isSessionArchived,
    setSessionArchived,
    setSessionsArchived,
    resetProjectDefaults,
  }
}
