const RELEASE_SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)$/i

export function cleanReleaseSemver(value: string | undefined): string | undefined {
  if (!value) return undefined
  const match = RELEASE_SEMVER_RE.exec(value.trim())

  if (!match?.[1] || !match[2] || !match[3]) return undefined

  return `${Number.parseInt(match[1], 10)}.${Number.parseInt(match[2], 10)}.${Number.parseInt(match[3], 10)}`
}

export function isReleaseSemver(value: string | undefined): boolean {
  return cleanReleaseSemver(value) !== undefined
}

/**
 * Compares two strict release semver strings (`X.Y.Z` or `vX.Y.Z`).
 * Returns `-1` when `a < b`, `0` when `a === b`, `1` when `a > b`,
 * or `undefined` if either string is not a release semver (e.g. `local`, `0.0.0-beta-2`).
 */
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
