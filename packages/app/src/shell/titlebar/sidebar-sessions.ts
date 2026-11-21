import type { OpenCodeEvent, SessionInfo } from "@opencode/client/promise"
import { createStore } from "solid-js/store"
import { mergeHomeSessionIndex } from "@/home/sessions/index"

export function sidebarActivitySessionID(event: OpenCodeEvent): string | undefined {
  switch (event.type) {
    case "form.created":
      return event.data.form.sessionID
    case "session.created":
    case "session.inbox.enqueued":
    case "session.inbox.delivered":
    case "session.execution.started":
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted":
    case "session.step.started":
    case "session.step.ended":
    case "session.step.failed":
    case "permission.asked":
    case "session.renamed":
    case "session.moved":
    case "session.archived":
    case "session.unarchived":
    case "session.revert.staged":
    case "session.revert.cleared":
    case "session.revert.committed":
      return event.data.sessionID
    default:
      return undefined
  }
}

// Passive metadata and agent/model selection sync must not promote a session just because it was opened.
export function isSidebarSessionActivity(event: OpenCodeEvent): boolean {
  return sidebarActivitySessionID(event) !== undefined
}

// Completion and waiting-on-user events auto-expand a collapsed project so the finished/waiting session is visible.
export function isSidebarCompletionOrAttentionEvent(event: OpenCodeEvent): boolean {
  return (
    event.type === "session.execution.succeeded" ||
    event.type === "session.execution.failed" ||
    event.type === "session.step.ended" ||
    event.type === "permission.asked" ||
    event.type === "form.created"
  )
}

export function createSidebarSessionActivity() {
  const [activity, setActivity] = createStore<Record<string, Record<string, number | undefined>>>({})

  return {
    get(server: string, sessionId: string) {
      return activity[server]?.[sessionId]
    },
    update(server: string, event: OpenCodeEvent, rootSessionID?: string) {
      const sessionID = sidebarActivitySessionID(event)
      if (!sessionID) return
      const created = "created" in event ? event.created : Date.now()
      setActivity(server, (sessions) => {
        const next: Record<string, number | undefined> = {
          ...sessions,
          [sessionID]: Math.max(sessions?.[sessionID] ?? 0, created),
        }
        if (rootSessionID && rootSessionID !== sessionID) {
          next[rootSessionID] = Math.max(next[rootSessionID] ?? 0, created)
        }
        return next
      })

      return { event, sessionID }
    },
  }
}

// Loading a tab refreshes its metadata, not its place in the project list; completion (`time.idle`) and real activity
// events advance the session's timestamp so active and newly completed sessions float to the top.
export function mergeSidebarSessions(
  indexed: SessionInfo[],
  known: SessionInfo[],
  activity: (id: string) => number | undefined,
) {
  const timestamps = new Map(indexed.map((session) => [session.id, session.time.updated]))

  return mergeHomeSessionIndex(
    indexed,
    known.map((session) => {
      const indexedUpdated = timestamps.get(session.id)
      if (indexedUpdated === undefined) return session
      const effective = Math.max(indexedUpdated, session.time.idle ?? 0)
      return { ...session, time: { ...session.time, updated: effective } }
    }),
  ).map((session) => {
    const updated = Math.max(session.time.idle ?? 0, activity(session.id) ?? 0)

    return updated > session.time.updated
      ? { ...session, time: { ...session.time, updated } }
      : session
  })
}
