export * as SessionExternal from "./external.js"

import { and, eq, like, lt, notLike, sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import nodeFs from "node:fs"
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
import { KVTable } from "../kv/sql.js"
import { Project } from "../project.js"
import { ProjectTable, upsertProject } from "../project/sql.js"
import { AbsolutePath, RelativePath } from "../schema.js"
import { Slug } from "../util/slug.js"
import {
  asString,
  BACKFILL_CHUNK_BYTES,
  cleanTitle,
  decodeJson,
  INITIAL_TAIL_BYTES,
  isDshBrokenFallbackTitle,
  isInjectedPromptBoilerplate,
  isRecord,
  normalizeCandidatePath,
  normalizeExternalToolCall,
  parseAgyLines,
  parseClaudeLines,
  parseCodexLines,
  parseDshLines,
  parseGenericLines,
  parseSliceBySource,
  parseTime,
  readJsonlForwardSync,
  readJsonlHeaderLinesSync,
  readJsonlWindowSync,
  stripIdeMetadataTags,
  type ExternalEntry,
  type ExternalToolItem,
  type SourceApp,
} from "./external-parse.js"
import { SessionMessage } from "./message.js"
import { SessionSchema } from "./schema.js"
import { SessionMessageTable, SessionTable } from "./sql.js"
import type { MessagesInput } from "./store.js"

export type { SourceApp }

const EXTERNAL_PARSER_VERSION = 7
const SEQ_BASE = 1_000_000
const REVIVAL_GRACE_MS = 5_000

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
  readonly entries: ReadonlyArray<ExternalEntry>
  readonly syncedFileSize: number
  readonly syncedMtimeMs: number
  readonly historyBackfillOffset: number
}

const CodexIndexLineSchema = Schema.Struct({
  id: Schema.String,
  thread_name: Schema.optional(Schema.String),
})

const ClaudeHistoryLineSchema = Schema.Struct({
  display: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.Number),
  project: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
})

const PiLineSchema = Schema.Struct({
  type: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.String),
  message: Schema.optional(
    Schema.Struct({
      role: Schema.optional(Schema.String),
      content: Schema.optional(Schema.Unknown),
    }),
  ),
})

const decodeCodexIndex = Schema.decodeUnknownOption(CodexIndexLineSchema)
const decodeClaudeHistoryLine = Schema.decodeUnknownOption(ClaudeHistoryLineSchema)
const decodePiLine = Schema.decodeUnknownOption(PiLineSchema)

export function makeSessionID(source: SourceApp, externalID: string) {
  return SessionSchema.ID.make(`ses_ext_${source}_${Hash.fast(`${source}:${externalID}`)}`)
}

function makeMessageID(sessionID: SessionSchema.ID, seq: number) {
  const seqTag = seq < 0 ? `n${Math.abs(seq)}` : String(seq)
  return SessionMessage.ID.make(`msg_ext_${Hash.fast(`${sessionID}:${seq}`)}_${seqTag}`)
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
  return (
    norm === `${normHome}/desktop` ||
    norm === `${normHome}/documents` ||
    norm === `${normHome}/downloads`
  )
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

function resolveClaudeProjectFolder(encodedParent: string): string {
  const trimmed = encodedParent.trim()
  if (!trimmed || trimmed === ".") return ""

  const walkSegments = (rootPrefix: string, parts: ReadonlyArray<string>): string | undefined => {
    let current = rootPrefix
    let idx = 0
    while (idx < parts.length) {
      let matched = ""
      let nextIdx = idx
      for (let end = parts.length; end > idx; end -= 1) {
        const candidateName = parts.slice(idx, end).join("-")
        const candidatePath = path.join(current, candidateName)
        if (nodeFs.existsSync(candidatePath)) {
          matched = candidatePath
          nextIdx = end
          break
        }
      }
      if (!matched) return undefined
      current = matched
      idx = nextIdx
    }
    return current
  }

  const winMatch = /^([a-zA-Z])--(.+)$/.exec(trimmed)
  if (winMatch?.[1] && winMatch[2]) {
    const segments = winMatch[2].split("-").filter(Boolean)
    const resolved = walkSegments(`${winMatch[1]}:\\`, segments)
    return resolved ?? (segments.at(-1) ?? "")
  }
  if (trimmed.startsWith("-")) {
    const segments = trimmed.slice(1).split("-").filter(Boolean)
    const resolved = walkSegments("/", segments)
    return resolved ?? (segments.at(-1) ?? "")
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
  if (!fullPath || !nodeFs.existsSync(fullPath)) return 0
  return Math.floor(nodeFs.statSync(fullPath, { throwIfNoEntry: false })?.mtimeMs ?? 0)
}

async function queryExternalSqliteSafely<T>(
  dbPath: string,
  preferDirectReadonly: boolean,
  runQuery: (db: InstanceType<typeof import("bun:sqlite").Database>) => T,
): Promise<T | undefined> {
  if (!dbPath || !nodeFs.existsSync(dbPath)) return undefined
  const sqlite = await import("bun:sqlite")

  if (preferDirectReadonly) {
    const direct = Option.liftThrowable(() => {
      const db = new sqlite.Database(dbPath, { readonly: true })
      const out = runQuery(db)
      db.close()
      return out
    })()
    if (Option.isSome(direct)) return direct.value
  }

  const tmpDir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "pigu-ext-sqlite-"))
  const tmpDbPath = path.join(tmpDir, path.basename(dbPath))
  const copied = Option.liftThrowable(() => {
    nodeFs.copyFileSync(dbPath, tmpDbPath)
    nodeFs.chmodSync(tmpDbPath, 0o600)
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${dbPath}${suffix}`
      if (nodeFs.existsSync(sidecar)) {
        const dst = `${tmpDbPath}${suffix}`
        nodeFs.copyFileSync(sidecar, dst)
        nodeFs.chmodSync(dst, 0o600)
      }
    }
    const db = new sqlite.Database(tmpDbPath)
    const out = runQuery(db)
    db.close()
    return out
  })()
  Option.liftThrowable(() => nodeFs.rmSync(tmpDir, { recursive: true, force: true }))()
  return Option.getOrUndefined(copied)
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

function readTailWindowEffect(fullPath: string, source: SourceApp) {
  return Effect.sync(() => {
    const stat = fullPath && nodeFs.existsSync(fullPath) ? nodeFs.statSync(fullPath, { throwIfNoEntry: false }) : undefined
    const size = stat?.isFile() ? stat.size : 0
    const targetStart = Math.max(0, size - INITIAL_TAIL_BYTES)
    return readJsonlWindowSync({ fullPath, targetStart, endOffset: size, source })
  })
}

interface CodexSqliteThreadRow {
  readonly id: string
  readonly rollout_path: string | null
  readonly created_at: number | null
  readonly updated_at: number | null
  readonly cwd: string | null
  readonly title: string | null
  readonly name: string | null
  readonly first_user_message: string | null
  readonly model: string | null
}

const parseCodexRolloutFile = Effect.fnUntraced(function* (
  fullPath: string,
  externalID: string,
  sessionID: SessionSchema.ID,
  titles: ReadonlyMap<string, string>,
  isBlocked: (sessionID: string, activityTimeMs: number) => boolean,
  fallbackCwd?: string,
  fallbackTitle?: string,
  fallbackFirstUser?: string,
  fallbackCreatedAt?: number,
  fallbackUpdatedAt?: number,
  fallbackModel?: string,
) {
  const window = yield* readTailWindowEffect(fullPath, "codex")
  const headerLines = window.startOffset > 0 ? readJsonlHeaderLinesSync(fullPath, 25) : []
  const headerParsed = headerLines.length > 0 ? parseCodexLines(headerLines, fallbackCreatedAt ?? window.mtimeMs) : undefined
  if (headerParsed?.meta.isSubagent) return undefined

  const fallbackTime = fallbackUpdatedAt ?? (window.mtimeMs || Date.now())
  const parsed = parseCodexLines(window.lines, fallbackTime)
  if (parsed.meta.isSubagent) return undefined

  const cwd = fallbackCwd || parsed.meta.cwd || headerParsed?.meta.cwd || ""
  const model = parsed.meta.model || headerParsed?.meta.model || fallbackModel?.trim() || ""
  const createdAt =
    fallbackCreatedAt ??
    (headerParsed?.meta.createdAt || parsed.meta.createdAt || window.mtimeMs || Date.now())
  const updatedAt = Math.max(
    createdAt,
    fallbackUpdatedAt ?? 0,
    parsed.meta.updatedAt,
    window.mtimeMs,
  )

  if (isBlocked(sessionID, updatedAt)) return undefined

  const cleanedFallbackUser = fallbackFirstUser ? stripIdeMetadataTags(fallbackFirstUser) : ""
  const entries: ReadonlyArray<ExternalEntry> =
    parsed.entries.length > 0
      ? parsed.entries
      : cleanedFallbackUser && !isInjectedPromptBoilerplate(cleanedFallbackUser)
        ? [{ kind: "user", text: cleanedFallbackUser, time: createdAt }]
        : []

  const firstUser =
    headerParsed?.entries.find((e): e is Extract<ExternalEntry, { kind: "user" }> => e.kind === "user") ??
    entries.find((e): e is Extract<ExternalEntry, { kind: "user" }> => e.kind === "user")

  if (entries.length === 0 && !fallbackTitle) return undefined

  const chosenTitle =
    titles.get(externalID) ??
    (fallbackTitle ? cleanTitle(fallbackTitle) : cleanTitle(firstUser?.text ?? cleanedFallbackUser ?? externalID))

  const discovered: DiscoveredSession = {
    id: sessionID,
    source: "codex",
    sourceLabel: "Codex",
    externalID,
    filePath: fullPath,
    cwd,
    title: chosenTitle || externalID,
    ...(model ? { model } : {}),
    createdAt,
    updatedAt,
    entries:
      entries.length > 0
        ? entries
        : [{ kind: "user", text: fallbackTitle ?? externalID, time: createdAt }],
    syncedFileSize: window.endOffset,
    syncedMtimeMs: window.mtimeMs,
    historyBackfillOffset: window.startOffset,
  }

  return discovered
})

const scanCodex = Effect.fn("SessionExternal.scanCodex")(function* (
  fs: FSUtil.Interface,
  home: string,
  existing: Set<string>,
  isBlocked: (sessionID: string, activityTimeMs: number) => boolean,
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
    const rows = await queryExternalSqliteSafely(path.join(codexRoot, latestDb), true, (db) => {
      const columns = new Set(
        db
          .query<{ name: string }, []>("PRAGMA table_info(threads)")
          .all()
          .map((col) => col.name),
      )
      const modelExpr = columns.has("model") ? "model" : "NULL as model"
      const nameExpr = columns.has("name") ? "name" : "NULL as name"
      return db
        .query<CodexSqliteThreadRow, []>(
          `SELECT id, rollout_path, created_at, updated_at, cwd, title, ${nameExpr}, first_user_message, ${modelExpr} FROM threads WHERE archived = 0 ORDER BY updated_at DESC LIMIT 300`,
        )
        .all()
    })
    return rows ?? []
  }).pipe(Effect.orElseSucceed((): CodexSqliteThreadRow[] => []))

  const byCwdCount = new Map<string, number>()
  const pickedSqliteRows = sqliteThreads
    .filter((row) => {
      if (!row.id) return false
      const key = (row.cwd ?? "__history__").toLowerCase()
      const count = byCwdCount.get(key) ?? 0
      if (count >= 40) return false
      byCwdCount.set(key, count + 1)
      return true
    })
    .slice(0, 200)

  const fromSqlite = yield* Effect.forEach(
    pickedSqliteRows,
    Effect.fnUntraced(function* (row) {
      const sessionID = makeSessionID("codex", row.id)
      if (seenIDs.has(sessionID)) return undefined
      seenIDs.add(sessionID)

      const createdAt = row.created_at
        ? row.created_at < 10_000_000_000
          ? row.created_at * 1000
          : row.created_at
        : Date.now()
      const updatedAt = row.updated_at
        ? row.updated_at < 10_000_000_000
          ? row.updated_at * 1000
          : row.updated_at
        : createdAt
      const rolloutPath = row.rollout_path ?? ""
      const explicitTitle = row.name?.trim() || row.title?.trim() || undefined

      return yield* parseCodexRolloutFile(
        rolloutPath,
        row.id,
        sessionID,
        titles,
        isBlocked,
        row.cwd ?? undefined,
        explicitTitle,
        row.first_user_message ?? explicitTitle,
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

  const recentFiles = fileCandidates.toSorted((a, b) => fileMtimeMs(b) - fileMtimeMs(a)).slice(0, 100)

  const fromFiles = yield* Effect.forEach(
    recentFiles,
    Effect.fnUntraced(function* (fullPath) {
      const logicalName = path.basename(fullPath).replace(/\.jsonl(?:\.zst)?$/i, "")
      const uuidMatch = logicalName.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)
      const externalID = uuidMatch ? uuidMatch[1]! : logicalName
      const sessionID = makeSessionID("codex", externalID)

      if (seenIDs.has(sessionID)) return undefined
      seenIDs.add(sessionID)

      return yield* parseCodexRolloutFile(fullPath, externalID, sessionID, titles, isBlocked)
    }),
    { concurrency: 4 },
  )

  return [...fromSqlite, ...fromFiles].filter((item): item is DiscoveredSession => item !== undefined)
})

const scanClaude = Effect.fn("SessionExternal.scanClaude")(function* (
  fs: FSUtil.Interface,
  home: string,
  existing: Set<string>,
  isBlocked: (sessionID: string, activityTimeMs: number) => boolean,
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
    const pickedFiles = selectRecentFilesByParent(claudeRoot, primaryFiles, 30, 180)

    const results = yield* Effect.forEach(
      pickedFiles,
      Effect.fnUntraced(function* (rel) {
        const externalID = path.basename(rel, ".jsonl")
        const sessionID = makeSessionID("claude", externalID)

        if (seenIDs.has(sessionID)) return undefined

        const fullPath = path.join(claudeRoot, rel)
        const window = yield* readTailWindowEffect(fullPath, "claude")
        if (window.lines.length === 0) return undefined

        const fallbackTime = window.mtimeMs || Date.now()
        const headerLines = window.startOffset > 0 ? readJsonlHeaderLinesSync(fullPath, 30) : []
        const headerParsed = headerLines.length > 0 ? parseClaudeLines(headerLines, fallbackTime) : undefined
        const parsed = parseClaudeLines(window.lines, fallbackTime)

        const effectiveCwd =
          parsed.meta.cwd || headerParsed?.meta.cwd || resolveClaudeProjectFolder(path.dirname(rel))
        const detectedModel = parsed.meta.model || headerParsed?.meta.model || ""
        const explicitTitle = parsed.meta.title || headerParsed?.meta.title || ""
        const createdAt = headerParsed?.meta.createdAt || parsed.meta.createdAt || fallbackTime
        const updatedAt = Math.max(createdAt, parsed.meta.updatedAt || fallbackTime, window.mtimeMs)

        if (isBlocked(sessionID, updatedAt)) return undefined

        const firstUser =
          headerParsed?.entries.find((e): e is Extract<ExternalEntry, { kind: "user" }> => e.kind === "user") ??
          parsed.entries.find((e): e is Extract<ExternalEntry, { kind: "user" }> => e.kind === "user")

        if (parsed.entries.length === 0 && !explicitTitle) return undefined
        seenIDs.add(sessionID)

        const discovered: DiscoveredSession = {
          id: sessionID,
          source: "claude",
          sourceLabel: "Claude",
          externalID,
          filePath: fullPath,
          cwd: effectiveCwd,
          title: explicitTitle ? cleanTitle(explicitTitle) : cleanTitle(firstUser?.text ?? externalID),
          ...(detectedModel ? { model: detectedModel } : {}),
          createdAt,
          updatedAt,
          entries: parsed.entries,
          syncedFileSize: window.endOffset,
          syncedMtimeMs: window.mtimeMs,
          historyBackfillOffset: window.startOffset,
        }

        return discovered
      }),
      { concurrency: 4 },
    )

    return results.filter((item): item is DiscoveredSession => item !== undefined)
  })

  const historyPath = path.join(claudeConfigRoot, "history.jsonl")
  const historyWindow = yield* readTailWindowEffect(historyPath, "claude")
  const historyBySession = new Map<
    string,
    { project: string; createdAt: number; updatedAt: number; prompts: ExternalEntry[] }
  >()

  for (const rawLine of historyWindow.lines) {
    const json = decodeJson(rawLine)
    if (Option.isNone(json)) continue
    const parsed = decodeClaudeHistoryLine(json.value)
    if (Option.isNone(parsed)) continue
    const row = parsed.value
    const sid = row.sessionId?.trim()
    const proj = row.project?.trim()
    const text = stripIdeMetadataTags(row.display ?? "")
    if (!sid || !proj || !text || text.startsWith("/")) continue
    const ts = Math.floor(row.timestamp ?? Date.now())
    const entry = historyBySession.get(sid) ?? {
      project: proj,
      createdAt: ts,
      updatedAt: ts,
      prompts: [],
    }
    entry.updatedAt = Math.max(entry.updatedAt, ts)
    entry.prompts.push({ kind: "user", text, time: ts })
    historyBySession.set(sid, entry)
  }

  const fromHistory: DiscoveredSession[] = []
  const byProjCount = new Map<string, number>()
  const sortedHistory = [...historyBySession.entries()].toSorted((a, b) => b[1].updatedAt - a[1].updatedAt)

  for (const [sid, entry] of sortedHistory) {
    if (fromHistory.length >= 80) break
    const sessionID = makeSessionID("claude", sid)
    if (seenIDs.has(sessionID) || isBlocked(sessionID, entry.updatedAt)) continue
    const projKey = entry.project.toLowerCase()
    const count = byProjCount.get(projKey) ?? 0
    if (count >= 15) continue
    const firstUser = entry.prompts[0]
    if (!firstUser || firstUser.kind !== "user") continue
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
      entries: entry.prompts,
      syncedFileSize: historyWindow.endOffset,
      syncedMtimeMs: historyWindow.mtimeMs,
      historyBackfillOffset: 0,
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
  readonly parent_conversation_id: string | null
}

const scanAgy = Effect.fn("SessionExternal.scanAgy")(function* (
  fs: FSUtil.Interface,
  home: string,
  existing: Set<string>,
  isBlocked: (sessionID: string, activityTimeMs: number) => boolean,
) {
  const seenIDs = new Set<string>(existing)
  const subagentConvIDs = new Set<string>()
  const agyBaseDirs = [
    path.join(home, ".gemini", "antigravity"),
    path.join(home, ".gemini", "antigravity-cli"),
  ]

  const summariesByConvID = new Map<
    string,
    { title?: string; cwd?: string; preview?: string; updatedAt?: number; dbPath: string }
  >()

  yield* Effect.tryPromise(async () => {
    for (const baseDir of agyBaseDirs) {
      const dbPath = path.join(baseDir, "conversation_summaries.db")
      const rows = await queryExternalSqliteSafely(dbPath, false, (db) => {
        const cols = new Set(
          db
            .query<{ name: string }, []>("PRAGMA table_info(conversation_summaries)")
            .all()
            .map((c) => c.name),
        )
        const parentExpr = cols.has("parent_conversation_id")
          ? "parent_conversation_id"
          : "NULL as parent_conversation_id"
        return db
          .query<AgySummaryRow, []>(
            `SELECT conversation_id, title, workspace_uris, preview, last_modified_time, ${parentExpr} FROM conversation_summaries`,
          )
          .all()
      })
      if (!rows) continue

      for (const row of rows) {
        if (!row.conversation_id) continue
        if (row.parent_conversation_id?.trim()) {
          subagentConvIDs.add(row.conversation_id)
          continue
        }
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
      if (subagentConvIDs.has(convID)) continue
      const fullTranscript = path.join(brainRoot, convID, ".system_generated", "logs", "transcript_full.jsonl")
      const compactTranscript = path.join(brainRoot, convID, ".system_generated", "logs", "transcript.jsonl")
      const transcriptPath = nodeFs.existsSync(fullTranscript) ? fullTranscript : compactTranscript
      const mtime = fileMtimeMs(transcriptPath)
      if (mtime > 0) {
        candidates.push({ convID, transcriptPath, mtime })
      }
    }
  }

  const sortedDirs = candidates.toSorted((a, b) => b.mtime - a.mtime).slice(0, 120)

  const fromTranscripts = yield* Effect.forEach(
    sortedDirs,
    Effect.fnUntraced(function* (item) {
      const sessionID = makeSessionID("agy", item.convID)
      if (seenIDs.has(sessionID)) return undefined

      const window = yield* readTailWindowEffect(item.transcriptPath, "agy")
      if (window.lines.length === 0) return undefined

      const summary = summariesByConvID.get(item.convID)
      const headerLines = window.startOffset > 0 ? readJsonlHeaderLinesSync(item.transcriptPath, 25) : []
      const sampleHead = (headerLines.length > 0 ? headerLines : window.lines.slice(0, 25)).join("\n")
      const inferredCwd =
        summary?.cwd ??
        extractPathsFromText(sampleHead, home) ??
        extractPathsFromText(window.lines.slice(-20).join("\n"), home) ??
        ""

      const fallbackTime = item.mtime || Date.now()
      const headerParsed = headerLines.length > 0 ? parseAgyLines(headerLines, fallbackTime) : undefined
      const parsed = parseAgyLines(window.lines, fallbackTime)

      const createdAt = headerParsed?.createdAt || parsed.createdAt || fallbackTime
      const updatedAt = Math.max(
        createdAt,
        summary?.updatedAt ?? 0,
        parsed.updatedAt || fallbackTime,
        window.mtimeMs,
      )

      if (isBlocked(sessionID, updatedAt)) return undefined

      const firstUser =
        headerParsed?.entries.find((e): e is Extract<ExternalEntry, { kind: "user" }> => e.kind === "user") ??
        parsed.entries.find((e): e is Extract<ExternalEntry, { kind: "user" }> => e.kind === "user")

      if (parsed.entries.length === 0 && !summary?.title && !summary?.preview) return undefined
      seenIDs.add(sessionID)

      const finalEntries: ReadonlyArray<ExternalEntry> =
        parsed.entries.length > 0
          ? parsed.entries
          : [{ kind: "user", text: summary?.preview ?? summary?.title ?? item.convID, time: fallbackTime }]

      const discovered: DiscoveredSession = {
        id: sessionID,
        source: "agy",
        sourceLabel: "AGY",
        externalID: item.convID,
        filePath: item.transcriptPath,
        cwd: inferredCwd,
        title: summary?.title
          ? cleanTitle(summary.title)
          : cleanTitle(firstUser?.text ?? summary?.preview ?? item.convID),
        createdAt,
        updatedAt,
        entries: finalEntries,
        syncedFileSize: window.endOffset,
        syncedMtimeMs: window.mtimeMs,
        historyBackfillOffset: window.startOffset,
      }

      return discovered
    }),
    { concurrency: 4 },
  )

  const fromSummaryOnly: DiscoveredSession[] = []
  for (const [convID, summary] of summariesByConvID.entries()) {
    if (fromSummaryOnly.length >= 60) break
    const sessionID = makeSessionID("agy", convID)
    const ts = summary.updatedAt || Date.now()
    if (seenIDs.has(sessionID) || isBlocked(sessionID, ts)) continue
    if (!summary.title && !summary.preview) continue
    seenIDs.add(sessionID)
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
      entries: [{ kind: "user", text: summary.preview ?? summary.title ?? convID, time: ts }],
      syncedFileSize: 0,
      syncedMtimeMs: ts,
      historyBackfillOffset: 0,
    })
  }

  return [...fromTranscripts.filter((item): item is DiscoveredSession => item !== undefined), ...fromSummaryOnly]
})

const scanPi = Effect.fn("SessionExternal.scanPi")(function* (
  fs: FSUtil.Interface,
  home: string,
  existing: Set<string>,
  isBlocked: (sessionID: string, activityTimeMs: number) => boolean,
) {
  const piRoot = path.join(home, ".pi", "agent", "sessions")
  if (!(yield* fs.isDir(piRoot))) return []

  const relativeFiles = yield* fs
    .scan("**/*.jsonl", { cwd: piRoot })
    .pipe(Effect.orElseSucceed((): string[] => []))

  const pickedFiles = selectRecentFilesByParent(piRoot, relativeFiles, 20, 60)

  const results = yield* Effect.forEach(
    pickedFiles,
    Effect.fnUntraced(function* (rel) {
      const sessionID = makeSessionID("pi", rel)
      if (existing.has(sessionID)) return undefined

      const fullPath = path.join(piRoot, rel)
      const window = yield* readTailWindowEffect(fullPath, "pi")
      if (window.lines.length === 0) return undefined

      const fallbackTime = window.mtimeMs || Date.now()
      let cwd = ""
      let createdAt = 0
      let updatedAt = 0
      const entries: ExternalEntry[] = []

      const headerLines = window.startOffset > 0 ? readJsonlHeaderLinesSync(fullPath, 10) : []
      for (const hLine of headerLines) {
        const json = decodeJson(hLine)
        if (Option.isNone(json)) continue
        const parsed = decodePiLine(json.value)
        if (Option.isSome(parsed) && parsed.value.type === "session" && parsed.value.cwd && !cwd) {
          cwd = parsed.value.cwd
        }
      }

      for (const rawLine of window.lines) {
        const json = decodeJson(rawLine)
        if (Option.isNone(json)) continue
        const parsed = decodePiLine(json.value)
        if (Option.isNone(parsed)) continue
        const row = parsed.value
        const time = parseTime(row.timestamp, updatedAt || fallbackTime)

        if (row.timestamp) {
          if (!createdAt) createdAt = time
          updatedAt = Math.max(updatedAt, time)
        }

        if (row.type === "session" && row.cwd && !cwd) cwd = row.cwd

        if (row.type === "message" && (row.message?.role === "user" || row.message?.role === "assistant")) {
          const parsedMsg = parseGenericLines([rawLine], time)
          entries.push(...parsedMsg.entries)
        }
      }

      const finalUpdated = Math.max(createdAt || fallbackTime, updatedAt || fallbackTime, window.mtimeMs)
      if (isBlocked(sessionID, finalUpdated)) return undefined

      const firstUser = entries.find((e): e is Extract<ExternalEntry, { kind: "user" }> => e.kind === "user")
      if (!firstUser) return undefined

      const discovered: DiscoveredSession = {
        id: sessionID,
        source: "pi",
        sourceLabel: "Pi",
        externalID: rel,
        filePath: fullPath,
        cwd,
        title: cleanTitle(firstUser.text),
        createdAt: createdAt || fallbackTime,
        updatedAt: finalUpdated,
        entries,
        syncedFileSize: window.endOffset,
        syncedMtimeMs: window.mtimeMs,
        historyBackfillOffset: window.startOffset,
      }
      return discovered
    }),
    { concurrency: 6 },
  )

  return results.filter((item): item is DiscoveredSession => item !== undefined)
})

const scanGenericJsonlSource = Effect.fn("SessionExternal.scanGenericJsonlSource")(function* (input: {
  fs: FSUtil.Interface
  home: string
  rootDir: string
  pattern: string
  source: SourceApp
  sourceLabel: string
  existing: Set<string>
  isBlocked: (sessionID: string, activityTimeMs: number) => boolean
}) {
  if (!(yield* input.fs.isDir(input.rootDir))) return []

  const relativeFiles = yield* input.fs
    .scan(input.pattern, { cwd: input.rootDir })
    .pipe(Effect.orElseSucceed((): string[] => []))

  const pickedFiles = selectRecentFilesByParent(input.rootDir, relativeFiles, 20, 80)

  const results = yield* Effect.forEach(
    pickedFiles,
    Effect.fnUntraced(function* (rel) {
      const externalID = path.basename(rel, path.extname(rel))
      const sessionID = makeSessionID(input.source, rel.replaceAll("\\", "/"))
      if (input.existing.has(sessionID)) return undefined

      const fullPath = path.join(input.rootDir, rel)
      const window = yield* readTailWindowEffect(fullPath, input.source)
      if (window.lines.length === 0) return undefined

      const fallbackTime = window.mtimeMs || Date.now()
      const headerLines = window.startOffset > 0 ? readJsonlHeaderLinesSync(fullPath, 25) : []
      const headerParsed = headerLines.length > 0 ? parseGenericLines(headerLines, fallbackTime) : undefined
      const parsed = parseGenericLines(window.lines, fallbackTime)

      const sampleHead = (headerLines.length > 0 ? headerLines : window.lines.slice(0, 25)).join("\n")
      const cwd = parsed.meta.cwd || headerParsed?.meta.cwd || extractPathsFromText(sampleHead, input.home) || ""
      const createdAt = headerParsed?.meta.createdAt || parsed.meta.createdAt || fallbackTime
      const updatedAt = Math.max(createdAt, parsed.meta.updatedAt || fallbackTime, window.mtimeMs)

      if (input.isBlocked(sessionID, updatedAt)) return undefined

      const firstUser =
        headerParsed?.entries.find((e): e is Extract<ExternalEntry, { kind: "user" }> => e.kind === "user") ??
        parsed.entries.find((e): e is Extract<ExternalEntry, { kind: "user" }> => e.kind === "user")
      if (!firstUser) return undefined

      const discovered: DiscoveredSession = {
        id: sessionID,
        source: input.source,
        sourceLabel: input.sourceLabel,
        externalID,
        filePath: fullPath,
        cwd,
        title: cleanTitle(firstUser.text),
        createdAt,
        updatedAt,
        entries: parsed.entries,
        syncedFileSize: window.endOffset,
        syncedMtimeMs: window.mtimeMs,
        historyBackfillOffset: window.startOffset,
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
  isBlocked: (sessionID: string, activityTimeMs: number) => boolean,
) {
  const dshRoot = process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(home, ".dsh")
  if (!(yield* fs.isDir(dshRoot))) return []

  const seenIDs = new Set<string>(existing)
  const sessionsDir = path.join(dshRoot, "sessions")
  const zstdFiles = (yield* fs.isDir(sessionsDir))
    ? yield* fs.scan("**/*.jsonl.zstd", { cwd: sessionsDir }).pipe(Effect.orElseSucceed((): string[] => []))
    : []

  const pickedZstd = selectRecentFilesByParent(sessionsDir, zstdFiles, 20, 80)
  const fromZstd = yield* Effect.forEach(
    pickedZstd,
    Effect.fnUntraced(function* (rel) {
      const fullPath = path.join(sessionsDir, rel)
      const parentName = path.basename(path.dirname(rel))
      const externalID = parentName.startsWith("session-") ? parentName : path.basename(rel, ".jsonl.zstd")
      const sessionID = makeSessionID("deepseek-harness", externalID)
      if (seenIDs.has(sessionID)) return undefined

      const window = yield* readTailWindowEffect(fullPath, "deepseek-harness")
      if (window.lines.length === 0) return undefined

      const fallbackTime = window.mtimeMs || Date.now()
      const parsed = parseDshLines(window.lines, fallbackTime)
      const createdAt = parsed.meta.createdAt || fallbackTime
      const updatedAt = Math.max(createdAt, parsed.meta.updatedAt || fallbackTime, window.mtimeMs)

      if (isBlocked(sessionID, updatedAt)) return undefined

      const firstUser = parsed.entries.find(
        (e): e is Extract<ExternalEntry, { kind: "user" }> => e.kind === "user",
      )
      if (!firstUser) return undefined
      seenIDs.add(sessionID)

      const discovered: DiscoveredSession = {
        id: sessionID,
        source: "deepseek-harness",
        sourceLabel: "DSH",
        externalID,
        filePath: fullPath,
        cwd: parsed.meta.cwd,
        title: parsed.meta.title ? cleanTitle(parsed.meta.title) : cleanTitle(firstUser.text),
        ...(parsed.meta.model ? { model: parsed.meta.model } : {}),
        createdAt,
        updatedAt,
        entries: parsed.entries,
        syncedFileSize: window.endOffset,
        syncedMtimeMs: window.mtimeMs,
        historyBackfillOffset: window.startOffset,
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
    cacheFiles.slice(0, 60),
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
      const firstText = stripIdeMetadataTags(typeof firstInput?.text === "string" ? firstInput.text : "").trim()
      const rawTitleCandidate = typeof titleRow?.val === "string" ? titleRow.val.trim() : ""
      const rawTitle =
        rawTitleCandidate && !isDshBrokenFallbackTitle(rawTitleCandidate) ? rawTitleCandidate : firstText
      const cleanedTitle = cleanTitle(rawTitle)

      if (!firstText || !cleanedTitle || isDshBrokenFallbackTitle(cleanedTitle)) return undefined
      const mtime = fileMtimeMs(fullPath)
      const createdAt = Math.floor(typeof identity?.createdAt === "number" ? identity.createdAt : mtime || Date.now())
      const updatedAt = Math.max(createdAt, mtime || createdAt)
      if (isBlocked(sessionID, updatedAt)) return undefined

      seenIDs.add(sessionID)
      const discovered: DiscoveredSession = {
        id: sessionID,
        source: "deepseek-harness",
        sourceLabel: "DSH",
        externalID,
        filePath: fullPath,
        cwd,
        title: cleanedTitle,
        createdAt,
        updatedAt,
        entries: [{ kind: "user", text: firstText, time: createdAt }],
        syncedFileSize: 0,
        syncedMtimeMs: mtime,
        historyBackfillOffset: 0,
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
    isBlocked,
  })

  return [...fromZstd, ...fromProjCache, ...fromJsonl].filter(
    (item): item is DiscoveredSession => item !== undefined,
  )
})

const scanGrok = Effect.fn("SessionExternal.scanGrok")(function* (
  fs: FSUtil.Interface,
  home: string,
  existing: Set<string>,
  isBlocked: (sessionID: string, activityTimeMs: number) => boolean,
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

  const pickedSummaries = summaryFiles.toSorted((a, b) => fileMtimeMs(b) - fileMtimeMs(a)).slice(0, 60)
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
      const window = yield* readTailWindowEffect(chatHistoryPath, "grok")
      const fallbackTime = fileMtimeMs(summaryPath) || Date.now()
      const parsed = parseGenericLines(window.lines, fallbackTime)
      const createdAt =
        typeof decoded.created_at === "string"
          ? parseTime(decoded.created_at, fallbackTime)
          : parsed.meta.createdAt || fallbackTime
      const metaUpdated =
        typeof decoded.last_active_at === "string"
          ? parseTime(decoded.last_active_at, createdAt)
          : typeof decoded.updated_at === "string"
            ? parseTime(decoded.updated_at, createdAt)
            : createdAt
      const updatedAt = Math.max(createdAt, metaUpdated, parsed.meta.updatedAt, window.mtimeMs)

      if (isBlocked(sessionID, updatedAt)) return undefined

      const generatedTitle = typeof decoded.generated_title === "string" ? decoded.generated_title.trim() : ""
      const summaryText = typeof decoded.session_summary === "string" ? decoded.session_summary.trim() : ""
      const firstUser = parsed.entries.find(
        (e): e is Extract<ExternalEntry, { kind: "user" }> => e.kind === "user",
      )
      if (!firstUser && !generatedTitle && !summaryText) return undefined
      seenIDs.add(sessionID)

      const finalEntries: ReadonlyArray<ExternalEntry> =
        parsed.entries.length > 0
          ? parsed.entries
          : [{ kind: "user", text: summaryText || generatedTitle, time: createdAt }]

      const discovered: DiscoveredSession = {
        id: sessionID,
        source: "grok",
        sourceLabel: "Grok",
        externalID,
        filePath: nodeFs.existsSync(chatHistoryPath) ? chatHistoryPath : summaryPath,
        cwd,
        title: cleanTitle(generatedTitle || firstUser?.text || summaryText),
        createdAt,
        updatedAt,
        entries: finalEntries,
        syncedFileSize: window.endOffset,
        syncedMtimeMs: window.mtimeMs,
        historyBackfillOffset: window.startOffset,
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
    isBlocked,
  })

  return [...fromSummaries.filter((item): item is DiscoveredSession => item !== undefined), ...fromGeneric]
})

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

interface OpencodeV2PartRow {
  readonly message_id: string
  readonly ordinal: number
  readonly type: string
  readonly data: string
}

const scanOpencode = Effect.fn("SessionExternal.scanOpencode")(function* (
  fs: FSUtil.Interface,
  home: string,
  existing: Set<string>,
  nativeIDs: ReadonlySet<string>,
  isBlocked: (sessionID: string, activityTimeMs: number) => boolean,
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
    isBlocked,
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

  const dbStat = nodeFs.statSync(dbPath, { throwIfNoEntry: false })
  const dbMtime = Math.floor(dbStat?.mtimeMs ?? Date.now())

  const sqliteSessions = yield* Effect.tryPromise(async () => {
    const out = await queryExternalSqliteSafely(dbPath, true, (db) => {
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
            "SELECT id, directory, title, time_created, time_updated FROM session_v2 WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT 80",
          )
          .all()

        const hasV2Part = tables.has("session_part")

        for (const row of v2Rows) {
          if (row.id.startsWith("ses_ext_") || nativeIDs.has(row.id)) continue
          const sessionID = makeSessionID("opencode", row.id)
          const createdAt = Math.floor(row.time_created || dbMtime)
          const updatedAt = Math.max(createdAt, Math.floor(row.time_updated || dbMtime))
          if (seenIDs.has(sessionID) || isBlocked(sessionID, updatedAt)) continue

          const msgRows = db
            .query<OpencodeV2MessageRow, [string]>(
              "SELECT id, type, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq ASC, time_created ASC",
            )
            .all(row.id)

          const partsByMsg = new Map<string, Array<Record<string, unknown>>>()
          if (hasV2Part) {
            const pRows = db
              .query<OpencodeV2PartRow, [string]>(
                "SELECT message_id, ordinal, type, data FROM session_part WHERE session_id = ? ORDER BY message_id ASC, ordinal ASC",
              )
              .all(row.id)
            for (const pRow of pRows) {
              const pData = Option.getOrUndefined(decodeJson(pRow.data))
              if (!isRecord(pData)) continue
              const list = partsByMsg.get(pRow.message_id) ?? []
              list.push({ ...pData, type: pRow.type })
              partsByMsg.set(pRow.message_id, list)
            }
          }

          const entries: ExternalEntry[] = []
          for (const msgRow of msgRows) {
            const decoded = Option.getOrUndefined(decodeJson(msgRow.data))
            if (!isRecord(decoded)) continue
            const time = Math.floor(msgRow.time_created || createdAt)

            if (msgRow.type === "user" && typeof decoded.text === "string" && decoded.text.trim()) {
              entries.push({ kind: "user", text: decoded.text.trim(), time })
              continue
            }

            if (msgRow.type === "compaction" && decoded.status === "completed" && typeof decoded.summary === "string") {
              entries.push({
                kind: "compaction",
                reason: decoded.reason === "manual" ? "manual" : "auto",
                summary: decoded.summary,
                time,
              })
              continue
            }

            if (msgRow.type === "assistant") {
              const rawParts = [
                ...(partsByMsg.get(msgRow.id) ?? []),
                ...(Array.isArray(decoded.content) ? decoded.content.filter(isRecord) : []),
              ]
              const text = rawParts
                .flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text.trim()] : []))
                .filter(Boolean)
                .join("\n\n")
              const thinking = rawParts
                .flatMap((part) => (part.type === "reasoning" && typeof part.text === "string" ? [part.text.trim()] : []))
                .filter(Boolean)
                .join("\n\n")
              const tools = rawParts.flatMap((part, pIdx): ExternalToolItem[] => {
                if (part.type !== "tool") return []
                const state = isRecord(part.state) ? part.state : undefined
                const stateInput = isRecord(state?.input) ? state.input : {}
                const contentArr = Array.isArray(state?.content) ? state.content : []
                const outText = contentArr
                  .flatMap((c) => (isRecord(c) && typeof c.text === "string" ? [c.text] : []))
                  .join("\n")
                const errObj = isRecord(state?.error) ? state.error : undefined
                return [
                  normalizeExternalToolCall({
                    id: asString(part.id),
                    seed: `ocv2:${msgRow.id}:${pIdx}`,
                    rawName: asString(part.name) ?? "tool",
                    rawArgs: stateInput,
                    rawOutput: outText || asString(errObj?.message) || "Done",
                    isError: state?.status === "error",
                    time,
                  }),
                ]
              })
              if (text || thinking || tools.length > 0) {
                entries.push({
                  kind: "assistant",
                  ...(text ? { text } : {}),
                  ...(thinking ? { thinking } : {}),
                  ...(tools.length > 0 ? { tools } : {}),
                  time,
                })
              }
            }
          }

          const firstUser = entries.find((e): e is Extract<ExternalEntry, { kind: "user" }> => e.kind === "user")
          if (!firstUser && !row.title?.trim()) continue
          seenIDs.add(sessionID)

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
            entries:
              entries.length > 0
                ? entries
                : [{ kind: "user", text: row.title ?? row.id, time: createdAt }],
            syncedFileSize: 0,
            syncedMtimeMs: updatedAt,
            historyBackfillOffset: 0,
          })
        }
      }

      if (tables.has("session") && tables.has("message") && tables.has("part")) {
        const sessionRows = db
          .query<OpencodeSessionRow, []>(
            "SELECT id, directory, title, time_created, time_updated FROM session WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT 80",
          )
          .all()

        for (const row of sessionRows) {
          if (row.id.startsWith("ses_ext_") || nativeIDs.has(row.id)) continue
          const sessionID = makeSessionID("opencode", row.id)
          const createdAt = Math.floor(row.time_created || dbMtime)
          const updatedAt = Math.max(createdAt, Math.floor(row.time_updated || dbMtime))
          if (seenIDs.has(sessionID) || isBlocked(sessionID, updatedAt)) continue

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

          const partsByMessage = new Map<
            string,
            { textParts: string[]; thinkingParts: string[]; tools: ExternalToolItem[] }
          >()
          for (let pIdx = 0; pIdx < partRows.length; pIdx += 1) {
            const partRow = partRows[pIdx]!
            const parsedPart = Option.getOrUndefined(decodeJson(partRow.data))
            if (!isRecord(parsedPart)) continue
            const entry = partsByMessage.get(partRow.message_id) ?? {
              textParts: [],
              thinkingParts: [],
              tools: [],
            }
            const pText = asString(parsedPart.text)?.trim()
            if (parsedPart.type === "text" && pText) entry.textParts.push(pText)
            if (parsedPart.type === "reasoning" && pText) entry.thinkingParts.push(pText)
            if (parsedPart.type === "tool") {
              const state = isRecord(parsedPart.state) ? parsedPart.state : undefined
              const stateInput = isRecord(state?.input) ? state.input : {}
              const outStr = asString(state?.output ?? state?.error) ?? "Done"
              entry.tools.push(
                normalizeExternalToolCall({
                  id: asString(parsedPart.callID ?? parsedPart.id),
                  seed: `ocv1:${partRow.message_id}:${pIdx}`,
                  rawName: asString(parsedPart.tool ?? parsedPart.name) ?? "tool",
                  rawArgs: stateInput,
                  rawOutput: outStr,
                  isError: state?.status === "error",
                  time: Math.floor(partRow.time_created || createdAt),
                }),
              )
            }
            partsByMessage.set(partRow.message_id, entry)
          }

          const entries = messageRows.flatMap((msgRow): ExternalEntry[] => {
            const parsedMsg = Option.getOrUndefined(decodeJson(msgRow.data))
            if (!isRecord(parsedMsg)) return []
            const role = asString(parsedMsg.role)
            if (role !== "user" && role !== "assistant") return []
            const parts = partsByMessage.get(msgRow.id)
            const text = parts?.textParts.join("\n\n").trim() ?? ""
            const thinking = parts && parts.thinkingParts.length > 0 ? parts.thinkingParts.join("\n\n") : undefined
            const tools = parts?.tools ?? []
            const time = Math.floor(msgRow.time_created || createdAt)
            if (role === "user") {
              return text ? [{ kind: "user", text, time }] : []
            }
            if (!text && !thinking && tools.length === 0) return []
            return [
              {
                kind: "assistant",
                ...(text ? { text } : {}),
                ...(thinking ? { thinking } : {}),
                ...(tools.length > 0 ? { tools } : {}),
                time,
              },
            ]
          })

          const firstUser = entries.find((e): e is Extract<ExternalEntry, { kind: "user" }> => e.kind === "user")
          if (!firstUser && !row.title?.trim()) continue
          seenIDs.add(sessionID)

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
            entries:
              entries.length > 0
                ? entries
                : [{ kind: "user", text: row.title ?? row.id, time: createdAt }],
            syncedFileSize: 0,
            syncedMtimeMs: updatedAt,
            historyBackfillOffset: 0,
          })
        }
      }

      return results
    })
    return out ?? []
  }).pipe(Effect.orElseSucceed((): DiscoveredSession[] => []))

  return [...sqliteSessions, ...jsonlSessions]
})

const SYNC_COOLDOWN_MS = 15_000
let lastSyncAt = 0
let initialSyncCompleted = false
let inFlightSync: Promise<void> | undefined
const inFlightSessionOps = new Map<string, Promise<void>>()

let deletedSessionsCache: Map<string, number> | undefined
let deletedSessionsCacheHome: string | undefined
let deletedProjectDirsCache: Set<string> | undefined
let deletedProjectDirsCacheHome: string | undefined

export function resetForTesting() {
  lastSyncAt = 0
  initialSyncCompleted = false
  inFlightSync = undefined
  inFlightSessionOps.clear()
  deletedSessionsCache = undefined
  deletedSessionsCacheHome = undefined
  deletedProjectDirsCache = undefined
  deletedProjectDirsCacheHome = undefined
}

function effectiveHomeDir() {
  return process.env.OPENCODE_TEST_HOME || process.env.HOME || os.homedir()
}

function normalizeDirKey(dir: string) {
  const cleaned = path.resolve(dir).replaceAll("\\", "/").replace(/\/+$/, "")
  return process.platform === "win32" || process.platform === "darwin" ? cleaned.toLowerCase() : cleaned
}

function deletedExternalSessionsPath(home: string) {
  return path.join(home, ".config", "opencode", "deleted-external-sessions.json")
}

function deletedExternalProjectsPath(home: string) {
  return path.join(home, ".config", "opencode", "deleted-external-projects.json")
}

function loadDeletedProjectDirs(home = effectiveHomeDir()): Set<string> {
  if (deletedProjectDirsCache && deletedProjectDirsCacheHome === home) return deletedProjectDirsCache
  const filePath = deletedExternalProjectsPath(home)
  const set = new Set<string>()
  if (nodeFs.existsSync(filePath)) {
    const raw = nodeFs.readFileSync(filePath, "utf8")
    const decoded = Option.getOrUndefined(decodeJson(raw))
    if (Array.isArray(decoded)) {
      for (const item of decoded) {
        if (typeof item === "string" && item.trim()) {
          set.add(normalizeDirKey(item))
        }
      }
    }
  }
  deletedProjectDirsCache = set
  deletedProjectDirsCacheHome = home
  return set
}

export function isProjectDeleted(directory: string): boolean {
  if (!directory.trim()) return false
  return loadDeletedProjectDirs().has(normalizeDirKey(directory))
}

export function markProjectDeleted(directory: string) {
  if (!directory.trim()) return
  const home = effectiveHomeDir()
  const set = loadDeletedProjectDirs(home)
  const key = normalizeDirKey(directory)
  if (set.has(key)) return
  set.add(key)
  const filePath = deletedExternalProjectsPath(home)
  nodeFs.mkdirSync(path.dirname(filePath), { recursive: true })
  nodeFs.writeFileSync(filePath, JSON.stringify([...set], null, 2), "utf8")
}

export function unmarkProjectDeleted(directory: string) {
  if (!directory.trim()) return
  const home = effectiveHomeDir()
  const set = loadDeletedProjectDirs(home)
  const key = normalizeDirKey(directory)
  if (!set.has(key)) return
  set.delete(key)
  const filePath = deletedExternalProjectsPath(home)
  nodeFs.mkdirSync(path.dirname(filePath), { recursive: true })
  nodeFs.writeFileSync(filePath, JSON.stringify([...set], null, 2), "utf8")
}

function persistDeletedSessionsMap(home: string, map: ReadonlyMap<string, number>) {
  const filePath = deletedExternalSessionsPath(home)
  nodeFs.mkdirSync(path.dirname(filePath), { recursive: true })
  const obj = Object.fromEntries(map.entries())
  nodeFs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8")
}

function loadDeletedSessionsMap(home = effectiveHomeDir()): Map<string, number> {
  if (deletedSessionsCache && deletedSessionsCacheHome === home) return deletedSessionsCache
  const filePath = deletedExternalSessionsPath(home)
  const map = new Map<string, number>()
  if (nodeFs.existsSync(filePath)) {
    const legacyDeletedAt = fileMtimeMs(filePath) || Date.now()
    const raw = nodeFs.readFileSync(filePath, "utf8")
    const decoded = Option.getOrUndefined(decodeJson(raw))
    if (Array.isArray(decoded)) {
      for (const item of decoded) {
        if (typeof item === "string" && item.startsWith("ses_ext_")) {
          map.set(item, legacyDeletedAt)
        }
      }
    }
    if (isRecord(decoded)) {
      for (const [id, ts] of Object.entries(decoded)) {
        if (id.startsWith("ses_ext_") && typeof ts === "number" && Number.isFinite(ts)) {
          map.set(id, Math.floor(ts))
        }
      }
    }
  }
  deletedSessionsCache = map
  deletedSessionsCacheHome = home
  return map
}

function checkOrReviveDeletedSession(sessionID: string, activityTimeMs: number, home: string): boolean {
  const map = loadDeletedSessionsMap(home)
  const deletedAt = map.get(sessionID)
  if (deletedAt === undefined) return false
  if (activityTimeMs > deletedAt + REVIVAL_GRACE_MS) {
    map.delete(sessionID)
    Option.liftThrowable(() => persistDeletedSessionsMap(home, map))()
    return false
  }
  return true
}

export function markDeleted(sessionID: string) {
  if (!sessionID.startsWith("ses_ext_")) return
  const home = effectiveHomeDir()
  const map = loadDeletedSessionsMap(home)
  map.set(sessionID, Date.now())
  persistDeletedSessionsMap(home, map)
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

function entryToMessageRow(input: {
  readonly sessionID: SessionSchema.ID
  readonly seq: number
  readonly entry: ExternalEntry
  readonly source: SourceApp
  readonly defaultAgent: Agent.ID
  readonly sessionModel: { readonly providerID: Provider.ID; readonly id: Model.ID }
}): typeof SessionMessageTable.$inferInsert {
  const id = makeMessageID(input.sessionID, input.seq)
  const created = Math.floor(input.entry.time || Date.now())

  if (input.entry.kind === "user") {
    return {
      id,
      session_id: input.sessionID,
      type: "user",
      seq: input.seq,
      time_created: created,
      time_updated: created,
      data: {
        text: input.entry.text,
        ...(input.entry.files && input.entry.files.length > 0 ? { files: [...input.entry.files] } : {}),
        time: { created },
      },
    }
  }

  if (input.entry.kind === "compaction") {
    return {
      id,
      session_id: input.sessionID,
      type: "compaction",
      seq: input.seq,
      time_created: created,
      time_updated: created,
      data: {
        status: "completed",
        reason: input.entry.reason,
        summary: input.entry.summary,
        ...(input.entry.tokens
          ? {
              tokens: {
                input: input.entry.tokens.input,
                output: input.entry.tokens.output,
                reasoning: 0,
                cache: { read: input.entry.tokens.cacheRead ?? 0, write: 0 },
              },
            }
          : {}),
        time: { created },
      },
    }
  }

  const itemModel = input.entry.model
    ? localModelForSource(input.source, input.entry.model)
    : input.sessionModel
  const tools = input.entry.tools ?? []
  const content: SessionMessage.AssistantContentEncoded[] = [
    ...(input.entry.thinking
      ? [
          {
            type: "reasoning" as const,
            text: input.entry.thinking,
          },
        ]
      : []),
    ...(input.entry.text
      ? [
          {
            type: "text" as const,
            text: input.entry.text,
          },
        ]
      : []),
    ...tools.map((tool): SessionMessage.AssistantContentEncoded => {
      const toolTime = Math.floor(tool.time || created)
      if (tool.isError) {
        return {
          type: "tool" as const,
          id: tool.id,
          name: tool.name,
          state: {
            status: "error" as const,
            input: tool.input,
            error: {
              type: "tool",
              message: tool.output || "Tool execution failed",
            },
            ...(tool.metadata ? { metadata: tool.metadata } : {}),
          },
          time: { created: toolTime, ran: toolTime, completed: toolTime },
        }
      }
      return {
        type: "tool" as const,
        id: tool.id,
        name: tool.name,
        state: {
          status: "completed" as const,
          input: tool.input,
          content: [{ type: "text" as const, text: tool.output || "Done" }],
          ...(tool.metadata ? { metadata: tool.metadata } : {}),
        },
        time: { created: toolTime, ran: toolTime, completed: toolTime },
      }
    }),
  ]

  return {
    id,
    session_id: input.sessionID,
    type: "assistant",
    seq: input.seq,
    time_created: created,
    time_updated: created,
    data: {
      agent: input.defaultAgent,
      model: itemModel,
      content,
      finish: tools.length > 0 && !input.entry.text ? "tool-calls" : "stop",
      time: {
        created,
        streamed: created,
        completed: created,
      },
    },
  }
}

function isIncrementalJsonlPath(filePath: string): boolean {
  if (!filePath) return false
  const lower = filePath.toLowerCase()
  return (
    (lower.endsWith(".jsonl") || lower.endsWith(".jsonl.zstd") || lower.endsWith(".jsonl.zst")) &&
    !lower.endsWith("history.jsonl")
  )
}

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

function detectSourceFromSessionID(
  sessionID: string,
  metadata: Record<string, unknown> | null | undefined,
): SourceApp | undefined {
  const metaSrc = asString(metadata?.source)
  if (metaSrc && knownSources.includes(metaSrc as SourceApp)) return metaSrc as SourceApp
  return knownSources.find((src) => sessionID.startsWith(`ses_ext_${src}_`))
}

function extractPluginEngineSyncedSize(
  kvValue: unknown,
  source: SourceApp,
  filePath: string,
): number {
  if (!isRecord(kvValue) || !filePath) return 0
  const engines = isRecord(kvValue.engines) ? kvValue.engines : undefined
  const rawEngineRec = engines ? engines[source] : undefined
  const engineRec = isRecord(rawEngineRec) ? rawEngineRec : undefined
  if (!engineRec) return 0
  const recPath = asString(engineRec.filePath)
  const recSize = typeof engineRec.syncedFileSize === "number" ? engineRec.syncedFileSize : 0
  if (!recPath || recSize <= 0) return 0
  return path.resolve(recPath) === path.resolve(filePath) ? recSize : 0
}

function filterOutPiguMirroredEntries(
  entries: ReadonlyArray<ExternalEntry>,
  latestNativeUser: { readonly text: string; readonly timeCreated: number; readonly maxNativeUpdated: number } | undefined,
): ReadonlyArray<ExternalEntry> {
  if (!latestNativeUser || entries.length === 0) return entries
  const filtered: ExternalEntry[] = []
  let skippingMirroredTurn = false

  for (const entry of entries) {
    if (entry.kind === "user") {
      const samePrompt = entry.text.trim() === latestNativeUser.text.trim()
      const withinPiguTurnWindow =
        entry.time >= latestNativeUser.timeCreated - 5_000 &&
        entry.time <= latestNativeUser.maxNativeUpdated + 5_000
      skippingMirroredTurn = samePrompt && withinPiguTurnWindow
      if (!skippingMirroredTurn) filtered.push(entry)
      continue
    }
    if (!skippingMirroredTurn) {
      filtered.push(entry)
    }
  }

  return filtered
}

const appendForwardJsonlEntries = Effect.fnUntraced(function* (input: {
  readonly db: Database.Interface["db"]
  readonly sessionID: SessionSchema.ID
  readonly source: SourceApp
  readonly filePath: string
  readonly syncedFileSize: number
  readonly currentUpdated: number
  readonly currentMetadata: Record<string, unknown>
  readonly model: { readonly id: string; readonly providerID: string } | null
}) {
  if (!isIncrementalJsonlPath(input.filePath) || input.syncedFileSize <= 0) return input.currentUpdated

  const kvRow = yield* input.db
    .select({ key: KVTable.key, value: KVTable.value })
    .from(KVTable)
    .where(like(KVTable.key, `plugin:%:session:${input.sessionID}`))
    .get()
    .pipe(Effect.orElseSucceed(() => undefined))

  const pluginSyncedSize = extractPluginEngineSyncedSize(kvRow?.value, input.source, input.filePath)
  const effectiveSyncedSize = Math.max(input.syncedFileSize, pluginSyncedSize)

  const forward = readJsonlForwardSync(input.filePath, effectiveSyncedSize)
  if (forward.endOffset <= effectiveSyncedSize) {
    if (effectiveSyncedSize > input.syncedFileSize) {
      yield* input.db
        .update(SessionTable)
        .set({
          metadata: {
            ...input.currentMetadata,
            parserVersion: EXTERNAL_PARSER_VERSION,
            syncedFileSize: effectiveSyncedSize,
            syncedMtimeMs: forward.mtimeMs || input.currentUpdated,
          },
          time_updated: sql`${SessionTable.time_updated}`,
        })
        .where(eq(SessionTable.id, input.sessionID))
        .run()
        .pipe(Effect.ignoreCause)
    }
    return input.currentUpdated
  }

  const rawEntries =
    forward.lines.length > 0 ? parseSliceBySource(input.source, forward.lines, forward.mtimeMs) : []

  const nativeTailRows = yield* input.db
    .select({
      type: SessionMessageTable.type,
      time_created: SessionMessageTable.time_created,
      time_updated: SessionMessageTable.time_updated,
      text: sql<unknown>`json_extract(${SessionMessageTable.data}, '$.text')`,
    })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, input.sessionID), notLike(SessionMessageTable.id, "msg_ext_%")))
    .all()
    .pipe(Effect.orElseSucceed(() => []))

  const lastNativeUserRow = nativeTailRows.findLast((r) => r.type === "user" && typeof r.text === "string")
  const maxNativeUpdated = nativeTailRows.reduce((acc, r) => Math.max(acc, r.time_updated), 0)
  const newEntries = filterOutPiguMirroredEntries(
    rawEntries,
    lastNativeUserRow && typeof lastNativeUserRow.text === "string"
      ? {
          text: lastNativeUserRow.text,
          timeCreated: lastNativeUserRow.time_created,
          maxNativeUpdated: Math.max(lastNativeUserRow.time_created, maxNativeUpdated),
        }
      : undefined,
  )

  const defaultAgent = Agent.ID.make("build")
  const sessionModel = input.model
    ? { providerID: Provider.ID.make(input.model.providerID), id: Model.ID.make(input.model.id) }
    : localModelForSource(input.source)

  let latestTime = input.currentUpdated

  if (newEntries.length > 0) {
    latestTime = Math.max(latestTime, forward.mtimeMs)
    const maxRow = yield* input.db
      .select({ maxSeq: sql<number | null>`max(${SessionMessageTable.seq})` })
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, input.sessionID))
      .get()
      .pipe(Effect.orElseSucceed(() => undefined))

    const baseSeq = maxRow?.maxSeq ?? SEQ_BASE
    const rows = newEntries.map((entry, idx) => {
      latestTime = Math.max(latestTime, Math.floor(entry.time || 0))
      return entryToMessageRow({
        sessionID: input.sessionID,
        seq: baseSeq + idx + 1,
        entry,
        source: input.source,
        defaultAgent,
        sessionModel,
      })
    })

    for (const batch of DatabaseBatch.insertBatches(SessionMessageTable, rows)) {
      yield* input.db.insert(SessionMessageTable).values(batch).onConflictDoNothing().run().pipe(Effect.ignoreCause)
    }

    yield* Bus.reserveSequence(input.db, input.sessionID, baseSeq + rows.length).pipe(Effect.ignoreCause)

    const addedPromptTurns = newEntries.filter((e) => e.kind === "user" || e.kind === "assistant").length
    if (addedPromptTurns > 0 && kvRow && isRecord(kvRow.value) && typeof kvRow.value.lastPromptCount === "number") {
      const prevEngines = isRecord(kvRow.value.engines) ? kvRow.value.engines : {}
      const rawSrcRec = prevEngines[input.source]
      const prevSrcRec = isRecord(rawSrcRec) ? rawSrcRec : undefined
      const updatedKvVal = {
        ...kvRow.value,
        lastPromptCount: kvRow.value.lastPromptCount + addedPromptTurns,
        ...(prevSrcRec
          ? {
              engines: {
                ...prevEngines,
                [input.source]: {
                  ...prevSrcRec,
                  syncedFileSize: forward.endOffset,
                },
              },
            }
          : {}),
      }
      yield* input.db
        .update(KVTable)
        .set({ value: updatedKvVal, time_updated: Date.now() })
        .where(eq(KVTable.key, kvRow.key))
        .run()
        .pipe(Effect.ignoreCause)
    }
  }

  const nextMeta = {
    ...input.currentMetadata,
    parserVersion: EXTERNAL_PARSER_VERSION,
    syncedFileSize: forward.endOffset,
    syncedMtimeMs: forward.mtimeMs,
  }

  yield* input.db
    .update(SessionTable)
    .set({
      metadata: nextMeta,
      time_updated: newEntries.length > 0 ? latestTime : sql`${SessionTable.time_updated}`,
      ...(newEntries.length > 0 ? { time_idle: latestTime } : {}),
    })
    .where(eq(SessionTable.id, input.sessionID))
    .run()
    .pipe(Effect.ignoreCause)

  return latestTime
})

const prepareMessagesReadInternal = Effect.fnUntraced(function* (input: {
  readonly db: Database.Interface["db"]
  readonly sessionID: SessionSchema.ID
  readonly request: MessagesInput
}) {
  const row = yield* input.db
    .select({
      id: SessionTable.id,
      model: SessionTable.model,
      time_updated: SessionTable.time_updated,
      time_suspended: SessionTable.time_suspended,
      metadata: SessionTable.metadata,
    })
    .from(SessionTable)
    .where(eq(SessionTable.id, input.sessionID))
    .get()
    .pipe(Effect.orElseSucceed(() => undefined))

  if (!row) return
  const meta = isRecord(row.metadata) ? row.metadata : {}
  const source = detectSourceFromSessionID(row.id, meta)
  const filePath = asString(meta.filePath) ?? ""
  if (!source || !filePath || !nodeFs.existsSync(filePath)) return

  const syncedSize = typeof meta.syncedFileSize === "number" ? meta.syncedFileSize : 0
  if (row.time_suspended === null && (!input.request.cursor || input.request.cursor.direction === "previous")) {
    yield* appendForwardJsonlEntries({
      db: input.db,
      sessionID: row.id,
      source,
      filePath,
      syncedFileSize: syncedSize,
      currentUpdated: row.time_updated,
      currentMetadata: meta,
      model: row.model,
    })
  }

  if (!isIncrementalJsonlPath(filePath)) return

  const refreshedRow = yield* input.db
    .select({ metadata: SessionTable.metadata })
    .from(SessionTable)
    .where(eq(SessionTable.id, row.id))
    .get()
    .pipe(Effect.orElseSucceed(() => undefined))
  const currentMeta = isRecord(refreshedRow?.metadata) ? refreshedRow.metadata : meta
  let backfillOffset =
    typeof currentMeta.historyBackfillOffset === "number" ? currentMeta.historyBackfillOffset : 0
  if (backfillOffset <= 0) return

  const direction = input.request.cursor?.direction ?? "next"
  const requestedOrder = input.request.order ?? "desc"
  const effectiveOrder = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
  if (effectiveOrder !== "desc") return

  const targetCount = input.request.limit ?? 50
  let availableOlder = 0

  if (input.request.cursor) {
    const anchor = yield* input.db
      .select({ seq: SessionMessageTable.seq })
      .from(SessionMessageTable)
      .where(and(eq(SessionMessageTable.session_id, row.id), eq(SessionMessageTable.id, input.request.cursor.id)))
      .get()
      .pipe(Effect.orElseSucceed(() => undefined))
    if (!anchor) return

    const countRow = yield* input.db
      .select({ cnt: sql<number>`count(*)` })
      .from(SessionMessageTable)
      .where(and(eq(SessionMessageTable.session_id, row.id), lt(SessionMessageTable.seq, anchor.seq)))
      .get()
      .pipe(Effect.orElseSucceed(() => ({ cnt: 0 })))
    availableOlder = Number(countRow?.cnt ?? 0)
  }

  if (!input.request.cursor) {
    const totalRow = yield* input.db
      .select({ cnt: sql<number>`count(*)` })
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, row.id))
      .get()
      .pipe(Effect.orElseSucceed(() => ({ cnt: 0 })))
    availableOlder = Number(totalRow?.cnt ?? 0)
  }

  if (availableOlder >= targetCount) return

  const defaultAgent = Agent.ID.make("build")
  const sessionModel = row.model
    ? { providerID: Provider.ID.make(row.model.providerID), id: Model.ID.make(row.model.id) }
    : localModelForSource(source)

  let rounds = 0
  while (availableOlder < targetCount && backfillOffset > 0 && rounds < 8) {
    rounds += 1
    const window = readJsonlWindowSync({
      fullPath: filePath,
      targetStart: Math.max(0, backfillOffset - BACKFILL_CHUNK_BYTES),
      endOffset: backfillOffset,
      source,
    })

    const olderEntries =
      window.lines.length > 0 ? parseSliceBySource(source, window.lines, window.mtimeMs || row.time_updated) : []
    backfillOffset = window.startOffset

    if (olderEntries.length > 0) {
      const minRow = yield* input.db
        .select({ minSeq: sql<number | null>`min(${SessionMessageTable.seq})` })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, row.id))
        .get()
        .pipe(Effect.orElseSucceed(() => undefined))

      const minSeq = minRow?.minSeq ?? SEQ_BASE + 1
      const startSeq = minSeq - olderEntries.length
      const rows = olderEntries.map((entry, idx) =>
        entryToMessageRow({
          sessionID: row.id,
          seq: startSeq + idx,
          entry,
          source,
          defaultAgent,
          sessionModel,
        }),
      )

      for (const batch of DatabaseBatch.insertBatches(SessionMessageTable, rows)) {
        yield* input.db.insert(SessionMessageTable).values(batch).onConflictDoNothing().run().pipe(Effect.ignoreCause)
      }

      availableOlder += rows.length
    }

    const updatedMeta = {
      ...currentMeta,
      historyBackfillOffset: backfillOffset,
    }
    yield* input.db
      .update(SessionTable)
      .set({
        metadata: updatedMeta,
        time_updated: sql`${SessionTable.time_updated}`,
      })
      .where(eq(SessionTable.id, row.id))
      .run()
      .pipe(Effect.ignoreCause)

    if (window.startOffset === 0) break
  }
})

export const prepareMessagesRead = Effect.fn("SessionExternal.prepareMessagesRead")(function* (input: {
  readonly db: Database.Interface["db"]
  readonly sessionID: SessionSchema.ID
  readonly request: MessagesInput
}) {
  if (!input.sessionID.startsWith("ses_ext_")) return

  const existingOp = inFlightSessionOps.get(input.sessionID)
  if (existingOp) {
    yield* Effect.promise(() => existingOp)
  }

  let resolveDone: (() => void) | undefined
  const opPromise = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  inFlightSessionOps.set(input.sessionID, opPromise)

  yield* prepareMessagesReadInternal(input).pipe(
    Effect.ignoreCause,
    Effect.ensuring(
      Effect.sync(() => {
        if (inFlightSessionOps.get(input.sessionID) === opPromise) {
          inFlightSessionOps.delete(input.sessionID)
        }
        resolveDone?.()
      }),
    ),
  )
})

const runSyncInternal = Effect.fn("SessionExternal.runSyncInternal")(function* (input: {
  readonly db: Database.Interface["db"]
  readonly fs: FSUtil.Interface
  readonly projects: Project.Interface
  readonly version: string
}) {
  const home = effectiveHomeDir()
  const deletedProjectDirs = loadDeletedProjectDirs(home)
  const deletedSessionsMap = loadDeletedSessionsMap(home)
  const isBlocked = (sessionID: string, activityTimeMs: number) =>
    checkOrReviveDeletedSession(sessionID, activityTimeMs, home)

  const existingRows = yield* input.db
    .select({
      id: SessionTable.id,
      project_id: SessionTable.project_id,
      model: SessionTable.model,
      directory: SessionTable.directory,
      time_updated: SessionTable.time_updated,
      time_suspended: SessionTable.time_suspended,
      metadata: SessionTable.metadata,
    })
    .from(SessionTable)
    .where(like(SessionTable.id, "ses_ext_%"))
    .all()
    .pipe(Effect.orElseSucceed(() => []))

  const nativeSessionRows = yield* input.db
    .select({ id: SessionTable.id })
    .from(SessionTable)
    .where(notLike(SessionTable.id, "ses_ext_%"))
    .all()
    .pipe(Effect.orElseSucceed(() => []))
  const nativeSessionIDs = new Set<string>(nativeSessionRows.map((r) => String(r.id)))
  const externalFileByID = new Map<string, string>(
    existingRows.map((r) => {
      const m = isRecord(r.metadata) ? r.metadata : {}
      const fp = asString(m.filePath)
      return [String(r.id), fp ? path.resolve(fp) : ""]
    }),
  )
  const allKnownOwnerIDs = new Set<string>([...nativeSessionIDs, ...externalFileByID.keys()])

  const kvRows = yield* input.db
    .select({ key: KVTable.key, value: KVTable.value })
    .from(KVTable)
    .where(like(KVTable.key, "plugin:%:session:%"))
    .all()
    .pipe(Effect.orElseSucceed(() => []))

  const ownedChildExternalIDs = new Set<string>()
  const ownedChildFilePaths = new Set<string>()
  for (const kvRow of kvRows) {
    const marker = ":session:"
    const markerIdx = kvRow.key.indexOf(marker)
    if (markerIdx < 0) continue
    const ownerID = kvRow.key.slice(markerIdx + marker.length)
    const isActiveOwner =
      Boolean(ownerID) &&
      (allKnownOwnerIDs.has(ownerID) || (ownerID.startsWith("ses_ext_") && !deletedSessionsMap.has(ownerID)))
    if (!isActiveOwner) continue
    if (!isRecord(kvRow.value)) continue
    const ownerOwnFile = externalFileByID.get(ownerID) ?? ""

    const registerChild = (src: SourceApp, childSessionID: string | undefined, childFilePath: string | undefined) => {
      const childExtID = childSessionID ? makeSessionID(src, childSessionID) : ""
      if (childExtID && childExtID !== ownerID) {
        ownedChildExternalIDs.add(childExtID)
      }
      if (childFilePath) {
        const resolvedChild = path.resolve(childFilePath)
        if ((!childExtID || childExtID !== ownerID) && resolvedChild !== ownerOwnFile) {
          ownedChildFilePaths.add(resolvedChild)
        }
      }
    }

    registerChild("claude", asString(kvRow.value.claudeSessionId), asString(kvRow.value.claudeFilePath))
    registerChild("codex", asString(kvRow.value.codexSessionId), asString(kvRow.value.codexFilePath))

    const retired = Array.isArray(kvRow.value.retiredChildSessions) ? kvRow.value.retiredChildSessions : []
    for (const item of retired) {
      if (!isRecord(item)) continue
      const src = asString(item.source)
      if (!src || !knownSources.includes(src as SourceApp)) continue
      registerChild(src as SourceApp, asString(item.sessionId), asString(item.filePath))
    }

    const engines = isRecord(kvRow.value.engines) ? kvRow.value.engines : undefined
    if (!engines) continue
    for (const [src, engineVal] of Object.entries(engines)) {
      if (!knownSources.includes(src as SourceApp) || !isRecord(engineVal)) continue
      registerChild(src as SourceApp, asString(engineVal.sessionId), asString(engineVal.filePath))
    }
  }
  const isOwnedChildSession = (id: string, filePath: string) =>
    ownedChildExternalIDs.has(id) || (Boolean(filePath) && ownedChildFilePaths.has(path.resolve(filePath)))

  const locallyContinuedRows = yield* input.db
    .select({ sessionID: SessionMessageTable.session_id })
    .from(SessionMessageTable)
    .where(and(like(SessionMessageTable.session_id, "ses_ext_%"), notLike(SessionMessageTable.id, "msg_ext_%")))
    .groupBy(SessionMessageTable.session_id)
    .all()
    .pipe(Effect.orElseSucceed(() => []))

  const locallyContinuedSet = new Set(locallyContinuedRows.map((r) => r.sessionID))
  const checkedExternalIDs = new Set<SessionSchema.ID>()
  const upgradableSessionIDs = new Set<SessionSchema.ID>()

  const maxActivityByProject = new Map<Project.ID, number>()
  const recordProjectActivity = (projectID: Project.ID, timestamp: number) => {
    const prev = maxActivityByProject.get(projectID) ?? 0
    if (timestamp > prev) maxActivityByProject.set(projectID, timestamp)
  }

  const resolvedDirs = new Map<string, Project.Resolved>()
  const resolveProjectForDir = Effect.fnUntraced(function* (dir: string, activityTime?: number) {
    const cached = resolvedDirs.get(dir)
    if (cached) {
      if (activityTime && !deletedProjectDirs.has(normalizeDirKey(cached.canonical))) {
        recordProjectActivity(cached.id, activityTime)
      }
      return cached
    }
    const project = yield* input.projects.resolve(AbsolutePath.make(dir), { persist: false })
    resolvedDirs.set(dir, project)
    if (deletedProjectDirs.has(normalizeDirKey(project.canonical))) return project
    yield* upsertProject(input.db, project).pipe(Effect.ignoreCause)
    if (activityTime) recordProjectActivity(project.id, activityTime)
    return project
  })

  for (const row of existingRows) {
    const meta = isRecord(row.metadata) ? row.metadata : {}
    const filePath = asString(meta.filePath) ?? ""
    const mtime = filePath ? fileMtimeMs(filePath) : 0
    const latestKnownActivity = Math.max(row.time_updated, mtime)

    const externalID = asString(meta.externalID) ?? ""
    if (
      isBlocked(row.id, latestKnownActivity) ||
      isOwnedChildSession(row.id, filePath) ||
      (row.id.startsWith("ses_ext_opencode_") && externalID && nativeSessionIDs.has(externalID))
    ) {
      yield* input.db.delete(SessionTable).where(eq(SessionTable.id, row.id)).run().pipe(Effect.ignoreCause)
      continue
    }

    const parserVersion = typeof meta.parserVersion === "number" ? meta.parserVersion : 1
    const canAutoUpgrade = !locallyContinuedSet.has(row.id) && (parserVersion < EXTERNAL_PARSER_VERSION || !filePath)

    if (canAutoUpgrade) {
      upgradableSessionIDs.add(row.id)
    }

    if (!canAutoUpgrade) {
      checkedExternalIDs.add(row.id)
      const source = detectSourceFromSessionID(row.id, meta)
      const syncedSize = typeof meta.syncedFileSize === "number" ? meta.syncedFileSize : 0

      if (row.time_suspended === null && source && filePath && isIncrementalJsonlPath(filePath) && syncedSize > 0) {
        const currentStat = nodeFs.statSync(filePath, { throwIfNoEntry: false })
        if (currentStat && currentStat.size > syncedSize) {
          const updatedTime = yield* appendForwardJsonlEntries({
            db: input.db,
            sessionID: row.id,
            source,
            filePath,
            syncedFileSize: syncedSize,
            currentUpdated: row.time_updated,
            currentMetadata: meta,
            model: row.model,
          })
          recordProjectActivity(row.project_id, updatedTime)
          continue
        }
      }
    }

    const effectiveUpdated = Math.floor(mtime > 0 && row.time_updated > mtime + 60_000 ? mtime : row.time_updated)
    if (effectiveUpdated !== row.time_updated) {
      yield* input.db
        .update(SessionTable)
        .set({
          time_updated: effectiveUpdated,
          time_idle: effectiveUpdated,
          time_viewed: effectiveUpdated,
        })
        .where(eq(SessionTable.id, row.id))
        .run()
        .pipe(Effect.ignoreCause)
    }

    const shouldUpgradeModel =
      (row.model?.providerID === "pigu" && row.model?.id === "default") ||
      row.model?.providerID === "native-cli"

    if (shouldUpgradeModel) {
      const matchedSource = detectSourceFromSessionID(row.id, meta)
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
      const project = yield* resolveProjectForDir(fallbackDir, effectiveUpdated)
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
      continue
    }

    recordProjectActivity(row.project_id, effectiveUpdated)
  }

  const [codex, claude, agy, pi, opencode, cursor, grok, dsh, workbuddy] = yield* Effect.all([
    scanCodex(input.fs, home, checkedExternalIDs, isBlocked),
    scanClaude(input.fs, home, checkedExternalIDs, isBlocked),
    scanAgy(input.fs, home, checkedExternalIDs, isBlocked),
    scanPi(input.fs, home, checkedExternalIDs, isBlocked),
    scanOpencode(input.fs, home, checkedExternalIDs, nativeSessionIDs, isBlocked),
    scanGenericJsonlSource({
      fs: input.fs,
      home,
      rootDir: path.join(home, ".cursor", "projects"),
      pattern: "**/agent-transcripts/*.jsonl",
      source: "cursor",
      sourceLabel: "Cursor",
      existing: checkedExternalIDs,
      isBlocked,
    }),
    scanGrok(input.fs, home, checkedExternalIDs, isBlocked),
    scanDsh(input.fs, home, checkedExternalIDs, isBlocked),
    scanGenericJsonlSource({
      fs: input.fs,
      home,
      rootDir: path.join(home, ".workbuddy", "sessions"),
      pattern: "**/*.jsonl",
      source: "workbuddy",
      sourceLabel: "WorkBuddy",
      existing: checkedExternalIDs,
      isBlocked,
    }),
  ], { concurrency: "unbounded" })

  const all = [...codex, ...claude, ...agy, ...pi, ...opencode, ...cursor, ...grok, ...dsh, ...workbuddy].filter(
    (s) => !isOwnedChildSession(s.id, s.filePath),
  )
  const defaultAgent = Agent.ID.make("build")

  for (const session of all) {
    const existingDir = yield* resolveExistingDir(input.fs, session.cwd, home)
    const validDir = existingDir ?? ensureFallbackProjectDir(home, session.cwd)
    if (deletedProjectDirs.has(normalizeDirKey(validDir))) continue

    const sessionModel = localModelForSource(session.source, session.model)
    const project = yield* resolveProjectForDir(validDir, session.updatedAt)
    if (deletedProjectDirs.has(normalizeDirKey(project.canonical))) continue

    const subpath = RelativePath.make(path.relative(project.directory, validDir).replaceAll("\\", "/"))
    const nextMetadata = {
      source: session.source,
      sourceLabel: session.sourceLabel,
      externalID: session.externalID,
      filePath: session.filePath,
      parserVersion: EXTERNAL_PARSER_VERSION,
      syncedFileSize: session.syncedFileSize,
      syncedMtimeMs: session.syncedMtimeMs,
      historyBackfillOffset: session.historyBackfillOffset,
      ...(existingDir ? {} : session.cwd ? { originalCwd: session.cwd } : {}),
    }

    const isUpgrade = upgradableSessionIDs.has(session.id)

    if (isUpgrade) {
      yield* input.db
        .delete(SessionMessageTable)
        .where(and(eq(SessionMessageTable.session_id, session.id), like(SessionMessageTable.id, "msg_ext_%")))
        .run()
        .pipe(Effect.ignoreCause)

      yield* input.db
        .update(SessionTable)
        .set({
          project_id: project.id,
          directory: AbsolutePath.make(validDir),
          path: subpath,
          title: session.title,
          metadata: nextMetadata,
          model: sessionModel,
          time_created: session.createdAt,
          time_updated: session.updatedAt,
          time_idle: session.updatedAt,
        })
        .where(eq(SessionTable.id, session.id))
        .run()
        .pipe(Effect.ignoreCause)
    }

    if (!isUpgrade) {
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
          metadata: nextMetadata,
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
    }

    const messageRows = session.entries.map((entry, index) =>
      entryToMessageRow({
        sessionID: session.id,
        seq: SEQ_BASE + index + 1,
        entry,
        source: session.source,
        defaultAgent,
        sessionModel,
      }),
    )

    if (messageRows.length > 0) {
      for (const batch of DatabaseBatch.insertBatches(SessionMessageTable, messageRows)) {
        yield* input.db.insert(SessionMessageTable).values(batch).onConflictDoNothing().run().pipe(Effect.ignoreCause)
      }
    }

    yield* Bus.reserveSequence(input.db, session.id, SEQ_BASE + Math.max(1, messageRows.length)).pipe(
      Effect.ignoreCause,
    )
  }

  // Repair sequence watermarks for any pre-existing external sessions whose event_sequence was below SEQ_BASE.
  const existingMaxSeqRows = yield* input.db
    .select({
      sessionID: SessionMessageTable.session_id,
      maxSeq: sql<number>`max(${SessionMessageTable.seq})`,
    })
    .from(SessionMessageTable)
    .where(like(SessionMessageTable.session_id, "ses_ext_%"))
    .groupBy(SessionMessageTable.session_id)
    .all()
    .pipe(Effect.orElseSucceed(() => []))

  for (const maxItem of existingMaxSeqRows) {
    if (typeof maxItem.maxSeq === "number" && maxItem.maxSeq > 0) {
      yield* Bus.reserveSequence(input.db, maxItem.sessionID, maxItem.maxSeq).pipe(Effect.ignoreCause)
    }
  }

  // Ensure any remaining v1 sessions whose backing file no longer exists still get marked checked so we don't rescan forever.
  for (const orphanID of upgradableSessionIDs) {
    if (all.some((s) => s.id === orphanID)) continue
    const orphanRow = existingRows.find((r) => r.id === orphanID)
    if (!orphanRow) continue
    const prevMeta = isRecord(orphanRow.metadata) ? orphanRow.metadata : {}
    yield* input.db
      .update(SessionTable)
      .set({
        metadata: { ...prevMeta, parserVersion: EXTERNAL_PARSER_VERSION },
        time_updated: sql`${SessionTable.time_updated}`,
      })
      .where(eq(SessionTable.id, orphanID))
      .run()
      .pipe(Effect.ignoreCause)
  }

  for (const [projectID, maxActivity] of maxActivityByProject) {
    yield* input.db
      .update(ProjectTable)
      .set({
        time_active: maxActivity,
        time_updated: sql`${ProjectTable.time_updated}`,
      })
      .where(eq(ProjectTable.id, projectID))
      .run()
      .pipe(Effect.ignoreCause)
  }
})

export const sync = Effect.fn("SessionExternal.sync")(function* (input: {
  readonly db: Database.Interface["db"]
  readonly fs: FSUtil.Interface
  readonly projects: Project.Interface
  readonly version: string
  readonly force?: boolean
}) {
  const now = Date.now()
  if (!input.force && initialSyncCompleted && now - lastSyncAt < SYNC_COOLDOWN_MS && !inFlightSync) return

  if (inFlightSync) {
    yield* Effect.promise(() => inFlightSync ?? Promise.resolve())
    if (!input.force) return
  }

  lastSyncAt = now
  let resolveDone: (() => void) | undefined
  inFlightSync = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  yield* runSyncInternal(input).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        initialSyncCompleted = true
      }),
    ),
    Effect.ignoreCause,
    Effect.ensuring(
      Effect.sync(() => {
        lastSyncAt = Date.now()
        inFlightSync = undefined
        resolveDone?.()
      }),
    ),
  )
})
