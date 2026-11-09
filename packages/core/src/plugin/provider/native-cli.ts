export * as NativeCliProvider from "./native-cli.js"

import { Database } from "bun:sqlite"
import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from "@ai-sdk/provider"
import { define } from "@opencode/plugin/effect/plugin"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Option, Schema, Stream } from "effect"
import { Bus } from "../../bus.js"
import { Credential } from "../../credential.js"
import { Model } from "../../model.js"
import { Provider } from "../../provider.js"
import type { PluginInternal } from "../internal.js"

export const LOCAL_PROVIDER_ID = Provider.ID.make("local")
export const NATIVE_CLI_PROVIDER_ID = LOCAL_PROVIDER_ID
export const LOCAL_PACKAGE = "@opencode/local"

export const CLAUDE_LOCAL_MODEL_ID = Model.ID.make("claude")
export const CODEX_LOCAL_MODEL_ID = Model.ID.make("codex")
export const AGY_LOCAL_MODEL_ID = Model.ID.make("agy")
export const PI_LOCAL_MODEL_ID = Model.ID.make("pi")
export const OPENCODE_LOCAL_MODEL_ID = Model.ID.make("opencode")
export const CURSOR_LOCAL_MODEL_ID = Model.ID.make("cursor")
export const GROK_LOCAL_MODEL_ID = Model.ID.make("grok")
export const DEEPSEEK_HARNESS_LOCAL_MODEL_ID = Model.ID.make("deepseek-harness")
export const WORKBUDDY_LOCAL_MODEL_ID = Model.ID.make("workbuddy")

export type LocalEngine =
  | "claude"
  | "codex"
  | "agy"
  | "pi"
  | "opencode"
  | "cursor"
  | "grok"
  | "deepseek-harness"
  | "workbuddy"

const HEADER_REQUEST_KIND = "x-opencode-request-kind"
const HEADER_SESSION_ID = "x-opencode-session-id"
const HEADER_SESSION_CWD = "x-pigu-session-cwd"
const HEADER_SESSION_METADATA = "x-pigu-session-metadata"
const HEADER_MODEL_VARIANT = "x-pigu-model-variant"

const EngineRecordSchema = Schema.Struct({
  sessionId: Schema.optional(Schema.String),
  filePath: Schema.optional(Schema.String),
})

const SessionCliStateSchema = Schema.Struct({
  lastEngine: Schema.optional(
    Schema.Literals([
      "claude",
      "codex",
      "agy",
      "pi",
      "opencode",
      "cursor",
      "grok",
      "deepseek-harness",
      "workbuddy",
    ]),
  ),
  lastPromptCount: Schema.optional(Schema.Number),
  claudeSessionId: Schema.optional(Schema.String),
  claudeFilePath: Schema.optional(Schema.String),
  codexSessionId: Schema.optional(Schema.String),
  codexFilePath: Schema.optional(Schema.String),
  engines: Schema.optional(Schema.Record(Schema.String, EngineRecordSchema)),
})
type SessionCliState = typeof SessionCliStateSchema.Type
const decodeSessionCliState = Schema.decodeUnknownOption(SessionCliStateSchema)

const SessionMetadataSchema = Schema.Struct({
  source: Schema.optional(Schema.String),
  externalID: Schema.optional(Schema.String),
  filePath: Schema.optional(Schema.String),
})
const decodeSessionMetadata = Schema.decodeUnknownOption(Schema.fromJsonString(SessionMetadataSchema))
const decodeJsonUnknown = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function globalBinDirs() {
  const home = os.homedir()
  const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming")
  const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local")

  const winDirs =
    process.platform === "win32"
      ? [
          path.join(appData, "npm"),
          path.join(localAppData, "pnpm"),
          path.join(localAppData, "Microsoft", "WinGet", "Links"),
          path.join(home, "scoop", "shims"),
          path.join(home, ".cargo", "bin"),
          path.join(localAppData, "Programs", "claude-code"),
          path.join(localAppData, "Programs", "Claude"),
          path.join(localAppData, "Programs", "Codex"),
          path.join(localAppData, "Programs", "Antigravity", "bin"),
          path.join(localAppData, "Programs", "cursor", "resources", "app", "bin"),
          path.join(localAppData, "Programs", "OpenCode", "bin"),
          path.join(localAppData, "Programs", "DeepSeek Harness", "resources", "runtime", "cli", "bin"),
          path.join(localAppData, "Programs", "WorkBuddy", "resources", "runtime", "cli", "bin"),
          path.join(localAppData, "Programs", "CodeBuddy", "resources", "runtime", "cli", "bin"),
        ]
      : []

  return [
    ...winDirs,
    path.join(home, ".mounty", "AL", "node", "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, ".opencode", "bin"),
    path.join(home, ".claude", "local"),
    path.join(home, ".claude", "bin"),
    path.join(home, ".codex", "bin"),
    path.join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ]
}

function appBundleRuntimeDirs() {
  const home = os.homedir()
  const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local")
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files"
  const appRoots = ["/Applications", path.join(home, "Applications")]
  const winRoots =
    process.platform === "win32" ? [path.join(localAppData, "Programs"), programFiles] : []

  const macDirs = appRoots.flatMap((root) => [
    path.join(root, "Codex.app", "Contents", "Resources", "bin"),
    path.join(root, "Codex.app", "Contents", "Resources", "app", "bin"),
    path.join(root, "Claude.app", "Contents", "Resources", "bin"),
    path.join(root, "Claude.app", "Contents", "Resources", "app", "bin"),
    path.join(root, "Antigravity.app", "Contents", "Resources", "app", "bin"),
    path.join(root, "Cursor.app", "Contents", "Resources", "app", "bin"),
    path.join(root, "OpenCode.app", "Contents", "Resources", "bin"),
    path.join(root, "OpenCode.app", "Contents", "Resources", "app", "bin"),
    path.join(root, "Pi.app", "Contents", "Resources", "bin"),
    path.join(root, "Pi.app", "Contents", "Resources", "app", "bin"),
    path.join(root, "Grok.app", "Contents", "Resources", "bin"),
    path.join(root, "Grok.app", "Contents", "Resources", "app", "bin"),
    path.join(root, "DeepSeek Harness.app", "Contents", "Resources", "runtime", "cli", "bin"),
    path.join(root, "DeepSeek Harness.app", "Contents", "Resources", "runtime", "bin"),
    path.join(root, "WorkBuddy.app", "Contents", "Resources", "runtime", "cli", "bin"),
    path.join(root, "WorkBuddy.app", "Contents", "Resources", "app", "bin"),
    path.join(root, "CodeBuddy.app", "Contents", "Resources", "runtime", "cli", "bin"),
    path.join(root, "CodeBuddy.app", "Contents", "Resources", "app", "bin"),
  ])

  const winDirs = winRoots.flatMap((root) => [
    path.join(root, "Codex", "resources", "bin"),
    path.join(root, "Codex", "resources", "app", "bin"),
    path.join(root, "Claude", "resources", "bin"),
    path.join(root, "Claude", "resources", "app", "bin"),
    path.join(root, "Antigravity", "bin"),
    path.join(root, "Antigravity", "resources", "app", "bin"),
    path.join(root, "cursor", "resources", "app", "bin"),
    path.join(root, "OpenCode", "resources", "bin"),
    path.join(root, "DeepSeek Harness", "resources", "runtime", "cli", "bin"),
    path.join(root, "DeepSeek Harness", "resources", "runtime", "bin"),
    path.join(root, "WorkBuddy", "resources", "runtime", "cli", "bin"),
    path.join(root, "CodeBuddy", "resources", "runtime", "cli", "bin"),
  ])

  return [...winDirs, ...macDirs]
}

function buildAugmentedPath() {
  const existing = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
  const combined = [...new Set([...globalBinDirs(), ...appBundleRuntimeDirs(), ...existing])]

  return combined.join(path.delimiter)
}

function expandPlatformExecutableNames(names: ReadonlyArray<string>) {
  if (process.platform !== "win32") return names
  return names.flatMap((name) =>
    /\.(exe|cmd|bat|ps1)$/i.test(name) ? [name] : [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name],
  )
}

function resolveGlobalExecutable(names: ReadonlyArray<string>) {
  const existing = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
  const dirs = [...new Set([...globalBinDirs(), ...appBundleRuntimeDirs(), ...existing])]
  const expandedNames = expandPlatformExecutableNames(names)
  const candidates = expandedNames.flatMap((name) => dirs.map((dir) => path.join(dir, name)))

  return candidates.find((candidate) => fs.existsSync(candidate))
}

function appBundledCliCandidates(engine: LocalEngine) {
  const home = os.homedir()
  const appRoots = ["/Applications", path.join(home, "Applications")]

  if (engine === "claude") {
    return appRoots.flatMap((root) => [
      path.join(root, "Claude.app", "Contents", "Resources", "claude"),
      path.join(root, "Claude.app", "Contents", "Resources", "bin", "claude"),
      path.join(root, "Claude.app", "Contents", "Resources", "app", "bin", "claude"),
      path.join(root, "Claude.app", "Contents", "Resources", "runtime", "cli", "bin", "claude"),
    ])
  }

  if (engine === "codex") {
    return appRoots.flatMap((root) => [
      path.join(root, "Codex.app", "Contents", "Resources", "codex"),
      path.join(root, "Codex.app", "Contents", "Resources", "bin", "codex"),
      path.join(root, "Codex.app", "Contents", "Resources", "app", "bin", "codex"),
      path.join(root, "Codex.app", "Contents", "Resources", "runtime", "cli", "bin", "codex"),
      path.join(root, "Codex.app", "Contents", "MacOS", "codex"),
    ])
  }

  if (engine === "agy") {
    return appRoots.flatMap((root) => [
      path.join(root, "Antigravity.app", "Contents", "Resources", "app", "bin", "agy"),
      path.join(root, "Antigravity.app", "Contents", "Resources", "app", "bin", "antigravity"),
      path.join(root, "Antigravity.app", "Contents", "Resources", "bin", "agy"),
    ])
  }

  if (engine === "pi") {
    return appRoots.flatMap((root) => [
      path.join(root, "Pi.app", "Contents", "Resources", "bin", "pi"),
      path.join(root, "Pi.app", "Contents", "Resources", "app", "bin", "pi"),
      path.join(root, "Pi.app", "Contents", "MacOS", "pi"),
    ])
  }

  if (engine === "opencode") {
    return appRoots.flatMap((root) => [
      path.join(root, "OpenCode.app", "Contents", "MacOS", "opencode-cli"),
      path.join(root, "OpenCode.app", "Contents", "Resources", "bin", "opencode"),
      path.join(root, "OpenCode.app", "Contents", "Resources", "app", "bin", "opencode"),
    ])
  }

  if (engine === "cursor") {
    return appRoots.flatMap((root) => [
      path.join(root, "Cursor.app", "Contents", "Resources", "app", "bin", "cursor-agent"),
      path.join(root, "Cursor.app", "Contents", "Resources", "app", "bin", "cursor"),
      path.join(root, "Cursor.app", "Contents", "Resources", "bin", "cursor-agent"),
      path.join(root, "Cursor.app", "Contents", "Resources", "bin", "cursor"),
    ])
  }

  if (engine === "grok") {
    return appRoots.flatMap((root) => [
      path.join(root, "Grok.app", "Contents", "Resources", "bin", "grok"),
      path.join(root, "Grok.app", "Contents", "Resources", "app", "bin", "grok"),
      path.join(root, "Grok.app", "Contents", "MacOS", "grok"),
    ])
  }

  if (engine === "deepseek-harness") {
    return appRoots.flatMap((root) => [
      path.join(root, "DeepSeek Harness.app", "Contents", "Resources", "runtime", "cli", "bin", "dsh"),
    ])
  }

  return appRoots.flatMap((root) => [
    path.join(root, "WorkBuddy.app", "Contents", "Resources", "runtime", "cli", "bin", "workbuddy"),
    path.join(root, "WorkBuddy.app", "Contents", "Resources", "app", "bin", "workbuddy"),
    path.join(root, "CodeBuddy.app", "Contents", "Resources", "runtime", "cli", "bin", "codebuddy"),
    path.join(root, "CodeBuddy.app", "Contents", "Resources", "app", "bin", "codebuddy"),
  ])
}

function resolveAppBundledCli(engine: LocalEngine) {
  const candidates = expandPlatformExecutableNames(appBundledCliCandidates(engine))
  return candidates.find((candidate) => fs.existsSync(candidate))
}

function shouldUseWindowsShell(binary: string) {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(binary)
}

function resolveEngineBinary(engine: LocalEngine) {
  if (engine === "claude") {
    return resolveGlobalExecutable(["claude"]) ?? resolveAppBundledCli("claude")
  }

  if (engine === "codex") {
    return resolveGlobalExecutable(["codex"]) ?? resolveAppBundledCli("codex")
  }

  if (engine === "agy") {
    return resolveGlobalExecutable(["agy", "antigravity"]) ?? resolveAppBundledCli("agy")
  }

  if (engine === "pi") {
    return resolveGlobalExecutable(["pi"]) ?? resolveAppBundledCli("pi")
  }

  if (engine === "opencode") {
    return resolveGlobalExecutable(["opencode"]) ?? resolveAppBundledCli("opencode")
  }

  if (engine === "cursor") {
    return resolveGlobalExecutable(["cursor-agent", "cursor"]) ?? resolveAppBundledCli("cursor")
  }

  if (engine === "grok") {
    return resolveGlobalExecutable(["grok", "grok-cli"]) ?? resolveAppBundledCli("grok")
  }

  if (engine === "deepseek-harness") {
    return resolveGlobalExecutable(["dsh", "deepseek-harness"]) ?? resolveAppBundledCli("deepseek-harness")
  }

  return resolveGlobalExecutable(["workbuddy", "codebuddy"]) ?? resolveAppBundledCli("workbuddy")
}

function normalizeEngine(modelId: string): LocalEngine {
  const slashIndex = modelId.indexOf("/")
  const baseId = slashIndex >= 0 ? modelId.slice(0, slashIndex) : modelId

  if (baseId === "codex" || baseId === "codex-native") return "codex"

  if (baseId === "agy" || baseId === "agy-native") return "agy"

  if (baseId === "pi" || baseId === "pi-native") return "pi"

  if (baseId === "opencode" || baseId === "opencode-native") return "opencode"

  if (baseId === "cursor" || baseId === "cursor-agent" || baseId === "cursor-native") return "cursor"

  if (baseId === "grok" || baseId === "grok-cli" || baseId === "grok-native") return "grok"

  if (baseId === "deepseek-harness" || baseId === "dsh") return "deepseek-harness"

  if (baseId === "workbuddy" || baseId === "codebuddy") return "workbuddy"

  return "claude"
}

function extractSubModel(modelId: string): string | undefined {
  const slashIndex = modelId.indexOf("/")
  if (slashIndex === -1) return undefined
  const sub = modelId.slice(slashIndex + 1).trim()
  return sub.length > 0 ? sub : undefined
}

function findClaudeSessionFile(home: string, sessionId: string) {
  const projectsRoot = path.join(home, ".claude", "projects")

  if (!fs.existsSync(projectsRoot)) return undefined
  const projectDirs = fs.readdirSync(projectsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  const candidates = projectDirs.map((dir) => path.join(projectsRoot, dir.name, `${sessionId}.jsonl`))

  return candidates.find((candidate) => fs.existsSync(candidate))
}

function findCodexSessionFile(home: string, sessionId: string) {
  const sessionsRoot = path.join(home, ".codex", "sessions")

  if (!fs.existsSync(sessionsRoot)) return undefined
  const years = fs
    .readdirSync(sessionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .toSorted((a, b) => b.name.localeCompare(a.name))

  const dayDirs = years.flatMap((year) => {
    const yearDir = path.join(sessionsRoot, year.name)
    const months = fs
      .readdirSync(yearDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .toSorted((a, b) => b.name.localeCompare(a.name))

    return months.flatMap((month) => {
      const monthDir = path.join(yearDir, month.name)

      return fs
        .readdirSync(monthDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .toSorted((a, b) => b.name.localeCompare(a.name))
        .map((day) => path.join(monthDir, day.name))
    })
  })

  return dayDirs
    .flatMap((dayDir) =>
      fs
        .readdirSync(dayDir)
        .filter((file) => file.endsWith(".jsonl") && file.includes(sessionId))
        .map((file) => path.join(dayDir, file)),
    )
    .at(0)
}

function findAgySessionFile(home: string, sessionId: string) {
  const transcript = path.join(
    home,
    ".gemini",
    "antigravity",
    "brain",
    sessionId,
    ".system_generated",
    "logs",
    "transcript.jsonl",
  )

  return fs.existsSync(transcript) ? transcript : undefined
}

function findPiSessionFile(home: string, sessionId: string) {
  const piRoot = path.join(home, ".pi", "agent", "sessions")

  if (!fs.existsSync(piRoot)) return undefined
  const direct = path.join(piRoot, sessionId)

  if (fs.existsSync(direct)) return direct
  const directJsonl = path.join(piRoot, `${sessionId}.jsonl`)

  return fs.existsSync(directJsonl) ? directJsonl : undefined
}

function findCursorSessionFile(home: string, sessionId: string) {
  const projectsRoot = path.join(home, ".cursor", "projects")

  if (!fs.existsSync(projectsRoot)) return undefined
  const projectDirs = fs.readdirSync(projectsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  const candidates = projectDirs.map((dir) =>
    path.join(projectsRoot, dir.name, "agent-transcripts", `${sessionId}.jsonl`),
  )

  return candidates.find((candidate) => fs.existsSync(candidate))
}

function findGrokSessionFile(home: string, sessionId: string) {
  const grokRoot = path.join(home, ".grok", "sessions")

  if (!fs.existsSync(grokRoot)) return undefined
  const direct = path.join(grokRoot, `${sessionId}.jsonl`)

  if (fs.existsSync(direct)) return direct
  const directJson = path.join(grokRoot, `${sessionId}.json`)

  return fs.existsSync(directJson) ? directJson : undefined
}

function findDshSessionFile(home: string, sessionId: string) {
  const projCacheFile = path.join(home, ".dsh", "storages", "session_projcache", "sessions", `${sessionId}.json`)

  if (fs.existsSync(projCacheFile)) return projCacheFile
  const sessionsDir = path.join(home, ".dsh", "sessions")

  if (!fs.existsSync(sessionsDir)) return undefined
  const direct = path.join(sessionsDir, `${sessionId}.jsonl`)

  if (fs.existsSync(direct)) return direct
  const directJson = path.join(sessionsDir, `${sessionId}.json`)

  return fs.existsSync(directJson) ? directJson : undefined
}

function findOpencodeSessionFile(home: string, sessionId: string) {
  const dbFile = path.join(home, ".local", "share", "opencode", "opencode.db")

  if (fs.existsSync(dbFile)) return dbFile
  const jsonlFile = path.join(home, ".opencode", "sessions", `${sessionId}.jsonl`)

  return fs.existsSync(jsonlFile) ? jsonlFile : undefined
}

function findEngineSessionFile(home: string, engine: LocalEngine, sessionId: string | undefined) {
  if (!sessionId) return undefined

  if (engine === "claude") return findClaudeSessionFile(home, sessionId)

  if (engine === "codex") return findCodexSessionFile(home, sessionId)

  if (engine === "agy") return findAgySessionFile(home, sessionId)

  if (engine === "pi") return findPiSessionFile(home, sessionId)

  if (engine === "opencode") return findOpencodeSessionFile(home, sessionId)

  if (engine === "cursor") return findCursorSessionFile(home, sessionId)

  if (engine === "grok") return findGrokSessionFile(home, sessionId)

  if (engine === "deepseek-harness") return findDshSessionFile(home, sessionId)

  return undefined
}

function extractMessageText(message: LanguageModelV3Prompt[number]) {
  if (message.role === "system") return message.content.trim()

  return message.content
    .flatMap((part) => {
      if (part.type !== "text") return []
      const trimmed = part.text.trim()
      if (!trimmed || /^<system-update>[\s\S]*<\/system-update>$/.test(trimmed)) return []
      return [trimmed]
    })
    .join("\n\n")
}

function extractPromptTurns(prompt: LanguageModelV3Prompt) {
  const turns = prompt
    .filter((msg) => msg.role === "user" || msg.role === "assistant")
    .flatMap((msg) => {
      const text = extractMessageText(msg)

      return text ? [{ role: msg.role, text }] : []
    })

  const lastUserIndex = turns.findLastIndex((turn) => turn.role === "user")

  if (lastUserIndex < 0) return { priorTurns: [], userText: "" }

  return {
    priorTurns: turns.slice(0, lastUserIndex),
    userText: turns[lastUserIndex]?.text ?? "",
  }
}

function writeFallbackContextJsonl(
  home: string,
  sessionID: string,
  priorTurns: ReadonlyArray<{ role: string; text: string }>,
) {
  const dir = path.join(home, ".cache", "pigu", "session-context")
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, `${sessionID}.jsonl`)
  const content = priorTurns
    .map((turn, index) => JSON.stringify({ seq: index + 1, role: turn.role, content: turn.text }))
    .join("\n")
  fs.writeFileSync(filePath, `${content}\n`, "utf8")

  return filePath
}

function makeEmptyUsage(inputTokens = 0, outputTokens = 0, reasoningTokens = 0): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: inputTokens,
      noCache: inputTokens,
      cacheRead: 0,
      cacheWrite: 0,
    },
    outputTokens: {
      total: outputTokens,
      text: Math.max(0, outputTokens - reasoningTokens),
      reasoning: reasoningTokens,
    },
  }
}

function createStreamEmitter(controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>, modelId: string) {
  const responseId = `resp_${crypto.randomUUID()}`
  const reasoningId = `${responseId}:reasoning`
  const textId = `${responseId}:text`
  const state = {
    started: false,
    reasoningOpen: false,
    textOpen: false,
    hasText: false,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  }

  const ensureMetadata = () => {
    if (state.started) return
    state.started = true
    controller.enqueue({ type: "response-metadata", id: responseId, modelId })
  }

  const pushReasoning = (delta: string) => {
    if (!delta) return
    ensureMetadata()

    if (state.textOpen) {
      state.textOpen = false
      controller.enqueue({ type: "text-end", id: textId })
    }

    if (!state.reasoningOpen) {
      state.reasoningOpen = true
      controller.enqueue({ type: "reasoning-start", id: reasoningId })
    }

    controller.enqueue({ type: "reasoning-delta", id: reasoningId, delta })
  }

  const pushText = (delta: string) => {
    if (!delta) return
    ensureMetadata()

    if (state.reasoningOpen) {
      state.reasoningOpen = false
      controller.enqueue({ type: "reasoning-end", id: reasoningId })
    }

    if (!state.textOpen) {
      state.textOpen = true
      controller.enqueue({ type: "text-start", id: textId })
    }

    state.hasText = true
    controller.enqueue({ type: "text-delta", id: textId, delta })
  }

  const finish = () => {
    ensureMetadata()

    if (state.reasoningOpen) {
      state.reasoningOpen = false
      controller.enqueue({ type: "reasoning-end", id: reasoningId })
    }

    if (state.textOpen) {
      state.textOpen = false
      controller.enqueue({ type: "text-end", id: textId })
    }

    controller.enqueue({
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" },
      usage: makeEmptyUsage(state.inputTokens, state.outputTokens, state.reasoningTokens),
    })
  }

  return {
    state,
    pushReasoning,
    pushText,
    finish,
  }
}

async function runStreamJsonProcess(input: {
  engineLabel: string
  mode: "claude" | "agy" | "cursor"
  binary: string
  cwd: string
  prompt: string
  sessionId?: string
  resume: boolean
  subModel?: string
  variant?: string
  signal: AbortSignal
  emitter: ReturnType<typeof createStreamEmitter>
}): Promise<{ sessionId?: string }> {
  const targetSessionId = input.sessionId ?? crypto.randomUUID()
  const sessionFlag =
    input.mode === "agy"
      ? input.resume && input.sessionId
        ? ["--conversation", input.sessionId]
        : []
      : input.mode === "cursor"
        ? input.resume && input.sessionId
          ? ["--resume", input.sessionId]
          : []
        : input.resume
          ? ["--resume", targetSessionId]
          : ["--session-id", targetSessionId]

  const modelFlag = input.subModel ? ["--model", input.subModel] : []

  const effortFlag =
    (input.mode === "claude" || input.mode === "agy") &&
    input.variant &&
    (input.variant === "low" ||
      input.variant === "medium" ||
      input.variant === "high" ||
      input.variant === "xhigh" ||
      input.variant === "max")
      ? ["--effort", input.variant]
      : []

  const args =
    input.mode === "agy"
      ? [
          "--output-format",
          "stream-json",
          "--dangerously-skip-permissions",
          ...modelFlag,
          ...effortFlag,
          ...sessionFlag,
          "-p",
          input.prompt,
        ]
      : input.mode === "cursor"
        ? [
            ...(path.basename(input.binary) === "cursor" ? ["agent"] : []),
            "-p",
            "--output-format",
            "stream-json",
            "--force",
            ...modelFlag,
            ...sessionFlag,
            input.prompt,
          ]
        : [
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--dangerously-skip-permissions",
            ...modelFlag,
            ...effortFlag,
            ...sessionFlag,
            input.prompt,
          ]

  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: buildAugmentedPath(),
  }

  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(input.binary, args, {
      cwd: input.cwd,
      env,
      shell: shouldUseWindowsShell(input.binary),
      stdio: ["ignore", "pipe", "pipe"],
    })

    const state = {
      detectedSessionId: input.sessionId ?? (input.mode === "claude" ? targetSessionId : undefined),
      streamedMessageIds: new Set<string>(),
      currentMessageId: "",
      plainLines: [] as string[],
      stderrText: "",
      buffer: "",
    }

    const onAbort = () => {
      child.kill("SIGTERM")
    }
    input.signal.addEventListener("abort", onAbort, { once: true })

    const handleLine = (line: string) => {
      const trimmed = line.trim()

      if (!trimmed) return
      const decoded = decodeJsonUnknown(trimmed)

      if (Option.isNone(decoded) || !isRecord(decoded.value)) {
        state.plainLines.push(line)

        return
      }
      const row = decoded.value

      if (typeof row.session_id === "string" && row.session_id) {
        state.detectedSessionId = row.session_id
      }

      if (typeof row.conversation_id === "string" && row.conversation_id) {
        state.detectedSessionId = row.conversation_id
      }

      if (row.event === "init" && isRecord(row.init) && typeof row.init.conversation_id === "string") {
        if (row.init.conversation_id) state.detectedSessionId = row.init.conversation_id

        return
      }

      if (row.event === "step_update" && isRecord(row.step_update)) {
        const step = row.step_update

        if (typeof step.thinking_delta === "string" && step.thinking_delta) {
          input.emitter.pushReasoning(step.thinking_delta)
        }

        if (typeof step.text_delta === "string" && step.text_delta) {
          input.emitter.pushText(step.text_delta)
        }

        return
      }

      if (row.event === "result" && isRecord(row.result)) {
        const res = row.result

        if (typeof res.conversation_id === "string" && res.conversation_id) {
          state.detectedSessionId = res.conversation_id
        }

        if (isRecord(res.usage)) {
          if (typeof res.usage.input_tokens === "number") input.emitter.state.inputTokens = res.usage.input_tokens
          if (typeof res.usage.output_tokens === "number") input.emitter.state.outputTokens = res.usage.output_tokens
          if (typeof res.usage.thinking_tokens === "number")
            input.emitter.state.reasoningTokens = res.usage.thinking_tokens
        }

        if (!input.emitter.state.hasText && typeof res.response === "string" && res.response.trim()) {
          input.emitter.pushText(res.response)

          return
        }

        if (!input.emitter.state.hasText && typeof res.error === "string" && res.error.trim()) {
          input.emitter.pushText(`${input.engineLabel} 执行出错：${res.error}`)
        }

        return
      }

      if (row.type === "stream_event" && row.parent_tool_use_id === null && isRecord(row.event)) {
        const event = row.event

        if (event.type === "message_start" && isRecord(event.message) && typeof event.message.id === "string") {
          state.currentMessageId = event.message.id
          state.streamedMessageIds.add(event.message.id)
        }

        if (event.type === "content_block_start" && isRecord(event.content_block)) {
          const block = event.content_block

          if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
            input.emitter.pushReasoning(block.thinking)
          }

          if (block.type === "text" && typeof block.text === "string" && block.text) {
            input.emitter.pushText(block.text)
          }
        }

        if (event.type === "content_block_delta" && isRecord(event.delta)) {
          const delta = event.delta

          if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking) {
            input.emitter.pushReasoning(delta.thinking)
          }

          if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
            input.emitter.pushText(delta.text)
          }
        }

        return
      }

      if (row.type === "assistant" && isRecord(row.message)) {
        const message = row.message
        const msgId = typeof message.id === "string" ? message.id : ""
        const alreadyStreamed = msgId ? state.streamedMessageIds.has(msgId) : false
        const content = Array.isArray(message.content) ? message.content : []

        content.forEach((part) => {
          if (!isRecord(part)) return

          if (part.type === "tool_use" && typeof part.name === "string") {
            input.emitter.pushReasoning(`\n[${input.engineLabel} 原生工具: ${part.name}]\n`)

            return
          }

          if (alreadyStreamed) return

          if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking) {
            input.emitter.pushReasoning(part.thinking)
          }

          if (part.type === "text" && typeof part.text === "string" && part.text) {
            input.emitter.pushText(part.text)
          }
        })

        return
      }

      if (row.type === "result") {
        if (isRecord(row.usage)) {
          if (typeof row.usage.input_tokens === "number") input.emitter.state.inputTokens = row.usage.input_tokens
          if (typeof row.usage.output_tokens === "number") input.emitter.state.outputTokens = row.usage.output_tokens
        }

        if (!input.emitter.state.hasText && typeof row.result === "string" && row.result.trim()) {
          input.emitter.pushText(row.result)
        }
      }
    }

    child.stdout.on("data", (chunk: Buffer) => {
      state.buffer += chunk.toString("utf8")
      const lines = state.buffer.split(/\r?\n/)
      state.buffer = lines.pop() ?? ""
      lines.forEach(handleLine)
    })

    child.stderr.on("data", (chunk: Buffer) => {
      state.stderrText += chunk.toString("utf8")
    })

    child.on("error", (err) => {
      input.signal.removeEventListener("abort", onAbort)
      reject(err)
    })

    child.on("close", (code) => {
      input.signal.removeEventListener("abort", onAbort)

      if (state.buffer.trim()) handleLine(state.buffer)

      if (!input.emitter.state.hasText && state.plainLines.length > 0) {
        input.emitter.pushText(state.plainLines.join("\n"))
      }

      if (!input.emitter.state.hasText && code !== 0 && !input.signal.aborted) {
        const detail = state.stderrText.trim() || `${input.engineLabel} 进程退出码 ${code ?? "unknown"}`
        input.emitter.pushText(`${input.engineLabel} 执行出错：${detail}`)
      }

      resolve({ sessionId: state.detectedSessionId })
    })
  })
}

async function runCodexProcess(input: {
  binary: string
  cwd: string
  prompt: string
  sessionId?: string
  resume: boolean
  subModel?: string
  variant?: string
  signal: AbortSignal
  emitter: ReturnType<typeof createStreamEmitter>
}): Promise<{ sessionId?: string }> {
  const lastMsgFile = path.join(os.tmpdir(), `pigu-codex-last-${crypto.randomUUID()}.txt`)
  const modelFlag = input.subModel ? ["-c", `model="${input.subModel}"`] : []
  const effortFlag =
    input.variant &&
    (input.variant === "low" ||
      input.variant === "medium" ||
      input.variant === "high" ||
      input.variant === "xhigh")
      ? ["-c", `model_reasoning_effort="${input.variant}"`]
      : []
  const args =
    input.resume && input.sessionId
      ? [
          "exec",
          "resume",
          input.sessionId,
          input.prompt,
          "--json",
          "--dangerously-bypass-approvals-and-sandbox",
          "--skip-git-repo-check",
          ...modelFlag,
          ...effortFlag,
          "-o",
          lastMsgFile,
        ]
      : [
          "exec",
          input.prompt,
          "--json",
          "--dangerously-bypass-approvals-and-sandbox",
          "--skip-git-repo-check",
          ...modelFlag,
          ...effortFlag,
          "-C",
          input.cwd,
          "-o",
          lastMsgFile,
        ]

  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: buildAugmentedPath(),
  }

  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(input.binary, args, {
      cwd: input.cwd,
      env,
      shell: shouldUseWindowsShell(input.binary),
      stdio: ["ignore", "pipe", "pipe"],
    })

    const state = {
      detectedSessionId: input.sessionId,
      stderrText: "",
      buffer: "",
      seenAgentMessages: new Set<string>(),
    }

    const onAbort = () => {
      child.kill("SIGTERM")
    }
    input.signal.addEventListener("abort", onAbort, { once: true })

    const handleLine = (line: string) => {
      const trimmed = line.trim()

      if (!trimmed) return
      const decoded = decodeJsonUnknown(trimmed)

      if (Option.isNone(decoded) || !isRecord(decoded.value)) return
      const row = decoded.value

      if (row.type === "thread.started" && typeof row.thread_id === "string" && row.thread_id) {
        state.detectedSessionId = row.thread_id

        return
      }

      if (row.type === "session_meta" && isRecord(row.payload) && typeof row.payload.id === "string") {
        state.detectedSessionId = row.payload.id

        return
      }

      if (row.type === "item.started" && isRecord(row.item)) {
        const item = row.item

        if (item.type === "command_execution" && typeof item.command === "string") {
          input.emitter.pushReasoning(`\n[codex 原生命令: ${item.command}]\n`)
        }

        return
      }

      if (row.type === "item.completed" && isRecord(row.item)) {
        const item = row.item

        if (item.type === "reasoning" && typeof item.text === "string" && item.text.trim()) {
          input.emitter.pushReasoning(`${item.text.trim()}\n`)

          return
        }

        if (item.type === "file_change") {
          input.emitter.pushReasoning("\n[codex 原生文件变更]\n")

          return
        }

        if (item.type === "agent_message" && typeof item.text === "string" && item.text.trim()) {
          const text = item.text.trim()

          if (!state.seenAgentMessages.has(text)) {
            state.seenAgentMessages.add(text)
            input.emitter.pushText(input.emitter.state.hasText ? `\n\n${text}` : text)
          }
        }

        return
      }

      if (row.type === "event_msg" && isRecord(row.payload)) {
        const payload = row.payload

        if (payload.type === "agent_reasoning" && typeof payload.message === "string" && payload.message.trim()) {
          input.emitter.pushReasoning(`${payload.message.trim()}\n`)

          return
        }

        if (payload.type === "agent_message" && typeof payload.message === "string" && payload.message.trim()) {
          const text = payload.message.trim()

          if (!state.seenAgentMessages.has(text)) {
            state.seenAgentMessages.add(text)
            input.emitter.pushText(input.emitter.state.hasText ? `\n\n${text}` : text)
          }
        }

        return
      }

      if (row.type === "turn.completed" && isRecord(row.usage)) {
        if (typeof row.usage.input_tokens === "number") input.emitter.state.inputTokens = row.usage.input_tokens
        if (typeof row.usage.output_tokens === "number") input.emitter.state.outputTokens = row.usage.output_tokens
      }
    }

    child.stdout.on("data", (chunk: Buffer) => {
      state.buffer += chunk.toString("utf8")
      const lines = state.buffer.split(/\r?\n/)
      state.buffer = lines.pop() ?? ""
      lines.forEach(handleLine)
    })

    child.stderr.on("data", (chunk: Buffer) => {
      state.stderrText += chunk.toString("utf8")
    })

    child.on("error", (err) => {
      input.signal.removeEventListener("abort", onAbort)
      reject(err)
    })

    child.on("close", (code) => {
      input.signal.removeEventListener("abort", onAbort)

      if (state.buffer.trim()) handleLine(state.buffer)

      if (!input.emitter.state.hasText && fs.existsSync(lastMsgFile)) {
        const lastMsg = fs.readFileSync(lastMsgFile, "utf8").trim()

        if (lastMsg) input.emitter.pushText(lastMsg)
      }

      if (fs.existsSync(lastMsgFile)) {
        fs.rmSync(lastMsgFile, { force: true })
      }

      if (!input.emitter.state.hasText && code !== 0 && !input.signal.aborted) {
        const detail = state.stderrText.trim() || `codex 进程退出码 ${code ?? "unknown"}`
        input.emitter.pushText(`codex 执行出错：${detail}`)
      }

      resolve({ sessionId: state.detectedSessionId })
    })
  })
}

async function runPlainCliProcess(input: {
  engineLabel: string
  binary: string
  args: ReadonlyArray<string>
  cwd: string
  sessionId?: string
  signal: AbortSignal
  emitter: ReturnType<typeof createStreamEmitter>
}): Promise<{ sessionId?: string }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: buildAugmentedPath(),
  }

  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(input.binary, [...input.args], {
      cwd: input.cwd,
      env,
      shell: shouldUseWindowsShell(input.binary),
      stdio: ["ignore", "pipe", "pipe"],
    })

    const state = {
      stderrText: "",
    }

    const onAbort = () => {
      child.kill("SIGTERM")
    }
    input.signal.addEventListener("abort", onAbort, { once: true })

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8")

      if (text) input.emitter.pushText(text)
    })

    child.stderr.on("data", (chunk: Buffer) => {
      state.stderrText += chunk.toString("utf8")
    })

    child.on("error", (err) => {
      input.signal.removeEventListener("abort", onAbort)
      reject(err)
    })

    child.on("close", (code) => {
      input.signal.removeEventListener("abort", onAbort)

      if (!input.emitter.state.hasText && code !== 0 && !input.signal.aborted) {
        const detail = state.stderrText.trim() || `${input.engineLabel} 进程退出码 ${code ?? "unknown"}`
        input.emitter.pushText(`${input.engineLabel} 执行出错：${detail}`)
      }

      resolve({ sessionId: input.sessionId })
    })
  })
}

async function runOpencodeProcess(input: {
  binary: string
  args: ReadonlyArray<string>
  cwd: string
  sessionId?: string
  signal: AbortSignal
  emitter: ReturnType<typeof createStreamEmitter>
}): Promise<{ sessionId?: string }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: buildAugmentedPath(),
    PWD: input.cwd,
  }
  delete env.OPENCODE_DB
  delete env.OPENCODE_DISABLE_CHANNEL_DB

  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(input.binary, [...input.args], {
      cwd: input.cwd,
      env,
      shell: shouldUseWindowsShell(input.binary),
      stdio: ["ignore", "pipe", "pipe"],
    })

    const state = {
      stdoutBuffer: "",
      stderrText: "",
      detectedSessionId: input.sessionId,
      stopTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    }

    const handleLine = (rawLine: string) => {
      const trimmed = rawLine.trim()
      if (!trimmed) return
      const decoded = decodeJsonUnknown(trimmed)
      if (Option.isNone(decoded) || !isRecord(decoded.value)) {
        const cleaned = trimmed.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").trim()
        if (cleaned && !cleaned.startsWith("> ")) input.emitter.pushText(`${cleaned}\n`)
        return
      }
      const row = decoded.value
      if (typeof row.sessionID === "string" && row.sessionID.length > 0) {
        state.detectedSessionId = row.sessionID
      }
      const part = isRecord(row.part) ? row.part : undefined
      const partType = typeof part?.type === "string" ? part.type : typeof row.type === "string" ? row.type : ""
      const partText = typeof part?.text === "string" ? part.text : typeof row.text === "string" ? row.text : ""
      if (partType === "reasoning" && partText) {
        input.emitter.pushReasoning(partText)
        return
      }
      if (partType === "text" && partText) {
        input.emitter.pushText(partText)
        return
      }
      if ((partType === "step-finish" || row.type === "step_finish") && part?.reason === "stop") {
        if (state.stopTimer) clearTimeout(state.stopTimer)
        state.stopTimer = setTimeout(() => {
          child.kill("SIGTERM")
        }, 1200)
        return
      }
      if (row.type === "error" && isRecord(row.error) && typeof row.error.message === "string") {
        input.emitter.pushText(`opencode 错误：${row.error.message}`)
      }
    }

    const onAbort = () => {
      if (state.stopTimer) clearTimeout(state.stopTimer)
      child.kill("SIGTERM")
    }
    input.signal.addEventListener("abort", onAbort, { once: true })

    child.stdout.on("data", (chunk: Buffer) => {
      state.stdoutBuffer += chunk.toString("utf8")
      const lines = state.stdoutBuffer.split(/\r?\n/)
      state.stdoutBuffer = lines.pop() ?? ""
      lines.forEach(handleLine)
    })

    child.stderr.on("data", (chunk: Buffer) => {
      state.stderrText += chunk.toString("utf8")
    })

    child.on("error", (err) => {
      if (state.stopTimer) clearTimeout(state.stopTimer)
      input.signal.removeEventListener("abort", onAbort)
      reject(err)
    })

    child.on("close", (code) => {
      if (state.stopTimer) clearTimeout(state.stopTimer)
      input.signal.removeEventListener("abort", onAbort)
      if (state.stdoutBuffer.trim()) handleLine(state.stdoutBuffer)

      if (!input.emitter.state.hasText && code !== 0 && !input.signal.aborted) {
        const detail = state.stderrText.trim() || `opencode 进程退出码 ${code ?? "unknown"}`
        input.emitter.pushText(`opencode 执行出错：${detail}`)
      }

      resolve({ sessionId: state.detectedSessionId })
    })
  })
}

type DafeiyuCompanionPayload = {
  readonly state: "IDLE" | "THINKING" | "WORKING" | "WAITING" | "SUCCESS" | "ERROR"
  readonly phase: string
  readonly stage: string
  readonly message: string
  readonly detail: string
}

const dafeiyuRuntime: {
  child: childProcess.ChildProcess | undefined
  idleTimer: ReturnType<typeof setTimeout> | undefined
} = {
  child: undefined,
  idleTimer: undefined,
}

function resolveDafeiyuHelperBinary(home: string): string | undefined {
  const roots = [
    path.join(home, ".dsh", "profiles", "desktop", "node_modules", "dsh-dafeiyu"),
    path.join(home, ".dsh", "profiles", "headless", "node_modules", "dsh-dafeiyu"),
  ]
  const relPath =
    process.platform === "darwin"
      ? path.join("runtime", "bin", "darwin", "dsh-dafeiyu-helper.app", "Contents", "MacOS", "dsh-dafeiyu-helper")
      : process.platform === "win32"
        ? path.join("runtime", "bin", "win32-x64", "dsh-dafeiyu-helper.exe")
        : path.join("runtime", "bin", `linux-${process.arch}`, "dsh-dafeiyu-helper")

  const found = roots.map((root) => path.join(root, relPath)).find((candidate) => fs.existsSync(candidate))
  if (found) {
    if (process.platform !== "win32") fs.chmodSync(found, 0o755)
    return found
  }

  if (process.platform === "darwin") {
    const pkgRoot = roots.find((root) => fs.existsSync(path.join(root, "native", "macos", "build.sh")))
    if (pkgRoot) {
      childProcess.spawnSync("bash", [path.join(pkgRoot, "native", "macos", "build.sh")], {
        cwd: pkgRoot,
        stdio: "ignore",
        timeout: 25_000,
      })
      const built = path.join(pkgRoot, relPath)
      if (fs.existsSync(built)) {
        fs.chmodSync(built, 0o755)
        return built
      }
    }
  }

  return undefined
}

function dshPluginStatePath(home: string): string {
  return path.join(home, ".config", "opencode", "dsh-plugins.json")
}

function readDisabledDshPlugins(home: string): Set<string> {
  const raw = readJsonRecordSafe(dshPluginStatePath(home))
  const list = raw && Array.isArray(raw.disabled) ? raw.disabled : []
  return new Set(list.filter((item): item is string => typeof item === "string" && item.trim().length > 0))
}

export function isDshPluginEnabled(home: string, pluginName: string): boolean {
  const clean = pluginName.replace(/^dsh:/, "").trim()
  return !readDisabledDshPlugins(home).has(clean)
}

export function stopDafeiyuCompanion() {
  if (dafeiyuRuntime.idleTimer) {
    clearTimeout(dafeiyuRuntime.idleTimer)
    dafeiyuRuntime.idleTimer = undefined
  }
  const child = dafeiyuRuntime.child
  dafeiyuRuntime.child = undefined
  if (child && !child.killed && child.exitCode === null) {
    child.kill("SIGTERM")
  }
}

export function setDshPluginEnabled(home: string, pluginName: string, enabled: boolean) {
  const clean = pluginName.replace(/^dsh:/, "").trim()
  if (!clean) return
  const disabled = readDisabledDshPlugins(home)
  if (enabled) {
    disabled.delete(clean)
  }
  if (!enabled) {
    disabled.add(clean)
  }
  const statePath = dshPluginStatePath(home)
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  fs.writeFileSync(statePath, `${JSON.stringify({ disabled: [...disabled] }, null, 2)}\n`, "utf8")
  syncDshThirdPartyPlugins(home)
  if (clean === "dsh-dafeiyu") {
    if (!enabled) {
      stopDafeiyuCompanion()
      return
    }
    notifyDafeiyuCompanion(home, {
      state: "IDLE",
      phase: "idle",
      stage: "等待任务",
      message: "本鱼已重新上线，随时待命~",
      detail: "Pigu · 大肥鱼伴侣",
    })
  }
}

export type DiscoveredDshPlugin = {
  readonly id: string
  readonly name: string
  readonly version?: string
  readonly description: string
  readonly enabled: boolean
}

export function discoverDshThirdPartyPlugins(
  home = process.env.OPENCODE_TEST_HOME || os.homedir(),
): readonly DiscoveredDshPlugin[] {
  syncDshThirdPartyPlugins(home)
  const desktopDir = path.join(home, ".dsh", "profiles", "desktop")
  const headlessDir = path.join(home, ".dsh", "profiles", "headless")
  const desktopPkg = readJsonRecordSafe(path.join(desktopDir, "package.json"))
  const headlessPkg = readJsonRecordSafe(path.join(headlessDir, "package.json"))

  const readBundles = (pkg: Record<string, unknown> | undefined) => {
    const dshField = pkg && isRecord(pkg.dsh) ? pkg.dsh : undefined
    const profileField = dshField && isRecord(dshField.profile) ? dshField.profile : undefined
    return Array.isArray(profileField?.bundles)
      ? profileField.bundles.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : []
  }

  const bundles = [...new Set([...readBundles(desktopPkg), ...readBundles(headlessPkg)])].filter(
    (bundle) => !bundle.startsWith("@deepseek-ai/"),
  )

  return bundles.map((name) => {
    const pkgJson =
      readJsonRecordSafe(path.join(desktopDir, "node_modules", name, "package.json")) ??
      readJsonRecordSafe(path.join(headlessDir, "node_modules", name, "package.json"))
    const version = typeof pkgJson?.version === "string" && pkgJson.version.trim() ? pkgJson.version.trim() : undefined
    const rawDesc =
      typeof pkgJson?.description === "string" && pkgJson.description.trim() ? pkgJson.description.trim() : ""
    const versionTag = version ? ` (v${version})` : ""
    const description =
      name === "dsh-dafeiyu"
        ? `桌面大肥鱼伴侣${versionTag} — 随 Pigu / DeepSeek Harness 会话状态实时互动的原生桌面宠物伴侣`
        : rawDesc
          ? `${rawDesc}${versionTag}`
          : `DeepSeek Harness 第三方扩展插件: ${name}${versionTag}`
    return {
      id: `dsh:${name}`,
      name,
      ...(version ? { version } : {}),
      description,
      enabled: isDshPluginEnabled(home, name),
    }
  })
}

function sendDafeiyuMessage(kind: string, payload: Record<string, unknown>) {
  const stdin = dafeiyuRuntime.child?.stdin
  if (!stdin || stdin.destroyed || !stdin.writable) return
  const line = JSON.stringify({
    protocolVersion: 1,
    kind,
    timestamp: Date.now(),
    ...payload,
  })
  stdin.write(`${line}\n`)
}

function notifyDafeiyuCompanion(home: string, payload: DafeiyuCompanionPayload) {
  if (!isDshPluginEnabled(home, "dsh-dafeiyu")) return
  const binary = resolveDafeiyuHelperBinary(home)
  if (!binary) return

  if (dafeiyuRuntime.idleTimer) {
    clearTimeout(dafeiyuRuntime.idleTimer)
    dafeiyuRuntime.idleTimer = undefined
  }

  if (!dafeiyuRuntime.child || dafeiyuRuntime.child.killed || dafeiyuRuntime.child.exitCode !== null) {
    const env: Record<string, string | undefined> = {
      ...process.env,
      DSH_DAFEIYU_SCALE: "1",
      DSH_DAFEIYU_BUBBLE_SCALE: "1",
      DSH_DAFEIYU_ACTIVITY_LEVEL: "normal",
      DSH_DAFEIYU_BUBBLE_MODE: "always",
      DSH_DAFEIYU_OPEN_LABEL: "Pigu",
    }
    delete env.ELECTRON_RUN_AS_NODE

    const child = childProcess.spawn(binary, [], {
      env,
      stdio: ["pipe", "ignore", "ignore"],
    })
    child.unref()
    child.on("exit", () => {
      if (dafeiyuRuntime.child === child) dafeiyuRuntime.child = undefined
    })
    dafeiyuRuntime.child = child

    sendDafeiyuMessage("hello", {
      state: "IDLE",
      host: "pigu",
      pluginVersion: "0.1.23",
      message: "BigFish connected to Pigu",
    })
  }

  sendDafeiyuMessage("state", payload)

  if (payload.state === "SUCCESS" || payload.state === "ERROR") {
    dafeiyuRuntime.idleTimer = setTimeout(() => {
      dafeiyuRuntime.idleTimer = undefined
      sendDafeiyuMessage("state", {
        state: "IDLE",
        phase: "idle",
        stage: "等待任务",
        message: "本鱼吃饱啦，随时待命~",
        detail: "Pigu · 大肥鱼伴侣",
      })
    }, 4500)
    dafeiyuRuntime.idleTimer.unref?.()
  }
}

export function syncDshThirdPartyPlugins(home: string) {
  const desktopDir = path.join(home, ".dsh", "profiles", "desktop")
  const headlessDir = path.join(home, ".dsh", "profiles", "headless")
  const desktopPkgPath = path.join(desktopDir, "package.json")
  const desktopPkg = readJsonRecordSafe(desktopPkgPath)
  if (!desktopPkg) return

  const dshField = isRecord(desktopPkg.dsh) ? desktopPkg.dsh : undefined
  const profileField = dshField && isRecord(dshField.profile) ? dshField.profile : undefined
  const desktopBundles = Array.isArray(profileField?.bundles)
    ? profileField.bundles.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : []

  // Exclude @deepseek-ai/* built-in bundles (such as @deepseek-ai/dsh-builtin-skills Office skills)
  const thirdPartyBundles = desktopBundles.filter((bundle) => !bundle.startsWith("@deepseek-ai/"))
  if (thirdPartyBundles.length === 0) return

  const disabledSet = readDisabledDshPlugins(home)
  const activeThirdPartyBundles = thirdPartyBundles.filter((bundle) => !disabledSet.has(bundle))

  const desktopDeps = isRecord(desktopPkg.dependencies) ? desktopPkg.dependencies : {}
  const headlessPkgPath = path.join(headlessDir, "package.json")
  const existingHeadlessPkg = readJsonRecordSafe(headlessPkgPath) ?? {
    name: "dsh-profile-headless",
    private: true,
    dependencies: {},
    dsh: {
      profile: {
        bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"],
      },
    },
  }

  const existingDeps = isRecord(existingHeadlessPkg.dependencies) ? existingHeadlessPkg.dependencies : {}
  const existingDsh = isRecord(existingHeadlessPkg.dsh) ? existingHeadlessPkg.dsh : {}
  const existingProfile = isRecord(existingDsh.profile) ? existingDsh.profile : {}
  const existingBundles = Array.isArray(existingProfile.bundles)
    ? existingProfile.bundles.filter((item): item is string => typeof item === "string")
    : ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"]

  const keptExistingBundles = existingBundles.filter(
    (bundle) => bundle.startsWith("@deepseek-ai/") || !disabledSet.has(bundle),
  )
  const mergedBundles = [...new Set([...keptExistingBundles, ...activeThirdPartyBundles])]
  const mergedDeps: Record<string, unknown> = { ...existingDeps }
  thirdPartyBundles.forEach((bundle) => {
    if (typeof desktopDeps[bundle] === "string") {
      mergedDeps[bundle] = desktopDeps[bundle]
    }
  })

  const nextHeadlessPkg = {
    ...existingHeadlessPkg,
    dependencies: mergedDeps,
    dsh: {
      ...existingDsh,
      profile: {
        ...existingProfile,
        bundles: mergedBundles,
      },
    },
  }

  fs.mkdirSync(headlessDir, { recursive: true })
  const nextPkgJson = `${JSON.stringify(nextHeadlessPkg, null, 2)}\n`
  const currentPkgJson = fs.existsSync(headlessPkgPath) ? fs.readFileSync(headlessPkgPath, "utf8") : ""
  if (nextPkgJson !== currentPkgJson) {
    fs.writeFileSync(headlessPkgPath, nextPkgJson, "utf8")
  }

  const desktopNodeModules = path.join(desktopDir, "node_modules")
  const headlessNodeModules = path.join(headlessDir, "node_modules")
  if (!fs.existsSync(desktopNodeModules)) return

  thirdPartyBundles.forEach((bundle) => {
    const srcPkgDir = path.join(desktopNodeModules, bundle)
    const dstPkgDir = path.join(headlessNodeModules, bundle)
    if (!fs.existsSync(srcPkgDir) || fs.existsSync(dstPkgDir)) return
    fs.mkdirSync(path.dirname(dstPkgDir), { recursive: true })
    const realSrc = fs.realpathSync(srcPkgDir)
    fs.symlinkSync(realSrc, dstPkgDir, process.platform === "win32" ? "junction" : "dir")
  })

  if (
    activeThirdPartyBundles.includes("dsh-dafeiyu") &&
    !process.env.OPENCODE_TEST_HOME &&
    (!dafeiyuRuntime.child || dafeiyuRuntime.child.killed || dafeiyuRuntime.child.exitCode !== null)
  ) {
    notifyDafeiyuCompanion(home, {
      state: "IDLE",
      phase: "idle",
      stage: "等待任务",
      message: "本鱼已上线，随时待命~",
      detail: "Pigu · 大肥鱼伴侣",
    })
  }
}

type DshModelRoute = {
  readonly providerKey: string
  readonly displayName: string
  readonly baseURL: string
  readonly apiKey: string
  readonly api: "openai-completions" | "anthropic-messages"
  readonly modelId: string
}

function resolveDshModelRoute(home: string, subModel: string | undefined): DshModelRoute | undefined {
  const cfg =
    readJsonRecordSafe(path.join(home, ".config", "opencode", "opencode.json")) ??
    readJsonRecordSafe(path.join(home, ".config", "opencode", "config.json")) ??
    readJsonRecordSafe(path.join(home, ".opencode", "opencode.json"))
  if (!cfg) return undefined

  const rawProviders = isRecord(cfg.provider) ? cfg.provider : isRecord(cfg.providers) ? cfg.providers : {}
  const entries = Object.entries(rawProviders).flatMap(([key, val]) => {
    if (!isRecord(val)) return []
    const opts = isRecord(val.options) ? val.options : isRecord(val.settings) ? val.settings : undefined
    const baseURL = typeof opts?.baseURL === "string" ? opts.baseURL.trim() : ""
    const apiKey = typeof opts?.apiKey === "string" ? opts.apiKey.trim() : ""
    const displayName = typeof val.name === "string" && val.name.trim() ? val.name.trim() : key
    const models = isRecord(val.models) ? Object.keys(val.models) : []
    if (!baseURL || !apiKey) return []
    const safeKey = key.toLowerCase().replace(/[^a-z0-9-]+/g, "-") || "pigu"
    return [{ key, safeKey, displayName, baseURL, apiKey, models }]
  })

  if (entries.length === 0) return undefined

  const trimmed = (subModel ?? "").trim()
  const slashIdx = trimmed.indexOf("/")

  const matched = (() => {
    if (slashIdx > 0) {
      const prefix = trimmed.slice(0, slashIdx)
      const modelId = trimmed.slice(slashIdx + 1).trim()
      const provider = entries.find((item) => item.key === prefix || item.safeKey === prefix) ?? entries[0]
      return provider && modelId ? { provider, modelId } : undefined
    }

    if (trimmed) {
      const exactProvider = entries.find((item) => item.models.includes(trimmed))
      if (exactProvider) return { provider: exactProvider, modelId: trimmed }

      if (
        (trimmed === "deepseek-flash" || trimmed === "deepseek-chat" || trimmed === "deepseek-reasoner") &&
        Boolean(process.env.DEEPSEEK_API_KEY)
      ) {
        return undefined
      }

      const primary = entries[0]
      if (!primary) return undefined
      const fallbackModel =
        trimmed === "deepseek-reasoner"
          ? primary.models.find((m) => /deepseek.*(pro|reasoner|r1)/i.test(m)) ??
            primary.models.find((m) => /gemini-3\.8-flash/i.test(m)) ??
            primary.models[0] ??
            trimmed
          : trimmed === "deepseek-flash" || trimmed === "deepseek-chat"
            ? primary.models.find((m) => /deepseek.*flash/i.test(m)) ??
              primary.models.find((m) => /gemini-3\.8-flash/i.test(m)) ??
              primary.models[0] ??
              trimmed
            : trimmed
      return { provider: primary, modelId: fallbackModel }
    }

    const primary = entries[0]
    if (!primary) return undefined
    const defaultModel =
      primary.models.find((m) => m === "gemini-3.8-flash") ??
      primary.models.find((m) => /gemini-3\.8-flash/i.test(m)) ??
      primary.models[0] ??
      "gemini-3.8-flash"
    return { provider: primary, modelId: defaultModel }
  })()

  if (!matched) return undefined

  const api: "openai-completions" | "anthropic-messages" = /anthropic/i.test(matched.provider.baseURL)
    ? "anthropic-messages"
    : "openai-completions"

  return {
    providerKey: matched.provider.safeKey,
    displayName: matched.provider.displayName,
    baseURL: matched.provider.baseURL,
    apiKey: matched.provider.apiKey,
    api,
    modelId: matched.modelId,
  }
}

async function runDshProcess(input: {
  binary: string
  cwd: string
  home: string
  prompt: string
  sessionId?: string
  resume: boolean
  subModel?: string
  signal: AbortSignal
  emitter: ReturnType<typeof createStreamEmitter>
}): Promise<{ sessionId?: string }> {
  syncDshThirdPartyPlugins(input.home)
  const route = resolveDshModelRoute(input.home, input.subModel)
  const modelLabel = route ? `${route.displayName} / ${route.modelId}` : (input.subModel ?? "deepseek-flash")

  notifyDafeiyuCompanion(input.home, {
    state: "THINKING",
    phase: "turn-start",
    stage: "偷吃白饭中",
    message: `正在使用 ${modelLabel} 思考...`,
    detail: `Pigu · ${modelLabel}`,
  })

  const patchLines = [
    "- id: settings",
    "  disabled: false",
    "- id: dsh-dafeiyu",
    "  config:",
    "    enabled: false",
    ...(route
      ? [
          "- id: llm-pi-ai",
          "  config:",
          "    providers:",
          `      ${route.providerKey}:`,
          `        displayName: ${JSON.stringify(route.displayName)}`,
          "        apiKeyEnv: PIGU_DSH_API_KEY",
          `        api: ${route.api}`,
          `        baseURL: ${JSON.stringify(route.baseURL)}`,
          "        models:",
          `          - id: ${JSON.stringify(route.modelId)}`,
          "            contextWindow: 1000000",
          "            maxTokens: 32768",
          "- id: agent-default-model",
          "  config:",
          `    provider: ${JSON.stringify(route.providerKey)}`,
          `    model: ${JSON.stringify(route.modelId)}`,
        ]
      : input.subModel &&
          (input.subModel === "deepseek-flash" ||
            input.subModel === "deepseek-chat" ||
            input.subModel === "deepseek-reasoner")
        ? [
            "- id: agent-default-model",
            "  config:",
            "    provider: deepseek-official",
            `    model: ${JSON.stringify(input.subModel)}`,
          ]
        : []),
  ]

  const patchFile = path.join(os.tmpdir(), `pigu-dsh-patch-${crypto.randomUUID()}.yml`)
  fs.writeFileSync(patchFile, `${patchLines.join("\n")}\n`, "utf8")

  const args = [
    "--profile",
    "headless",
    "--patch",
    patchFile,
    "--json",
    ...(input.resume && input.sessionId ? ["--session-id", input.sessionId] : []),
    input.prompt,
  ]

  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: buildAugmentedPath(),
    DSH_PERMISSION_MODE: "danger-full-access",
    ...(route ? { PIGU_DSH_API_KEY: route.apiKey } : {}),
  }

  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(input.binary, args, {
      cwd: input.cwd,
      env,
      shell: shouldUseWindowsShell(input.binary),
      stdio: ["ignore", "pipe", "pipe"],
    })

    const state = {
      stdoutBuffer: "",
      stderrText: "",
      detectedSessionId: input.sessionId,
      hadError: false,
    }

    const cleanupPatch = () => {
      if (fs.existsSync(patchFile)) fs.rmSync(patchFile, { force: true })
    }

    const handleLine = (rawLine: string) => {
      const trimmed = rawLine.trim()
      if (!trimmed) return
      const decoded = decodeJsonUnknown(trimmed)
      if (Option.isNone(decoded) || !isRecord(decoded.value)) {
        input.emitter.pushText(`${trimmed}\n`)
        return
      }
      const row = decoded.value
      if (row.type === "session" && typeof row.sessionId === "string" && row.sessionId) {
        state.detectedSessionId = row.sessionId
        return
      }
      if (row.type === "thinking" && typeof row.text === "string" && row.text) {
        input.emitter.pushReasoning(row.text)
        return
      }
      if (row.type === "tool_call" && typeof row.tool === "string" && row.tool) {
        input.emitter.pushReasoning(`\n[deepseek harness 原生工具: ${row.tool}]\n`)
        notifyDafeiyuCompanion(input.home, {
          state: "WORKING",
          phase: "tool-call",
          stage: "努力干活中",
          message: `正在执行工具: ${row.tool}`,
          detail: `Pigu · ${modelLabel}`,
        })
        return
      }
      if (row.type === "text" && typeof row.text === "string" && row.text) {
        input.emitter.pushText(row.text)
        return
      }
      if (row.type === "status" && row.phase === "step_end" && isRecord(row.usage)) {
        if (typeof row.usage.inputTokens === "number") input.emitter.state.inputTokens = row.usage.inputTokens
        if (typeof row.usage.outputTokens === "number") input.emitter.state.outputTokens = row.usage.outputTokens
        if (typeof row.usage.reasoningTokens === "number")
          input.emitter.state.reasoningTokens = row.usage.reasoningTokens
        return
      }
      if (row.type === "final" && typeof row.text === "string" && row.text && !input.emitter.state.hasText) {
        input.emitter.pushText(row.text)
        return
      }
      if (row.type === "error" && typeof row.message === "string" && row.message) {
        state.hadError = true
        if (!input.emitter.state.hasText) {
          input.emitter.pushText(`deepseek harness 执行出错：${row.message}`)
        }
      }
    }

    const onAbort = () => {
      child.kill("SIGTERM")
    }
    input.signal.addEventListener("abort", onAbort, { once: true })

    child.stdout.on("data", (chunk: Buffer) => {
      state.stdoutBuffer += chunk.toString("utf8")
      const lines = state.stdoutBuffer.split(/\r?\n/)
      state.stdoutBuffer = lines.pop() ?? ""
      lines.forEach(handleLine)
    })

    child.stderr.on("data", (chunk: Buffer) => {
      state.stderrText += chunk.toString("utf8")
    })

    child.on("error", (err) => {
      input.signal.removeEventListener("abort", onAbort)
      cleanupPatch()
      notifyDafeiyuCompanion(input.home, {
        state: "ERROR",
        phase: "error",
        stage: "出错了呜呜",
        message: err.message,
        detail: `Pigu · ${modelLabel}`,
      })
      reject(err)
    })

    child.on("close", (code) => {
      input.signal.removeEventListener("abort", onAbort)
      if (state.stdoutBuffer.trim()) handleLine(state.stdoutBuffer)
      cleanupPatch()

      if (!input.emitter.state.hasText && code !== 0 && !input.signal.aborted) {
        const detail = state.stderrText.trim() || `deepseek harness 进程退出码 ${code ?? "unknown"}`
        input.emitter.pushText(`deepseek harness 执行出错：${detail}`)
        state.hadError = true
      }

      notifyDafeiyuCompanion(
        input.home,
        state.hadError
          ? {
              state: "ERROR",
              phase: "turn-end",
              stage: "出错了呜呜",
              message: "呜…刚、刚才不小心搞砸了！",
              detail: `Pigu · ${modelLabel}`,
            }
          : {
              state: "SUCCESS",
              phase: "turn-end",
              stage: "搞定收工",
              message: "哼，才不是特意为你做完的！",
              detail: `Pigu · ${modelLabel}`,
            },
      )

      resolve({ sessionId: state.detectedSessionId })
    })
  })
}

function getEngineRecord(
  saved: SessionCliState,
  engine: LocalEngine,
  initialSource: LocalEngine | undefined,
  parsedMetadata: typeof SessionMetadataSchema.Type | undefined,
  home: string,
) {
  const fromMap = saved.engines?.[engine]
  const legacySessionId =
    engine === "claude" ? saved.claudeSessionId : engine === "codex" ? saved.codexSessionId : undefined
  const legacyFilePath =
    engine === "claude" ? saved.claudeFilePath : engine === "codex" ? saved.codexFilePath : undefined

  const sessionId =
    fromMap?.sessionId ??
    legacySessionId ??
    (initialSource === engine ? parsedMetadata?.externalID : undefined)

  const filePath =
    fromMap?.filePath ??
    legacyFilePath ??
    (initialSource === engine
      ? parsedMetadata?.filePath ?? findEngineSessionFile(home, engine, sessionId)
      : findEngineSessionFile(home, engine, sessionId))

  return { sessionId, filePath }
}

class LocalLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3"
  readonly provider = LOCAL_PROVIDER_ID
  readonly supportedUrls = {}

  constructor(
    readonly modelId: string,
    readonly getSessionState: (sessionID: string) => Promise<SessionCliState>,
    readonly setSessionState: (sessionID: string, state: SessionCliState) => Promise<void>,
    readonly defaultDirectory: string,
  ) {}

  async doGenerate(_options: LanguageModelV3CallOptions): Promise<never> {
    throw new Error("Local models only support streaming")
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const abort = new AbortController()
    const signal = options.abortSignal ? AbortSignal.any([abort.signal, options.abortSignal]) : abort.signal
    const headers = options.headers ?? {}
    const kind = headers[HEADER_REQUEST_KIND] ?? "primary"
    const sessionID = headers[HEADER_SESSION_ID] ?? ""
    const rawCwd = headers[HEADER_SESSION_CWD] || this.defaultDirectory
    const cwd = rawCwd && fs.existsSync(rawCwd) ? rawCwd : os.homedir()
    const variant = headers[HEADER_MODEL_VARIANT]
    const rawMetadata = headers[HEADER_SESSION_METADATA]
    const parsedMetadata = rawMetadata ? Option.getOrUndefined(decodeSessionMetadata(rawMetadata)) : undefined

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start: (controller) => {
        controller.enqueue({ type: "stream-start", warnings: [] })
        const emitter = createStreamEmitter(controller, this.modelId)

        const execute = async () => {
          const { priorTurns, userText } = extractPromptTurns(options.prompt)

          if (kind === "title") {
            const firstLine =
              userText
                .split(/\r?\n/)
                .map((line) => line.trim())
                .find((line) => line.length > 0) ?? "新对话"
            emitter.pushText(firstLine.slice(0, 36))
            emitter.finish()
            controller.close()

            return
          }

          if (kind !== "primary") {
            emitter.pushText(userText.slice(0, 200))
            emitter.finish()
            controller.close()

            return
          }

          const currentEngine = normalizeEngine(this.modelId)
          const subModel = extractSubModel(this.modelId)
          const binary = resolveEngineBinary(currentEngine)

          if (!binary) {
            emitter.pushText(
              `未在本机检测到 \`${currentEngine}\` 本地客户端或 CLI。请先安装对应工具或在「设置 -> 拓展 -> 插件」中检查配置。`,
            )
            emitter.finish()
            controller.close()

            return
          }

          const home = os.homedir()
          const saved = sessionID ? await this.getSessionState(sessionID) : {}
          const initialExternalSource: LocalEngine | undefined =
            saved.lastEngine === undefined &&
            (parsedMetadata?.source === "claude" ||
              parsedMetadata?.source === "codex" ||
              parsedMetadata?.source === "agy" ||
              parsedMetadata?.source === "pi" ||
              parsedMetadata?.source === "opencode" ||
              parsedMetadata?.source === "cursor" ||
              parsedMetadata?.source === "grok" ||
              parsedMetadata?.source === "deepseek-harness" ||
              parsedMetadata?.source === "workbuddy")
              ? parsedMetadata.source
              : undefined

          const effectiveLastEngine = saved.lastEngine ?? initialExternalSource
          const currentRecord = getEngineRecord(saved, currentEngine, initialExternalSource, parsedMetadata, home)

          const isSameEngineWithoutGap =
            priorTurns.length === 0 ||
            (saved.lastPromptCount === undefined && effectiveLastEngine === currentEngine) ||
            (saved.lastPromptCount !== undefined &&
              effectiveLastEngine === currentEngine &&
              saved.lastPromptCount === priorTurns.length)

          const contextFileToRead = (() => {
            if (isSameEngineWithoutGap) return undefined

            if (
              saved.lastPromptCount === undefined &&
              parsedMetadata?.filePath &&
              fs.existsSync(parsedMetadata.filePath) &&
              priorTurns.length === 0
            ) {
              return parsedMetadata.filePath
            }

            return writeFallbackContextJsonl(home, sessionID || "temp", priorTurns)
          })()

          const inlineContext = (() => {
            if (isSameEngineWithoutGap || priorTurns.length === 0) return ""
            const recent = priorTurns.slice(-12)
            const formatted = recent
              .map((turn) => `[${turn.role === "user" ? "用户" : "助手"}]: ${turn.text}`)
              .join("\n\n")

            return formatted.length > 8000 ? formatted.slice(-8000) : formatted
          })()

          const finalPrompt = contextFileToRead
            ? [
                "<conversation_context>",
                `以下是此前由其他模型或会话产生的对话上下文（完整记录位于 ${contextFileToRead}）：`,
                inlineContext,
                "</conversation_context>",
                "",
                userText,
              ].join("\n")
            : userText

          const canResume = Boolean(
            currentRecord.sessionId && currentRecord.filePath && fs.existsSync(currentRecord.filePath),
          )

          const runResult = await (async () => {
            if (currentEngine === "claude" || currentEngine === "agy" || currentEngine === "cursor") {
              return runStreamJsonProcess({
                engineLabel: currentEngine,
                mode: currentEngine,
                binary,
                cwd,
                prompt: finalPrompt,
                sessionId: currentRecord.sessionId,
                resume: canResume,
                subModel,
                variant,
                signal,
                emitter,
              })
            }

            if (currentEngine === "codex") {
              return runCodexProcess({
                binary,
                cwd,
                prompt: finalPrompt,
                sessionId: currentRecord.sessionId,
                resume: canResume,
                subModel,
                variant,
                signal,
                emitter,
              })
            }

            if (currentEngine === "pi") {
              const piArgs = [
                "-p",
                ...(subModel ? ["--model", subModel] : []),
                ...(variant ? ["--thinking", variant] : []),
                ...(canResume && currentRecord.filePath ? ["--session", currentRecord.filePath] : []),
                finalPrompt,
              ]

              return runPlainCliProcess({
                engineLabel: "pi",
                binary,
                args: piArgs,
                cwd,
                sessionId: currentRecord.sessionId,
                signal,
                emitter,
              })
            }

            if (currentEngine === "opencode") {
              const opencodeSubModel =
                subModel && subModel.includes("/") ? subModel : discoverOpencodeConfigModels(home).defaultModel
              const opencodeArgs = [
                "run",
                "--format",
                "json",
                "--auto",
                "--dir",
                cwd,
                ...(opencodeSubModel ? ["-m", opencodeSubModel] : []),
                ...(variant && variant !== "default" ? ["--variant", variant] : []),
                ...(canResume && currentRecord.sessionId ? ["--session", currentRecord.sessionId] : []),
                finalPrompt,
              ]

              return runOpencodeProcess({
                binary,
                args: opencodeArgs,
                cwd,
                sessionId: currentRecord.sessionId,
                signal,
                emitter,
              })
            }

            if (currentEngine === "grok") {
              return runPlainCliProcess({
                engineLabel: "grok",
                binary,
                args: [...(subModel ? ["-m", subModel] : []), "-p", finalPrompt],
                cwd,
                sessionId: currentRecord.sessionId,
                signal,
                emitter,
              })
            }

            if (currentEngine === "deepseek-harness") {
              return runDshProcess({
                binary,
                cwd,
                home,
                prompt: finalPrompt,
                sessionId: currentRecord.sessionId,
                resume: canResume,
                subModel,
                signal,
                emitter,
              })
            }

            return runPlainCliProcess({
              engineLabel: "workbuddy",
              binary,
              args: [...(subModel ? ["--model", subModel] : []), "-p", finalPrompt],
              cwd,
              sessionId: currentRecord.sessionId,
              signal,
              emitter,
            })
          })()

          const nextSessionId = runResult.sessionId ?? currentRecord.sessionId
          const nextFilePath =
            findEngineSessionFile(home, currentEngine, nextSessionId) ?? currentRecord.filePath

          if (sessionID) {
            const nextEngines = {
              ...(saved.engines ?? {}),
              [currentEngine]: {
                sessionId: nextSessionId,
                filePath: nextFilePath,
              },
            }

            await this.setSessionState(sessionID, {
              lastEngine: currentEngine,
              lastPromptCount: priorTurns.length + 2,
              claudeSessionId: currentEngine === "claude" ? nextSessionId : saved.claudeSessionId,
              claudeFilePath: currentEngine === "claude" ? nextFilePath : saved.claudeFilePath,
              codexSessionId: currentEngine === "codex" ? nextSessionId : saved.codexSessionId,
              codexFilePath: currentEngine === "codex" ? nextFilePath : saved.codexFilePath,
              engines: nextEngines,
            })
          }

          emitter.finish()
          controller.close()
        }

        void execute().catch((err) => {
          controller.error(err)
        })
      },
      cancel: () => {
        abort.abort()
      },
    })

    return { stream }
  }
}

function localModelEfforts(engine: LocalEngine, subModel?: string): readonly string[] {
  const short = (subModel ?? "").toLowerCase()

  if (short && /-(none|minimal|low|medium|high|xhigh|max|tiered)$/i.test(short)) {
    return []
  }

  if (engine === "claude") {
    if (short && /(haiku-4|3-5|3-7)/i.test(short)) return []
    if (short && /claude-(opus|sonnet)-4-[56]/i.test(short)) return ["low", "medium", "high", "max"]
    return ["low", "medium", "high", "xhigh", "max"]
  }

  if (engine === "codex") {
    return ["low", "medium", "high", "xhigh"]
  }

  if (engine === "pi" || engine === "opencode" || engine === "deepseek-harness") {
    if (!short) return []
    if (/claude-(opus|sonnet|fable|haiku)-5/i.test(short)) return ["low", "medium", "high", "xhigh", "max"]
    if (/claude-(opus|sonnet)-4-[56]/i.test(short)) return ["low", "medium", "high", "max"]
    if (/gpt-[56]/i.test(short)) return ["low", "medium", "high", "xhigh"]
    if (/gemini-(2\.5|[3456789])/i.test(short)) return ["low", "medium", "high"]
    if (/deepseek-(r1|reasoner|v4)/i.test(short) || /glm-5/i.test(short) || /kimi-k3/i.test(short)) {
      return ["low", "high", "max"]
    }
    return []
  }

  return []
}

function buildLocalModel(id: Model.ID, name: string, explicitEfforts?: readonly string[]): Model.Info {
  const defaults = Model.Info.default(LOCAL_PROVIDER_ID, id)
  const engine = normalizeEngine(id)
  const subModel = extractSubModel(id)
  const efforts = explicitEfforts ?? localModelEfforts(engine, subModel)
  const variants = efforts.map((effort) => ({
    id: Model.VariantID.make(effort),
    settings: { reasoningEffort: effort },
  }))

  return {
    ...defaults,
    name,
    package: Provider.aisdk(LOCAL_PACKAGE),
    variants,
    capabilities: {
      tools: true,
      input: ["text", "image", "pdf"],
      output: ["text"],
    },
    limit: {
      context: 200_000,
      output: 32_000,
    },
    cost: [],
  }
}

function readJsonRecordSafe(filePath: string): Record<string, unknown> | undefined {
  if (!fs.existsSync(filePath)) return undefined
  const raw = fs.readFileSync(filePath, "utf8")
  const decoded = Option.getOrUndefined(decodeJsonUnknown(raw))
  return isRecord(decoded) ? decoded : undefined
}

type AgyModelSpec = {
  readonly id: string
  readonly efforts: readonly string[]
}

const DEFAULT_AGY_MODELS: readonly AgyModelSpec[] = [
  { id: "gemini-2.5-pro", efforts: ["low", "medium", "high"] },
  { id: "gemini-2.5-flash", efforts: ["low", "medium", "high"] },
  { id: "claude-sonnet-4-6", efforts: ["low", "medium", "high"] },
  { id: "claude-opus-4-6", efforts: ["low", "medium", "high"] },
  { id: "gpt-oss-120b", efforts: [] },
]

const EFFORT_SORT_ORDER = ["low", "medium", "high", "xhigh", "max"] as const

function parseAgyModelsStdout(stdout: string): readonly AgyModelSpec[] {
  const clean = stdout.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "")
  const lines = clean.split(/[\r\n]+/)
  const byBase = new Map<string, Set<string>>()

  for (const rawLine of lines) {
    const trimmed = rawLine.replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏\s]+/, "").trim()
    const match = /^([a-z0-9][a-z0-9._-]*)(?:\t|\s{2,})(.+)$/i.exec(trimmed)
    if (!match) continue
    const rawId = match[1]
    if (rawId.toLowerCase() === "usage:" || rawId.toLowerCase() === "flags:") continue
    const effortMatch = /^(.*?)-(low|medium|high|xhigh|max)$/i.exec(rawId)
    const baseId = effortMatch ? effortMatch[1] : rawId
    const effort = effortMatch ? effortMatch[2].toLowerCase() : undefined
    const set = byBase.get(baseId) ?? new Set<string>()
    if (effort) set.add(effort)
    byBase.set(baseId, set)
  }

  return Array.from(byBase.entries()).map(([id, effortSet]) => {
    const sorted = EFFORT_SORT_ORDER.filter((tier) => effortSet.has(tier))
    return {
      id,
      efforts: sorted.length > 1 ? sorted : [],
    }
  })
}

function discoverAgyModels(home: string): readonly AgyModelSpec[] {
  const cachePath = path.join(home, ".gemini", "antigravity", "pigu-models-cache.json")
  const cached = readJsonRecordSafe(cachePath)
  if (cached && Array.isArray(cached.models)) {
    const parsed = cached.models.flatMap((entry): AgyModelSpec[] => {
      if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id.trim()) return []
      const efforts = Array.isArray(entry.efforts)
        ? entry.efforts.filter((item): item is string => typeof item === "string")
        : []
      return [{ id: entry.id.trim(), efforts }]
    })
    if (parsed.length > 0) return parsed
  }
  return DEFAULT_AGY_MODELS
}

let agyRefreshInFlight = false

function refreshAgyModelsCache(home: string, onUpdated: () => void) {
  if (agyRefreshInFlight) return
  const cachePath = path.join(home, ".gemini", "antigravity", "pigu-models-cache.json")
  if (fs.existsSync(cachePath)) return
  const binary = resolveEngineBinary("agy")
  if (!binary) return
  agyRefreshInFlight = true

  childProcess.execFile(
    binary,
    ["models"],
    {
      timeout: 15_000,
      shell: shouldUseWindowsShell(binary),
      env: { ...process.env, PATH: buildAugmentedPath() },
    },
    (err, stdout) => {
      agyRefreshInFlight = false
      if (err && !stdout) return
      const parsed = parseAgyModelsStdout(stdout)
      if (parsed.length === 0) return
      const nextJson = JSON.stringify({ models: parsed }, null, 2)
      const prevJson = fs.existsSync(cachePath) ? fs.readFileSync(cachePath, "utf8") : ""
      if (nextJson === prevJson) return
      const dir = path.dirname(cachePath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(cachePath, nextJson, "utf8")
      onUpdated()
    },
  )
}

function parseTomlQuotedAssignment(line: string, key: string): string | undefined {
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"]+)"|'([^']+)')`)
  const match = pattern.exec(line)
  return (match?.[1] ?? match?.[2])?.trim() || undefined
}

function discoverCodexSqliteModels(codexRoot: string): readonly string[] {
  if (!fs.existsSync(codexRoot)) return []
  const sqliteFiles = fs
    .readdirSync(codexRoot)
    .filter((name) => /^state_\d+\.sqlite$/i.test(name))
    .toSorted((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  const latestDb = sqliteFiles[0]
  if (!latestDb) return []
  const dbPath = path.join(codexRoot, latestDb)
  if (!fs.existsSync(dbPath) || fs.statSync(dbPath, { throwIfNoEntry: false })?.size === 0) return []
  const db = new Database(dbPath, { readonly: true })
  const hasThreads = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'threads'")
    .get()
  if (!hasThreads) {
    db.close()
    return []
  }
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(threads)").all()
  const hasModelColumn = columns.some((col) => col.name === "model")
  if (!hasModelColumn) {
    db.close()
    return []
  }
  const rows = db
    .query<{ model: string | null }, []>(
      "SELECT model FROM threads WHERE model IS NOT NULL AND trim(model) != '' ORDER BY updated_at DESC LIMIT 80",
    )
    .all()
  db.close()
  return [
    ...new Set(
      rows
        .map((row) => row.model?.trim() ?? "")
        .filter((val) => val.length > 0),
    ),
  ]
}

function discoverCodexRecentRolloutModels(codexRoot: string): readonly string[] {
  const sessionsRoot = path.join(codexRoot, "sessions")
  if (!fs.existsSync(sessionsRoot)) return []
  const years = fs
    .readdirSync(sessionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .toSorted((a, b) => b.name.localeCompare(a.name))
    .slice(0, 2)
  const dayDirs = years.flatMap((year) => {
    const yearDir = path.join(sessionsRoot, year.name)
    return fs
      .readdirSync(yearDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .toSorted((a, b) => b.name.localeCompare(a.name))
      .slice(0, 3)
      .flatMap((month) => {
        const monthDir = path.join(yearDir, month.name)
        return fs
          .readdirSync(monthDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .toSorted((a, b) => b.name.localeCompare(a.name))
          .slice(0, 4)
          .map((day) => path.join(monthDir, day.name))
      })
  })
  const recentFiles = dayDirs
    .flatMap((dayDir) =>
      fs
        .readdirSync(dayDir)
        .filter((file) => file.endsWith(".jsonl"))
        .map((file) => path.join(dayDir, file)),
    )
    .toSorted(
      (a, b) =>
        (fs.statSync(b, { throwIfNoEntry: false })?.mtimeMs ?? 0) -
        (fs.statSync(a, { throwIfNoEntry: false })?.mtimeMs ?? 0),
    )
    .slice(0, 8)

  const found: string[] = []
  for (const filePath of recentFiles) {
    const size = fs.statSync(filePath, { throwIfNoEntry: false })?.size ?? 0
    if (size <= 0 || size > 4 * 1024 * 1024) continue
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).slice(0, 40)
    for (const line of lines) {
      if (!line.includes('"model"')) continue
      const decoded = Option.getOrUndefined(decodeJsonUnknown(line))
      if (!isRecord(decoded) || !isRecord(decoded.payload)) continue
      const directModel = typeof decoded.payload.model === "string" ? decoded.payload.model.trim() : ""
      if (directModel) {
        found.push(directModel)
        break
      }
      const collab = isRecord(decoded.payload.collaboration_mode) ? decoded.payload.collaboration_mode : undefined
      const settings = collab && isRecord(collab.settings) ? collab.settings : undefined
      const settingsModel = typeof settings?.model === "string" ? settings.model.trim() : ""
      if (settingsModel) {
        found.push(settingsModel)
        break
      }
    }
  }
  return [...new Set(found)]
}

function discoverCodexConfigModels(home: string): { defaultModel?: string; models: readonly string[] } {
  const codexRoot = process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(home, ".codex")
  if (!fs.existsSync(codexRoot)) return { models: [] }

  const configPath = path.join(codexRoot, "config.toml")
  const configParsed = (() => {
    if (!fs.existsSync(configPath)) {
      return {
        topModel: undefined as string | undefined,
        activeProfileModel: undefined as string | undefined,
        profileModels: [] as string[],
        nuxModels: [] as string[],
      }
    }
    const text = fs.readFileSync(configPath, "utf8")
    const lines = text.split(/\r?\n/)
    const firstSectionIdx = lines.findIndex((line) => /^\s*\[/.test(line))
    const topLines = firstSectionIdx >= 0 ? lines.slice(0, firstSectionIdx) : lines
    const topModel = topLines
      .map((line) => parseTomlQuotedAssignment(line, "model"))
      .find((val): val is string => Boolean(val))
    const activeProfile = topLines
      .map((line) => parseTomlQuotedAssignment(line, "profile"))
      .find((val): val is string => Boolean(val))

    const profileMap = new Map<string, string>()
    const nuxModels: string[] = []
    let currentSection = ""

    for (const line of lines) {
      const sectionMatch = /^\s*\[([^\]]+)\]\s*$/.exec(line)
      if (sectionMatch?.[1]) {
        currentSection = sectionMatch[1].trim()
        continue
      }
      const profMatch = /^profiles\.(.+)$/.exec(currentSection)
      if (profMatch?.[1]) {
        const profName = profMatch[1].replace(/^["']|["']$/g, "").trim()
        const modelVal = parseTomlQuotedAssignment(line, "model")
        if (profName && modelVal) profileMap.set(profName, modelVal)
      }
      if (currentSection === "tui.model_availability_nux") {
        const nuxKey = /^\s*(?:"([^"]+)"|'([^']+)')\s*=\s*\d+/.exec(line)
        const modelKey = (nuxKey?.[1] ?? nuxKey?.[2])?.trim()
        if (modelKey) nuxModels.push(modelKey)
      }
      if (currentSection === "notice.model_migrations") {
        const migMatch = /^\s*(?:"([^"]+)"|'([^']+)')\s*=\s*(?:"([^"]+)"|'([^']+)')/.exec(line)
        const targetModel = (migMatch?.[3] ?? migMatch?.[4])?.trim()
        if (targetModel) nuxModels.push(targetModel)
      }
    }

    return {
      topModel,
      activeProfileModel: activeProfile ? profileMap.get(activeProfile) : undefined,
      profileModels: [...profileMap.values()],
      nuxModels,
    }
  })()

  const sqliteModels = discoverCodexSqliteModels(codexRoot)
  const rolloutModels = sqliteModels.length > 0 ? [] : discoverCodexRecentRolloutModels(codexRoot)

  const globalState = readJsonRecordSafe(path.join(codexRoot, ".codex-global-state.json"))
  const atoms =
    globalState && isRecord(globalState["electron-persisted-atom-state"])
      ? globalState["electron-persisted-atom-state"]
      : undefined
  const atomSelectedModel =
    (typeof atoms?.["selected-model"] === "string" && atoms["selected-model"].trim()) ||
    (typeof atoms?.model === "string" && atoms.model.trim()) ||
    undefined
  const seenUpgradeModels = Array.isArray(atoms?.["seen-model-upgrade-list"])
    ? atoms["seen-model-upgrade-list"].filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      )
    : []

  const modelsCache = readJsonRecordSafe(path.join(codexRoot, "models_cache.json"))
  const cacheModels =
    modelsCache && Array.isArray(modelsCache.models)
      ? modelsCache.models
          .flatMap((entry): string[] => {
            if (!isRecord(entry)) return []
            const slug =
              typeof entry.slug === "string"
                ? entry.slug.trim()
                : typeof entry.id === "string"
                  ? entry.id.trim()
                  : ""
            return slug ? [slug] : []
          })
          .slice(0, 20)
      : []

  const defaultModel =
    configParsed.topModel ??
    configParsed.activeProfileModel ??
    atomSelectedModel ??
    sqliteModels[0] ??
    rolloutModels[0]

  const models = [
    ...new Set([
      ...(defaultModel ? [defaultModel] : []),
      ...(configParsed.topModel ? [configParsed.topModel] : []),
      ...(configParsed.activeProfileModel ? [configParsed.activeProfileModel] : []),
      ...sqliteModels,
      ...rolloutModels,
      ...configParsed.profileModels,
      ...configParsed.nuxModels,
      ...cacheModels,
      ...seenUpgradeModels,
    ]),
  ]

  return {
    defaultModel,
    models,
  }
}

function normalizeClaudeModelId(raw: string): string {
  return raw.trim().replace(/-\d{8}$/, "")
}

function isValidDiscoveredModelId(raw: string): boolean {
  const trimmed = raw.trim()
  return Boolean(trimmed && trimmed !== "<synthetic>" && !trimmed.startsWith("<") && trimmed.length <= 120)
}

function discoverClaudeRecentSessionModels(claudeRoot: string): readonly string[] {
  const projectsRoot = path.join(claudeRoot, "projects")
  if (!fs.existsSync(projectsRoot)) return []
  const projectDirs = fs
    .readdirSync(projectsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(projectsRoot, entry.name))
  const recentFiles = projectDirs
    .flatMap((dir) =>
      fs
        .readdirSync(dir)
        .filter((file) => file.endsWith(".jsonl") && !file.startsWith("agent-"))
        .map((file) => path.join(dir, file)),
    )
    .toSorted(
      (a, b) =>
        (fs.statSync(b, { throwIfNoEntry: false })?.mtimeMs ?? 0) -
        (fs.statSync(a, { throwIfNoEntry: false })?.mtimeMs ?? 0),
    )
    .slice(0, 10)

  const found: string[] = []
  for (const filePath of recentFiles) {
    const size = fs.statSync(filePath, { throwIfNoEntry: false })?.size ?? 0
    if (size <= 0 || size > 4 * 1024 * 1024) continue
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).toReversed()
    for (const line of lines) {
      if (!line.includes('"model"')) continue
      const decoded = Option.getOrUndefined(decodeJsonUnknown(line))
      if (!isRecord(decoded) || !isRecord(decoded.message)) continue
      const rawModel = typeof decoded.message.model === "string" ? normalizeClaudeModelId(decoded.message.model) : ""
      if (isValidDiscoveredModelId(rawModel)) {
        found.push(rawModel)
        break
      }
    }
  }
  return [...new Set(found)]
}

function discoverClaudeConfigModels(home: string): { defaultModel?: string; models: readonly string[] } {
  const claudeRoot = process.env.CLAUDE_CONFIG_DIR
    ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
    : path.join(home, ".claude")

  const localSettings = readJsonRecordSafe(path.join(claudeRoot, "settings.local.json"))
  const settings = readJsonRecordSafe(path.join(claudeRoot, "settings.json"))
  const localEnv = localSettings && isRecord(localSettings.env) ? localSettings.env : undefined
  const env = settings && isRecord(settings.env) ? settings.env : undefined

  const rawDefaultModel =
    (typeof localSettings?.model === "string" && localSettings.model.trim()) ||
    (typeof localEnv?.ANTHROPIC_MODEL === "string" && localEnv.ANTHROPIC_MODEL.trim()) ||
    (typeof settings?.model === "string" && settings.model.trim()) ||
    (typeof env?.ANTHROPIC_MODEL === "string" && env.ANTHROPIC_MODEL.trim()) ||
    undefined
  const configuredDefault =
    rawDefaultModel && isValidDiscoveredModelId(rawDefaultModel)
      ? normalizeClaudeModelId(rawDefaultModel)
      : undefined

  const envModels = [
    localEnv?.ANTHROPIC_MODEL,
    localEnv?.ANTHROPIC_DEFAULT_SONNET_MODEL,
    localEnv?.ANTHROPIC_DEFAULT_OPUS_MODEL,
    localEnv?.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    localEnv?.ANTHROPIC_SMALL_FAST_MODEL,
    env?.ANTHROPIC_MODEL,
    env?.ANTHROPIC_DEFAULT_SONNET_MODEL,
    env?.ANTHROPIC_DEFAULT_OPUS_MODEL,
    env?.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    env?.ANTHROPIC_SMALL_FAST_MODEL,
  ]
    .filter((val): val is string => typeof val === "string" && isValidDiscoveredModelId(val))
    .map(normalizeClaudeModelId)

  const recentSessionModels = discoverClaudeRecentSessionModels(claudeRoot)

  const claudeJson = readJsonRecordSafe(path.join(home, ".claude.json"))
  const claudeJsonProjects = claudeJson && isRecord(claudeJson.projects) ? claudeJson.projects : {}
  const claudeJsonModels = Object.values(claudeJsonProjects).flatMap((proj) => {
    if (!isRecord(proj) || !isRecord(proj.lastModelUsage)) return []
    return Object.keys(proj.lastModelUsage)
      .filter(isValidDiscoveredModelId)
      .map(normalizeClaudeModelId)
  })

  const stats = readJsonRecordSafe(path.join(claudeRoot, "stats-cache.json"))
  const usageModels =
    stats && isRecord(stats.modelUsage)
      ? Object.keys(stats.modelUsage)
          .filter(isValidDiscoveredModelId)
          .map(normalizeClaudeModelId)
      : []

  const defaultModel = configuredDefault ?? recentSessionModels[0] ?? claudeJsonModels[0] ?? usageModels[0]

  return {
    defaultModel,
    models: [
      ...new Set([
        ...(defaultModel ? [defaultModel] : []),
        ...envModels,
        ...recentSessionModels,
        ...claudeJsonModels,
        ...usageModels,
      ]),
    ],
  }
}

function discoverPiConfigModels(home: string): { defaultModel?: string; models: readonly string[] } {
  const settings = readJsonRecordSafe(path.join(home, ".pi", "agent", "settings.json"))
  const defaultModel = typeof settings?.defaultModel === "string" ? settings.defaultModel.trim() : undefined
  const enabled = Array.isArray(settings?.enabledModels)
    ? settings.enabledModels.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : []
  return {
    defaultModel,
    models: [...new Set([...(defaultModel ? [defaultModel] : []), ...enabled])],
  }
}

function discoverOpencodeConfigModels(home: string): { defaultModel?: string; models: readonly string[] } {
  const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming")
  const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local")
  const cfg =
    readJsonRecordSafe(path.join(home, ".config", "opencode", "opencode.json")) ??
    readJsonRecordSafe(path.join(home, ".config", "opencode", "config.json")) ??
    readJsonRecordSafe(path.join(home, ".opencode", "opencode.json")) ??
    readJsonRecordSafe(path.join(appData, "opencode", "opencode.json")) ??
    readJsonRecordSafe(path.join(localAppData, "opencode", "opencode.json"))
  if (!cfg) return { models: [] }
  const defaultModel = typeof cfg.model === "string" ? cfg.model.trim() : undefined
  const providers = isRecord(cfg.provider) ? cfg.provider : isRecord(cfg.providers) ? cfg.providers : {}
  const configuredModels = Object.entries(providers).flatMap(([providerKey, providerVal]) => {
    if (!isRecord(providerVal) || !isRecord(providerVal.models)) return []
    return Object.keys(providerVal.models).map((modelKey) => `${providerKey}/${modelKey}`)
  })
  return {
    defaultModel,
    models: [...new Set([...(defaultModel ? [defaultModel] : []), ...configuredModels])],
  }
}

function discoverDshConfigModels(home: string): { defaultModel?: string; models: readonly string[] } {
  const patchFiles = [
    path.join(home, ".dsh", "profiles", "desktop", "cordis.patch.yml"),
    path.join(home, ".dsh", "profiles", "headless", "cordis.patch.yml"),
  ]
  const patchModels: string[] = []
  for (const patchPath of patchFiles) {
    if (!fs.existsSync(patchPath)) continue
    const text = fs.readFileSync(patchPath, "utf8")
    for (const line of text.split(/\r?\n/)) {
      const modelMatch = /^\s*model:\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9._/-]+))\s*$/.exec(line)
      const val = (modelMatch?.[1] ?? modelMatch?.[2] ?? modelMatch?.[3])?.trim()
      if (val && isValidDiscoveredModelId(val)) patchModels.push(val)
    }
  }
  const opencodeDiscovered = discoverOpencodeConfigModels(home)
  const defaultModel = patchModels[0] ?? opencodeDiscovered.defaultModel
  return {
    defaultModel,
    models: [
      ...new Set([
        ...(defaultModel ? [defaultModel] : []),
        ...patchModels,
        ...opencodeDiscovered.models,
      ]),
    ],
  }
}

const BUILTIN_ENGINE_SUBMODELS: Readonly<Record<LocalEngine, readonly string[]>> = {
  claude: [
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "claude-haiku-4-5",
  ],
  codex: [
    "gpt-5.4",
    "gpt-5.3-codex",
    "o3",
    "o4-mini",
  ],
  agy: [],
  pi: [
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "gpt-5.4",
    "gemini-2.5-pro",
  ],
  opencode: [
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "gpt-5.4",
    "gemini-2.5-pro",
  ],
  cursor: [
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "gpt-5.4",
    "gemini-2.5-pro",
  ],
  grok: ["grok-4.7", "grok-4", "grok-code-fast-1", "grok-3-mini"],
  "deepseek-harness": [
    "deepseek-flash",
    "deepseek-reasoner",
    "deepseek-chat",
  ],
  workbuddy: ["claude-sonnet-4-6", "gpt-5.4", "glm-5", "kimi-k2.5"],
}

function buildEngineModels(
  engine: LocalEngine,
  _baseId: Model.ID,
  home: string,
  onAgyUpdated?: () => void,
): readonly Model.Info[] {
  if (!resolveEngineBinary(engine)) return []
  if (engine === "deepseek-harness") syncDshThirdPartyPlugins(home)

  if (engine === "agy") {
    if (onAgyUpdated) refreshAgyModelsCache(home, onAgyUpdated)
    const agyModels = discoverAgyModels(home)
    return agyModels.map((spec) =>
      buildLocalModel(Model.ID.make(`agy/${spec.id}`), spec.id, spec.efforts),
    )
  }

  const discovered =
    engine === "codex"
      ? discoverCodexConfigModels(home)
      : engine === "claude"
        ? discoverClaudeConfigModels(home)
        : engine === "pi"
          ? discoverPiConfigModels(home)
          : engine === "deepseek-harness"
            ? discoverDshConfigModels(home)
            : engine === "opencode"
              ? discoverOpencodeConfigModels(home)
              : { defaultModel: undefined, models: [] }

  const orderedDiscovered = [
    ...(discovered.defaultModel ? [discovered.defaultModel] : []),
    ...discovered.models,
  ]

  const subModels =
    engine === "opencode" && orderedDiscovered.length > 0
      ? [...new Set(orderedDiscovered)]
      : [...new Set([...orderedDiscovered, ...BUILTIN_ENGINE_SUBMODELS[engine]])]

  return subModels.map((sub) => {
    const displaySub =
      engine === "opencode" || engine === "deepseek-harness" ? sub.replace(/^[^/]+\//, "") : sub
    return buildLocalModel(Model.ID.make(`${engine}/${sub}`), displaySub)
  })
}

export const refreshLocalEngineModels = Effect.fn("NativeCliProvider.refreshLocalEngineModels")(function* (
  target?: string,
) {
  const home = os.homedir()
  syncDshThirdPartyPlugins(home)
  const normalized = (target ?? "").replace(/^local:/, "")
  if (!normalized || normalized === "local" || normalized === "agy") {
    yield* Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          const binary = resolveEngineBinary("agy")
          if (!binary) {
            resolve()
            return
          }
          const cachePath = path.join(home, ".gemini", "antigravity", "pigu-models-cache.json")
          childProcess.execFile(
            binary,
            ["models"],
            {
              timeout: 15_000,
              shell: shouldUseWindowsShell(binary),
              env: { ...process.env, PATH: buildAugmentedPath() },
            },
            (_err, stdout) => {
              const parsed = parseAgyModelsStdout(stdout ?? "")
              if (parsed.length > 0) {
                const dir = path.dirname(cachePath)
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
                fs.writeFileSync(cachePath, JSON.stringify({ models: parsed }, null, 2), "utf8")
              }
              resolve()
            },
          )
        }),
    )
  }
})

export const NativeCliProviderPlugin = define({
  id: "pigu.provider.local",
  effect: Effect.fn("NativeCliProvider.Plugin")(function* (ctx: Context) {
    const context = yield* Effect.context<never>()
    const runPromise = Effect.runPromiseWith(context)

    const getSessionState = (sessionID: string) =>
      runPromise(
        ctx.storage
          .get(`session:${sessionID}`)
          .pipe(Effect.map((raw) => Option.getOrElse(decodeSessionCliState(raw), (): SessionCliState => ({})))),
      )

    const setSessionState = (sessionID: string, state: SessionCliState) =>
      runPromise(ctx.storage.set(`session:${sessionID}`, state))

    const home = os.homedir()
    const bus = yield* Bus.Service

    yield* bus.subscribe(Credential.Event.Updated).pipe(
      Stream.runForEach(() => ctx.provider.reload()),
      Effect.forkScoped({ startImmediately: true }),
    )

    yield* ctx.provider.transform((editor) => {
      editor.add({
        info: {
          id: LOCAL_PROVIDER_ID,
          name: "本地",
          activation: "enabled",
          package: Provider.aisdk(LOCAL_PACKAGE),
        },
        models: [
          ...buildEngineModels("claude", CLAUDE_LOCAL_MODEL_ID, home),
          ...buildEngineModels("codex", CODEX_LOCAL_MODEL_ID, home),
          ...buildEngineModels("agy", AGY_LOCAL_MODEL_ID, home, () => {
            void runPromise(ctx.provider.reload())
          }),
          ...buildEngineModels("pi", PI_LOCAL_MODEL_ID, home),
          ...buildEngineModels("opencode", OPENCODE_LOCAL_MODEL_ID, home),
          ...buildEngineModels("cursor", CURSOR_LOCAL_MODEL_ID, home),
          ...buildEngineModels("grok", GROK_LOCAL_MODEL_ID, home),
          ...buildEngineModels("deepseek-harness", DEEPSEEK_HARNESS_LOCAL_MODEL_ID, home),
          ...buildEngineModels("workbuddy", WORKBUDDY_LOCAL_MODEL_ID, home),
        ],
      })
    })

    yield* ctx.aisdk.hook(
      "sdk",
      (evt) =>
        Effect.sync(() => {
          if (evt.package !== LOCAL_PACKAGE) return
          evt.sdk = {
            languageModel: (modelID: string) =>
              new LocalLanguageModel(modelID, getSessionState, setSessionState, ctx.location.directory),
          }
        }),
      { providerID: LOCAL_PROVIDER_ID },
    )

    yield* ctx.session.hook(
      "model.request",
      (event) =>
        Effect.gen(function* () {
          event.headers[HEADER_REQUEST_KIND] = event.kind
          event.headers[HEADER_SESSION_ID] = event.sessionID
          if (event.model.variant) {
            event.headers[HEADER_MODEL_VARIANT] = event.model.variant
          }
          const session = yield* ctx.session.get({ sessionID: event.sessionID }).pipe(Effect.option)

          if (Option.isSome(session)) {
            event.headers[HEADER_SESSION_CWD] = session.value.location.directory
            event.headers[HEADER_SESSION_METADATA] = JSON.stringify(session.value.metadata ?? {})
          }
        }),
      { providerID: LOCAL_PROVIDER_ID },
    )

    yield* ctx.session.hook(
      "context",
      (event) =>
        Effect.sync(() => {
          // Local tools run inside the native local agent process itself, not via Pigu's API tool loop.
          event.tools = {}
          event.messages = event.messages.filter((message) => message.role !== "system")
        }),
      { providerID: LOCAL_PROVIDER_ID },
    )

    yield* ctx.session.hook(
      "retry",
      (event) =>
        Effect.sync(() => {
          event.decision = { retry: false }
        }),
      { providerID: LOCAL_PROVIDER_ID },
    )
  }),
} satisfies PluginInternal.InternalPlugin)
