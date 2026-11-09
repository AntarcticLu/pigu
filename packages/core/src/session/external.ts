export * as SessionExternal from "./external.js"

import { eq, like, sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import nodeFs from "node:fs"
import os from "os"
import path from "path"
import zlib from "node:zlib"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { FSUtil } from "@opencode/util/fs-util"
import { Hash } from "@opencode/util/hash"
import { Bus } from "../bus.js"
import { DatabaseBatch } from "../database/batch.js"
import { Database } from "../database/database.js"
import { Project } from "../project.js"
import { ProjectTable, upsertProject } from "../project/sql.js"
import { AbsolutePath, RelativePath } from "../schema.js"
import { Slug } from "../util/slug.js"
import { SessionMessage } from "./message.js"
import { SessionSchema } from "./schema.js"
import { SessionMessageTable, SessionTable } from "./sql.js"

export type SourceApp =
  | "codex"
  | "claude"
  | "agy"
  | "pi"
  | "opencode"
  | "cursor"
  | "grok"
  | "deepseek-harness"
  | "workbuddy"

interface ExternalMessage {
  readonly role: "user" | "assistant"
  readonly text: string
  readonly thinking?: string
  readonly time: number
}

interface DiscoveredSession {
  readonly id: SessionSchema.ID
  readonly source: SourceApp
  readonly sourceLabel: string
  readonly externalID: string
  readonly filePath: string
  readonly cwd: string
  readonly title: string
  readonly model?: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly messages: ReadonlyArray<ExternalMessage>
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

const ContentPartSchema = Schema.Struct({
  type: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.String),
})

const CodexIndexLineSchema = Schema.Struct({
  id: Schema.String,
  thread_name: Schema.optional(Schema.String),
})

const CodexItemSchema = Schema.Struct({
  type: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Array(ContentPartSchema)),
})

const CodexEventSchema = Schema.Struct({
  timestamp: Schema.optional(Schema.String),
  type: Schema.String,
  payload: Schema.optional(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      type: Schema.optional(Schema.String),
      cwd: Schema.optional(Schema.String),
      model: Schema.optional(Schema.String),
      role: Schema.optional(Schema.String),
      source: Schema.optional(Schema.Unknown),
      message: Schema.optional(Schema.String),
      content: Schema.optional(Schema.Array(ContentPartSchema)),
      item: Schema.optional(CodexItemSchema),
    }),
  ),
})

const ClaudeLineSchema = Schema.Struct({
  type: Schema.optional(Schema.String),
  isMeta: Schema.optional(Schema.Boolean),
  isSidechain: Schema.optional(Schema.Boolean),
  cwd: Schema.optional(Schema.String),
  relocatedCwd: Schema.optional(Schema.String),
  customTitle: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.String),
  message: Schema.optional(
    Schema.Struct({
      role: Schema.optional(Schema.String),
      model: Schema.optional(Schema.String),
      content: Schema.optional(Schema.Union([Schema.String, Schema.Array(ContentPartSchema)])),
    }),
  ),
})

const ClaudeHistoryLineSchema = Schema.Struct({
  display: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.Number),
  project: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
})

const AgyLineSchema = Schema.Struct({
  step_index: Schema.optional(Schema.Number),
  type: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  created_at: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.String),
})

const PiLineSchema = Schema.Struct({
  type: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.String),
  message: Schema.optional(
    Schema.Struct({
      role: Schema.optional(Schema.String),
      content: Schema.optional(Schema.Union([Schema.String, Schema.Array(ContentPartSchema)])),
    }),
  ),
})

const decodeCodexIndex = Schema.decodeUnknownOption(CodexIndexLineSchema)
const decodeCodexEvent = Schema.decodeUnknownOption(CodexEventSchema)
const decodeClaudeLine = Schema.decodeUnknownOption(ClaudeLineSchema)
const decodeClaudeHistoryLine = Schema.decodeUnknownOption(ClaudeHistoryLineSchema)
const decodeAgyLine = Schema.decodeUnknownOption(AgyLineSchema)
const decodePiLine = Schema.decodeUnknownOption(PiLineSchema)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseTime(iso: string | undefined, fallback: number) {
  if (!iso) return fallback
  const parsed = Date.parse(iso)

  return Number.isFinite(parsed) ? parsed : fallback
}

function extractCodexPromptFromIdeContext(text: string): string | undefined {
  const normalized = text.replace(/\r\n/g, "\n")
  const lines = normalized.split("\n")
  let prompt: string | undefined

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = (lines[i] ?? "").trim()
    if (!trimmed.startsWith("#")) continue
    const heading = trimmed.replace(/^#+\s*/, "")
    if (!heading.toLowerCase().startsWith("my request for codex")) continue
    const suffix = heading.slice("my request for codex".length).trimStart()
    const inline = suffix.replace(/^[:：\-—\s]+/, "").trim()
    if (inline) {
      prompt = inline
      continue
    }
    const following = lines.slice(i + 1).join("\n").trim()
    if (following) prompt = following
  }

  return prompt
}

function stripIdeMetadataTags(text: string) {
  const cleaned = text
    .replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/gi, "")
    .replace(/<ide_selection>[\s\S]*?<\/ide_selection>/gi, "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "")
    .replace(/<permissions instructions>[\s\S]*?<\/permissions instructions>/gi, "")
    .replace(/<user_instructions>[\s\S]*?<\/user_instructions>/gi, "")
    .replace(/<skills_instructions>[\s\S]*?<\/skills_instructions>/gi, "")
    .replace(/<collaboration_mode>[\s\S]*?<\/collaboration_mode>/gi, "")
    .replace(/<multi_agent_mode>[\s\S]*?<\/multi_agent_mode>/gi, "")
    .trim()

  if (cleaned.startsWith("# Context from my IDE setup:")) {
    return extractCodexPromptFromIdeContext(cleaned) ?? ""
  }

  return cleaned
}

function isWrappedInXmlTag(text: string): boolean {
  if (!text.startsWith("<")) return false
  const tagMatch = /^<([A-Za-z0-9_-]+)[\s>]/.exec(text)
  if (!tagMatch?.[1]) return false
  return text.endsWith(`</${tagMatch[1]}>`)
}

function isInjectedPromptBoilerplate(text: string) {
  const trimmed = text.trim()
  if (!trimmed) return true
  if (isWrappedInXmlTag(trimmed)) return true
  return (
    trimmed.startsWith("<environment_context>") ||
    trimmed.startsWith("<permissions instructions>") ||
    trimmed.startsWith("<user_instructions>") ||
    trimmed.startsWith("<skills_instructions>") ||
    trimmed.startsWith("<collaboration_mode>") ||
    trimmed.startsWith("<multi_agent_mode>") ||
    trimmed.startsWith("<local-command") ||
    trimmed.startsWith("<command-name>") ||
    trimmed.startsWith("<turn_aborted>") ||
    trimmed.startsWith("# Context from my IDE setup:") ||
    trimmed.startsWith("Current runtime context.") ||
    /^#\s*AGENTS\.md\b/i.test(trimmed)
  )
}

function cleanTitle(text: string) {
  const cleaned = stripIdeMetadataTags(text)
  const line =
    cleaned
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find((item) => item.length > 0) ?? cleaned.trim()

  return line.slice(0, 64)
}

function makeSessionID(source: SourceApp, externalID: string) {
  return SessionSchema.ID.make(`ses_ext_${source}_${Hash.fast(`${source}:${externalID}`)}`)
}

function makeMessageID(sessionID: SessionSchema.ID, seq: number) {
  return SessionMessage.ID.make(`msg_ext_${Hash.fast(`${sessionID}:${seq}`)}_${seq}`)
}

function extractParts(content: string | ReadonlyArray<typeof ContentPartSchema.Type> | undefined) {
  if (!content) return { text: "", thinking: undefined }

  if (typeof content === "string") return { text: content.trim(), thinking: undefined }

  const text = content
    .flatMap((part) => {
      const kind = part.type?.toLowerCase()
      return (kind === "text" || kind === "input_text" || kind === "output_text") && part.text
        ? [part.text.trim()]
        : []
    })
    .filter(Boolean)
    .join("\n\n")

  const thinking = content
    .flatMap((part) => (part.type === "thinking" && part.thinking ? [part.thinking.trim()] : []))
    .filter(Boolean)
    .join("\n\n")

  return { text, thinking: thinking || undefined }
}

const MAX_FULL_READ_BYTES = 1024 * 1024
const CHUNK_READ_BYTES = 512 * 1024
const MAX_LINE_LENGTH = 1_048_576
const MAX_IMPORTED_MESSAGES = 60

const readBoundedJsonlLines = (fullPath: string) =>
  Effect.tryPromise(async () => {
    if (!fullPath || !nodeFs.existsSync(fullPath)) return []

    if (fullPath.endsWith(".zst") || fullPath.endsWith(".zstd")) {
      const compressed = nodeFs.readFileSync(fullPath)
      const decompressed = zlib.zstdDecompressSync(compressed).toString("utf8")
      return decompressed
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0 && line.length <= MAX_LINE_LENGTH)
    }

    const file = Bun.file(fullPath)
    const size = file.size

    if (size <= 0) return []

    if (size <= MAX_FULL_READ_BYTES) {
      const text = await file.text()

      return text.split(/\r?\n/).filter((line) => line.trim().length > 0 && line.length <= MAX_LINE_LENGTH)
    }

    const headText = await file.slice(0, CHUNK_READ_BYTES).text()
    const tailText = await file.slice(size - CHUNK_READ_BYTES, size).text()
    const headLines = headText.split(/\r?\n/).slice(0, -1)
    const tailLines = tailText.split(/\r?\n/).slice(1)

    return [...headLines, ...tailLines].filter((line) => line.trim().length > 0 && line.length <= MAX_LINE_LENGTH)
  }).pipe(Effect.orElseSucceed((): string[] => []))

function capMessages(messages: ReadonlyArray<ExternalMessage>): ReadonlyArray<ExternalMessage> {
  if (messages.length <= MAX_IMPORTED_MESSAGES) return messages
  const firstUser = messages.find((msg) => msg.role === "user")
  const tail = messages.slice(-(MAX_IMPORTED_MESSAGES - 1))

  if (!firstUser || tail.includes(firstUser)) return messages.slice(-MAX_IMPORTED_MESSAGES)

  return [firstUser, ...tail]
}

function normalizeCandidatePath(raw: string): string {
  const trimmed = raw.trim().replace(/^["']|["']$/g, "")
  if (!trimmed) return ""

  const withoutUri = trimmed.startsWith("file://")
    ? decodeURIComponent(trimmed.replace(/^file:\/\/\/?/i, (match) => (process.platform === "win32" ? "" : match.endsWith("///") ? "/" : "")))
    : trimmed

  const withoutExtendedPrefix = withoutUri.replace(/^(?:\\\\\?\\|\/\/\?\/)/, "")
  return FSUtil.windowsPath(withoutExtendedPrefix)
}

function isHomeOrRoot(dir: string, home: string): boolean {
  const norm = dir.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()
  const normHome = home.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()
  if (!norm || norm === "/" || /^[a-z]:$/i.test(norm)) return true
  if (norm === normHome) return true
  if (norm === "/users" || norm === "/home" || norm === "/volumes" || /^[a-z]:\/users$/i.test(norm)) return true
  return false
}

function isGenericFallbackRoot(dir: string, home: string): boolean {
  if (isHomeOrRoot(dir, home)) return true
  const norm = dir.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()
  const normHome = home.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()
  if (
    norm === `${normHome}/desktop` ||
    norm === `${normHome}/documents` ||
    norm === `${normHome}/downloads`
  ) {
    return true
  }
  return false
}

const resolveExistingDir = Effect.fnUntraced(function* (
  fs: FSUtil.Interface,
  candidate: string,
  home: string,
) {
  const normalized = normalizeCandidatePath(candidate)
  if (!normalized) return undefined

  const initial = path.resolve(normalized)
  if (!isHomeOrRoot(initial, home) && (yield* fs.isDir(initial))) {
    return initial
  }

  let current = path.dirname(initial)
  let depth = 1

  while (current && current !== path.dirname(current) && depth <= 2) {
    if (isGenericFallbackRoot(current, home)) return undefined
    if (
      (yield* fs.isDir(current)) &&
      ((yield* fs.exists(path.join(current, ".git"))) || (yield* fs.exists(path.join(current, ".hg"))))
    ) {
      return current
    }
    current = path.dirname(current)
    depth += 1
  }

  return undefined
})

function ensureFallbackProjectDir(home: string, candidate: string): string {
  const normalized = normalizeCandidatePath(candidate)
  const rawBase = normalized && !isHomeOrRoot(normalized, home) ? path.basename(normalized) : ""
  const cleanBase = rawBase.replace(/^[._-]+/, "").replace(/[<>:"/\\|?*\x00-\x1f]+/g, "-").trim()
  const folderName = cleanBase && !/^(temp|tmp|t)$/i.test(cleanBase) ? cleanBase : "历史会话"
  const dir = path.join(home, ".pigu", "projects", folderName)
  nodeFs.mkdirSync(dir, { recursive: true })
  return dir
}

function decodeClaudeProjectFolderFallback(encodedParent: string): string {
  const trimmed = encodedParent.trim()
  if (!trimmed || trimmed === ".") return ""
  const winMatch = /^([a-zA-Z])--(.+)$/.exec(trimmed)
  if (winMatch?.[1] && winMatch[2]) {
    const segments = winMatch[2].split("-").filter(Boolean)
    return segments.at(-1) ?? ""
  }
  if (trimmed.startsWith("-")) {
    const segments = trimmed.slice(1).split("-").filter(Boolean)
    return segments.at(-1) ?? ""
  }
  return trimmed
}

function extractPathsFromText(sample: string, home: string): string | undefined {
  const unescaped = sample.replace(/\\\\/g, "\\")
  const explicitPatterns = [
    /Command Working Directory:\s*([^\r\n"<]+)/i,
    /Active Workspaces:\s*\r?\n-\s*([^\r\n"<]+)/i,
    /Current working directory:\s*"([^"\r\n]+)"/i,
    /<cwd>\s*([^<\r\n]+)\s*<\/cwd>/i,
  ]

  for (const pattern of explicitPatterns) {
    const match = pattern.exec(unescaped)
    const candidate = match?.[1]?.trim()
    if (candidate) {
      const normalized = normalizeCandidatePath(candidate)
      if (normalized && !isGenericFallbackRoot(normalized, home)) return normalized
    }
  }

  const matches = [
    ...unescaped.matchAll(
      /[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n"'\s)\]`]+\\)+[^\\/:*?"<>|\r\n"'\s)\]`]+|[A-Za-z]:\/(?:[^\\/:*?"<>|\r\n"'\s)\]`]+\/)+[^\\/:*?"<>|\r\n"'\s)\]`]+|\/Volumes\/[^"'\s)\]`]+\/[^"'\s/)\]`]+|\/Users\/[^/"'\s]+\/[^."'\s/)\]`]+|\/home\/[^/"'\s]+\/[^."'\s/)\]`]+|\/root\/[^."'\s/)\]`]+/g,
    ),
  ].map((match) => normalizeCandidatePath(match[0]))

  return matches.find(
    (candidate) =>
      candidate.length > 0 &&
      !isGenericFallbackRoot(candidate, home) &&
      !candidate.includes(".gemini") &&
      !candidate.includes(".cursor") &&
      !candidate.includes(".claude") &&
      !candidate.includes(".codex") &&
      !candidate.includes(".dsh") &&
      !candidate.toLowerCase().includes("appdata"),
  )
}

function fileMtimeMs(fullPath: string): number {
  if (!nodeFs.existsSync(fullPath)) return 0
  return nodeFs.statSync(fullPath, { throwIfNoEntry: false })?.mtimeMs ?? 0
}

function selectRecentFilesByParent(
  rootDir: string,
  relativeFiles: ReadonlyArray<string>,
  perParentLimit: number,
  totalLimit: number,
): ReadonlyArray<string> {
  const withMtime = relativeFiles
    .map((rel) => ({
      rel,
      parent: path.dirname(rel),
      mtime: fileMtimeMs(path.join(rootDir, rel)),
    }))
    .toSorted((a, b) => b.mtime - a.mtime || b.rel.localeCompare(a.rel))

  const byParent = new Map<string, number>()
  const picked: string[] = []

  for (const item of withMtime) {
    if (picked.length >= totalLimit) break
    const count = byParent.get(item.parent) ?? 0
    if (count >= perParentLimit) continue
    byParent.set(item.parent, count + 1)
    picked.push(item.rel)
  }

  return picked
}

interface CodexSqliteThreadRow {
  readonly id: string
  readonly rollout_path: string | null
  readonly created_at: number | null
  readonly updated_at: number | null
  readonly cwd: string | null
  readonly title: string | null
  readonly first_user_message: string | null
  readonly model: string | null
}

const parseCodexRolloutFile = Effect.fnUntraced(function* (
  fullPath: string,
  externalID: string,
  sessionID: SessionSchema.ID,
  titles: ReadonlyMap<string, string>,
  fallbackCwd?: string,
  fallbackTitle?: string,
  fallbackFirstUser?: string,
  fallbackCreatedAt?: number,
  fallbackUpdatedAt?: number,
  fallbackModel?: string,
) {
  const lines = yield* readBoundedJsonlLines(fullPath)
  let cwd = fallbackCwd ?? ""
  let model = fallbackModel?.trim() ?? ""
  let createdAt = fallbackCreatedAt ?? Date.now()
  let updatedAt = fallbackUpdatedAt ?? createdAt
  const eventMessages: ExternalMessage[] = []
  const fallbackMessages: ExternalMessage[] = []

  for (const rawLine of lines) {
    const json = decodeJson(rawLine)

    if (Option.isNone(json)) continue
    const parsed = decodeCodexEvent(json.value)

    if (Option.isNone(parsed)) continue
    const row = parsed.value
    const time = parseTime(row.timestamp, updatedAt)
    updatedAt = Math.max(updatedAt, time)

    if (row.type === "session_meta" || row.type === "turn_context") {
      if (row.type === "session_meta" && isRecord(row.payload?.source) && "subagent" in row.payload.source) {
        return undefined
      }
      if (row.payload?.cwd && !cwd) cwd = row.payload.cwd
      if (row.payload?.model?.trim()) model = row.payload.model.trim()

      if (row.type === "session_meta" && row.timestamp) createdAt = time
    }

    if (row.type === "event_msg") {
      if (row.payload?.message?.trim()) {
        const cleaned = stripIdeMetadataTags(row.payload.message)
        if (row.payload.type === "user_message" && !isInjectedPromptBoilerplate(cleaned)) {
          eventMessages.push({ role: "user", text: cleaned, time })
        }

        if (row.payload.type === "agent_message" && cleaned) {
          eventMessages.push({ role: "assistant", text: cleaned, time })
        }
      }

      if (row.payload?.type === "item_completed" && row.payload.item) {
        const itemType = row.payload.item.type
        const extracted = extractParts(row.payload.item.content)
        const cleaned = stripIdeMetadataTags(extracted.text)
        if (itemType === "UserMessage" && !isInjectedPromptBoilerplate(cleaned)) {
          eventMessages.push({ role: "user", text: cleaned, time })
        }
        if (itemType === "AgentMessage" && cleaned) {
          eventMessages.push({ role: "assistant", text: cleaned, time })
        }
      }
    }

    if (row.type === "response_item" && row.payload?.type === "message") {
      const role = row.payload.role
      const extracted = extractParts(row.payload.content)
      const cleaned = stripIdeMetadataTags(extracted.text)

      if (role === "user" && !isInjectedPromptBoilerplate(cleaned)) {
        fallbackMessages.push({ role: "user", text: cleaned, thinking: extracted.thinking, time })
      }
      if (role === "assistant" && cleaned) {
        fallbackMessages.push({ role: "assistant", text: cleaned, thinking: extracted.thinking, time })
      }
    }
  }

  const baseMessages = eventMessages.length > 0 ? eventMessages : fallbackMessages
  const cleanedFallbackUser = fallbackFirstUser ? stripIdeMetadataTags(fallbackFirstUser) : ""
  const messages =
    baseMessages.length > 0
      ? baseMessages
      : cleanedFallbackUser && !isInjectedPromptBoilerplate(cleanedFallbackUser)
        ? [{ role: "user" as const, text: cleanedFallbackUser, time: createdAt }]
        : []
  const firstUser = messages.find((msg) => msg.role === "user")

  if (!firstUser) return undefined

  const discovered: DiscoveredSession = {
    id: sessionID,
    source: "codex",
    sourceLabel: "Codex",
    externalID,
    filePath: fullPath,
    cwd,
    title: titles.get(externalID) ?? (fallbackTitle ? cleanTitle(fallbackTitle) : cleanTitle(firstUser.text)),
    ...(model ? { model } : {}),
    createdAt,
    updatedAt: Math.max(createdAt, updatedAt),
    messages: capMessages(messages),
  }

  return discovered
})

const scanCodex = Effect.fn("SessionExternal.scanCodex")(function* (
  fs: FSUtil.Interface,
  home: string,
  existing: Set<string>,
) {
  const codexRoot = process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(home, ".codex")
  if (!(yield* fs.isDir(codexRoot))) return []

  const indexRaw = yield* fs.readFileStringSafe(path.join(codexRoot, "session_index.jsonl")).pipe(
    Effect.orElseSucceed(() => undefined),
  )

  const titles = new Map<string, string>(
    (indexRaw?.split(/\r?\n/) ?? []).flatMap((line) => {
      const json = line.trim() ? decodeJson(line) : Option.none()

      if (Option.isNone(json)) return []
      const decoded = decodeCodexIndex(json.value)

      if (Option.isNone(decoded) || !decoded.value.thread_name?.trim()) return []

      return [[decoded.value.id, decoded.value.thread_name.trim()]]
    }),
  )

  const seenIDs = new Set<string>(existing)
  const sqliteThreads = yield* Effect.tryPromise(async () => {
    const entries = nodeFs.readdirSync(codexRoot).filter((name) => /^state_\d+\.sqlite$/i.test(name))
    const latestDb = entries.toSorted((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0]
    if (!latestDb) return [] as CodexSqliteThreadRow[]
    const sqlite = await import("bun:sqlite")
    const db = new sqlite.Database(path.join(codexRoot, latestDb), { readonly: true })
    const columns = db.query<{ name: string }, []>("PRAGMA table_info(threads)").all()
    const hasModelCol = columns.some((col) => col.name === "model")
    const selectCols = hasModelCol
      ? "SELECT id, rollout_path, created_at, updated_at, cwd, title, first_user_message, model FROM threads WHERE archived = 0 ORDER BY updated_at DESC LIMIT 120"
      : "SELECT id, rollout_path, created_at, updated_at, cwd, title, first_user_message, NULL as model FROM threads WHERE archived = 0 ORDER BY updated_at DESC LIMIT 120"
    const rows = db.query<CodexSqliteThreadRow, []>(selectCols).all()
    db.close()
    return rows
  }).pipe(Effect.orElseSucceed((): CodexSqliteThreadRow[] => []))

  const byCwdCount = new Map<string, number>()
  const pickedSqliteRows = sqliteThreads.filter((row) => {
    if (!row.id) return false
    const key = (row.cwd ?? "__history__").toLowerCase()
    const count = byCwdCount.get(key) ?? 0
    if (count >= 8) return false
    byCwdCount.set(key, count + 1)
    return true
  }).slice(0, 50)

  const fromSqlite = yield* Effect.forEach(
    pickedSqliteRows,
    Effect.fnUntraced(function* (row) {
      const sessionID = makeSessionID("codex", row.id)
      if (seenIDs.has(sessionID)) return undefined
      seenIDs.add(sessionID)

      const createdAt = row.created_at ? (row.created_at < 10_000_000_000 ? row.created_at * 1000 : row.created_at) : Date.now()
      const updatedAt = row.updated_at ? (row.updated_at < 10_000_000_000 ? row.updated_at * 1000 : row.updated_at) : createdAt
      const rolloutPath = row.rollout_path ?? ""

      return yield* parseCodexRolloutFile(
        rolloutPath,
        row.id,
        sessionID,
        titles,
        row.cwd ?? undefined,
        row.title ?? undefined,
        row.first_user_message ?? row.title ?? undefined,
        createdAt,
        updatedAt,
        row.model ?? undefined,
      )
    }),
    { concurrency: 4 },
  )

  const codexDirs = [path.join(codexRoot, "sessions"), path.join(codexRoot, "archived_sessions")]
  const fileCandidates: string[] = []

  for (const dir of codexDirs) {
    if (!(yield* fs.isDir(dir))) continue
    const jsonlList = yield* fs.scan("**/*.jsonl", { cwd: dir }).pipe(Effect.orElseSucceed((): string[] => []))
    const zstList = yield* fs.scan("**/*.jsonl.zst", { cwd: dir }).pipe(Effect.orElseSucceed((): string[] => []))
    const plainSet = new Set(jsonlList.map((rel) => rel.replaceAll("\\", "/")))
    const dedupedZst = zstList
      .map((rel) => rel.replaceAll("\\", "/"))
      .filter((rel) => !plainSet.has(rel.slice(0, -4)))
    for (const rel of [...jsonlList.map((r) => r.replaceAll("\\", "/")), ...dedupedZst]) {
      fileCandidates.push(path.join(dir, rel))
    }
  }

  const recentFiles = fileCandidates
    .toSorted((a, b) => fileMtimeMs(b) - fileMtimeMs(a))
    .slice(0, 45)

  const fromFiles = yield* Effect.forEach(
    recentFiles,
    Effect.fnUntraced(function* (fullPath) {
      const logicalName = path.basename(fullPath).replace(/\.jsonl(?:\.zst)?$/i, "")
      const uuidMatch = logicalName.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)
      const externalID = uuidMatch ? uuidMatch[1]! : logicalName
      const sessionID = makeSessionID("codex", externalID)

      if (seenIDs.has(sessionID)) return undefined
      seenIDs.add(sessionID)

      return yield* parseCodexRolloutFile(fullPath, externalID, sessionID, titles)
    }),
    { concurrency: 4 },
  )

  return [...fromSqlite, ...fromFiles].filter((item): item is DiscoveredSession => item !== undefined)
})

const scanClaude = Effect.fn("SessionExternal.scanClaude")(function* (
  fs: FSUtil.Interface,
  home: string,
  existing: Set<string>,
) {
  const claudeConfigRoot = process.env.CLAUDE_CONFIG_DIR
    ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
    : path.join(home, ".claude")
  const claudeRoot = path.join(claudeConfigRoot, "projects")
  const seenIDs = new Set<string>(existing)

  const fromProjectFiles = yield* Effect.gen(function* () {
    if (!(yield* fs.isDir(claudeRoot))) return [] as DiscoveredSession[]

    const relativeFiles = yield* fs
      .scan("**/*.jsonl", { cwd: claudeRoot })
      .pipe(Effect.orElseSucceed((): string[] => []))

    const primaryFiles = relativeFiles.filter((rel) => !path.basename(rel).startsWith("agent-"))
    const pickedFiles = selectRecentFilesByParent(claudeRoot, primaryFiles, 8, 60)

    const results = yield* Effect.forEach(
      pickedFiles,
      Effect.fnUntraced(function* (rel) {
        const externalID = path.basename(rel, ".jsonl")
        const sessionID = makeSessionID("claude", externalID)

        if (seenIDs.has(sessionID)) return undefined

        const fullPath = path.join(claudeRoot, rel)
        const lines = yield* readBoundedJsonlLines(fullPath)

        if (lines.length === 0) return undefined
        let cwd = ""
        let relocatedCwd = ""
        let customTitle = ""
        let detectedModel = ""
        let createdAt = 0
        let updatedAt = 0
        const messages: ExternalMessage[] = []

        for (const rawLine of lines) {
          const json = decodeJson(rawLine)

          if (Option.isNone(json)) continue
          const parsed = decodeClaudeLine(json.value)

          if (Option.isNone(parsed)) continue
          const row = parsed.value

          if (row.isSidechain) continue
          if (row.cwd && !cwd) cwd = row.cwd
          if (row.type === "relocated" && row.relocatedCwd?.trim()) relocatedCwd = row.relocatedCwd.trim()
          if (row.type === "custom-title" && row.customTitle?.trim()) customTitle = row.customTitle.trim()

          const time = parseTime(row.timestamp, updatedAt || Date.now())

          if (!createdAt && row.timestamp) createdAt = time
          updatedAt = Math.max(updatedAt, time)

          if (row.type === "user" && !row.isMeta) {
            const extracted = extractParts(row.message?.content)
            const cleaned = stripIdeMetadataTags(extracted.text)

            if (cleaned && !isInjectedPromptBoilerplate(cleaned)) {
              messages.push({ role: "user", text: cleaned, time })
            }
          }

          if (row.type === "assistant") {
            const rawModel = row.message?.model?.trim().replace(/-\d{8}$/, "") ?? ""
            if (rawModel && rawModel !== "<synthetic>" && !rawModel.startsWith("<")) {
              detectedModel = rawModel
            }
            const extracted = extractParts(row.message?.content)

            if (extracted.text || extracted.thinking) {
              messages.push({
                role: "assistant",
                text: extracted.text || "...",
                thinking: extracted.thinking,
                time,
              })
            }
          }
        }

        const effectiveCwd = relocatedCwd || cwd || decodeClaudeProjectFolderFallback(path.dirname(rel))
        const firstUser = messages.find((msg) => msg.role === "user")

        if (!firstUser) return undefined
        seenIDs.add(sessionID)

        const fallbackTime = fileMtimeMs(fullPath) || Date.now()
        const discovered: DiscoveredSession = {
          id: sessionID,
          source: "claude",
          sourceLabel: "Claude",
          externalID,
          filePath: fullPath,
          cwd: effectiveCwd,
          title: customTitle ? cleanTitle(customTitle) : cleanTitle(firstUser.text),
          ...(detectedModel ? { model: detectedModel } : {}),
          createdAt: createdAt || fallbackTime,
          updatedAt: Math.max(createdAt || fallbackTime, updatedAt || fallbackTime),
          messages: capMessages(messages),
        }

        return discovered
      }),
      { concurrency: 4 },
    )

    return results.filter((item): item is DiscoveredSession => item !== undefined)
  })

  const historyPath = path.join(claudeConfigRoot, "history.jsonl")
  const historyLines = yield* readBoundedJsonlLines(historyPath)
  const historyBySession = new Map<
    string,
    { project: string; createdAt: number; updatedAt: number; prompts: ExternalMessage[] }
  >()

  for (const rawLine of historyLines) {
    const json = decodeJson(rawLine)
    if (Option.isNone(json)) continue
    const parsed = decodeClaudeHistoryLine(json.value)
    if (Option.isNone(parsed)) continue
    const row = parsed.value
    const sid = row.sessionId?.trim()
    const proj = row.project?.trim()
    const text = stripIdeMetadataTags(row.display ?? "")
    if (!sid || !proj || !text || text.startsWith("/")) continue
    const ts = row.timestamp ?? Date.now()
    const entry = historyBySession.get(sid) ?? {
      project: proj,
      createdAt: ts,
      updatedAt: ts,
      prompts: [],
    }
    entry.updatedAt = Math.max(entry.updatedAt, ts)
    entry.prompts.push({ role: "user", text, time: ts })
    historyBySession.set(sid, entry)
  }

  const fromHistory: DiscoveredSession[] = []
  const byProjCount = new Map<string, number>()
  const sortedHistory = [...historyBySession.entries()].toSorted((a, b) => b[1].updatedAt - a[1].updatedAt)

  for (const [sid, entry] of sortedHistory) {
    if (fromHistory.length >= 40) break
    const sessionID = makeSessionID("claude", sid)
    if (seenIDs.has(sessionID)) continue
    const projKey = entry.project.toLowerCase()
    const count = byProjCount.get(projKey) ?? 0
    if (count >= 6) continue
    const firstUser = entry.prompts[0]
    if (!firstUser) continue
    byProjCount.set(projKey, count + 1)
    seenIDs.add(sessionID)
    fromHistory.push({
      id: sessionID,
      source: "claude",
      sourceLabel: "Claude",
      externalID: sid,
      filePath: historyPath,
      cwd: entry.project,
      title: cleanTitle(firstUser.text),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      messages: capMessages(entry.prompts),
    })
  }

  return [...fromProjectFiles, ...fromHistory]
})

interface AgySummaryRow {
  readonly conversation_id: string
  readonly title: string | null
  readonly workspace_uris: string | null
  readonly preview: string | null
  readonly last_modified_time: string | null
}

const scanAgy = Effect.fn("SessionExternal.scanAgy")(function* (
  fs: FSUtil.Interface,
  home: string,
  existing: Set<string>,
) {
  const seenIDs = new Set<string>(existing)
  const agyBaseDirs = [
    path.join(home, ".gemini", "antigravity"),
    path.join(home, ".gemini", "antigravity-cli"),
  ]

  const summariesByConvID = new Map<
    string,
    { title?: string; cwd?: string; preview?: string; updatedAt?: number; dbPath: string }
  >()

  yield* Effect.tryPromise(async () => {
    const sqlite = await import("bun:sqlite")
    for (const baseDir of agyBaseDirs) {
      const dbPath = path.join(baseDir, "conversation_summaries.db")
      if (!nodeFs.existsSync(dbPath)) continue
      const db = new sqlite.Database(dbPath, { readonly: true })
      const rows = db
        .query<AgySummaryRow, []>(
          "SELECT conversation_id, title, workspace_uris, preview, last_modified_time FROM conversation_summaries",
        )
        .all()
      db.close()

      for (const row of rows) {
        if (!row.conversation_id) continue
        const uris = row.workspace_uris ? Option.getOrUndefined(decodeJson(row.workspace_uris)) : undefined
        const firstUri =
          Array.isArray(uris) && typeof uris[0] === "string" ? normalizeCandidatePath(uris[0]) : undefined
        const updatedAt = row.last_modified_time ? parseTime(row.last_modified_time, 0) : 0
        summariesByConvID.set(row.conversation_id, {
          title: row.title?.trim() || undefined,
          cwd: firstUri || undefined,
          preview: row.preview?.trim() || undefined,
          updatedAt: updatedAt || undefined,
          dbPath,
        })
      }
    }
  }).pipe(Effect.ignoreCause)

  const candidates: Array<{ convID: string; transcriptPath: string; mtime: number }> = []
  for (const baseDir of agyBaseDirs) {
    const brainRoot = path.join(baseDir, "brain")
    if (!(yield* fs.isDir(brainRoot))) continue
    const dirs = yield* fs.readDirectory(brainRoot).pipe(Effect.orElseSucceed((): string[] => []))
    for (const convID of dirs) {
      const fullTranscript = path.join(brainRoot, convID, ".system_generated", "logs", "transcript_full.jsonl")
      const compactTranscript = path.join(brainRoot, convID, ".system_generated", "logs", "transcript.jsonl")
      const transcriptPath = nodeFs.existsSync(fullTranscript) ? fullTranscript : compactTranscript
      const mtime = fileMtimeMs(transcriptPath)
      if (mtime > 0) {
        candidates.push({ convID, transcriptPath, mtime })
      }
    }
  }

  const sortedDirs = candidates.toSorted((a, b) => b.mtime - a.mtime).slice(0, 40)

  const fromTranscripts = yield* Effect.forEach(
    sortedDirs,
    Effect.fnUntraced(function* ({ convID, transcriptPath, mtime }) {
      const sessionID = makeSessionID("agy", convID)
      if (seenIDs.has(sessionID)) return undefined

      const lines = yield* readBoundedJsonlLines(transcriptPath)
      if (lines.length === 0) return undefined

      const summary = summariesByConvID.get(convID)
      const sampleHead = lines.slice(0, 30).join("\n")
      const inferredCwd = summary?.cwd ?? extractPathsFromText(sampleHead, home) ?? ""

      let createdAt = 0
      let updatedAt = summary?.updatedAt ?? 0
      const stepRows = new Map<number, typeof AgyLineSchema.Type>()
      const unindexedRows: Array<typeof AgyLineSchema.Type> = []

      for (const rawLine of lines) {
        const json = decodeJson(rawLine)
        if (Option.isNone(json)) continue
        const parsed = decodeAgyLine(json.value)
        if (Option.isNone(parsed)) continue
        const row = parsed.value
        if (typeof row.step_index === "number") {
          stepRows.set(row.step_index, row)
        } else {
          unindexedRows.push(row)
        }
      }

      const orderedRows = [
        ...[...stepRows.entries()].toSorted((a, b) => a[0] - b[0]).map((entry) => entry[1]),
        ...unindexedRows,
      ]
      const messages: ExternalMessage[] = []

      for (const row of orderedRows) {
        const time = parseTime(row.created_at, updatedAt || mtime || Date.now())
        if (!createdAt && row.created_at) createdAt = time
        updatedAt = Math.max(updatedAt, time)

        if (row.type === "USER_INPUT" && row.content) {
          const reqMatch = row.content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/)
          const userText = (reqMatch ? reqMatch[1]! : row.content).trim()

          if (userText && !userText.startsWith("<CONTEXT_SUMMARY>")) {
            messages.push({ role: "user", text: userText, time })
          }
        }

        if ((row.type === "PLANNER_RESPONSE" || row.source === "MODEL") && row.content?.trim()) {
          messages.push({
            role: "assistant",
            text: row.content.trim(),
            thinking: row.thinking?.trim() || undefined,
            time,
          })
        }
      }

      const firstUser = messages.find((msg) => msg.role === "user")
      if (!firstUser && !summary?.title && !summary?.preview) return undefined
      seenIDs.add(sessionID)

      const fallbackTime = mtime || Date.now()
      const finalMessages: ReadonlyArray<ExternalMessage> =
        messages.length > 0
          ? capMessages(messages)
          : [{ role: "user", text: summary?.preview ?? summary?.title ?? convID, time: fallbackTime }]
      const discovered: DiscoveredSession = {
        id: sessionID,
        source: "agy",
        sourceLabel: "AGY",
        externalID: convID,
        filePath: transcriptPath,
        cwd: inferredCwd,
        title: summary?.title ? cleanTitle(summary.title) : cleanTitle(firstUser?.text ?? summary?.preview ?? convID),
        createdAt: createdAt || fallbackTime,
        updatedAt: Math.max(createdAt || fallbackTime, updatedAt || fallbackTime),
        messages: finalMessages,
      }

      return discovered
    }),
    { concurrency: 3 },
  )

  const fromSummaryOnly: DiscoveredSession[] = []
  for (const [convID, summary] of summariesByConvID.entries()) {
    if (fromSummaryOnly.length >= 25) break
    const sessionID = makeSessionID("agy", convID)
    if (seenIDs.has(sessionID)) continue
    if (!summary.title && !summary.preview) continue
    seenIDs.add(sessionID)
    const ts = summary.updatedAt || Date.now()
    fromSummaryOnly.push({
      id: sessionID,
      source: "agy",
      sourceLabel: "AGY",
      externalID: convID,
      filePath: summary.dbPath,
      cwd: summary.cwd ?? "",
      title: cleanTitle(summary.title ?? summary.preview ?? convID),
      createdAt: ts,
      updatedAt: ts,
      messages: [{ role: "user", text: summary.preview ?? summary.title ?? convID, time: ts }],
    })
  }

  return [...fromTranscripts.filter((item): item is DiscoveredSession => item !== undefined), ...fromSummaryOnly]
})

const scanPi = Effect.fn("SessionExternal.scanPi")(function* (
  fs: FSUtil.Interface,
  home: string,
  existing: Set<string>,
) {
  const piRoot = path.join(home, ".pi", "agent", "sessions")

  if (!(yield* fs.isDir(piRoot))) return []

  const relativeFiles = yield* fs
    .scan("**/*.jsonl", { cwd: piRoot })
    .pipe(Effect.orElseSucceed((): string[] => []))

  const pickedFiles = selectRecentFilesByParent(piRoot, relativeFiles, 8, 30)

  const results = yield* Effect.forEach(
    pickedFiles,
    Effect.fnUntraced(function* (rel) {
      const sessionID = makeSessionID("pi", rel)

      if (existing.has(sessionID)) return undefined

      const fullPath = path.join(piRoot, rel)
      const lines = yield* readBoundedJsonlLines(fullPath)

      if (lines.length === 0) return undefined
      let cwd = ""
      let createdAt = 0
      let updatedAt = 0
      const messages: ExternalMessage[] = []

      for (const rawLine of lines) {
        const json = decodeJson(rawLine)

        if (Option.isNone(json)) continue
        const parsed = decodePiLine(json.value)

        if (Option.isNone(parsed)) continue
        const row = parsed.value
        const time = parseTime(row.timestamp, updatedAt || Date.now())

        if (!createdAt && row.timestamp) createdAt = time
        updatedAt = Math.max(updatedAt, time)

        if (row.type === "session" && row.cwd && !cwd) cwd = row.cwd

        if (row.type === "message" && (row.message?.role === "user" || row.message?.role === "assistant")) {
          const extracted = extractParts(row.message.content)

          if (extracted.text) {
            messages.push({
              role: row.message.role,
              text: extracted.text,
              thinking: extracted.thinking,
              time,
            })
          }
        }
      }

      const firstUser = messages.find((msg) => msg.role === "user")

      if (!firstUser) return undefined

      const fallbackTime = fileMtimeMs(fullPath) || Date.now()
      const discovered: DiscoveredSession = {
        id: sessionID,
        source: "pi",
        sourceLabel: "Pi",
        externalID: rel,
        filePath: fullPath,
        cwd,
        title: cleanTitle(firstUser.text),
        createdAt: createdAt || fallbackTime,
        updatedAt: Math.max(createdAt || fallbackTime, updatedAt || fallbackTime),
        messages: capMessages(messages),
      }
      return discovered
    }),
    { concurrency: 6 },
  )

  return results.filter((item): item is DiscoveredSession => item !== undefined)
})

const GenericJsonlLineSchema = Schema.Struct({
  type: Schema.optional(Schema.String),
  role: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Union([Schema.String, Schema.Array(ContentPartSchema)])),
  thinking: Schema.optional(Schema.String),
  message: Schema.optional(
    Schema.Struct({
      role: Schema.optional(Schema.String),
      content: Schema.optional(Schema.Union([Schema.String, Schema.Array(ContentPartSchema)])),
    }),
  ),
})

const decodeGenericJsonlLine = Schema.decodeUnknownOption(GenericJsonlLineSchema)

const scanGenericJsonlSource = Effect.fn("SessionExternal.scanGenericJsonlSource")(function* (input: {
  fs: FSUtil.Interface
  home: string
  rootDir: string
  pattern: string
  source: SourceApp
  sourceLabel: string
  existing: Set<string>
}) {
  if (!(yield* input.fs.isDir(input.rootDir))) return []

  const relativeFiles = yield* input.fs
    .scan(input.pattern, { cwd: input.rootDir })
    .pipe(Effect.orElseSucceed((): string[] => []))

  const pickedFiles = selectRecentFilesByParent(input.rootDir, relativeFiles, 8, 35)

  const results = yield* Effect.forEach(
    pickedFiles,
    Effect.fnUntraced(function* (rel) {
      const externalID = path.basename(rel, path.extname(rel))
      const sessionID = makeSessionID(input.source, rel.replaceAll("\\", "/"))

      if (input.existing.has(sessionID)) return undefined

      const fullPath = path.join(input.rootDir, rel)
      const lines = yield* readBoundedJsonlLines(fullPath)

      if (lines.length === 0) return undefined
      let cwd = ""
      let createdAt = 0
      let updatedAt = 0
      const messages: ExternalMessage[] = []

      for (const rawLine of lines) {
        const json = decodeJson(rawLine)

        if (Option.isNone(json)) continue
        const parsed = decodeGenericJsonlLine(json.value)

        if (Option.isNone(parsed)) continue
        const row = parsed.value

        if (row.cwd && !cwd) cwd = row.cwd
        const time = parseTime(row.timestamp, updatedAt || Date.now())

        if (!createdAt && row.timestamp) createdAt = time
        updatedAt = Math.max(updatedAt, time)

        const role = row.message?.role ?? row.role ?? (row.type === "user" || row.type === "assistant" ? row.type : undefined)
        const rawContent = row.message?.content ?? row.content

        if (role === "user" || role === "assistant") {
          const extracted = extractParts(rawContent)
          const cleaned = role === "user" ? stripIdeMetadataTags(extracted.text) : extracted.text

          if (cleaned && (role !== "user" || !isInjectedPromptBoilerplate(cleaned))) {
            messages.push({
              role,
              text: cleaned,
              thinking: extracted.thinking ?? row.thinking?.trim(),
              time,
            })
          }
        }
      }

      if (!cwd) {
        const sampleHead = lines.slice(0, 30).join("\n")
        cwd = extractPathsFromText(sampleHead, input.home) ?? ""
      }

      const firstUser = messages.find((msg) => msg.role === "user")

      if (!firstUser) return undefined

      const fallbackTime = fileMtimeMs(fullPath) || Date.now()
      const discovered: DiscoveredSession = {
        id: sessionID,
        source: input.source,
        sourceLabel: input.sourceLabel,
        externalID,
        filePath: fullPath,
        cwd,
        title: cleanTitle(firstUser.text),
        createdAt: createdAt || fallbackTime,
        updatedAt: Math.max(createdAt || fallbackTime, updatedAt || fallbackTime),
        messages: capMessages(messages),
      }

      return discovered
    }),
    { concurrency: 4 },
  )

  return results.filter((item): item is DiscoveredSession => item !== undefined)
})

const scanDsh = Effect.fn("SessionExternal.scanDsh")(function* (
  fs: FSUtil.Interface,
  home: string,
  existing: Set<string>,
) {
  const dshRoot = process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(home, ".dsh")
  if (!(yield* fs.isDir(dshRoot))) return []

  const seenIDs = new Set<string>(existing)
  const sessionsDir = path.join(dshRoot, "sessions")
  const zstdFiles = (yield* fs.isDir(sessionsDir))
    ? yield* fs.scan("**/*.jsonl.zstd", { cwd: sessionsDir }).pipe(Effect.orElseSucceed((): string[] => []))
    : []

  const pickedZstd = selectRecentFilesByParent(sessionsDir, zstdFiles, 8, 35)
  const fromZstd = yield* Effect.forEach(
    pickedZstd,
    Effect.fnUntraced(function* (rel) {
      const fullPath = path.join(sessionsDir, rel)
      const parentName = path.basename(path.dirname(rel))
      const externalID = parentName.startsWith("session-") ? parentName : path.basename(rel, ".jsonl.zstd")
      const sessionID = makeSessionID("deepseek-harness", externalID)

      if (seenIDs.has(sessionID)) return undefined

      const lines = yield* readBoundedJsonlLines(fullPath)

      if (lines.length === 0) return undefined
      let cwd = ""
      let title = ""
      let createdAt = 0
      let updatedAt = 0
      const seenMsgIDs = new Set<string>()
      const messages: ExternalMessage[] = []

      for (const rawLine of lines) {
        const json = decodeJson(rawLine)
        if (Option.isNone(json) || !isRecord(json.value)) continue
        const row = json.value
        const surfaceOp = isRecord(row.surfaceOp) ? row.surfaceOp : undefined
        if (surfaceOp?.op === "replace") continue

        const time = typeof row.time === "number" ? row.time : typeof row.createdAt === "number" ? row.createdAt : updatedAt || Date.now()
        if (!createdAt && time) createdAt = time
        updatedAt = Math.max(updatedAt, time)

        if ((row.type === "session" || row.type === "header") && typeof row.cwd === "string" && row.cwd && !cwd) {
          cwd = row.cwd
        }

        const data = isRecord(row.data) ? row.data : undefined
        if (row.type === "session/title" && typeof data?.title === "string" && data.title.trim()) {
          title = data.title.trim()
        }

        if (row.type === "user/message" && data) {
          if (typeof data.id === "string" && data.id) {
            if (seenMsgIDs.has(data.id)) continue
            seenMsgIDs.add(data.id)
          }
          const source = isRecord(data.source) ? data.source : undefined
          if ((!source?.kind || source.kind === "user") && Array.isArray(data.content)) {
            const text = data.content
              .flatMap((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text.trim()] : []))
              .filter(Boolean)
              .join("\n\n")
            if (text && !isInjectedPromptBoilerplate(text)) {
              messages.push({ role: "user", text, time })
            }
          }
        }

        if (row.type === "assistant/message" && data && isRecord(data.message) && Array.isArray(data.message.content)) {
          if (typeof data.message.id === "string" && data.message.id) {
            if (seenMsgIDs.has(data.message.id)) continue
            seenMsgIDs.add(data.message.id)
          }
          const text = data.message.content
            .flatMap((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text.trim()] : []))
            .filter(Boolean)
            .join("\n\n")
          const thinking = data.message.content
            .flatMap((part) =>
              isRecord(part) && (part.type === "reasoning" || part.type === "thinking") && typeof (part.text ?? part.thinking) === "string"
                ? [String(part.text ?? part.thinking).trim()]
                : [],
            )
            .filter(Boolean)
            .join("\n\n")
          if (text || thinking) {
            messages.push({
              role: "assistant",
              text: text || "...",
              thinking: thinking || undefined,
              time,
            })
          }
        }
      }

      const firstUser = messages.find((msg) => msg.role === "user")
      if (!firstUser) return undefined
      seenIDs.add(sessionID)

      const fallbackTime = fileMtimeMs(fullPath) || Date.now()
      const discovered: DiscoveredSession = {
        id: sessionID,
        source: "deepseek-harness",
        sourceLabel: "DSH",
        externalID,
        filePath: fullPath,
        cwd,
        title: title ? cleanTitle(title) : cleanTitle(firstUser.text),
        createdAt: createdAt || fallbackTime,
        updatedAt: Math.max(createdAt || fallbackTime, updatedAt || fallbackTime),
        messages: capMessages(messages),
      }
      return discovered
    }),
    { concurrency: 4 },
  )

  const projCacheDir = path.join(dshRoot, "storages", "session_projcache", "sessions")
  const cacheFiles = (yield* fs.isDir(projCacheDir))
    ? yield* fs.scan("*.json", { cwd: projCacheDir }).pipe(Effect.orElseSucceed((): string[] => []))
    : []

  const fromProjCache = yield* Effect.forEach(
    cacheFiles.slice(0, 30),
    Effect.fnUntraced(function* (rel) {
      const externalID = path.basename(rel, ".json")
      const sessionID = makeSessionID("deepseek-harness", externalID)
      if (seenIDs.has(sessionID)) return undefined

      const fullPath = path.join(projCacheDir, rel)
      const raw = yield* fs.readFileStringSafe(fullPath).pipe(Effect.orElseSucceed(() => undefined))
      const decoded = raw ? Option.getOrUndefined(decodeJson(raw)) : undefined
      if (!isRecord(decoded) || !isRecord(decoded.record)) return undefined

      const record = decoded.record
      const identity = isRecord(record.identity) ? record.identity : undefined
      const rows = isRecord(record.rows) ? record.rows : undefined
      const workingDirRow = rows && isRecord(rows.workingDirectory) ? rows.workingDirectory : undefined
      const titleRow = rows && isRecord(rows.title) ? rows.title : undefined
      const titleInputRow = rows && isRecord(rows.titleInput) ? rows.titleInput : undefined
      const titleInputVal = titleInputRow && isRecord(titleInputRow.val) ? titleInputRow.val : undefined
      const firstInput = titleInputVal && isRecord(titleInputVal.first) ? titleInputVal.first : undefined

      const cwd =
        (typeof workingDirRow?.val === "string" ? workingDirRow.val : undefined) ??
        (typeof identity?.cwd === "string" ? identity.cwd : "")
      const firstText = typeof firstInput?.text === "string" ? firstInput.text.trim() : ""
      const title = typeof titleRow?.val === "string" && titleRow.val.trim() ? titleRow.val.trim() : firstText

      if (!firstText) return undefined
      seenIDs.add(sessionID)

      const createdAt = typeof identity?.createdAt === "number" ? identity.createdAt : fileMtimeMs(fullPath) || Date.now()
      const updatedAt = Math.max(createdAt, fileMtimeMs(fullPath) || createdAt)
      const discovered: DiscoveredSession = {
        id: sessionID,
        source: "deepseek-harness",
        sourceLabel: "DSH",
        externalID,
        filePath: fullPath,
        cwd,
        title: cleanTitle(title),
        createdAt,
        updatedAt,
        messages: [{ role: "user", text: firstText, time: createdAt }],
      }
      return discovered
    }),
    { concurrency: 4 },
  )

  const fromJsonl = yield* scanGenericJsonlSource({
    fs,
    home,
    rootDir: sessionsDir,
    pattern: "**/*.jsonl",
    source: "deepseek-harness",
    sourceLabel: "DSH",
    existing: seenIDs,
  })

  return [...fromZstd, ...fromProjCache, ...fromJsonl].filter((item): item is DiscoveredSession => item !== undefined)
})

const scanGrok = Effect.fn("SessionExternal.scanGrok")(function* (
  fs: FSUtil.Interface,
  home: string,
  existing: Set<string>,
) {
  const grokRoot = path.join(home, ".grok")
  if (!(yield* fs.isDir(grokRoot))) return []

  const seenIDs = new Set<string>(existing)
  const summaryRoots = [path.join(grokRoot, "sessions"), path.join(grokRoot, "archived_sessions")]
  const summaryFiles: string[] = []

  for (const root of summaryRoots) {
    if (!(yield* fs.isDir(root))) continue
    const rels = yield* fs.scan("**/summary.json", { cwd: root }).pipe(Effect.orElseSucceed((): string[] => []))
    for (const rel of rels) {
      summaryFiles.push(path.join(root, rel))
    }
  }

  const pickedSummaries = summaryFiles.toSorted((a, b) => fileMtimeMs(b) - fileMtimeMs(a)).slice(0, 35)
  const fromSummaries = yield* Effect.forEach(
    pickedSummaries,
    Effect.fnUntraced(function* (summaryPath) {
      const raw = yield* fs.readFileStringSafe(summaryPath).pipe(Effect.orElseSucceed(() => undefined))
      const decoded = raw ? Option.getOrUndefined(decodeJson(raw)) : undefined
      if (!isRecord(decoded) || !isRecord(decoded.info)) return undefined

      const externalID = typeof decoded.info.id === "string" ? decoded.info.id.trim() : ""
      const cwd = typeof decoded.info.cwd === "string" ? decoded.info.cwd.trim() : ""
      if (!externalID) return undefined

      const sessionID = makeSessionID("grok", externalID)
      if (seenIDs.has(sessionID)) return undefined

      const chatHistoryPath = path.join(path.dirname(summaryPath), "chat_history.jsonl")
      const lines = yield* readBoundedJsonlLines(chatHistoryPath)
      const messages: ExternalMessage[] = []
      const fallbackTime = fileMtimeMs(summaryPath) || Date.now()
      let createdAt = typeof decoded.created_at === "string" ? parseTime(decoded.created_at, fallbackTime) : fallbackTime
      let updatedAt =
        typeof decoded.last_active_at === "string"
          ? parseTime(decoded.last_active_at, createdAt)
          : typeof decoded.updated_at === "string"
            ? parseTime(decoded.updated_at, createdAt)
            : createdAt

      for (const rawLine of lines) {
        const json = decodeJson(rawLine)
        if (Option.isNone(json) || !isRecord(json.value)) continue
        const row = json.value
        const role = row.type === "user" || row.type === "assistant" ? row.type : undefined
        if (!role) continue
        const time =
          typeof row.timestamp === "string"
            ? parseTime(row.timestamp, updatedAt)
            : typeof row.ts === "number"
              ? row.ts
              : updatedAt
        updatedAt = Math.max(updatedAt, time)
        const text =
          typeof row.content === "string"
            ? row.content.trim()
            : Array.isArray(row.content)
              ? row.content
                  .flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text.trim()] : []))
                  .filter(Boolean)
                  .join("\n\n")
              : ""
        if (text && (role !== "user" || !isInjectedPromptBoilerplate(text))) {
          messages.push({ role, text, time })
        }
      }

      const generatedTitle = typeof decoded.generated_title === "string" ? decoded.generated_title.trim() : ""
      const summaryText = typeof decoded.session_summary === "string" ? decoded.session_summary.trim() : ""
      const firstUser = messages.find((msg) => msg.role === "user")
      if (!firstUser && !generatedTitle && !summaryText) return undefined
      seenIDs.add(sessionID)

      const finalMessages: ReadonlyArray<ExternalMessage> =
        messages.length > 0
          ? capMessages(messages)
          : [{ role: "user", text: summaryText || generatedTitle, time: createdAt }]

      const discovered: DiscoveredSession = {
        id: sessionID,
        source: "grok",
        sourceLabel: "Grok",
        externalID,
        filePath: nodeFs.existsSync(chatHistoryPath) ? chatHistoryPath : summaryPath,
        cwd,
        title: cleanTitle(generatedTitle || firstUser?.text || summaryText),
        createdAt,
        updatedAt: Math.max(createdAt, updatedAt),
        messages: finalMessages,
      }
      return discovered
    }),
    { concurrency: 4 },
  )

  const fromGeneric = yield* scanGenericJsonlSource({
    fs,
    home,
    rootDir: path.join(grokRoot, "sessions"),
    pattern: "**/*.jsonl",
    source: "grok",
    sourceLabel: "Grok",
    existing: seenIDs,
  })

  return [...fromSummaries.filter((item): item is DiscoveredSession => item !== undefined), ...fromGeneric]
})

const OpencodeMessageDataSchema = Schema.Struct({
  role: Schema.optional(Schema.String),
})
const decodeOpencodeMessageData = Schema.decodeUnknownOption(Schema.fromJsonString(OpencodeMessageDataSchema))

const OpencodePartDataSchema = Schema.Struct({
  type: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
})
const decodeOpencodePartData = Schema.decodeUnknownOption(Schema.fromJsonString(OpencodePartDataSchema))

interface OpencodeSessionRow {
  readonly id: string
  readonly directory: string | null
  readonly title: string | null
  readonly time_created: number | null
  readonly time_updated: number | null
}

interface OpencodeMessageRow {
  readonly id: string
  readonly time_created: number | null
  readonly data: string
}

interface OpencodeV2MessageRow {
  readonly id: string
  readonly type: string | null
  readonly time_created: number | null
  readonly data: string
}

interface OpencodePartRow {
  readonly message_id: string
  readonly time_created: number | null
  readonly data: string
}

const scanOpencode = Effect.fn("SessionExternal.scanOpencode")(function* (
  fs: FSUtil.Interface,
  home: string,
  existing: Set<string>,
) {
  const seenIDs = new Set<string>(existing)
  const jsonlSessions = yield* scanGenericJsonlSource({
    fs,
    home,
    rootDir: path.join(home, ".opencode", "sessions"),
    pattern: "**/*.jsonl",
    source: "opencode",
    sourceLabel: "OpenCode",
    existing: seenIDs,
  })

  const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local")
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming")
  const xdgDataHome = process.env.XDG_DATA_HOME?.trim()
  const dbCandidates = [
    ...(process.env.OPENCODE_DB?.trim() ? [path.resolve(process.env.OPENCODE_DB.trim())] : []),
    ...(xdgDataHome ? [path.join(xdgDataHome, "opencode", "opencode.db")] : []),
    path.join(home, ".local", "share", "opencode", "opencode.db"),
    path.join(localAppData, "opencode", "opencode.db"),
    path.join(appData, "opencode", "opencode.db"),
  ]
  const dbPath = dbCandidates.find((candidate) => nodeFs.existsSync(candidate))
  if (!dbPath) return jsonlSessions

  const sqliteSessions = yield* Effect.tryPromise(async () => {
    const sqlite = await import("bun:sqlite")
    const db = new sqlite.Database(dbPath, { readonly: true })
    const tables = new Set(
      db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name),
    )

    const results: DiscoveredSession[] = []

    if (tables.has("session_v2") && tables.has("session_message")) {
      const v2Rows = db
        .query<OpencodeSessionRow, []>(
          "SELECT id, directory, title, time_created, time_updated FROM session_v2 WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT 35",
        )
        .all()

      for (const row of v2Rows) {
        if (row.id.startsWith("ses_ext_")) continue
        const sessionID = makeSessionID("opencode", row.id)
        if (seenIDs.has(sessionID)) continue

        const msgRows = db
          .query<OpencodeV2MessageRow, [string]>(
            "SELECT id, type, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq ASC, time_created ASC",
          )
          .all(row.id)

        const fallbackTime = Date.now()
        const messages: ExternalMessage[] = []
        for (const msgRow of msgRows) {
          const decoded = Option.getOrUndefined(decodeJson(msgRow.data))
          if (!isRecord(decoded)) continue
          const time = msgRow.time_created || row.time_created || fallbackTime
          if (msgRow.type === "user" && typeof decoded.text === "string" && decoded.text.trim()) {
            messages.push({ role: "user", text: decoded.text.trim(), time })
          }
          if (msgRow.type === "assistant" && Array.isArray(decoded.content)) {
            const text = decoded.content
              .flatMap((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text.trim()] : []))
              .filter(Boolean)
              .join("\n\n")
            const thinking = decoded.content
              .flatMap((part) => (isRecord(part) && part.type === "reasoning" && typeof part.text === "string" ? [part.text.trim()] : []))
              .filter(Boolean)
              .join("\n\n")
            if (text || thinking) {
              messages.push({ role: "assistant", text: text || "...", thinking: thinking || undefined, time })
            }
          }
        }

        const firstUser = messages.find((msg) => msg.role === "user")
        if (!firstUser && !row.title?.trim()) continue
        seenIDs.add(sessionID)

        const createdAt = row.time_created || fallbackTime
        const updatedAt = Math.max(createdAt, row.time_updated || fallbackTime)
        results.push({
          id: sessionID,
          source: "opencode",
          sourceLabel: "OpenCode",
          externalID: row.id,
          filePath: dbPath,
          cwd: row.directory ?? "",
          title: row.title?.trim() ? cleanTitle(row.title) : cleanTitle(firstUser?.text ?? row.id),
          createdAt,
          updatedAt,
          messages: messages.length > 0 ? capMessages(messages) : [{ role: "user", text: row.title ?? row.id, time: createdAt }],
        })
      }
    }

    if (tables.has("session") && tables.has("message") && tables.has("part")) {
      const sessionRows = db
        .query<OpencodeSessionRow, []>(
          "SELECT id, directory, title, time_created, time_updated FROM session WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT 35",
        )
        .all()

      for (const row of sessionRows) {
        if (row.id.startsWith("ses_ext_")) continue
        const sessionID = makeSessionID("opencode", row.id)
        if (seenIDs.has(sessionID)) continue

        const messageRows = db
          .query<OpencodeMessageRow, [string]>(
            "SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC",
          )
          .all(row.id)
        const partRows = db
          .query<OpencodePartRow, [string]>(
            "SELECT message_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created ASC",
          )
          .all(row.id)

        const partsByMessage = new Map<string, { textParts: string[]; thinkingParts: string[] }>()
        for (const partRow of partRows) {
          const parsedPart = decodeOpencodePartData(partRow.data)
          if (Option.isNone(parsedPart)) continue
          const partText = parsedPart.value.text?.trim()
          if (!partText) continue
          const entry = partsByMessage.get(partRow.message_id) ?? { textParts: [], thinkingParts: [] }
          if (parsedPart.value.type === "text") entry.textParts.push(partText)
          if (parsedPart.value.type === "reasoning") entry.thinkingParts.push(partText)
          partsByMessage.set(partRow.message_id, entry)
        }

        const fallbackTime = Date.now()
        const messages = messageRows.flatMap((msgRow): ExternalMessage[] => {
          const parsedMsg = decodeOpencodeMessageData(msgRow.data)
          if (Option.isNone(parsedMsg)) return []
          const role = parsedMsg.value.role
          if (role !== "user" && role !== "assistant") return []
          const parts = partsByMessage.get(msgRow.id)
          const text = parts?.textParts.join("\n\n").trim() ?? ""
          if (!text) return []
          const thinking = parts && parts.thinkingParts.length > 0 ? parts.thinkingParts.join("\n\n") : undefined
          return [
            {
              role,
              text,
              thinking,
              time: msgRow.time_created || row.time_created || fallbackTime,
            },
          ]
        })

        const firstUser = messages.find((msg) => msg.role === "user")
        if (!firstUser && !row.title?.trim()) continue
        seenIDs.add(sessionID)

        const createdAt = row.time_created || fallbackTime
        const updatedAt = Math.max(createdAt, row.time_updated || fallbackTime)
        results.push({
          id: sessionID,
          source: "opencode",
          sourceLabel: "OpenCode",
          externalID: row.id,
          filePath: dbPath,
          cwd: row.directory ?? "",
          title: row.title?.trim() ? cleanTitle(row.title) : cleanTitle(firstUser?.text ?? row.id),
          createdAt,
          updatedAt,
          messages: messages.length > 0 ? capMessages(messages) : [{ role: "user", text: row.title ?? row.id, time: createdAt }],
        })
      }
    }

    db.close()
    return results
  }).pipe(Effect.orElseSucceed((): DiscoveredSession[] => []))

  return [...sqliteSessions, ...jsonlSessions]
})

const SYNC_COOLDOWN_MS = 15_000
let lastSyncAt = 0
let initialSyncCompleted = false
let inFlightSync: Promise<void> | undefined
let deletedExternalIDsCache: Set<string> | undefined

function deletedExternalSessionsPath(home: string) {
  return path.join(home, ".config", "opencode", "deleted-external-sessions.json")
}

function loadDeletedExternalIDs(home = os.homedir()): Set<string> {
  if (deletedExternalIDsCache) return deletedExternalIDsCache
  const filePath = deletedExternalSessionsPath(home)
  const set = new Set<string>()
  if (nodeFs.existsSync(filePath)) {
    const raw = nodeFs.readFileSync(filePath, "utf8")
    const decoded = Option.getOrUndefined(decodeJson(raw))
    if (Array.isArray(decoded)) {
      for (const item of decoded) {
        if (typeof item === "string" && item.startsWith("ses_ext_")) {
          set.add(item)
        }
      }
    }
  }
  deletedExternalIDsCache = set
  return set
}

export function markDeleted(sessionID: string) {
  if (!sessionID.startsWith("ses_ext_")) return
  const home = os.homedir()
  const set = loadDeletedExternalIDs(home)
  if (set.has(sessionID)) return
  set.add(sessionID)
  const filePath = deletedExternalSessionsPath(home)
  nodeFs.mkdirSync(path.dirname(filePath), { recursive: true })
  nodeFs.writeFileSync(filePath, JSON.stringify([...set], null, 2), "utf8")
}

export function hasCompletedInitialSync() {
  return initialSyncCompleted
}

function localModelForSource(source: SourceApp, detectedModel?: string) {
  const cleanModel = detectedModel?.trim()
  const modelID =
    cleanModel && cleanModel !== "<synthetic>" && !cleanModel.startsWith(`${source}/`)
      ? `${source}/${cleanModel}`
      : cleanModel || source
  return {
    providerID: Provider.ID.make("local"),
    id: Model.ID.make(modelID),
  }
}

const runSyncInternal = Effect.fn("SessionExternal.runSyncInternal")(function* (input: {
  readonly db: Database.Interface["db"]
  readonly fs: FSUtil.Interface
  readonly projects: Project.Interface
  readonly version: string
}) {
  const home = os.homedir()
  const deletedIDs = loadDeletedExternalIDs(home)
  const checkedExternalIDs = new Set<string>(deletedIDs)

  const existingRows = yield* input.db
    .select({ id: SessionTable.id, model: SessionTable.model, directory: SessionTable.directory })
    .from(SessionTable)
    .where(like(SessionTable.id, "ses_ext_%"))
    .all()
    .pipe(Effect.orElseSucceed(() => []))

  const knownSources: ReadonlyArray<SourceApp> = [
    "claude",
    "codex",
    "agy",
    "pi",
    "opencode",
    "cursor",
    "grok",
    "deepseek-harness",
    "workbuddy",
  ]

  const resolvedDirs = new Map<string, Project.Resolved>()
  const resolveProjectForDir = Effect.fnUntraced(function* (dir: string) {
    const cached = resolvedDirs.get(dir)
    if (cached) return cached
    const project = yield* input.projects.resolve(AbsolutePath.make(dir))
    resolvedDirs.set(dir, project)
    yield* upsertProject(input.db, project).pipe(Effect.ignoreCause)
    return project
  })

  for (const row of existingRows) {
    if (deletedIDs.has(row.id)) {
      yield* input.db.delete(SessionTable).where(eq(SessionTable.id, row.id)).run().pipe(Effect.ignoreCause)
      continue
    }

    checkedExternalIDs.add(row.id)

    const shouldUpgrade =
      (row.model?.providerID === "pigu" && row.model?.id === "default") ||
      row.model?.providerID === "native-cli"

    if (shouldUpgrade) {
      const matchedSource = knownSources.find((src) => row.id.startsWith(`ses_ext_${src}_`))

      if (matchedSource) {
        yield* input.db
          .update(SessionTable)
          .set({ model: localModelForSource(matchedSource) })
          .where(eq(SessionTable.id, row.id))
          .run()
          .pipe(Effect.ignoreCause)
      }
    }

    if (isHomeOrRoot(row.directory, home) || !(yield* input.fs.isDir(row.directory))) {
      const fallbackDir = ensureFallbackProjectDir(home, row.directory)
      const project = yield* resolveProjectForDir(fallbackDir)
      const subpath = RelativePath.make(path.relative(project.directory, fallbackDir).replaceAll("\\", "/"))
      yield* input.db
        .update(SessionTable)
        .set({
          project_id: project.id,
          directory: AbsolutePath.make(fallbackDir),
          path: subpath,
        })
        .where(eq(SessionTable.id, row.id))
        .run()
        .pipe(Effect.ignoreCause)
    }
  }

  const [codex, claude, agy, pi, opencode, cursor, grok, dsh, workbuddy] = yield* Effect.all([
    scanCodex(input.fs, home, checkedExternalIDs),
    scanClaude(input.fs, home, checkedExternalIDs),
    scanAgy(input.fs, home, checkedExternalIDs),
    scanPi(input.fs, home, checkedExternalIDs),
    scanOpencode(input.fs, home, checkedExternalIDs),
    scanGenericJsonlSource({
      fs: input.fs,
      home,
      rootDir: path.join(home, ".cursor", "projects"),
      pattern: "**/agent-transcripts/*.jsonl",
      source: "cursor",
      sourceLabel: "Cursor",
      existing: checkedExternalIDs,
    }),
    scanGrok(input.fs, home, checkedExternalIDs),
    scanDsh(input.fs, home, checkedExternalIDs),
    scanGenericJsonlSource({
      fs: input.fs,
      home,
      rootDir: path.join(home, ".workbuddy", "sessions"),
      pattern: "**/*.jsonl",
      source: "workbuddy",
      sourceLabel: "WorkBuddy",
      existing: checkedExternalIDs,
    }),
  ])

  const all = [...codex, ...claude, ...agy, ...pi, ...opencode, ...cursor, ...grok, ...dsh, ...workbuddy]

  if (all.length === 0) return

  const defaultAgent = Agent.ID.make("build")

  for (const session of all) {
    const existingDir = yield* resolveExistingDir(input.fs, session.cwd, home)
    const validDir = existingDir ?? ensureFallbackProjectDir(home, session.cwd)
    const sessionModel = localModelForSource(session.source, session.model)
    const project = yield* resolveProjectForDir(validDir)

    const subpath = RelativePath.make(path.relative(project.directory, validDir).replaceAll("\\", "/"))

    const inserted = yield* input.db
      .insert(SessionTable)
      .values({
        id: session.id,
        project_id: project.id,
        slug: Slug.create(),
        directory: AbsolutePath.make(validDir),
        path: subpath,
        title: session.title,
        version: input.version,
        metadata: {
          source: session.source,
          sourceLabel: session.sourceLabel,
          externalID: session.externalID,
          filePath: session.filePath,
          ...(existingDir ? {} : session.cwd ? { originalCwd: session.cwd } : {}),
        },
        agent: defaultAgent,
        model: sessionModel,
        cost: 0,
        tokens_input: 0,
        tokens_output: 0,
        tokens_reasoning: 0,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
        time_created: session.createdAt,
        time_updated: session.updatedAt,
        time_idle: session.updatedAt,
        time_viewed: session.updatedAt,
        idle_outcome: "succeeded",
      })
      .onConflictDoNothing()
      .returning({ id: SessionTable.id })
      .get()
      .pipe(Effect.orElseSucceed(() => undefined))

    if (!inserted) continue

    const messageRows = session.messages.map((msg, index) => {
      const seq = index + 1
      const id = makeMessageID(session.id, seq)

      if (msg.role === "user") {
        return {
          id,
          session_id: session.id,
          type: "user" as const,
          seq,
          time_created: msg.time,
          time_updated: msg.time,
          data: {
            text: msg.text,
            time: { created: msg.time },
          },
        }
      }

      const content = [
        ...(msg.thinking
          ? [
              {
                type: "reasoning" as const,
                text: msg.thinking,
                time: { created: msg.time, completed: msg.time },
              },
            ]
          : []),
        {
          type: "text" as const,
          text: msg.text,
        },
      ]

      return {
        id,
        session_id: session.id,
        type: "assistant" as const,
        seq,
        time_created: msg.time,
        time_updated: msg.time,
        data: {
          agent: defaultAgent,
          model: sessionModel,
          content,
          finish: "stop" as const,
          time: {
            created: msg.time,
            streamed: msg.time,
            completed: msg.time,
          },
        },
      }
    })

    if (messageRows.length > 0) {
      for (const batch of DatabaseBatch.insertBatches(SessionMessageTable, messageRows)) {
        yield* input.db.insert(SessionMessageTable).values(batch).onConflictDoNothing().run().pipe(Effect.ignoreCause)
      }
    }

    yield* Bus.reserveSequence(input.db, session.id, Math.max(1, messageRows.length)).pipe(Effect.ignoreCause)

    yield* input.db
      .update(ProjectTable)
      .set({
        time_active: sql`max(${ProjectTable.time_active}, ${session.updatedAt})`,
        time_updated: sql`${ProjectTable.time_updated}`,
      })
      .where(eq(ProjectTable.id, project.id))
      .run()
      .pipe(Effect.ignoreCause)

    yield* input.projects.activate(project.id).pipe(Effect.ignoreCause)
  }
})

export const sync = Effect.fn("SessionExternal.sync")(function* (input: {
  readonly db: Database.Interface["db"]
  readonly fs: FSUtil.Interface
  readonly projects: Project.Interface
  readonly version: string
}) {
  const now = Date.now()
  if (initialSyncCompleted && now - lastSyncAt < SYNC_COOLDOWN_MS && !inFlightSync) return

  if (inFlightSync) {
    yield* Effect.promise(() => inFlightSync ?? Promise.resolve())
    return
  }

  lastSyncAt = now
  let resolveDone: (() => void) | undefined
  inFlightSync = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  yield* runSyncInternal(input).pipe(
    Effect.ignoreCause,
    Effect.ensuring(
      Effect.sync(() => {
        initialSyncCompleted = true
        lastSyncAt = Date.now()
        inFlightSync = undefined
        resolveDone?.()
      }),
    ),
  )
})

