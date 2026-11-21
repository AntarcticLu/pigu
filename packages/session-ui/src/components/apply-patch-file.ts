import type { FileDiffInfo } from "@opencode/client/promise"
import { completePatchContents, normalize, type ViewDiff } from "./session-diff"

type Kind = "add" | "update" | "delete"

export type ApplyPatchFile = {
  path: string
  type: Kind
  additions: number
  deletions: number
  view: ViewDiff
  contents?: { before: string; after: string }
}

export type ApplyPatchFileGroup = Omit<ApplyPatchFile, "view" | "contents"> & { views: ViewDiff[] }

export function changedFileDiff(value: unknown): value is FileDiffInfo {
  if (!value || typeof value !== "object") return false

  if (!("file" in value) || typeof value.file !== "string") return false

  if (!("patch" in value) || typeof value.patch !== "string") return false

  if (!("additions" in value) || typeof value.additions !== "number") return false

  if (!("deletions" in value) || typeof value.deletions !== "number") return false

  if (!("status" in value)) return false

  if (value.status !== "added" && value.status !== "deleted" && value.status !== "modified") return false

  return value.additions > 0 || value.deletions > 0
}

export function patchFile(value: unknown): ApplyPatchFile | undefined {
  if (!changedFileDiff(value)) return
  let view: ViewDiff | undefined

  return {
    path: value.file,
    type: value.status === "added" ? "add" : value.status === "deleted" ? "delete" : "update",
    additions: value.additions,
    deletions: value.deletions,
    get view() {
      return (view ??= normalize(value))
    },
    contents: completePatchContents(value.patch),
  }
}

export function patchFiles(value: unknown) {
  if (!Array.isArray(value)) return []

  return value.map(patchFile).filter((file): file is ApplyPatchFile => !!file)
}

export function patchFileGroups(value: unknown): ApplyPatchFileGroup[] {
  const groups = patchFiles(value).reduce((result, file) => {
    const files = result.get(file.path)

    if (files) files.push(file)

    if (!files) result.set(file.path, [file])

    return result
  }, new Map<string, ApplyPatchFile[]>())

  return [...groups].map(([path, files]) => {
    const first = files[0]!
    const last = files.at(-1)!
    const type = last.type === "delete" ? "delete" : first.type === "add" ? "add" : "update"

    const chained = files.every(
      (file, index) => !!file.contents && (index === 0 || files[index - 1]?.contents?.after === file.contents.before),
    )

    if (!chained) {
      return {
        path,
        type,
        additions: files.reduce((total, file) => total + file.additions, 0),
        deletions: files.reduce((total, file) => total + file.deletions, 0),
        views: files.map((file) => file.view),
      }
    }

    const view =
      files.length === 1
        ? first.view
        : normalize({
            file: path,
            before: first.contents!.before,
            after: last.contents!.after,
            status: type === "add" ? "added" : type === "delete" ? "deleted" : "modified",
            additions: 0,
            deletions: 0,
          })

    // Parsed hunks already contain net change counts, excluding unchanged context.
    const counts = view.fileDiff.hunks.reduce(
      (result, hunk) => ({
        additions: result.additions + hunk.additionLines,
        deletions: result.deletions + hunk.deletionLines,
      }),
      { additions: 0, deletions: 0 },
    )

    return {
      path,
      type,
      ...counts,
      views: [{ ...view, ...counts }],
    }
  })
}

export function previewPatchText(patchText: string): {
  diffs: FileDiffInfo[]
  pendingFiles: string[]
} {
  if (!patchText) return { diffs: [], pendingFiles: [] }
  const normalized = patchText.replaceAll("\r\n", "\n")
  const rawLines = normalized.split("\n")
  const completeLastLine = normalized.endsWith("\n")
  const lines =
    !completeLastLine && rawLines.at(-1)?.trimStart().startsWith("***") ? rawLines.slice(0, -1) : rawLines

  type Section =
    | { kind: "add"; path: string; added: string[] }
    | { kind: "delete"; path: string }
    | { kind: "update"; path: string; movePath?: string; hunks: string[][] }

  const sections: Section[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (
      trimmed === "*** Begin Patch" ||
      trimmed === "*** End Patch" ||
      trimmed === "*** End of File" ||
      trimmed.startsWith("*** Environment ID:") ||
      trimmed.startsWith("<<") ||
      trimmed === "EOF"
    ) {
      continue
    }
    if (trimmed.startsWith("*** Add File: ")) {
      const path = trimmed.slice("*** Add File: ".length).trim()
      if (path) sections.push({ kind: "add", path, added: [] })
      continue
    }
    if (trimmed.startsWith("*** Delete File: ")) {
      const path = trimmed.slice("*** Delete File: ".length).trim()
      if (path) sections.push({ kind: "delete", path })
      continue
    }
    if (trimmed.startsWith("*** Update File: ")) {
      const path = trimmed.slice("*** Update File: ".length).trim()
      if (path) sections.push({ kind: "update", path, hunks: [] })
      continue
    }
    const current = sections.at(-1)
    if (!current) continue
    if (current.kind === "update" && trimmed.startsWith("*** Move to: ")) {
      const movePath = trimmed.slice("*** Move to: ".length).trim()
      if (movePath) current.movePath = movePath
      continue
    }
    if (trimmed.startsWith("***")) continue
    if (current.kind === "add") {
      if (line.startsWith("+")) current.added.push(line.slice(1))
      continue
    }
    if (current.kind === "update") {
      if (line.startsWith("@@")) {
        current.hunks.push([])
        continue
      }
      if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {
        if (current.hunks.length === 0) current.hunks.push([])
        current.hunks.at(-1)!.push(line)
      }
    }
  }

  const diffs: FileDiffInfo[] = []
  const pendingFiles: string[] = []

  for (const section of sections) {
    if (section.kind === "delete") {
      diffs.push({
        file: section.path,
        status: "deleted",
        additions: 0,
        deletions: 1,
        patch: `--- a/${section.path}\n+++ b/${section.path}\n@@ -1 +0,0 @@\n-\n`,
      })
      continue
    }
    if (section.kind === "add") {
      if (section.added.length === 0) {
        pendingFiles.push(section.path)
        continue
      }
      diffs.push({
        file: section.path,
        status: "added",
        additions: section.added.length,
        deletions: 0,
        patch: `--- a/${section.path}\n+++ b/${section.path}\n@@ -0,0 +1,${section.added.length} @@\n${section.added.map((item) => `+${item}`).join("\n")}\n`,
      })
      continue
    }
    const targetPath = section.movePath ?? section.path
    const nonEmptyHunks = section.hunks.filter((hunk) => hunk.length > 0)
    const additions = nonEmptyHunks.reduce(
      (sum, hunk) => sum + hunk.filter((item) => item.startsWith("+")).length,
      0,
    )
    const deletions = nonEmptyHunks.reduce(
      (sum, hunk) => sum + hunk.filter((item) => item.startsWith("-")).length,
      0,
    )
    if (additions === 0 && deletions === 0) {
      pendingFiles.push(targetPath)
      continue
    }
    const formattedHunks = nonEmptyHunks.map((hunk) => {
      const oldCount = hunk.filter((item) => !item.startsWith("+")).length
      const newCount = hunk.filter((item) => !item.startsWith("-")).length
      return `@@ -1,${oldCount} +1,${newCount} @@\n${hunk.join("\n")}`
    })
    diffs.push({
      file: targetPath,
      status: "modified",
      additions,
      deletions,
      patch: `--- a/${section.path}\n+++ b/${targetPath}\n${formattedHunks.join("\n")}\n`,
    })
  }

  return { diffs, pendingFiles }
}
