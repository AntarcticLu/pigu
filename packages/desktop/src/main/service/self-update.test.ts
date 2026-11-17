import { describe, expect, test } from "bun:test"
import {
  compareVersions,
  parseMacScutilProxy,
  parseReleaseTagFromUrl,
  parseWindowsRegProxy,
  probeGitHubRelease,
  resolveMacAppBundlePath,
  resolveReleaseAssetName,
} from "./self-update-probe"

describe("self-update probe", () => {
  test("parses macOS scutil and Windows registry HTTP proxies cleanly", () => {
    expect(
      parseMacScutilProxy("<dictionary> {\n  HTTPEnable : 1\n  HTTPPort : 7890\n  HTTPProxy : 127.0.0.1\n  HTTPSEnable : 1\n  HTTPSPort : 7890\n  HTTPSProxy : 127.0.0.1\n  SOCKSEnable : 1\n}"),
    ).toBe("http://127.0.0.1:7890")
    expect(parseMacScutilProxy("<dictionary> {\n  HTTPEnable : 0\n  HTTPSEnable : 0\n}")).toBeUndefined()

    expect(
      parseWindowsRegProxy("    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    127.0.0.1:7897\r\n"),
    ).toBe("http://127.0.0.1:7897")
    expect(
      parseWindowsRegProxy("    ProxyEnable    REG_DWORD    0x0\r\n    ProxyServer    REG_SZ    127.0.0.1:7897\r\n"),
    ).toBeUndefined()
  })

  test("parses GitHub release tag URLs and compares semver cleanly", () => {
    expect(parseReleaseTagFromUrl("https://github.com/AntarcticLu/pigu/releases/tag/v1.0.2")).toEqual({
      rawTag: "v1.0.2",
      version: "1.0.2",
    })
    expect(parseReleaseTagFromUrl("https://github.com/AntarcticLu/pigu/releases")).toBeUndefined()

    expect(compareVersions("1.0.1", "1.0.0")).toBe(1)
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0)
    expect(compareVersions("1.10.0", "1.2.9")).toBe(1)
    expect(compareVersions("1.0.0", "1.0.0-beta.1")).toBe(1)
    expect(compareVersions("0.9.9", "1.0.0")).toBe(-1)
  })

  test("resolves platform release asset names and macOS app bundle paths", () => {
    expect(resolveReleaseAssetName("darwin", "arm64")).toBe("pigu-darwin-arm64.tar.gz")
    expect(resolveReleaseAssetName("darwin", "x64")).toBe("pigu-darwin-x64.tar.gz")
    expect(resolveReleaseAssetName("win32", "x64")).toBe("pigu-windows-x64.zip")
    expect(resolveReleaseAssetName("linux", "arm64")).toBe("pigu-linux-arm64.tar.gz")

    expect(resolveMacAppBundlePath("/Applications/Pigu.app/Contents/MacOS/Pigu")).toBe("/Applications/Pigu.app")
    expect(resolveMacAppBundlePath("/path/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")).toBeUndefined()
  })

  test("reports available, up-to-date, and offline when asset CDN is blocked", async () => {
    let blockAsset = false
    let tag = "v1.0.2"

    using server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)

        if (url.pathname === "/releases/latest") {
          return Response.redirect(`${url.origin}/releases/tag/${tag}`, 302)
        }

        if (url.pathname.startsWith("/releases/tag/")) {
          return new Response("ok", { status: 200 })
        }

        if (url.pathname.startsWith("/releases/download/")) {
          if (blockAsset) return new Response("blocked", { status: 502 })

          return new Response("P", {
            status: 206,
            headers: {
              "Content-Range": "bytes 0-0/255123456",
              "Content-Length": "1",
            },
          })
        }

        return new Response("not found", { status: 404 })
      },
    })

    const base = `http://127.0.0.1:${server.port}`

    const available = await probeGitHubRelease({
      repoBase: base,
      currentVersion: "1.0.0",
      assetName: "pigu-darwin-arm64.tar.gz",
      fetchImpl: (url, init) => fetch(url, init),
    })
    expect(available.rawTag).toBe("v1.0.2")
    expect(available.state).toEqual({
      status: "available",
      currentVersion: "1.0.0",
      latestVersion: "1.0.2",
      assetName: "pigu-darwin-arm64.tar.gz",
      totalBytes: 255123456,
    })

    tag = "v1.0.0"
    const upToDate = await probeGitHubRelease({
      repoBase: base,
      currentVersion: "1.0.0",
      assetName: "pigu-darwin-arm64.tar.gz",
      fetchImpl: (url, init) => fetch(url, init),
    })
    expect(upToDate.state.status).toBe("up-to-date")

    blockAsset = true
    const assetBlocked = await probeGitHubRelease({
      repoBase: base,
      currentVersion: "1.0.0",
      assetName: "pigu-darwin-arm64.tar.gz",
      fetchImpl: (url, init) => fetch(url, init),
    })
    expect(assetBlocked.state.status).toBe("offline")
  })
})
