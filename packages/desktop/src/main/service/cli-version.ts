const RELEASE_SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)$/i

export function cleanReleaseSemver(value: string | undefined): string | undefined {
  if (!value) return undefined
  const match = RELEASE_SEMVER_RE.exec(value.trim())

  if (!match?.[1] || !match[2] || !match[3]) return undefined

  return `${Number.parseInt(match[1], 10)}.${Number.parseInt(match[2], 10)}.${Number.parseInt(match[3], 10)}`
}

export function compareReleaseSemver(a: string | undefined, b: string | undefined): -1 | 0 | 1 | undefined {
  const cleanA = cleanReleaseSemver(a)
  const cleanB = cleanReleaseSemver(b)

  if (!cleanA || !cleanB) return undefined

  if (cleanA === cleanB) return 0
  const partsA = cleanA.split(".").map((part) => Number.parseInt(part, 10))
  const partsB = cleanB.split(".").map((part) => Number.parseInt(part, 10))

  for (let index = 0; index < 3; index += 1) {
    const numA = partsA[index] ?? 0
    const numB = partsB[index] ?? 0

    if (numA !== numB) return numA > numB ? 1 : -1
  }

  return 0
}

export function parseCliVersion(output: string) {
  const marker = output.lastIndexOf(" v")
  const version = marker === -1 ? output : output.slice(marker + 2)

  if (!version) throw new Error("V2 CLI did not provide a version")

  return version
}

export function serviceVersion(input: {
  readonly channel: "local" | "dev" | "beta" | "prod"
  readonly isolated?: boolean
  readonly mode: "initial" | "reconnect"
  readonly version: string
}) {
  if (input.mode === "reconnect") return undefined

  if (input.channel === "beta" && !input.isolated) return undefined

  return input.version
}

/**
 * Upgrades an older local background service to `required`, reuses an equal version,
 * and preserves a strictly newer running release service rather than downgrading it.
 */
export function serviceVersionMatcher(
  required: string | undefined,
): string | ((runningVersion: string) => boolean) | undefined {
  if (required === undefined) return undefined
  const cleanRequired = cleanReleaseSemver(required)

  if (!cleanRequired) return required

  return (runningVersion: string) => {
    const cmp = compareReleaseSemver(runningVersion, cleanRequired)

    if (cmp !== undefined) return cmp >= 0

    return runningVersion === required
  }
}

// Retrying on timeout can also replace a server stuck in a migration longer than 120 s, which is accepted.
export function shouldRetryEnsure(version: string | ((runningVersion: string) => boolean) | undefined, message: string) {
  if (version !== undefined) return false

  return (
    message === "Background service failed to start" ||
    message === "Timed out waiting for the background service to start"
  )
}

export function stageName(version: string, arch = process.arch) {
  return `${version}-${arch}`.replace(/[^a-zA-Z0-9._-]/g, "-")
}

export function keptStages(bundledVersion: string, runningVersion?: string, arch = process.arch) {
  const stages = [stageName(bundledVersion, arch)]

  if (runningVersion && runningVersion !== bundledVersion) stages.push(stageName(runningVersion, arch))

  return stages
}
