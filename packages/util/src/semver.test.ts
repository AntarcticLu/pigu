import { describe, expect, test } from "bun:test"
import { cleanReleaseSemver, compareReleaseSemver, isReleaseSemver } from "./semver.js"

describe("semver", () => {
  test("parses strict release semvers and rejects dev/beta/local tags", () => {
    expect(cleanReleaseSemver("1.0.0")).toBe("1.0.0")
    expect(cleanReleaseSemver("v1.2.10")).toBe("1.2.10")
    expect(cleanReleaseSemver(" V01.02.03 ")).toBe("1.2.3")
    expect(isReleaseSemver("1.0.1")).toBe(true)

    expect(cleanReleaseSemver("local")).toBeUndefined()
    expect(cleanReleaseSemver("0.0.0-beta-2")).toBeUndefined()
    expect(cleanReleaseSemver("1.0.0-rc.1")).toBeUndefined()
    expect(cleanReleaseSemver("")).toBeUndefined()
    expect(cleanReleaseSemver(undefined)).toBeUndefined()
    expect(isReleaseSemver("local")).toBe(false)
  })

  test("compares lower, equal, and higher versions accurately", () => {
    expect(compareReleaseSemver("1.0.0", "1.0.1")).toBe(-1)
    expect(compareReleaseSemver("v1.0.1", "1.0.1")).toBe(0)
    expect(compareReleaseSemver("1.0.2", "1.0.1")).toBe(1)
    expect(compareReleaseSemver("1.10.0", "1.2.9")).toBe(1)
    expect(compareReleaseSemver("2.0.0", "1.99.99")).toBe(1)
    expect(compareReleaseSemver("local", "1.0.0")).toBeUndefined()
    expect(compareReleaseSemver("1.0.0", "0.0.0-beta-1")).toBeUndefined()
  })
})
