import { comparablePath } from "@opencode/util/path"

export type PathKey = string & { _brand: "PathKey" }

export const pathKey = (path: string) => {
  const key = comparablePath(path)
  return (/^[a-z]:\//i.test(key) || key.startsWith("//") ? key.toLowerCase() : key) as PathKey
}
