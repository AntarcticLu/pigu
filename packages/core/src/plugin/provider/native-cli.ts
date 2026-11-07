export * as NativeCliProvider from "./native-cli.js"

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
import { Effect, Option, Schema } from "effect"
import { Model } from "../../model.js"
import { Provider } from "../../provider.js"
import type { PluginInternal } from "../internal.js"

export const LOCAL_PROVIDER_ID = Provider.ID.make("local")
export const NATIVE_CLI_PROVIDER_ID = LOCAL_PROVIDER_ID
export const LOCAL_PACKAGE = "@opencode/local"

export const CLAUDE_LOCAL_MODEL_ID = Model.ID.make("claude")
export const CODEX_LOCAL_MODEL_ID = Model.ID.make("codex")
export const AGY_LOCAL_MODEL_ID = Model.ID.make("agy")
export const DEEPSEEK_HARNESS_LOCAL_MODEL_ID = Model.ID.make("deepseek-harness")
export const WORKBUDDY_LOCAL_MODEL_ID = Model.ID.make("workbuddy")

export type LocalEngine = "claude" | "codex" | "agy" | "deepseek-harness" | "workbuddy"

const HEADER_REQUEST_KIND = "x-opencode-request-kind"
const HEADER_SESSION_ID = "x-opencode-session-id"
const HEADER_SESSION_CWD = "x-pigu-session-cwd"
const HEADER_SESSION_METADATA = "x-pigu-session-metadata"

const EngineRecordSchema = Schema.Struct({
  sessionId: Schema.optional(Schema.String),
  filePath: Schema.optional(Schema.String),
})

const SessionCliStateSchema = Schema.Struct({
  lastEngine: Schema.optional(
    Schema.Literals(["claude", "codex", "agy", "deepseek-harness", "workbuddy"]),
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

  return [
    path.join(home, ".mounty", "AL", "node", "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, ".claude", "local"),
    path.join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ]
}

function appBundleRuntimeDirs() {
  const home = os.homedir()
  const appRoots = ["/Applications", path.join(home, "Applications")]

  return appRoots.flatMap((root) => [
    path.join(root, "Codex.app", "Contents", "Resources", "bin"),
    path.join(root, "Codex.app", "Contents", "Resources", "app", "bin"),
    path.join(root, "Claude.app", "Contents", "Resources", "bin"),
    path.join(root, "Claude.app", "Contents", "Resources", "app", "bin"),
    path.join(root, "Antigravity.app", "Contents", "Resources", "app", "bin"),
    path.join(root, "DeepSeek Harness.app", "Contents", "Resources", "runtime", "cli", "bin"),
    path.join(root, "DeepSeek Harness.app", "Contents", "Resources", "runtime", "bin"),
    path.join(root, "WorkBuddy.app", "Contents", "Resources", "runtime", "cli", "bin"),
    path.join(root, "WorkBuddy.app", "Contents", "Resources", "app", "bin"),
    path.join(root, "CodeBuddy.app", "Contents", "Resources", "runtime", "cli", "bin"),
    path.join(root, "CodeBuddy.app", "Contents", "Resources", "app", "bin"),
  ])
}

function buildAugmentedPath() {
  const existing = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
  const combined = [...new Set([...globalBinDirs(), ...appBundleRuntimeDirs(), ...existing])]

  return combined.join(path.delimiter)
}

function resolveGlobalExecutable(names: ReadonlyArray<string>) {
  const existing = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
  const dirs = [...new Set([...globalBinDirs(), ...existing])]
  const candidates = names.flatMap((name) => dirs.map((dir) => path.join(dir, name)))

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
  return appBundledCliCandidates(engine).find((candidate) => fs.existsSync(candidate))
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

  if (engine === "deepseek-harness") {
    return resolveGlobalExecutable(["dsh", "deepseek-harness"]) ?? resolveAppBundledCli("deepseek-harness")
  }

  return resolveGlobalExecutable(["workbuddy", "codebuddy"]) ?? resolveAppBundledCli("workbuddy")
}

function detectLocalDisplayLabel(engine: LocalEngine) {
  if (engine === "claude") {
    const hasGlobalCli = Boolean(resolveGlobalExecutable(["claude"]))
    const hasApp = fs.existsSync("/Applications/Claude.app") || Boolean(resolveAppBundledCli("claude"))
    const kind = !hasGlobalCli && hasApp ? "桌面端" : "CLI"

    return `claude (${kind})`
  }

  if (engine === "codex") {
    const hasGlobalCli = Boolean(resolveGlobalExecutable(["codex"]))
    const hasApp = fs.existsSync("/Applications/Codex.app") || Boolean(resolveAppBundledCli("codex"))
    const kind = !hasGlobalCli && hasApp ? "桌面端" : "CLI"

    return `codex (${kind})`
  }

  if (engine === "agy") {
    const hasApp = fs.existsSync("/Applications/Antigravity.app")
    const kind = hasApp ? "桌面端" : "CLI"

    return `agy (${kind})`
  }

  if (engine === "deepseek-harness") {
    const hasApp = fs.existsSync("/Applications/DeepSeek Harness.app")
    const kind = hasApp ? "桌面端" : "CLI"

    return `deepseek harness (${kind})`
  }

  const hasBuddyApp =
    fs.existsSync("/Applications/WorkBuddy.app") || fs.existsSync("/Applications/CodeBuddy.app")
  const hasBuddyCli = Boolean(resolveGlobalExecutable(["workbuddy", "codebuddy"]))
  const buddyKind = hasBuddyApp && !hasBuddyCli ? "桌面端" : "CLI"

  return `workbuddy (${buddyKind})`
}

function normalizeEngine(modelId: string): LocalEngine {
  if (modelId === "codex" || modelId === "codex-native") return "codex"

  if (modelId === "agy" || modelId === "agy-native") return "agy"

  if (modelId === "deepseek-harness" || modelId === "dsh") return "deepseek-harness"

  if (modelId === "workbuddy" || modelId === "codebuddy") return "workbuddy"

  return "claude"
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

function findDshSessionFile(home: string, sessionId: string) {
  const sessionsDir = path.join(home, ".dsh", "sessions")

  if (!fs.existsSync(sessionsDir)) return undefined
  const direct = path.join(sessionsDir, `${sessionId}.jsonl`)

  if (fs.existsSync(direct)) return direct
  const directJson = path.join(sessionsDir, `${sessionId}.json`)

  return fs.existsSync(directJson) ? directJson : undefined
}

function findEngineSessionFile(home: string, engine: LocalEngine, sessionId: string | undefined) {
  if (!sessionId) return undefined

  if (engine === "claude") return findClaudeSessionFile(home, sessionId)

  if (engine === "codex") return findCodexSessionFile(home, sessionId)

  if (engine === "agy") return findAgySessionFile(home, sessionId)

  if (engine === "deepseek-harness") return findDshSessionFile(home, sessionId)

  return undefined
}

function extractMessageText(message: LanguageModelV3Prompt[number]) {
  if (message.role === "system") return message.content.trim()

  return message.content
    .flatMap((part) => (part.type === "text" && part.text.trim() ? [part.text.trim()] : []))
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
  mode: "claude" | "agy"
  binary: string
  cwd: string
  prompt: string
  sessionId?: string
  resume: boolean
  signal: AbortSignal
  emitter: ReturnType<typeof createStreamEmitter>
}): Promise<{ sessionId?: string }> {
  const targetSessionId = input.sessionId ?? crypto.randomUUID()
  const sessionFlag =
    input.mode === "agy"
      ? input.resume && input.sessionId
        ? ["--conversation", input.sessionId]
        : []
      : input.resume
        ? ["--resume", targetSessionId]
        : ["--session-id", targetSessionId]

  const args =
    input.mode === "agy"
      ? [
          "--output-format",
          "stream-json",
          "--dangerously-skip-permissions",
          ...sessionFlag,
          "-p",
          input.prompt,
        ]
      : [
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
          "--include-partial-messages",
          "--dangerously-skip-permissions",
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
      stdio: ["ignore", "pipe", "pipe"],
    })

    const state = {
      detectedSessionId: input.sessionId ?? (input.mode === "claude" ? targetSessionId : undefined),
      streamedMessageIds: new Set<string>(),
      currentMessageId: "",
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

      if (Option.isNone(decoded) || !isRecord(decoded.value)) return
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
  signal: AbortSignal
  emitter: ReturnType<typeof createStreamEmitter>
}): Promise<{ sessionId?: string }> {
  const lastMsgFile = path.join(os.tmpdir(), `pigu-codex-last-${crypto.randomUUID()}.txt`)
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
          "-o",
          lastMsgFile,
        ]
      : [
          "exec",
          input.prompt,
          "--json",
          "--dangerously-bypass-approvals-and-sandbox",
          "--skip-git-repo-check",
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
    const cwd = headers[HEADER_SESSION_CWD] || this.defaultDirectory
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
              parsedMetadata?.source === "agy")
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

            if (effectiveLastEngine) {
              const prevRecord = getEngineRecord(saved, effectiveLastEngine, initialExternalSource, parsedMetadata, home)

              if (prevRecord.filePath && fs.existsSync(prevRecord.filePath)) {
                return prevRecord.filePath
              }
            }

            if (
              saved.lastPromptCount === undefined &&
              parsedMetadata?.filePath &&
              fs.existsSync(parsedMetadata.filePath)
            ) {
              return parsedMetadata.filePath
            }

            return writeFallbackContextJsonl(home, sessionID || "temp", priorTurns)
          })()

          const finalPrompt = contextFileToRead
            ? `请先使用文件读取工具读取会话记录文件 ${contextFileToRead} 以了解此前的对话上下文，然后继续处理以下请求：\n\n${userText}`
            : userText

          const canResume = Boolean(
            currentRecord.sessionId && currentRecord.filePath && fs.existsSync(currentRecord.filePath),
          )

          const runResult = await (async () => {
            if (currentEngine === "claude" || currentEngine === "agy") {
              return runStreamJsonProcess({
                engineLabel: currentEngine,
                mode: currentEngine,
                binary,
                cwd,
                prompt: finalPrompt,
                sessionId: currentRecord.sessionId,
                resume: canResume,
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
                signal,
                emitter,
              })
            }

            if (currentEngine === "deepseek-harness") {
              const dshArgs = [
                "--profile",
                "headless",
                ...(canResume && currentRecord.sessionId ? ["--session-id", currentRecord.sessionId] : []),
                finalPrompt,
              ]

              return runPlainCliProcess({
                engineLabel: "deepseek harness",
                binary,
                args: dshArgs,
                cwd,
                sessionId: currentRecord.sessionId,
                signal,
                emitter,
              })
            }

            return runPlainCliProcess({
              engineLabel: "workbuddy",
              binary,
              args: ["-p", finalPrompt],
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

function buildLocalModel(id: Model.ID, name: string): Model.Info {
  const defaults = Model.Info.default(LOCAL_PROVIDER_ID, id)

  return {
    ...defaults,
    name,
    package: Provider.aisdk(LOCAL_PACKAGE),
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

    yield* ctx.provider.transform((editor) => {
      editor.add({
        info: {
          id: LOCAL_PROVIDER_ID,
          name: "本地",
          activation: "enabled",
          package: Provider.aisdk(LOCAL_PACKAGE),
        },
        models: [
          buildLocalModel(CLAUDE_LOCAL_MODEL_ID, detectLocalDisplayLabel("claude")),
          buildLocalModel(CODEX_LOCAL_MODEL_ID, detectLocalDisplayLabel("codex")),
          buildLocalModel(AGY_LOCAL_MODEL_ID, detectLocalDisplayLabel("agy")),
          buildLocalModel(DEEPSEEK_HARNESS_LOCAL_MODEL_ID, detectLocalDisplayLabel("deepseek-harness")),
          buildLocalModel(WORKBUDDY_LOCAL_MODEL_ID, detectLocalDisplayLabel("workbuddy")),
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
