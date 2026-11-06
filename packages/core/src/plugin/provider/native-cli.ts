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

export const NATIVE_CLI_PROVIDER_ID = Provider.ID.make("native-cli")
export const NATIVE_CLI_PACKAGE = "@opencode/native-cli"
export const CLAUDE_NATIVE_MODEL_ID = Model.ID.make("claude-native")
export const CODEX_NATIVE_MODEL_ID = Model.ID.make("codex-native")

const HEADER_REQUEST_KIND = "x-opencode-request-kind"
const HEADER_SESSION_ID = "x-opencode-session-id"
const HEADER_SESSION_CWD = "x-pigu-session-cwd"
const HEADER_SESSION_METADATA = "x-pigu-session-metadata"

const SessionCliStateSchema = Schema.Struct({
  lastEngine: Schema.optional(Schema.Literals(["claude", "codex"])),
  lastPromptCount: Schema.optional(Schema.Number),
  claudeSessionId: Schema.optional(Schema.String),
  claudeFilePath: Schema.optional(Schema.String),
  codexSessionId: Schema.optional(Schema.String),
  codexFilePath: Schema.optional(Schema.String),
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

function extraBinDirs() {
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

function buildAugmentedPath() {
  const existing = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
  const combined = [... new Set([...extraBinDirs(), ...existing])]

  return combined.join(path.delimiter)
}

function resolveBinary(name: "claude" | "codex") {
  const dirs = buildAugmentedPath().split(path.delimiter).filter(Boolean)
  const found = dirs.map((dir) => path.join(dir, name)).find((candidate) => fs.existsSync(candidate))

  return found
}

function findClaudeSessionFile(home: string, sessionId: string) {
  const projectsRoot = path.join(home, ".claude", "projects")

  if (!fs.existsSync(projectsRoot)) return undefined
  const projectDirs = fs.readdirSync(projectsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())

  for (const dir of projectDirs) {
    const candidate = path.join(projectsRoot, dir.name, `${sessionId}.jsonl`)

    if (fs.existsSync(candidate)) return candidate
  }

  return undefined
}

function findCodexSessionFile(home: string, sessionId: string) {
  const sessionsRoot = path.join(home, ".codex", "sessions")

  if (!fs.existsSync(sessionsRoot)) return undefined
  const years = fs.readdirSync(sessionsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())

  for (const year of years.toSorted((a, b) => b.name.localeCompare(a.name))) {
    const yearDir = path.join(sessionsRoot, year.name)
    const months = fs.readdirSync(yearDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())

    for (const month of months.toSorted((a, b) => b.name.localeCompare(a.name))) {
      const monthDir = path.join(yearDir, month.name)
      const days = fs.readdirSync(monthDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())

      for (const day of days.toSorted((a, b) => b.name.localeCompare(a.name))) {
        const dayDir = path.join(monthDir, day.name)
        const files = fs.readdirSync(dayDir)
        const match = files.find((file) => file.endsWith(".jsonl") && file.includes(sessionId))

        if (match) return path.join(dayDir, match)
      }
    }
  }

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

function writeFallbackContextJsonl(home: string, sessionID: string, priorTurns: ReadonlyArray<{ role: string; text: string }>) {
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

async function runClaudeProcess(input: {
  binary: string
  cwd: string
  prompt: string
  sessionId?: string
  resume: boolean
  signal: AbortSignal
  emitter: ReturnType<typeof createStreamEmitter>
}): Promise<{ sessionId?: string }> {
  const targetSessionId = input.sessionId ?? crypto.randomUUID()
  const sessionFlag = input.resume ? ["--resume", targetSessionId] : ["--session-id", targetSessionId]
  const args = [
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
      detectedSessionId: input.sessionId ?? targetSessionId,
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
            input.emitter.pushReasoning(`\n[Claude 原生工具: ${part.name}]\n`)

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
        const detail = state.stderrText.trim() || `claude 进程退出码 ${code ?? "unknown"}`
        input.emitter.pushText(`Claude 原生 CLI 执行出错：${detail}`)
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
          input.emitter.pushReasoning(`\n[Codex 原生命令: ${item.command}]\n`)
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
          input.emitter.pushReasoning("\n[Codex 原生文件变更]\n")

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
        input.emitter.pushText(`Codex 原生 CLI 执行出错：${detail}`)
      }

      resolve({ sessionId: state.detectedSessionId })
    })
  })
}

class NativeCliLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3"
  readonly provider = NATIVE_CLI_PROVIDER_ID
  readonly supportedUrls = {}

  constructor(
    readonly modelId: string,
    readonly getSessionState: (sessionID: string) => Promise<SessionCliState>,
    readonly setSessionState: (sessionID: string, state: SessionCliState) => Promise<void>,
    readonly defaultDirectory: string,
  ) {}

  async doGenerate(_options: LanguageModelV3CallOptions): Promise<never> {
    throw new Error("Native CLI models only support streaming")
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

          const currentEngine: "claude" | "codex" = this.modelId === CODEX_NATIVE_MODEL_ID ? "codex" : "claude"
          const binary = resolveBinary(currentEngine)

          if (!binary) {
            const installHint =
              currentEngine === "claude"
                ? "未在本机检测到 `claude` CLI。请先安装 Claude Code 并在终端执行 `claude auth login` 登录您的订阅账号。"
                : "未在本机检测到 `codex` CLI。请先安装 Codex CLI 并在终端完成订阅登录。"
            emitter.pushText(installHint)
            emitter.finish()
            controller.close()

            return
          }

          const home = os.homedir()
          const saved = sessionID ? await this.getSessionState(sessionID) : {}
          const initialExternalSource =
            saved.lastEngine === undefined &&
            (parsedMetadata?.source === "claude" || parsedMetadata?.source === "codex")
              ? parsedMetadata.source
              : undefined

          const claudeSessionId =
            saved.claudeSessionId ??
            (initialExternalSource === "claude" ? parsedMetadata?.externalID : undefined)
          const codexSessionId =
            saved.codexSessionId ??
            (initialExternalSource === "codex" ? parsedMetadata?.externalID : undefined)

          const claudeFilePath =
            saved.claudeFilePath ??
            (initialExternalSource === "claude"
              ? parsedMetadata?.filePath ?? (claudeSessionId ? findClaudeSessionFile(home, claudeSessionId) : undefined)
              : claudeSessionId
                ? findClaudeSessionFile(home, claudeSessionId)
                : undefined)

          const codexFilePath =
            saved.codexFilePath ??
            (initialExternalSource === "codex"
              ? parsedMetadata?.filePath ?? (codexSessionId ? findCodexSessionFile(home, codexSessionId) : undefined)
              : codexSessionId
                ? findCodexSessionFile(home, codexSessionId)
                : undefined)

          const effectiveLastEngine = saved.lastEngine ?? initialExternalSource

          const isSameEngineWithoutGap =
            priorTurns.length === 0 ||
            (saved.lastPromptCount === undefined && effectiveLastEngine === currentEngine) ||
            (saved.lastPromptCount !== undefined &&
              effectiveLastEngine === currentEngine &&
              saved.lastPromptCount === priorTurns.length)

          const contextFileToRead = (() => {
            if (isSameEngineWithoutGap) return undefined

            if (effectiveLastEngine === "codex" && codexFilePath && fs.existsSync(codexFilePath)) {
              return codexFilePath
            }

            if (effectiveLastEngine === "claude" && claudeFilePath && fs.existsSync(claudeFilePath)) {
              return claudeFilePath
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

          if (currentEngine === "claude") {
            const canResume = Boolean(claudeSessionId && claudeFilePath && fs.existsSync(claudeFilePath))
            const result = await runClaudeProcess({
              binary,
              cwd,
              prompt: finalPrompt,
              sessionId: claudeSessionId,
              resume: canResume,
              signal,
              emitter,
            })
            const nextClaudeId = result.sessionId ?? claudeSessionId
            const nextClaudeFile = nextClaudeId ? findClaudeSessionFile(home, nextClaudeId) ?? claudeFilePath : claudeFilePath

            if (sessionID) {
              await this.setSessionState(sessionID, {
                lastEngine: "claude",
                lastPromptCount: priorTurns.length + 2,
                claudeSessionId: nextClaudeId,
                claudeFilePath: nextClaudeFile,
                codexSessionId,
                codexFilePath,
              })
            }

            emitter.finish()
            controller.close()

            return
          }

          const canResumeCodex = Boolean(codexSessionId && codexFilePath && fs.existsSync(codexFilePath))
          const result = await runCodexProcess({
            binary,
            cwd,
            prompt: finalPrompt,
            sessionId: codexSessionId,
            resume: canResumeCodex,
            signal,
            emitter,
          })
          const nextCodexId = result.sessionId ?? codexSessionId
          const nextCodexFile = nextCodexId ? findCodexSessionFile(home, nextCodexId) ?? codexFilePath : codexFilePath

          if (sessionID) {
            await this.setSessionState(sessionID, {
              lastEngine: "codex",
              lastPromptCount: priorTurns.length + 2,
              claudeSessionId,
              claudeFilePath,
              codexSessionId: nextCodexId,
              codexFilePath: nextCodexFile,
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

function buildNativeModel(id: Model.ID, name: string): Model.Info {
  const defaults = Model.Info.default(NATIVE_CLI_PROVIDER_ID, id)

  return {
    ...defaults,
    name,
    package: Provider.aisdk(NATIVE_CLI_PACKAGE),
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
  id: "pigu.provider.native-cli",
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
          id: NATIVE_CLI_PROVIDER_ID,
          name: "本机订阅 (原生 CLI)",
          activation: "enabled",
          package: Provider.aisdk(NATIVE_CLI_PACKAGE),
        },
        models: [
          buildNativeModel(CLAUDE_NATIVE_MODEL_ID, "Claude 订阅 (原生 CLI)"),
          buildNativeModel(CODEX_NATIVE_MODEL_ID, "Codex 订阅 (原生 CLI)"),
        ],
      })
    })

    yield* ctx.aisdk.hook(
      "sdk",
      (evt) =>
        Effect.sync(() => {
          if (evt.package !== NATIVE_CLI_PACKAGE) return
          evt.sdk = {
            languageModel: (modelID: string) =>
              new NativeCliLanguageModel(modelID, getSessionState, setSessionState, ctx.location.directory),
          }
        }),
      { providerID: NATIVE_CLI_PROVIDER_ID },
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
      { providerID: NATIVE_CLI_PROVIDER_ID },
    )

    yield* ctx.session.hook(
      "context",
      (event) =>
        Effect.sync(() => {
          // Native CLI tools run inside the native CLI process itself, not via Pigu's tool loop.
          event.tools = {}
        }),
      { providerID: NATIVE_CLI_PROVIDER_ID },
    )

    yield* ctx.session.hook(
      "retry",
      (event) =>
        Effect.sync(() => {
          event.decision = { retry: false }
        }),
      { providerID: NATIVE_CLI_PROVIDER_ID },
    )
  }),
} satisfies PluginInternal.InternalPlugin)
