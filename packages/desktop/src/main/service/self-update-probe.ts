import path from "node:path"
import type { SelfUpdateState } from "../../shared/ipc-contract"

const PROBE_TIMEOUT_MS = 8_000

export function parseReleaseTagFromUrl(url: string): { rawTag: string; version: string } | undefined {
  const match = /\/releases\/tag\/([^/?#]+)/i.exec(url)

  if (!match?.[1]) return undefined
  const rawTag = decodeURIComponent(match[1]).trim()
  const version = rawTag.replace(/^v/i, "")

  if (!/^\d+\.\d+\.\d+/.test(version)) return undefined

  return { rawTag, version }
}

export function compareVersions(a: string, b: string): number {
  const cleanA = a.trim().replace(/^v/i, "")
  const cleanB = b.trim().replace(/^v/i, "")

  if (cleanA === cleanB) return 0
  const [coreA = "0.0.0", preA] = cleanA.split("-", 2)
  const [coreB = "0.0.0", preB] = cleanB.split("-", 2)
  const partsA = coreA.split(".").map((part) => Number.parseInt(part, 10) || 0)
  const partsB = coreB.split(".").map((part) => Number.parseInt(part, 10) || 0)
  const len = Math.max(partsA.length, partsB.length)

  for (let index = 0; index < len; index += 1) {
    const numA = partsA[index] ?? 0
    const numB = partsB[index] ?? 0

    if (numA !== numB) return numA > numB ? 1 : -1
  }

  if (!preA && preB) return 1

  if (preA && !preB) return -1

  if (preA && preB) return preA.localeCompare(preB)

  return 0
}

export function resolveReleaseAssetName(platform: NodeJS.Platform, arch: string): string {
  const normalizedArch = arch === "arm64" ? "arm64" : "x64"

  if (platform === "darwin") return `pigu-darwin-${normalizedArch}.tar.gz`

  if (platform === "win32") return "pigu-windows-x64.zip"

  return `pigu-linux-${normalizedArch}.tar.gz`
}

export function resolveMacAppBundlePath(exePath: string): string | undefined {
  const match = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(exePath)

  if (!match?.[1]) return undefined

  if (path.basename(match[1]).toLowerCase() === "electron.app") return undefined

  return match[1]
}

export function parseMacScutilProxy(output: string): string | undefined {
  const entries = new Map<string, string>()

  for (const rawLine of output.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_]+)\s*:\s*(.+?)\s*$/.exec(rawLine)

    if (match?.[1] && match[2]) {
      entries.set(match[1], match[2])
    }
  }

  if (entries.get("HTTPSEnable") === "1" && entries.get("HTTPSProxy") && entries.get("HTTPSPort")) {
    return `http://${entries.get("HTTPSProxy")}:${entries.get("HTTPSPort")}`
  }

  if (entries.get("HTTPEnable") === "1" && entries.get("HTTPProxy") && entries.get("HTTPPort")) {
    return `http://${entries.get("HTTPProxy")}:${entries.get("HTTPPort")}`
  }

  return undefined
}

export function parseWindowsRegProxy(output: string): string | undefined {
  const enabled = /ProxyEnable\s+REG_DWORD\s+0x0*1\b/i.test(output)

  if (!enabled) return undefined
  const serverMatch = /ProxyServer\s+REG_SZ\s+([^\r\n]+)/i.exec(output)
  const raw = serverMatch?.[1]?.trim()

  if (!raw) return undefined

  const pairs = raw.split(";").map((item) => item.trim())
  const httpsPair = pairs.find((item) => item.toLowerCase().startsWith("https="))
  const httpPair = pairs.find((item) => item.toLowerCase().startsWith("http="))
  const chosen = (httpsPair ?? httpPair ?? pairs[0] ?? "").replace(/^[a-z]+=/i, "").trim()

  if (!chosen) return undefined

  return /^https?:\/\//i.test(chosen) ? chosen : `http://${chosen}`
}

export function parseTotalBytes(res: Response): number | undefined {
  const range = res.headers.get("content-range")

  if (range) {
    const match = /\/(\d+)\s*$/.exec(range)

    if (match?.[1]) {
      const parsed = Number.parseInt(match[1], 10)

      if (Number.isFinite(parsed) && parsed > 0) return parsed
    }
  }

  const length = res.headers.get("content-length")

  if (!length) return undefined
  const parsed = Number.parseInt(length, 10)

  return Number.isFinite(parsed) && parsed > 1 ? parsed : undefined
}

export async function probeGitHubRelease(input: {
  repoBase: string
  currentVersion: string
  assetName: string
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>
}): Promise<{ state: SelfUpdateState; rawTag?: string }> {
  const latestUrl = `${input.repoBase}/releases/latest`
  const latestRes = await input
    .fetchImpl(latestUrl, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    .catch(() => undefined)

  if (!latestRes || !latestRes.ok) {
    return {
      state: {
        status: "offline",
        currentVersion: input.currentVersion,
        assetName: input.assetName,
      },
    }
  }

  const tag = parseReleaseTagFromUrl(latestRes.url)

  if (!tag) {
    return {
      state: {
        status: "offline",
        currentVersion: input.currentVersion,
        assetName: input.assetName,
      },
    }
  }

  const assetUrl = `${input.repoBase}/releases/download/${tag.rawTag}/${input.assetName}`
  const assetRes = await input
    .fetchImpl(assetUrl, {
      method: "GET",
      redirect: "follow",
      headers: { Range: "bytes=0-0" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    .catch(() => undefined)

  if (assetRes?.body) {
    void assetRes.body.cancel().catch(() => undefined)
  }

  if (!assetRes || (assetRes.status !== 200 && assetRes.status !== 206)) {
    return {
      rawTag: tag.rawTag,
      state: {
        status: "offline",
        currentVersion: input.currentVersion,
        latestVersion: tag.version,
        assetName: input.assetName,
      },
    }
  }

  const totalBytes = parseTotalBytes(assetRes)
  const hasNewer = compareVersions(tag.version, input.currentVersion) > 0

  return {
    rawTag: tag.rawTag,
    state: {
      status: hasNewer ? "available" : "up-to-date",
      currentVersion: input.currentVersion,
      latestVersion: tag.version,
      assetName: input.assetName,
      totalBytes,
    },
  }
}
