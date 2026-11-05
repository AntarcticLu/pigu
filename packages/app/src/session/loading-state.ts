import { createSignal } from "solid-js"

const MIN_SPINNER_MS = 350

const MAX_SPINNER_MS = 2400

const [loadingIDs, setLoadingIDs] = createSignal<ReadonlySet<string>>(new Set())

const startedAt = new Map<string, number>()

const timers = new Map<string, ReturnType<typeof setTimeout>>()

const warmKeys = new Set<string>()

function clearLoadingNow(sessionID: string) {
  const existing = timers.get(sessionID)

  if (existing) {
    clearTimeout(existing)
    timers.delete(sessionID)
  }

  startedAt.delete(sessionID)
  setLoadingIDs((prev) => {
    if (!prev.has(sessionID)) return prev
    const next = new Set(prev)
    next.delete(sessionID)

    return next
  })
}

export function startSessionUiLoading(sessionID: string | undefined) {
  if (!sessionID) return

  const existing = timers.get(sessionID)

  if (existing) clearTimeout(existing)

  startedAt.set(sessionID, performance.now())
  setLoadingIDs((prev) => {
    if (prev.has(sessionID)) return prev
    const next = new Set(prev)
    next.add(sessionID)

    return next
  })

  timers.set(
    sessionID,
    setTimeout(() => clearLoadingNow(sessionID), MAX_SPINNER_MS),
  )
}

export function stopSessionUiLoading(sessionID: string | undefined) {
  if (!sessionID) return

  const start = startedAt.get(sessionID)

  if (start === undefined) {
    clearLoadingNow(sessionID)

    return
  }

  const elapsed = performance.now() - start

  if (elapsed >= MIN_SPINNER_MS) {
    clearLoadingNow(sessionID)

    return
  }

  const existing = timers.get(sessionID)

  if (existing) clearTimeout(existing)

  timers.set(
    sessionID,
    setTimeout(() => clearLoadingNow(sessionID), MIN_SPINNER_MS - elapsed),
  )
}

export function isSessionUiLoading(sessionID: string | undefined) {
  if (!sessionID) return false

  return loadingIDs().has(sessionID)
}

export function markTimelineWarm(sessionKey: string | undefined) {
  if (!sessionKey) return
  warmKeys.add(sessionKey)
}

export function unmarkTimelineWarm(sessionKey: string | undefined) {
  if (!sessionKey) return
  warmKeys.delete(sessionKey)
}

export function clearWarmTimelines() {
  warmKeys.clear()
}

export function isTimelineWarm(sessionKey: string | undefined) {
  if (!sessionKey) return false

  return warmKeys.has(sessionKey)
}
