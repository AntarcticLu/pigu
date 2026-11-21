import { describe, expect, test } from "bun:test"
import {
  formatDynamicElapsed,
  makeSessionPinKey,
  resolveDynamicPinKind,
  sortDynamicPinItems,
  type SortableDynamicPin,
} from "./pin-store"

describe("dynamic session pinning and priority ordering", () => {
  test("maps inbox status and manual pin state to dynamic pin kind", () => {
    expect(resolveDynamicPinKind("approval", undefined)).toBe("approval")
    expect(resolveDynamicPinKind("input", 100)).toBe("input")
    expect(resolveDynamicPinKind("working", 100)).toBe("working")
    expect(resolveDynamicPinKind("failed", undefined)).toBe("failed")
    expect(resolveDynamicPinKind("done", undefined)).toBe("done")
    expect(resolveDynamicPinKind("ready", 12345)).toBe("pinned")
    expect(resolveDynamicPinKind("ready", undefined)).toBeUndefined()
    expect(makeSessionPinKey("local", "ses_1")).toBe("local\0ses_1")
  })

  test("sorts Needs You -> Working (stable by start) -> Unread Finished -> Manually Pinned", () => {
    const items: SortableDynamicPin[] = [
      { id: "pinned-old", kind: "pinned", pinnedAt: 100, updatedAt: 500 },
      { id: "working-2", kind: "working", since: 250, updatedAt: 999 },
      { id: "done-older", kind: "done", since: 300, updatedAt: 300 },
      { id: "input-newer", kind: "input", since: 400, updatedAt: 400 },
      { id: "approval-oldest", kind: "approval", since: 150, updatedAt: 150 },
      { id: "working-1", kind: "working", since: 200, updatedAt: 600 },
      { id: "failed-1", kind: "failed", since: 280, updatedAt: 280 },
      { id: "pinned-new", kind: "pinned", pinnedAt: 500, updatedAt: 200 },
      { id: "input-oldest", kind: "input", since: 120, updatedAt: 120 },
      { id: "done-newer", kind: "done", since: 450, updatedAt: 450 },
    ]

    const sorted = sortDynamicPinItems(items)
    expect(sorted.map((item) => item.id)).toEqual([
      "approval-oldest",
      "input-oldest",
      "input-newer",
      "working-1",
      "working-2",
      "failed-1",
      "done-newer",
      "done-older",
      "pinned-new",
      "pinned-old",
    ])
  })

  test("formats elapsed labels across seconds, minutes, hours, and days", () => {
    const tr = (zh: string) => zh
    expect(formatDynamicElapsed("working", 10_000, 28_000, tr)).toBe("18s")
    expect(formatDynamicElapsed("input", 10_000, 28_000, tr)).toBe("刚刚")
    expect(formatDynamicElapsed("input", 0, 5 * 60 * 1000, tr)).toBe("5m")
    expect(formatDynamicElapsed("done", 0, 3 * 3600 * 1000, tr)).toBe("3h")
    expect(formatDynamicElapsed("pinned", 0, 2 * 86_400 * 1000, tr)).toBe("2d")
  })
})
