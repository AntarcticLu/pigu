import { describe, expect, test } from "bun:test"
import { isIntrinsicArchivedProject } from "./archive-store"

describe("isIntrinsicArchivedProject", () => {
  test("keeps user home projects and fallback history projects visible when they contain sessions", () => {
    expect(isIntrinsicArchivedProject("/home/lsy", 2)).toBe(false)
    expect(isIntrinsicArchivedProject("/Users/al", 1)).toBe(false)
    expect(isIntrinsicArchivedProject("/root", 3)).toBe(false)
    expect(isIntrinsicArchivedProject("C:\\Users\\lsy", 1)).toBe(false)
    expect(isIntrinsicArchivedProject("/home/lsy/.pigu/projects/历史会话", 4)).toBe(false)
  })

  test("archives empty projects, bare filesystem roots, and temp directories", () => {
    expect(isIntrinsicArchivedProject("/home/lsy", 0)).toBe(true)
    expect(isIntrinsicArchivedProject("/", 5)).toBe(true)
    expect(isIntrinsicArchivedProject("/home", 5)).toBe(true)
    expect(isIntrinsicArchivedProject("/Users", 5)).toBe(true)
    expect(isIntrinsicArchivedProject("C:\\", 5)).toBe(true)
    expect(isIntrinsicArchivedProject("/tmp", 5)).toBe(true)
    expect(isIntrinsicArchivedProject("/var/folders/test_temp", 2)).toBe(true)
  })
})
