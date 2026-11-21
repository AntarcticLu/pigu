export * as MemoryPlugin from "./memory.js"

import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { define } from "@opencode/plugin/effect/plugin"
import type { RpcRegistration } from "@opencode/plugin/effect/rpc"
import { Memory } from "@opencode/schema/memory"
import { optional } from "@opencode/schema/schema"
import { Global } from "@opencode/util/global"
import { Clock, Effect, Option, Schema } from "effect"
import { InstructionDiscovery } from "../instruction-discovery.js"
import { Location } from "../location.js"

const LEGACY_STORE_FILENAME = "pigu-memories.json"
const STATE_FILENAME = "pigu-memory-state.json"
const VIRTUAL_INSTRUCTION_PATH = "pigu://memory/active"
const MAX_MEMORIES = 500
const MAX_CONTENT_CHARS = 32_000
const MAX_EXTERNAL_FILE_CHARS = 256_000

const FileFlagEntrySchema = Schema.Struct({
  enabled: optional(Schema.Boolean),
  pinned: optional(Schema.Boolean),
  tags: optional(Schema.Array(Schema.String)),
})

const StateFileSchema = Schema.Struct({
  version: Schema.Number,
  files: Schema.Record(Schema.String, FileFlagEntrySchema),
})

const LegacyStoredFileSchema = Schema.Struct({
  version: Schema.Number,
  items: Schema.Array(Memory.Item),
})

const decodeStateFile = Schema.decodeUnknownOption(Schema.fromJsonString(StateFileSchema))
const decodeLegacyFile = Schema.decodeUnknownOption(Schema.fromJsonString(LegacyStoredFileSchema))

type FileFlags = Schema.Schema.Type<typeof FileFlagEntrySchema>
type ChangeListener = (event: Memory.ChangedEvent) => void

const listenersByStore = new Map<string, Set<ChangeListener>>()

function subscribeStoreChanges(storeKey: string, listener: ChangeListener): () => void {
  const existing = listenersByStore.get(storeKey)
  const bucket = existing ?? new Set<ChangeListener>()
  if (!existing) listenersByStore.set(storeKey, bucket)
  bucket.add(listener)
  return () => {
    bucket.delete(listener)
    if (bucket.size === 0) listenersByStore.delete(storeKey)
  }
}

function broadcastStoreChange(storeKey: string, event: Memory.ChangedEvent) {
  const bucket = listenersByStore.get(storeKey)
  if (!bucket) return
  bucket.forEach((listener) => listener(event))
}

function makeMemoryIdFromPath(filePath: string): string {
  const digest = crypto.createHash("sha256").update(path.resolve(filePath)).digest("hex").slice(0, 14)
  return `mem_${digest}`
}

function makeRandomMemoryId(): string {
  return `mem_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`
}

function normalizeDir(dir: string | undefined): string {
  if (!dir) return ""
  const trimmed = dir.trim().replace(/[\\/]+$/, "")
  return trimmed || dir.trim()
}

function sameOrChildDir(candidate: string, base: string): boolean {
  const left = normalizeDir(candidate)
  const right = normalizeDir(base)
  if (!left || !right) return false
  if (left === right) return true
  const sep = right.includes("\\") ? "\\" : "/"
  return left.startsWith(right + sep) || right.startsWith(left + sep)
}

export function toClaudeProjectSlug(directory: string): string {
  return normalizeDir(directory).replace(/[^a-zA-Z0-9-]/g, "-")
}

function globalMemoryDir(dataDir: string): string {
  return path.join(dataDir, "memories", "global")
}

function projectMemoryDir(homeDir: string, directory: string): string {
  return path.join(homeDir, ".claude", "projects", toClaudeProjectSlug(directory), "memory")
}

function readStateMapSync(dataDir: string): Record<string, FileFlags> {
  const statePath = path.join(dataDir, STATE_FILENAME)
  if (!fs.existsSync(statePath)) return {}
  const raw = Option.getOrUndefined(Option.liftThrowable(() => fs.readFileSync(statePath, "utf8"))())
  if (!raw?.trim()) return {}
  const decoded = decodeStateFile(raw)
  return Option.isSome(decoded) ? { ...decoded.value.files } : {}
}

function writeStateMapSync(dataDir: string, files: Record<string, FileFlags>) {
  const statePath = path.join(dataDir, STATE_FILENAME)
  fs.mkdirSync(dataDir, { recursive: true })
  const tmpPath = `${statePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmpPath, `${JSON.stringify({ version: 1, files }, null, 2)}\n`, "utf8")
  fs.renameSync(tmpPath, statePath)
}

function sanitizeMemoryFileName(raw: string): string {
  const stripped = raw
    .trim()
    .replace(/\.md$/i, "")
    .replace(/[/\\:*?"<>|\0]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^\.+|-+$/g, "")
    .slice(0, 80)
  const base = stripped || `memory-${Date.now().toString(36)}`
  if (base.toUpperCase() === "MEMORY") return "memory-note.md"
  return `${base}.md`
}

function categoryToFrontmatterType(category: Memory.Category): string {
  if (category === "preference") return "feedback"
  if (category === "reference") return "reference"
  if (category === "architecture") return "architecture"
  if (category === "convention") return "convention"
  return "project"
}

function inferCategoryFromText(rawType: string | undefined, text: string): Memory.Category {
  const kind = (rawType ?? "").toLowerCase()
  if (kind.includes("pref") || kind.includes("user") || kind.includes("feedback")) return "preference"
  if (kind.includes("arch")) return "architecture"
  if (kind.includes("conv") || kind.includes("style") || kind.includes("rule")) return "convention"
  if (kind.includes("ref") || kind.includes("quirk")) return "reference"
  if (kind.includes("proj") || kind.includes("context")) return "context"

  const sample = text.toLowerCase()
  if (/architecture|schema|layer|架构|依赖|数据流/.test(sample)) return "architecture"
  if (/lint|test|commit|branch|规范|测试|命名/.test(sample)) return "convention"
  if (/endpoint|port|api|ssh|url|踩坑|报错|价格|token/.test(sample)) return "reference"
  if (/prefer|不要|禁止|习惯|风格|always|never/.test(sample)) return "preference"
  return "context"
}

function summarizeOneLine(description: string | undefined, content: string): string {
  const source = (description?.trim() || content.trim().split(/\r?\n/).find((line) => line.trim()) || "").trim()
  return source
    .replace(/^#+\s*/, "")
    .replace(/^[-*]\s*/, "")
    .replace(/\s+/g, " ")
    .slice(0, 140)
}

function formatMarkdownMemoryFile(input: {
  readonly name: string
  readonly description?: string
  readonly category: Memory.Category
  readonly sessionID?: string
  readonly content: string
}): string {
  const cleanDesc = summarizeOneLine(input.description, input.content).replaceAll('"', '\\"')
  const headerLines = [
    "---",
    `name: ${input.name.replace(/\r?\n/g, " ").trim()}`,
    ...(cleanDesc ? [`description: "${cleanDesc}"`] : []),
    "metadata:",
    "  node_type: memory",
    `  type: ${categoryToFrontmatterType(input.category)}`,
    ...(input.sessionID ? [`  originSessionId: ${input.sessionID}`] : []),
    "---",
    "",
    input.content.trim(),
    "",
  ]
  return headerLines.join("\n")
}

function readMemoryIndexLinks(dir: string): Map<string, { readonly title: string; readonly summary?: string }> {
  const map = new Map<string, { readonly title: string; readonly summary?: string }>()
  const indexPath = path.join(dir, "MEMORY.md")
  if (!fs.existsSync(indexPath)) return map
  const raw = Option.getOrUndefined(Option.liftThrowable(() => fs.readFileSync(indexPath, "utf8"))())
  if (!raw) return map
  raw.split(/\r?\n/).forEach((line) => {
    const match = /^\s*-\s*\[([^\]]+)\]\(([^)]+\.md)\)(?:\s*[—–-]+\s*(.+))?\s*$/.exec(line)
    if (!match?.[1] || !match[2]) return
    const fileKey = path.basename(match[2].trim())
    map.set(fileKey, {
      title: match[1].trim(),
      ...(match[3]?.trim() ? { summary: match[3].trim() } : {}),
    })
  })
  return map
}

function syncMemoryIndexFile(dir: string, items: readonly Memory.Item[]) {
  if (!fs.existsSync(dir)) return
  const indexPath = path.join(dir, "MEMORY.md")
  const enabledItems = items.filter((item) => item.enabled && item.fileName)
  if (enabledItems.length === 0) {
    if (fs.existsSync(indexPath)) {
      Option.liftThrowable(() => fs.rmSync(indexPath, { force: true }))()
    }
    return
  }
  const lines = enabledItems.map((item) => {
    const summary = summarizeOneLine(item.description, item.content)
    return summary ? `- [${item.title}](${item.fileName}) — ${summary}` : `- [${item.title}](${item.fileName})`
  })
  Option.liftThrowable(() => fs.writeFileSync(indexPath, `${lines.join("\n")}\n`, "utf8"))()
}

function parseSingleMemoryFileSync(input: {
  readonly filePath: string
  readonly scope: Memory.Scope
  readonly directory?: string
  readonly indexMeta?: { readonly title: string; readonly summary?: string }
  readonly flags?: FileFlags
}): Memory.Item | undefined {
  const stat = Option.getOrUndefined(Option.liftThrowable(() => fs.statSync(input.filePath))())
  if (!stat?.isFile()) return undefined
  const raw = Option.getOrUndefined(Option.liftThrowable(() => fs.readFileSync(input.filePath, "utf8"))())
  if (raw === undefined) return undefined

  const fileName = path.basename(input.filePath)
  const stem = path.basename(input.filePath, path.extname(input.filePath))
  const trimmed = raw.trim()
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(trimmed)

  const metaRaw = fm?.[1] ?? ""
  const body = (fm ? (fm[2] ?? "") : trimmed).trim()
  const nameMatch = /^name:\s*["']?(.+?)["']?\s*$/m.exec(metaRaw)
  const descMatch = /^description:\s*["']?(.+?)["']?\s*$/m.exec(metaRaw)
  const typeMatch = /^\s*type:\s*["']?(.+?)["']?\s*$/m.exec(metaRaw)
  const sessionMatch = /^\s*originSessionId:\s*["']?(.+?)["']?\s*$/m.exec(metaRaw)

  const parsedName = nameMatch?.[1]?.trim()
  const title = (input.indexMeta?.title || parsedName || stem).slice(0, 160)
  const description = descMatch?.[1]?.trim() || input.indexMeta?.summary
  const content = (body || description || title).slice(0, MAX_CONTENT_CHARS)
  const category = inferCategoryFromText(typeMatch?.[1], `${title}\n${description ?? ""}\n${content}`)
  const mtime = Math.floor(stat.mtimeMs)
  const ctime = Math.floor(stat.birthtimeMs || stat.mtimeMs)

  return {
    id: makeMemoryIdFromPath(input.filePath),
    scope: input.scope,
    ...(input.scope === "project" && input.directory ? { directory: normalizeDir(input.directory) } : {}),
    fileName,
    filePath: path.resolve(input.filePath),
    title,
    ...(description ? { description } : {}),
    content,
    category,
    tags: input.flags?.tags ? [...input.flags.tags] : [],
    enabled: input.flags?.enabled ?? true,
    ...(input.flags?.pinned ? { pinned: true } : {}),
    ...(sessionMatch?.[1] ? { source: "ai", sessionID: sessionMatch[1].trim() } : {}),
    createdAt: ctime,
    updatedAt: mtime,
  }
}

function readMemoryDirItemsSync(input: {
  readonly dir: string
  readonly scope: Memory.Scope
  readonly directory?: string
  readonly stateMap: Record<string, FileFlags>
}): Memory.Item[] {
  if (!fs.existsSync(input.dir)) return []
  const names = Option.getOrElse(Option.liftThrowable(() => fs.readdirSync(input.dir))(), (): string[] => [])
  const indexLinks = readMemoryIndexLinks(input.dir)
  return names
    .filter((name) => name.toLowerCase().endsWith(".md") && name.toUpperCase() !== "MEMORY.MD")
    .toSorted()
    .slice(0, MAX_MEMORIES)
    .flatMap((name) => {
      const fullPath = path.resolve(input.dir, name)
      const parsed = parseSingleMemoryFileSync({
        filePath: fullPath,
        scope: input.scope,
        directory: input.directory,
        indexMeta: indexLinks.get(name),
        flags: input.stateMap[fullPath],
      })
      return parsed ? [parsed] : []
    })
}

function migrateLegacyJsonIfNeededSync(dataDir: string, homeDir: string) {
  const legacyPath = path.join(dataDir, LEGACY_STORE_FILENAME)
  if (!fs.existsSync(legacyPath)) return
  const raw = Option.getOrUndefined(Option.liftThrowable(() => fs.readFileSync(legacyPath, "utf8"))())
  if (!raw?.trim()) {
    Option.liftThrowable(() => fs.rmSync(legacyPath, { force: true }))()
    return
  }
  const decoded = decodeLegacyFile(raw)
  if (Option.isSome(decoded) && decoded.value.items.length > 0) {
    const stateMap = readStateMapSync(dataDir)
    const touchedDirs = new Map<string, { scope: Memory.Scope; directory?: string }>()
    decoded.value.items.forEach((item) => {
      const dir =
        item.scope === "global"
          ? globalMemoryDir(dataDir)
          : projectMemoryDir(homeDir, item.directory || "")
      if (item.scope === "project" && !item.directory) return
      fs.mkdirSync(dir, { recursive: true })
      const fileName = sanitizeMemoryFileName(item.fileName || item.title)
      const fullPath = path.resolve(dir, fileName)
      if (!fs.existsSync(fullPath)) {
        fs.writeFileSync(
          fullPath,
          formatMarkdownMemoryFile({
            name: item.title,
            description: item.description,
            category: item.category,
            sessionID: item.sessionID,
            content: item.content,
          }),
          "utf8",
        )
      }
      if (!item.enabled || item.pinned || item.tags.length > 0) {
        stateMap[fullPath] = {
          ...(item.enabled ? {} : { enabled: false }),
          ...(item.pinned ? { pinned: true } : {}),
          ...(item.tags.length > 0 ? { tags: [...item.tags] } : {}),
        }
      }
      touchedDirs.set(dir, { scope: item.scope, directory: item.directory })
    })
    writeStateMapSync(dataDir, stateMap)
    touchedDirs.forEach((meta, dir) => {
      const items = readMemoryDirItemsSync({
        dir,
        scope: meta.scope,
        directory: meta.directory,
        stateMap,
      })
      syncMemoryIndexFile(dir, items)
    })
  }
  Option.liftThrowable(() => fs.renameSync(legacyPath, `${legacyPath}.migrated`))()
}

function resolveCandidateProjectDirs(directory: string, projectRoot?: string): string[] {
  const candidates: string[] = []
  const pushUnique = (dir: string | undefined) => {
    const norm = normalizeDir(dir)
    if (norm && !candidates.includes(norm)) candidates.push(norm)
  }
  pushUnique(projectRoot)
  pushUnique(directory)

  let cursor = normalizeDir(directory)
  for (let depth = 0; depth < 6 && cursor; depth++) {
    const parent = normalizeDir(path.dirname(cursor))
    if (!parent || parent === cursor || parent === "/" || /^[A-Za-z]:\\?$/.test(parent)) break
    pushUnique(parent)
    cursor = parent
  }
  return candidates
}

export function readMemoryStoreSync(
  dataDir: string,
  homeDir = os.homedir(),
  directory?: string,
  projectRoot?: string,
): readonly Memory.Item[] {
  migrateLegacyJsonIfNeededSync(dataDir, homeDir)
  const stateMap = readStateMapSync(dataDir)
  const seenPaths = new Set<string>()
  const results: Memory.Item[] = []

  const appendFrom = (items: readonly Memory.Item[]) => {
    items.forEach((item) => {
      const key = item.filePath ?? item.id
      if (seenPaths.has(key)) return
      seenPaths.add(key)
      results.push(item)
    })
  }

  appendFrom(
    readMemoryDirItemsSync({
      dir: globalMemoryDir(dataDir),
      scope: "global",
      stateMap,
    }),
  )
  appendFrom(
    readMemoryDirItemsSync({
      dir: path.join(homeDir, ".claude", "memory"),
      scope: "global",
      stateMap,
    }),
  )

  if (directory || projectRoot) {
    resolveCandidateProjectDirs(directory ?? "", projectRoot).forEach((candDir) => {
      appendFrom(
        readMemoryDirItemsSync({
          dir: projectMemoryDir(homeDir, candDir),
          scope: "project",
          directory: candDir,
          stateMap,
        }),
      )
    })
  }

  return results
}

function findMemoryItemByIdSync(dataDir: string, homeDir: string, id: string): Memory.Item | undefined {
  const stateMap = readStateMapSync(dataDir)
  const globalItems = [
    ...readMemoryDirItemsSync({ dir: globalMemoryDir(dataDir), scope: "global", stateMap }),
    ...readMemoryDirItemsSync({ dir: path.join(homeDir, ".claude", "memory"), scope: "global", stateMap }),
  ]
  const foundGlobal = globalItems.find((item) => item.id === id)
  if (foundGlobal) return foundGlobal

  const projectsRoot = path.join(homeDir, ".claude", "projects")
  if (!fs.existsSync(projectsRoot)) return undefined
  const slugs = Option.getOrElse(Option.liftThrowable(() => fs.readdirSync(projectsRoot))(), (): string[] => [])
  for (const slug of slugs) {
    const memDir = path.join(projectsRoot, slug, "memory")
    const items = readMemoryDirItemsSync({
      dir: memDir,
      scope: "project",
      directory: slug,
      stateMap,
    })
    const match = items.find((item) => item.id === id)
    if (match) return match
  }
  return undefined
}

export function selectActiveMemories(
  items: readonly Memory.Item[],
  directory: string,
  projectRoot?: string,
): readonly Memory.Item[] {
  const normDir = normalizeDir(directory)
  const normRoot = normalizeDir(projectRoot)
  return items
    .filter((item) => {
      if (!item.enabled) return false
      if (item.scope === "global") return true
      if (!item.directory) return false
      return (
        (normDir !== "" && sameOrChildDir(normDir, item.directory)) ||
        (normRoot !== "" && sameOrChildDir(normRoot, item.directory))
      )
    })
    .toSorted((a, b) => {
      const pinDiff = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
      if (pinDiff !== 0) return pinDiff
      if (a.scope !== b.scope) return a.scope === "global" ? -1 : 1
      return a.createdAt - b.createdAt
    })
}

export function formatMemoriesInstruction(items: readonly Memory.Item[]): string | undefined {
  if (items.length === 0) return undefined
  const globals = items.filter((item) => item.scope === "global")
  const projects = items.filter((item) => item.scope === "project")

  const renderLine = (item: Memory.Item) => {
    const tagSuffix = item.tags.length > 0 ? ` (${item.tags.map((tag) => `#${tag}`).join(" ")})` : ""
    const body = item.content.trim().replace(/\n+/g, "\n  ")
    return `- **[${item.category}] ${item.title}**${tagSuffix}: ${body}`
  }

  const sections = [
    "<long_term_memory>",
    "Active long-term memories configured in Pigu Visual Memory. Honor these preferences, conventions, and project facts across sessions:",
    ...(globals.length > 0 ? ["", "### Global Memory", ...globals.map(renderLine)] : []),
    ...(projects.length > 0 ? ["", "### Project Memory", ...projects.map(renderLine)] : []),
    "</long_term_memory>",
  ]
  return sections.join("\n")
}

export function loadActiveMemoriesPromptSync(
  dataDir: string | undefined,
  directory: string,
  homeDir = os.homedir(),
): string | undefined {
  if (!dataDir) return undefined
  const all = readMemoryStoreSync(dataDir, homeDir, directory)
  const active = selectActiveMemories(all, directory)
  return formatMemoriesInstruction(active)
}

export function parseExternalMarkdownToMemories(input: {
  readonly content: string
  readonly fallbackTitle: string
  readonly scope: Memory.Scope
  readonly directory?: string
  readonly source: string
  readonly now: number
}): readonly Memory.Item[] {
  const trimmed = input.content.trim()
  if (!trimmed) return []

  const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(trimmed)
  if (frontmatterMatch) {
    const metaRaw = frontmatterMatch[1] ?? ""
    const body = (frontmatterMatch[2] ?? "").trim()
    if (!body) return []
    const nameMatch = /^name:\s*["']?(.+?)["']?\s*$/m.exec(metaRaw)
    const descMatch = /^description:\s*["']?(.+?)["']?\s*$/m.exec(metaRaw)
    const typeMatch = /^\s*type:\s*["']?(.+?)["']?\s*$/m.exec(metaRaw)
    const title = (nameMatch?.[1] || descMatch?.[1] || input.fallbackTitle).trim().slice(0, 120)
    const fullBody = descMatch?.[1] && nameMatch?.[1] ? `${descMatch[1].trim()}\n\n${body}` : body
    return [
      {
        id: makeRandomMemoryId(),
        scope: input.scope,
        ...(input.scope === "project" && input.directory ? { directory: normalizeDir(input.directory) } : {}),
        title,
        ...(descMatch?.[1]?.trim() ? { description: descMatch[1].trim() } : {}),
        content: fullBody.slice(0, MAX_CONTENT_CHARS),
        category: inferCategoryFromText(typeMatch?.[1], `${title}\n${fullBody}`),
        tags: [input.source],
        enabled: true,
        source: input.source,
        createdAt: input.now,
        updatedAt: input.now,
      },
    ]
  }

  const lines = trimmed.split(/\r?\n/)
  const sections: { title: string; lines: string[] }[] = []
  let current: { title: string; lines: string[] } = { title: input.fallbackTitle, lines: [] }

  lines.forEach((line) => {
    const heading = /^#{1,3}\s+(.+?)\s*$/.exec(line)
    if (heading?.[1]) {
      if (current.lines.join("\n").trim()) {
        sections.push(current)
      }
      current = { title: heading[1].trim().slice(0, 120), lines: [] }
      return
    }
    current.lines.push(line)
  })
  if (current.lines.join("\n").trim()) {
    sections.push(current)
  }

  return sections.slice(0, 25).map((section, idx) => {
    const body = section.lines.join("\n").trim().slice(0, MAX_CONTENT_CHARS)
    return {
      id: makeRandomMemoryId(),
      scope: input.scope,
      ...(input.scope === "project" && input.directory ? { directory: normalizeDir(input.directory) } : {}),
      title: section.title || `${input.fallbackTitle} #${idx + 1}`,
      content: body,
      category: inferCategoryFromText(undefined, `${section.title}\n${body}`),
      tags: [input.source],
      enabled: true,
      source: input.source,
      createdAt: input.now + idx,
      updatedAt: input.now + idx,
    }
  })
}

function readExternalFileEntry(input: {
  readonly filePath: string
  readonly source: Memory.ExternalSource
  readonly scope: Memory.Scope
  readonly directory?: string
  readonly title: string
  readonly writable: boolean
}): Memory.ExternalFile | undefined {
  if (!fs.existsSync(input.filePath)) return undefined
  const stat = Option.getOrUndefined(Option.liftThrowable(() => fs.statSync(input.filePath))())
  if (!stat?.isFile()) return undefined
  const raw = Option.getOrUndefined(Option.liftThrowable(() => fs.readFileSync(input.filePath, "utf8"))())
  if (raw === undefined) return undefined
  return {
    id: `ext_${Buffer.from(input.filePath).toString("base64url").slice(0, 24)}`,
    source: input.source,
    scope: input.scope,
    ...(input.directory ? { directory: normalizeDir(input.directory) } : {}),
    title: input.title,
    path: input.filePath,
    content: raw.slice(0, MAX_EXTERNAL_FILE_CHARS),
    writable: input.writable,
    updatedAt: Math.floor(stat.mtimeMs),
  }
}

function discoverExternalFiles(input: {
  readonly home: string
  readonly configDir: string
  readonly scope?: Memory.Scope
  readonly directory?: string
}): readonly Memory.ExternalFile[] {
  const seen = new Set<string>()
  const results: Memory.ExternalFile[] = []

  const push = (entry: Memory.ExternalFile | undefined) => {
    if (!entry) return
    const resolved = Option.getOrElse(Option.liftThrowable(() => fs.realpathSync(entry.path))(), () => entry.path)
    if (seen.has(resolved)) return
    seen.add(resolved)
    results.push(entry)
  }

  if (input.scope !== "project") {
    push(
      readExternalFileEntry({
        filePath: path.join(input.configDir, "AGENTS.md"),
        source: "agents-md",
        scope: "global",
        title: "Global AGENTS.md",
        writable: true,
      }),
    )
    push(
      readExternalFileEntry({
        filePath: path.join(input.home, ".claude", "CLAUDE.md"),
        source: "claude-md",
        scope: "global",
        title: "Global CLAUDE.md",
        writable: true,
      }),
    )
    push(
      readExternalFileEntry({
        filePath: path.join(input.home, ".gemini", "GEMINI.md"),
        source: "gemini-md",
        scope: "global",
        title: "Global GEMINI.md",
        writable: true,
      }),
    )
  }

  const targetDir = input.scope === "global" ? "" : normalizeDir(input.directory)
  if (targetDir) {
    push(
      readExternalFileEntry({
        filePath: path.join(targetDir, "AGENTS.md"),
        source: "agents-md",
        scope: "project",
        directory: targetDir,
        title: `${path.basename(targetDir) || targetDir} / AGENTS.md`,
        writable: true,
      }),
    )
    push(
      readExternalFileEntry({
        filePath: path.join(targetDir, "CLAUDE.md"),
        source: "claude-md",
        scope: "project",
        directory: targetDir,
        title: `${path.basename(targetDir) || targetDir} / CLAUDE.md`,
        writable: true,
      }),
    )
  }

  return results
}

function isAllowedExternalMemoryWrite(
  filePath: string,
  home: string,
  configDir: string,
): { readonly source: Memory.ExternalSource; readonly scope: Memory.Scope } | undefined {
  const resolved = path.resolve(filePath)
  const base = path.basename(resolved)

  if (resolved === path.resolve(configDir, "AGENTS.md")) {
    return { source: "agents-md", scope: "global" }
  }
  if (resolved === path.resolve(home, ".claude", "CLAUDE.md")) {
    return { source: "claude-md", scope: "global" }
  }
  if (resolved === path.resolve(home, ".gemini", "GEMINI.md")) {
    return { source: "gemini-md", scope: "global" }
  }
  if (base === "AGENTS.md") {
    return { source: "agents-md", scope: "project" }
  }
  if (base === "CLAUDE.md") {
    return { source: "claude-md", scope: "project" }
  }
  return undefined
}

const SaveToolInput = Schema.Struct({
  id: optional(Schema.String).annotate({
    description: "Optional existing memory ID (mem_...) to update in place.",
  }),
  title: Schema.String.annotate({
    description: "Concise, descriptive title of the memory file (for example 'Use bun check instead of tsc').",
  }),
  content: Schema.String.annotate({
    description: "Clear, self-contained Markdown memory note (user preference, architecture decision, or pitfall).",
  }),
  scope: optional(Memory.Scope).annotate({
    description: "'project' (default, applies to the current project) or 'global' (user-wide preference across all projects).",
  }),
  category: optional(Memory.Category).annotate({
    description: "Category: 'preference' | 'architecture' | 'convention' | 'reference' | 'context'.",
  }),
  tags: optional(Schema.Array(Schema.String)).annotate({
    description: "Optional short tags for filtering.",
  }),
})

const ListToolInput = Schema.Struct({
  scope: optional(Memory.Scope).annotate({
    description: "Optional filter: 'global' or 'project'. Omit to list both global and current project memories.",
  }),
})

const DeleteToolInput = Schema.Struct({
  id: Schema.String.annotate({ description: "Memory ID (mem_...) to delete." }),
})

const ListToolOutput = Schema.Struct({
  items: Schema.Array(Memory.Item),
})

const DeleteToolOutput = Schema.Struct({
  id: Schema.String,
  deleted: Schema.Boolean,
})

export const Plugin = define({
  id: "opencode.memory",
  effect: Effect.fn("MemoryPlugin.Plugin")(function* (ctx) {
    const global = yield* Global.Service
    const location = yield* Location.Service
    const discovery = yield* InstructionDiscovery.Service

    const storeKey = path.resolve(global.data)
    const projectDir = normalizeDir(location.project.directory || location.directory)

    const loadCurrentLocationItems = () =>
      readMemoryStoreSync(global.data, global.home, location.directory, location.project.directory)

    const filterForDiscovery = (allItems: readonly Memory.Item[]) =>
      selectActiveMemories(allItems, location.directory, location.project.directory).filter(
        (item) => (item.scope === "global" ? discovery.global : discovery.project),
      )

    const renderedState: { current: string | undefined } = {
      current: formatMemoriesInstruction(filterForDiscovery(loadCurrentLocationItems())),
    }

    yield* discovery.transform((editor) => {
      if (!renderedState.current) {
        editor.remove(VIRTUAL_INSTRUCTION_PATH)
        return
      }
      editor.add(new InstructionDiscovery.File({ path: VIRTUAL_INSTRUCTION_PATH, content: renderedState.current }))
    })

    const syncDiscovery = Effect.fn("MemoryPlugin.syncDiscovery")(function* () {
      renderedState.current = formatMemoriesInstruction(filterForDiscovery(loadCurrentLocationItems()))
      yield* discovery.reload()
    })

    const upsertMemory = Effect.fn("MemoryPlugin.upsert")(function* (input: Memory.UpsertInput) {
      yield* Clock.currentTimeMillis
      const scope = input.scope
      const directory =
        scope === "project" ? normalizeDir(input.directory || projectDir || location.directory) : undefined
      const targetMemDir =
        scope === "global"
          ? globalMemoryDir(global.data)
          : projectMemoryDir(global.home, directory || location.directory)

      fs.mkdirSync(targetMemDir, { recursive: true })
      const stateMap = readStateMapSync(global.data)

      const existingById = input.id ? findMemoryItemByIdSync(global.data, global.home, input.id) : undefined
      const dirItems = readMemoryDirItemsSync({
        dir: targetMemDir,
        scope,
        directory,
        stateMap,
      })

      const title = input.title.trim().slice(0, 160) || "Untitled Memory"
      const content = input.content.trim().slice(0, MAX_CONTENT_CHARS)
      const category =
        input.category ??
        existingById?.category ??
        inferCategoryFromText(undefined, `${title}\n${input.description ?? ""}\n${content}`)
      const tags =
        input.tags !== undefined
          ? input.tags.map((tag) => tag.trim()).filter(Boolean).slice(0, 12)
          : (existingById?.tags ?? [])

      const existing =
        existingById ??
        dirItems.find(
          (item) =>
            item.title.toLowerCase() === title.toLowerCase() ||
            (input.fileName ? item.fileName?.toLowerCase() === sanitizeMemoryFileName(input.fileName).toLowerCase() : false),
        )

      const desiredFileName = sanitizeMemoryFileName(input.fileName || existing?.fileName || title)
      const destPath = path.resolve(targetMemDir, desiredFileName)

      if (existing?.filePath && path.resolve(existing.filePath) !== destPath && fs.existsSync(existing.filePath)) {
        const oldPath = path.resolve(existing.filePath)
        const prevFlags = stateMap[oldPath]
        if (prevFlags) {
          stateMap[destPath] = prevFlags
          delete stateMap[oldPath]
        }
        fs.rmSync(existing.filePath, { force: true })
      }

      const nextEnabled = input.enabled ?? existing?.enabled ?? true
      const nextPinned = input.pinned ?? existing?.pinned ?? false

      if (!nextEnabled || nextPinned || tags.length > 0) {
        stateMap[destPath] = {
          ...(nextEnabled ? {} : { enabled: false }),
          ...(nextPinned ? { pinned: true } : {}),
          ...(tags.length > 0 ? { tags } : {}),
        }
      }
      if (nextEnabled && !nextPinned && tags.length === 0 && stateMap[destPath]) {
        delete stateMap[destPath]
      }
      writeStateMapSync(global.data, stateMap)

      const description = input.description?.trim() || existing?.description || summarizeOneLine(undefined, content)
      const sessionID = input.sessionID ?? existing?.sessionID

      fs.writeFileSync(
        destPath,
        formatMarkdownMemoryFile({
          name: title,
          description,
          category,
          sessionID,
          content,
        }),
        "utf8",
      )

      const refreshedDirItems = readMemoryDirItemsSync({
        dir: targetMemDir,
        scope,
        directory,
        stateMap,
      })
      const withUpdatedTitle = refreshedDirItems.map((item) =>
        item.filePath === destPath ? { ...item, title, ...(description ? { description } : {}) } : item,
      )
      syncMemoryIndexFile(targetMemDir, withUpdatedTitle)

      const saved =
        parseSingleMemoryFileSync({
          filePath: destPath,
          scope,
          directory,
          indexMeta: { title, ...(description ? { summary: description } : {}) },
          flags: stateMap[destPath],
        }) ?? withUpdatedTitle[0]!

      const allVisible = loadCurrentLocationItems()
      broadcastStoreChange(storeKey, { items: [...allVisible], focusID: saved.id })
      return saved
    })

    const toggleMemory = Effect.fn("MemoryPlugin.toggle")(function* (input: {
      readonly id: string
      readonly enabled?: boolean
      readonly pinned?: boolean
    }) {
      const target = findMemoryItemByIdSync(global.data, global.home, input.id)
      if (!target?.filePath) return null
      const fullPath = path.resolve(target.filePath)
      const stateMap = readStateMapSync(global.data)
      const prev = stateMap[fullPath] ?? {}
      const nextEnabled = input.enabled !== undefined ? input.enabled : (prev.enabled ?? target.enabled)
      const nextPinned = input.pinned !== undefined ? input.pinned : Boolean(prev.pinned ?? target.pinned)
      const nextTags = prev.tags ?? (target.tags.length > 0 ? [...target.tags] : undefined)

      if (!nextEnabled || nextPinned || (nextTags && nextTags.length > 0)) {
        stateMap[fullPath] = {
          ...(nextEnabled ? {} : { enabled: false }),
          ...(nextPinned ? { pinned: true } : {}),
          ...(nextTags && nextTags.length > 0 ? { tags: nextTags } : {}),
        }
      }
      if (nextEnabled && !nextPinned && (!nextTags || nextTags.length === 0) && stateMap[fullPath]) {
        delete stateMap[fullPath]
      }
      writeStateMapSync(global.data, stateMap)

      const memDir = path.dirname(fullPath)
      const dirItems = readMemoryDirItemsSync({
        dir: memDir,
        scope: target.scope,
        directory: target.directory,
        stateMap,
      })
      syncMemoryIndexFile(memDir, dirItems)

      const updated = dirItems.find((item) => item.id === input.id) ?? null
      broadcastStoreChange(storeKey, { items: [...loadCurrentLocationItems()], focusID: updated?.id })
      return updated
    })

    const removeMemory = Effect.fn("MemoryPlugin.remove")(function* (id: string) {
      const target = findMemoryItemByIdSync(global.data, global.home, id)
      if (!target?.filePath || !fs.existsSync(target.filePath)) return false
      const fullPath = path.resolve(target.filePath)
      const memDir = path.dirname(fullPath)
      fs.rmSync(fullPath, { force: true })

      const stateMap = readStateMapSync(global.data)
      if (stateMap[fullPath]) {
        delete stateMap[fullPath]
        writeStateMapSync(global.data, stateMap)
      }

      const remaining = readMemoryDirItemsSync({
        dir: memDir,
        scope: target.scope,
        directory: target.directory,
        stateMap,
      })
      syncMemoryIndexFile(memDir, remaining)

      broadcastStoreChange(storeKey, { items: [...loadCurrentLocationItems()] })
      return true
    })

    const rpc: RpcRegistration<typeof Memory.Definition> = yield* ctx.rpc
      .register(Memory.Definition, {
        snapshot: (input) =>
          Effect.sync(() => {
            const targetDir =
              input.scope === "global"
                ? ""
                : input.scope === "project"
                  ? normalizeDir(input.directory)
                  : normalizeDir(input.directory || projectDir || location.directory)
            const combined = readMemoryStoreSync(
              global.data,
              global.home,
              targetDir || undefined,
              input.scope === "project" ? undefined : projectDir || undefined,
            )
            const items =
              input.scope === "global"
                ? combined.filter((item) => item.scope === "global")
                : input.scope === "project"
                  ? combined.filter(
                      (item) =>
                        item.scope === "project" &&
                        item.directory !== undefined &&
                        targetDir !== "" &&
                        sameOrChildDir(targetDir, item.directory),
                    )
                  : [...combined]

            const externalFiles = discoverExternalFiles({
              home: global.home,
              configDir: global.config,
              scope: input.scope,
              directory: targetDir || undefined,
            })
            return {
              items,
              projectDirectories: targetDir ? [targetDir] : [],
              externalFiles: [...externalFiles],
            }
          }),
        upsert: (input) => upsertMemory(input),
        toggle: (input) => toggleMemory(input),
        remove: (input) => removeMemory(input.id),
        saveExternalFile: (input) =>
          Effect.try({
            try: () => {
              const allowed = isAllowedExternalMemoryWrite(input.path, global.home, global.config)
              if (!allowed) {
                throw new Error(`Writing external file is restricted to instruction files: ${input.path}`)
              }
              const bounded = input.content.slice(0, MAX_EXTERNAL_FILE_CHARS)
              fs.mkdirSync(path.dirname(input.path), { recursive: true })
              fs.writeFileSync(input.path, bounded, "utf8")
              const reread = readExternalFileEntry({
                filePath: path.resolve(input.path),
                source: allowed.source,
                scope: allowed.scope,
                title: path.basename(input.path),
                writable: true,
              })
              if (!reread) {
                throw new Error(`Failed to read saved file: ${input.path}`)
              }
              return reread
            },
            catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
          }).pipe(Effect.orDie),
        importExternal: (input) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            const resolved = path.resolve(input.path)
            if (!fs.existsSync(resolved)) return []
            const content = Option.getOrElse(Option.liftThrowable(() => fs.readFileSync(resolved, "utf8"))(), () => "")
            const parsed = parseExternalMarkdownToMemories({
              content,
              fallbackTitle: path.basename(resolved, path.extname(resolved)),
              scope: input.scope,
              directory:
                input.scope === "project"
                  ? normalizeDir(input.directory || projectDir || path.dirname(resolved))
                  : undefined,
              source: "imported",
              now,
            })
            const savedList: Memory.Item[] = []
            for (const entry of parsed) {
              const created = yield* upsertMemory({
                scope: entry.scope,
                directory: entry.directory,
                title: entry.title,
                description: entry.description,
                content: entry.content,
                category: entry.category,
                tags: entry.tags,
              })
              savedList.push(created)
            }
            return savedList
          }),
      })
      .pipe(Effect.orDie)

    const context = yield* Effect.context<never>()
    const runFork = Effect.runForkWith(context)

    const unsubscribe = subscribeStoreChanges(storeKey, (event) => {
      runFork(
        syncDiscovery().pipe(
          Effect.andThen(rpc.events.emit("changed", event)),
          Effect.catchCause((cause) => Effect.logWarning("failed to sync memory update", { cause })),
        ),
      )
    })
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))

    yield* ctx.tool
      .transform((editor) => {
        editor.namespace({
          name: "memory",
          description:
            "Persistent visual Markdown memory files across sessions in Pigu. Stores user preferences (global) and project knowledge/pitfalls (project) as .md memory files shared across native models and external CLIs.",
        })

        editor.add({
          name: "list",
          description: "List long-term memory files stored in Pigu (global preferences and current project memories).",
          input: ListToolInput,
          output: ListToolOutput,
          options: { namespace: "memory", codemode: true },
          execute: (input) =>
            Effect.sync(() => {
              const all = loadCurrentLocationItems()
              const relevant = all.filter((item) => (!input.scope ? true : item.scope === input.scope))
              return {
                output: { items: [...relevant] },
                content:
                  relevant.length === 0
                    ? "No long-term memory files stored yet."
                    : JSON.stringify(
                        relevant.map((item) => ({
                          id: item.id,
                          scope: item.scope,
                          fileName: item.fileName,
                          category: item.category,
                          enabled: item.enabled,
                          title: item.title,
                          content: item.content,
                        })),
                        null,
                        2,
                      ),
              }
            }),
        })

        editor.add({
          name: "save",
          description:
            "Save or update a Markdown memory file in Pigu when the user asks you to remember something across sessions or when a durable project convention/pitfall is established. Pass `scope: 'global'` for user-wide preferences or `'project'` (default) for repository-specific knowledge.",
          input: SaveToolInput,
          output: Memory.Item,
          options: { namespace: "memory", codemode: true },
          execute: (input, toolCtx) =>
            upsertMemory({
              id: input.id,
              scope: input.scope ?? "project",
              directory: (input.scope ?? "project") === "project" ? projectDir || location.directory : undefined,
              title: input.title,
              content: input.content,
              category: input.category,
              tags: input.tags,
              source: "ai",
              sessionID: toolCtx.sessionID,
            }).pipe(
              Effect.map((saved) => ({
                output: saved,
                content: `Saved ${saved.scope} memory file "${saved.fileName ?? saved.title}" (${saved.id}) to Pigu Memory.`,
              })),
            ),
        })

        editor.add({
          name: "delete",
          description: "Delete a Markdown memory file from Pigu Memory by ID.",
          input: DeleteToolInput,
          output: DeleteToolOutput,
          options: { namespace: "memory", codemode: true },
          execute: (input) =>
            removeMemory(input.id).pipe(
              Effect.map((deleted) => ({
                output: { id: input.id, deleted },
                content: deleted ? `Deleted memory file ${input.id}.` : `Memory file ${input.id} not found.`,
              })),
            ),
        })
      })
      .pipe(Effect.orDie)
  }),
})
