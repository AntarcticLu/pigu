import { Schema } from "effect"
import { Persistence } from "@/runtime/persistence/schema"
import { Persist, persisted } from "@/runtime/persistence/storage"
import type { InboxStatus } from "./inbox-model"

export type DynamicPinKind = "approval" | "input" | "working" | "failed" | "done" | "pinned"

export type SortableDynamicPin = {
  readonly id: string
  readonly kind: DynamicPinKind
  readonly since?: number
  readonly updatedAt: number
  readonly pinnedAt?: number
}

const PinState = Persistence.struct({
  pinnedAt: Persistence.record(Schema.Number),
  sectionCollapsed: Schema.Boolean,
})

export function makeSessionPinKey(server: string, sessionID: string): string {
  return `${server}\0${sessionID}`
}

export function resolveDynamicPinKind(
  inboxStatus: InboxStatus,
  pinnedAt: number | undefined,
): DynamicPinKind | undefined {
  if (inboxStatus === "approval") return "approval"
  if (inboxStatus === "input") return "input"
  if (inboxStatus === "working") return "working"
  if (inboxStatus === "failed") return "failed"
  if (inboxStatus === "done") return "done"
  if (pinnedAt !== undefined) return "pinned"
  return undefined
}

function tierOf(kind: DynamicPinKind): number {
  if (kind === "approval" || kind === "input") return 0
  if (kind === "working") return 1
  if (kind === "failed" || kind === "done") return 2
  return 3
}

export function sortDynamicPinItems<T extends SortableDynamicPin>(items: readonly T[]): T[] {
  return items.toSorted((a, b) => {
    const tierDiff = tierOf(a.kind) - tierOf(b.kind)
    if (tierDiff !== 0) return tierDiff

    const tier = tierOf(a.kind)
    if (tier === 0) {
      if (a.kind !== b.kind) return a.kind === "approval" ? -1 : 1
      const waitDiff = (a.since ?? Number.POSITIVE_INFINITY) - (b.since ?? Number.POSITIVE_INFINITY)
      if (waitDiff !== 0) return waitDiff
      return a.id.localeCompare(b.id)
    }

    if (tier === 1) {
      const startDiff = (a.since ?? a.updatedAt) - (b.since ?? b.updatedAt)
      if (startDiff !== 0) return startDiff
      return a.id.localeCompare(b.id)
    }

    if (tier === 2) {
      if (a.kind !== b.kind) return a.kind === "failed" ? -1 : 1
      const finishDiff = (b.since ?? b.updatedAt) - (a.since ?? a.updatedAt)
      if (finishDiff !== 0) return finishDiff
      return a.id.localeCompare(b.id)
    }

    const pinDiff = (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0)
    if (pinDiff !== 0) return pinDiff
    return b.updatedAt - a.updatedAt
  })
}

export function formatDynamicElapsed(
  kind: DynamicPinKind,
  since: number | undefined,
  now: number,
  tr: (zh: string, en: string) => string,
): string | undefined {
  if (since === undefined) return undefined
  const seconds = Math.max(0, Math.floor((now - since) / 1000))
  if (kind === "working" && seconds < 60) {
    return `${seconds}s`
  }
  if (seconds < 60) {
    return tr("刚刚", "now")
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m`
  }
  if (seconds < 86_400) {
    return `${Math.floor(seconds / 3600)}h`
  }
  return `${Math.floor(seconds / 86_400)}d`
}

export function usePinState() {
  const [store, setStore] = persisted(
    { ...Persist.global("pigu.pins.v1"), sync: true },
    PinState,
    {
      pinnedAt: {},
      sectionCollapsed: false,
    },
  )

  const pinnedTimestamp = (server: string, sessionID: string): number | undefined => {
    const scoped = store.pinnedAt[makeSessionPinKey(server, sessionID)]
    if (scoped !== undefined) return scoped
    return store.pinnedAt[sessionID]
  }

  const isPinned = (server: string, sessionID: string): boolean => pinnedTimestamp(server, sessionID) !== undefined

  const setPinned = (server: string, sessionID: string, pinned: boolean) => {
    const key = makeSessionPinKey(server, sessionID)
    if (pinned) {
      setStore("pinnedAt", key, Date.now())
      return
    }
    setStore("pinnedAt", key, undefined!)
    if (store.pinnedAt[sessionID] !== undefined) {
      setStore("pinnedAt", sessionID, undefined!)
    }
  }

  const togglePinned = (server: string, sessionID: string) => {
    setPinned(server, sessionID, !isPinned(server, sessionID))
  }

  return {
    pinnedTimestamp,
    isPinned,
    setPinned,
    togglePinned,
    collapsed: () => store.sectionCollapsed,
    setCollapsed: (collapsed: boolean) => setStore("sectionCollapsed", collapsed),
    toggleCollapsed: () => setStore("sectionCollapsed", (prev) => !prev),
  }
}
