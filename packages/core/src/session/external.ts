export * as SessionExternal from "./external.js"

import { eq, like, sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import os from "os"
import path from "path"
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

const CodexEventSchema = Schema.Struct({
  timestamp: Schema.optional(Schema.String),
  type: Schema.String,
  payload: Schema.optional(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      type: Schema.optional(Schema.String),
      cwd: Schema.optional(Schema.String),
      role: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
      content: Schema.optional(Schema.Array(ContentPartSchema)),
    }),
  ),
})

const ClaudeLineSchema = Schema.Struct({
  type: Schema.optional(Schema.String),
  isMeta: Schema.optional(Schema.Boolean),
  cwd: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.String),
  message: Schema.optional(
    Schema.Struct({
      role: Schema.optional(Schema.String),
      content: Schema.optional(Schema.Union([Schema.String, Schema.Array(ContentPartSchema)])),
    }),
  ),
})

const AgyLineSchema = Schema.Struct({
  type: Schema.optional(Schema.String),
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
const decodeAgyLine = Schema.decodeUnknownOption(AgyLineSchema)
const decodePiLine = Schema.decodeUnknownOption(PiLineSchema)

function parseTime(iso: string | undefined, fallback: number) {
  if (!iso) return fallback
  const parsed = Date.parse(iso)

  return Number.isFinite(parsed) ? parsed : fallback
}

function cleanTitle(text: string) {
  const line =
    text
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find((item) => item.length > 0) ?? text.trim()

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
    .flatMap((part) =>
      (part.type === "text" || part.type === "input_text" || part.type === "output_text") && part.text
        ? [part.text.trim()]
        : [],
    )
    .filter(Boolean)
    .join("\n\n")

  const thinking = content
    .flatMap((part) => (part.type === "thinking" && part.thinking ? [part.thinking.trim()] : []))
    .filter(Boolean)
    .join("\n\n")

  return { text, thinking: thinking || undefined }
}

const MAX_FULL_READ_BYTES = 512 * 1024
const CHUNK_READ_BYTES = 256 * 1024
const MAX_LINE_LENGTH = 65_536
const MAX_IMPORTED_MESSAGES = 60

const readBoundedJsonlLines = (fullPath: string) =>
  Effect.tryPromise(async () => {
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

const resolveExistingDir = Effect.fnUntraced(function* (fs: FSUtil.Interface, candidate: string, fallback: string) {
  let current = candidate ? path.resolve(candidate) : fallback

  while (current && current !== path.dirname(current)) {
    if (yield* fs.isDir(current)) return current
    current = path.dirname(current)
  }

  return fallback
})

const scanCodex = Effect.fn("SessionExternal.scanCodex")(function* (
  fs: FSUtil.Interface,
  home: string,
  existing: Set<string>,
) {
  const codexRoot = path.join(home, ".codex")
  const sessionsDir = path.join(codexRoot, "sessions")

  if (!(yield* fs.isDir(sessionsDir))) return []

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

  const relativeFiles = yield* fs
    .scan("**/*.jsonl", { cwd: sessionsDir })
    .pipe(Effect.orElseSucceed((): string[] => []))

  const recentFiles = relativeFiles.toSorted((a, b) => b.localeCompare(a)).slice(0, 30)

  const results = yield* Effect.forEach(
    recentFiles,
    Effect.fnUntraced(function* (rel) {
      const fullPath = path.join(sessionsDir, rel)
      const uuidMatch = path.basename(rel, ".jsonl").match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)
      const externalID = uuidMatch ? uuidMatch[1]! : path.basename(rel, ".jsonl")
      const sessionID = makeSessionID("codex", externalID)

      if (existing.has(sessionID)) return undefined
      existing.add(sessionID)

      const lines = yield* readBoundedJsonlLines(fullPath)

      if (lines.length === 0) return undefined
      let cwd = ""
      let createdAt = Date.now()
      let updatedAt = createdAt
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
          if (row.payload?.cwd && !cwd) cwd = row.payload.cwd

          if (row.type === "session_meta" && row.timestamp) createdAt = time
        }

        if (row.type === "event_msg" && row.payload?.message?.trim()) {
          if (row.payload.type === "user_message") {
            eventMessages.push({ role: "user", text: row.payload.message.trim(), time })
          }

          if (row.payload.type === "agent_message") {
            eventMessages.push({ role: "assistant", text: row.payload.message.trim(), time })
          }
        }

        if (row.type === "response_item" && row.payload?.type === "message") {
          const role = row.payload.role
          const extracted = extractParts(row.payload.content)

          if ((role === "user" || role === "assistant") && extracted.text && !extracted.text.startsWith("<environment_context>")) {
            fallbackMessages.push({ role, text: extracted.text, thinking: extracted.thinking, time })
          }
        }
      }

      const messages = eventMessages.length > 0 ? eventMessages : fallbackMessages
      const firstUser = messages.find((msg) => msg.role === "user")

      if (!cwd || !firstUser) return undefined

      const discovered: DiscoveredSession = {
        id: sessionID,
        source: "codex",
        sourceLabel: "Codex",
        externalID,
        filePath: fullPath,
        cwd,
        title: titles.get(externalID) ?? cleanTitle(firstUser.text),
        createdAt,
        updatedAt: Math.max(createdAt, updatedAt),
        messages: capMessages(messages),
      }

      return discovered
    }),
    { concurrency: 4 },
  )

  return results.filter((item): item is DiscoveredSession => item !== undefined)
})

const scanClaude = Effect.fn("SessionExternal.scanClaude")(function* (
  fs: FSUtil.Interface,
  home: string,
  existing: Set<string>,
) {
  const claudeRoot = path.join(home, ".claude", "projects")

  if (!(yield* fs.isDir(claudeRoot))) return []

  const relativeFiles = yield* fs
    .scan("*/*.jsonl", { cwd: claudeRoot })
    .pipe(Effect.orElseSucceed((): string[] => []))

  const results = yield* Effect.forEach(
    relativeFiles.slice(0, 30),
    Effect.fnUntraced(function* (rel) {
      const externalID = path.basename(rel, ".jsonl")
      const sessionID = makeSessionID("claude", externalID)

      if (existing.has(sessionID)) return undefined
      existing.add(sessionID)

      const lines = yield* readBoundedJsonlLines(path.join(claudeRoot, rel))

      if (lines.length === 0) return undefined
      let cwd = ""
      let createdAt = 0
      let updatedAt = 0
      const messages: ExternalMessage[] = []

      for (const rawLine of lines) {
        const json = decodeJson(rawLine)

        if (Option.isNone(json)) continue
        const parsed = decodeClaudeLine(json.value)

        if (Option.isNone(parsed)) continue
        const row = parsed.value

        if (row.cwd && !cwd) cwd = row.cwd
        const time = parseTime(row.timestamp, updatedAt || Date.now())

        if (!createdAt && row.timestamp) createdAt = time
        updatedAt = Math.max(updatedAt, time)

        if (row.type === "user" && !row.isMeta) {
          const extracted = extractParts(row.message?.content)

          if (
            extracted.text &&
            !extracted.text.startsWith("<local-command") &&
            !extracted.text.startsWith("<command-name>")
          ) {
            messages.push({ role: "user", text: extracted.text, time })
          }
        }

        if (row.type === "assistant") {
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

      const firstUser = messages.find((msg) => msg.role === "user")

      if (!cwd || !firstUser) return undefined

      const fallbackTime = Date.now()
      const discovered: DiscoveredSession = {
        id: sessionID,
        source: "claude",
        sourceLabel: "Claude",
        externalID,
        filePath: path.join(claudeRoot, rel),
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

const scanAgy = Effect.fn("SessionExternal.scanAgy")(function* (
  fs: FSUtil.Interface,
  home: string,
  existing: Set<string>,
) {
  const agyRoot = path.join(home, ".gemini", "antigravity", "brain")

  if (!(yield* fs.isDir(agyRoot))) return []

  const dirs = yield* fs.readDirectory(agyRoot).pipe(Effect.orElseSucceed((): string[] => []))

  const results = yield* Effect.forEach(
    dirs.slice(0, 20),
    Effect.fnUntraced(function* (convID) {
      const sessionID = makeSessionID("agy", convID)

      if (existing.has(sessionID)) return undefined
      existing.add(sessionID)

      const transcriptPath = path.join(agyRoot, convID, ".system_generated", "logs", "transcript.jsonl")
      const lines = yield* readBoundedJsonlLines(transcriptPath)

      if (lines.length === 0) return undefined

      const sampleHead = lines.slice(0, 25).join("\n")
      const pathMatches = [
        ...sampleHead.matchAll(/\/Volumes\/[^"'\s)\]`]+\/[^"'\s/)\]`]+|\/Users\/[^/"'\s]+\/[^."'\s/)\]`]+/g),
      ].map((match) => match[0])

      const inferredCwd = pathMatches.find((candidate) => !candidate.includes(".gemini")) ?? home
      let createdAt = 0
      let updatedAt = 0
      const messages: ExternalMessage[] = []

      for (const rawLine of lines) {
        const json = decodeJson(rawLine)

        if (Option.isNone(json)) continue
        const parsed = decodeAgyLine(json.value)

        if (Option.isNone(parsed)) continue
        const row = parsed.value
        const time = parseTime(row.created_at, updatedAt || Date.now())

        if (!createdAt && row.created_at) createdAt = time
        updatedAt = Math.max(updatedAt, time)

        if (row.type === "USER_INPUT" && row.content) {
          const reqMatch = row.content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/)
          const userText = (reqMatch ? reqMatch[1]! : row.content).trim()

          if (userText) messages.push({ role: "user", text: userText, time })
        }

        if (row.type === "PLANNER_RESPONSE" && row.content?.trim()) {
          messages.push({
            role: "assistant",
            text: row.content.trim(),
            thinking: row.thinking?.trim() || undefined,
            time,
          })
        }
      }

      const firstUser = messages.find((msg) => msg.role === "user")

      if (!firstUser) return undefined

      const fallbackTime = Date.now()
      const discovered: DiscoveredSession = {
        id: sessionID,
        source: "agy",
        sourceLabel: "AGY",
        externalID: convID,
        filePath: transcriptPath,
        cwd: inferredCwd,
        title: cleanTitle(firstUser.text),
        createdAt: createdAt || fallbackTime,
        updatedAt: Math.max(createdAt || fallbackTime, updatedAt || fallbackTime),
        messages: capMessages(messages),
      }

      return discovered
    }),
    { concurrency: 3 },
  )

  return results.filter((item): item is DiscoveredSession => item !== undefined)
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

  const results = yield* Effect.forEach(
    relativeFiles.slice(0, 20),
    Effect.fnUntraced(function* (rel) {
      const sessionID = makeSessionID("pi", rel)

      if (existing.has(sessionID)) return undefined
      existing.add(sessionID)

      const lines = yield* readBoundedJsonlLines(path.join(piRoot, rel))

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

      if (!cwd || !firstUser) return undefined

      const fallbackTime = Date.now()
      const discovered: DiscoveredSession = {
        id: sessionID,
        source: "pi",
        sourceLabel: "Pi",
        externalID: rel,
        filePath: path.join(piRoot, rel),
        cwd,
        title: cleanTitle(firstUser.text),
        createdAt: createdAt || fallbackTime,
        updatedAt: Math.max(createdAt || fallbackTime, updatedAt || fallbackTime),
        messages,
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

  const results = yield* Effect.forEach(
    relativeFiles.slice(0, 20),
    Effect.fnUntraced(function* (rel) {
      const externalID = path.basename(rel, path.extname(rel))
      const sessionID = makeSessionID(input.source, rel)

      if (input.existing.has(sessionID)) return undefined
      input.existing.add(sessionID)

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

          if (extracted.text) {
            messages.push({
              role,
              text: extracted.text,
              thinking: extracted.thinking ?? row.thinking?.trim(),
              time,
            })
          }
        }
      }

      if (!cwd) {
        const sampleHead = lines.slice(0, 25).join("\n")
        const pathMatches = [
          ...sampleHead.matchAll(/\/Volumes\/[^"'\s)\]`]+\/[^"'\s/)\]`]+|\/Users\/[^/"'\s]+\/[^."'\s/)\]`]+/g),
        ].map((match) => match[0])
        cwd = pathMatches.find((candidate) => !candidate.includes("/.")) ?? input.home
      }

      const firstUser = messages.find((msg) => msg.role === "user")

      if (!firstUser) return undefined

      const fallbackTime = Date.now()
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

const SYNC_COOLDOWN_MS = 300_000
let lastSyncAt = 0
let firstSyncDelayed = false
const checkedExternalIDs = new Set<string>()
const decodeStringArray = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)))

function localModelForSource(source: SourceApp) {
  return {
    providerID: Provider.ID.make("local"),
    id: Model.ID.make(source),
  }
}

export const sync = Effect.fn("SessionExternal.sync")(function* (input: {
  readonly db: Database.Interface["db"]
  readonly fs: FSUtil.Interface
  readonly projects: Project.Interface
  readonly version: string
}) {
  const now = Date.now()

  if (now - lastSyncAt < SYNC_COOLDOWN_MS) return
  lastSyncAt = now

  if (!firstSyncDelayed) {
    firstSyncDelayed = true
    yield* Effect.sleep("2 seconds")
  }

  const home = os.homedir()
  const cacheDir = path.join(home, ".cache", "pigu")
  const cacheFile = path.join(cacheDir, "external-scan-cache-v1.json")

  if (checkedExternalIDs.size === 0) {
    const cachedRaw = yield* input.fs.readFileStringSafe(cacheFile).pipe(Effect.orElseSucceed(() => undefined))
    const decoded = cachedRaw ? Option.getOrUndefined(decodeStringArray(cachedRaw)) : undefined

    if (decoded) {
      decoded.forEach((id) => checkedExternalIDs.add(id))
    }
  }

  const existingRows = yield* input.db
    .select({ id: SessionTable.id, model: SessionTable.model })
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

  for (const row of existingRows) {
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
  }

  const [codex, claude, agy, pi, opencode, cursor, grok, dsh, workbuddy] = yield* Effect.all([
    scanCodex(input.fs, home, checkedExternalIDs),
    scanClaude(input.fs, home, checkedExternalIDs),
    scanAgy(input.fs, home, checkedExternalIDs),
    scanPi(input.fs, home, checkedExternalIDs),
    scanGenericJsonlSource({
      fs: input.fs,
      home,
      rootDir: path.join(home, ".opencode", "sessions"),
      pattern: "**/*.jsonl",
      source: "opencode",
      sourceLabel: "OpenCode",
      existing: checkedExternalIDs,
    }),
    scanGenericJsonlSource({
      fs: input.fs,
      home,
      rootDir: path.join(home, ".cursor", "projects"),
      pattern: "*/agent-transcripts/*.jsonl",
      source: "cursor",
      sourceLabel: "Cursor",
      existing: checkedExternalIDs,
    }),
    scanGenericJsonlSource({
      fs: input.fs,
      home,
      rootDir: path.join(home, ".grok", "sessions"),
      pattern: "**/*.jsonl",
      source: "grok",
      sourceLabel: "Grok",
      existing: checkedExternalIDs,
    }),
    scanGenericJsonlSource({
      fs: input.fs,
      home,
      rootDir: path.join(home, ".dsh", "sessions"),
      pattern: "**/*.jsonl",
      source: "deepseek-harness",
      sourceLabel: "DSH",
      existing: checkedExternalIDs,
    }),
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

  yield* Effect.tryPromise(async () => {
    await Bun.write(cacheFile, JSON.stringify([...checkedExternalIDs]))
  }).pipe(Effect.ignoreCause)

  const all = [...codex, ...claude, ...agy, ...pi, ...opencode, ...cursor, ...grok, ...dsh, ...workbuddy]

  if (all.length === 0) return

  const resolvedDirs = new Map<string, Project.Resolved>()
  const defaultAgent = Agent.ID.make("build")

  for (const session of all) {
    const sessionModel = localModelForSource(session.source)
    const validDir = yield* resolveExistingDir(input.fs, session.cwd, home)
    const cachedProject = resolvedDirs.get(validDir)
    const project = cachedProject ?? (yield* input.projects.resolve(AbsolutePath.make(validDir)))

    if (!cachedProject) {
      resolvedDirs.set(validDir, project)
      yield* upsertProject(input.db, project).pipe(Effect.ignoreCause)
    }

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

      yield* Bus.reserveSequence(input.db, session.id, messageRows.length).pipe(Effect.ignoreCause)
    }

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
