export * as SessionExternalParse from "./external-parse.js"

import { formatPatch, structuredPatch } from "diff"
import { Option, Schema } from "effect"
import nodeFs from "node:fs"
import path from "path"
import { fileURLToPath } from "url"
import zlib from "node:zlib"
import type { FileDiff } from "@opencode/schema/file-diff"
import type { FileAttachment } from "@opencode/schema/prompt"
import { FSUtil } from "@opencode/util/fs-util"
import { Hash } from "@opencode/util/hash"
import { VcsPatch } from "../vcs/patch.js"

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

export interface ExternalToolItem {
  readonly id: string
  readonly name: string
  readonly input: Record<string, unknown>
  readonly output: string
  readonly isError?: boolean
  readonly metadata?: Record<string, Schema.Json>
  readonly time: number
}

export type ExternalEntry =
  | {
      readonly kind: "user"
      readonly text: string
      readonly files?: ReadonlyArray<FileAttachment>
      readonly time: number
    }
  | {
      readonly kind: "assistant"
      readonly text?: string
      readonly thinking?: string
      readonly tools?: ReadonlyArray<ExternalToolItem>
      readonly model?: string
      readonly time: number
    }
  | {
      readonly kind: "compaction"
      readonly reason: "auto" | "manual"
      readonly summary: string
      readonly tokens?: {
        readonly input: number
        readonly output: number
        readonly cacheRead?: number
      }
      readonly time: number
    }

export interface JsonlWindowResult {
  readonly lines: ReadonlyArray<string>
  readonly startOffset: number
  readonly endOffset: number
  readonly fileSize: number
  readonly mtimeMs: number
}

export interface ParsedTranscriptMeta {
  readonly cwd: string
  readonly title: string
  readonly model: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly isSubagent: boolean
}

export const INITIAL_TAIL_BYTES = 3 * 1024 * 1024
export const BACKFILL_CHUNK_BYTES = 2 * 1024 * 1024
const BOUNDARY_PEEK_BYTES = 256 * 1024
const HEADER_PEEK_BYTES = 64 * 1024
const MAX_TOOL_OUTPUT_CHARS = 12_000
const MAX_INLINE_MEDIA_BYTES = 4 * 1024 * 1024

export const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value
  return undefined
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

export function parseTime(iso: string | undefined, fallback: number): number {
  if (!iso) return Math.floor(fallback)
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? Math.floor(parsed) : Math.floor(fallback)
}

export function sanitizeToolID(raw: string | undefined, seed: string): string {
  const cleaned = (raw ?? "").replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "")
  if (cleaned.length >= 1 && cleaned.length <= 64) return cleaned
  return `call_${Hash.fast(raw || seed).slice(0, 24)}`
}

export function sanitizeToolName(raw: string | undefined): string {
  const cleaned = (raw ?? "").replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "")
  if (cleaned.length >= 1 && cleaned.length <= 64) return cleaned
  return "tool"
}

export function truncateToolOutput(raw: string | undefined): string {
  const text = (raw ?? "").replace(/\r\n/g, "\n").trim()
  if (!text) return ""
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text
  const head = text.slice(0, 8_000)
  const tail = text.slice(-3_500)
  return `${head}\n\n... [truncated ${text.length - 11_500} chars] ...\n\n${tail}`
}

export function normalizeCandidatePath(raw: string): string {
  const trimmed = raw.trim().replace(/^["']|["']$/g, "")
  if (!trimmed) return ""

  const withoutUri = (() => {
    if (!trimmed.startsWith("file://")) return trimmed
    const parsedUrl = URL.parse(trimmed)
    if (parsedUrl?.protocol === "file:") {
      const converted = Option.getOrUndefined(
        Option.liftThrowable(() => fileURLToPath(parsedUrl))(),
      )
      if (converted) return converted
    }
    return decodeURIComponent(
      trimmed.replace(/^file:\/\/\/?/i, (match) =>
        process.platform === "win32" ? "" : match.endsWith("///") ? "/" : "",
      ),
    )
  })()

  const withoutExtendedPrefix = withoutUri.replace(/^(?:\\\\\?\\|\/\/\?\/)/, "")
  return FSUtil.windowsPath(withoutExtendedPrefix)
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

export function stripIdeMetadataTags(text: string): string {
  const cleaned = text
    .replace(/<conversation_context>[\s\S]*?<\/conversation_context>/gi, "")
    .replace(/<attached_files>[\s\S]*?<\/attached_files>/gi, "")
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

export function isInjectedPromptBoilerplate(text: string): boolean {
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

export function cleanTitle(text: string): string {
  const cleaned = stripIdeMetadataTags(text)
  const line =
    cleaned
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find((item) => item.length > 0) ?? cleaned.trim()

  return line.slice(0, 64)
}

export function buildUnifiedFileDiff(
  filePath: string,
  oldText: string,
  newText: string,
  explicitStatus?: "added" | "deleted" | "modified",
): FileDiff.Info | undefined {
  const cleanFile = normalizeCandidatePath(filePath) || filePath.trim()
  if (!cleanFile || oldText === newText) return undefined
  if (oldText.length + newText.length > 512_000) return undefined

  const normalizedOld = oldText.replace(/\r\n/g, "\n")
  const normalizedNew = newText.replace(/\r\n/g, "\n")
  const patchObj = structuredPatch(cleanFile, cleanFile, normalizedOld, normalizedNew, "", "", { context: 3 })
  if (patchObj.hunks.length === 0) return undefined

  const patch = formatPatch(patchObj)
  const counts = VcsPatch.countPatch(patch)
  if (counts.additions === 0 && counts.deletions === 0) return undefined

  const status =
    explicitStatus ??
    (normalizedOld.length === 0 ? "added" : normalizedNew.length === 0 ? "deleted" : "modified")

  return {
    file: cleanFile,
    patch,
    additions: counts.additions,
    deletions: counts.deletions,
    status,
  }
}

export function parseCodexApplyPatchDiffs(patchInput: string): FileDiff.Info[] {
  const lines = patchInput.replace(/\r\n/g, "\n").split("\n")
  const diffs: FileDiff.Info[] = []
  let currentFile = ""
  let currentKind: "added" | "deleted" | "modified" = "modified"
  let beforeLines: string[] = []
  let afterLines: string[] = []

  const flushCurrent = () => {
    if (!currentFile) return
    const diff = buildUnifiedFileDiff(
      currentFile,
      beforeLines.join("\n"),
      afterLines.join("\n"),
      currentKind,
    )
    if (diff) diffs.push(diff)
    currentFile = ""
    beforeLines = []
    afterLines = []
  }

  for (const line of lines) {
    if (line.startsWith("*** Begin Patch") || line.startsWith("*** End Patch")) {
      flushCurrent()
      continue
    }
    if (line.startsWith("*** Update File:")) {
      flushCurrent()
      currentFile = line.slice("*** Update File:".length).trim()
      currentKind = "modified"
      continue
    }
    if (line.startsWith("*** Add File:")) {
      flushCurrent()
      currentFile = line.slice("*** Add File:".length).trim()
      currentKind = "added"
      continue
    }
    if (line.startsWith("*** Delete File:")) {
      flushCurrent()
      currentFile = line.slice("*** Delete File:".length).trim()
      currentKind = "deleted"
      continue
    }
    if (line.startsWith("*** Move to:") || line.startsWith("@@") || !currentFile) continue
    if (line.startsWith("+")) {
      afterLines.push(line.slice(1))
      continue
    }
    if (line.startsWith("-")) {
      beforeLines.push(line.slice(1))
      continue
    }
    const text = line.startsWith(" ") ? line.slice(1) : line
    beforeLines.push(text)
    afterLines.push(text)
  }

  flushCurrent()
  return diffs
}

function unwrapAgyArgValue(value: unknown): unknown {
  if (typeof value !== "string") return value
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    trimmed === "true" ||
    trimmed === "false" ||
    /^-?\d+(?:\.\d+)?$/.test(trimmed)
  ) {
    const decoded = decodeJson(trimmed)
    if (Option.isSome(decoded)) return decoded.value
  }
  return value
}

function unwrapAgyArgs(rawArgs: unknown): Record<string, unknown> {
  if (!isRecord(rawArgs)) return {}
  const result: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(rawArgs)) {
    result[key] = unwrapAgyArgValue(val)
  }
  return result
}

function cleanAgyToolOutput(rawName: string, rawContent: string | undefined): { output: string; isError: boolean } {
  if (!rawContent) return { output: "Done", isError: false }
  const withoutTimestamps = rawContent
    .replace(/^Created At:[^\n]*\n(?:Completed At:[^\n]*\n)?/i, "")
    .trim()

  const isError = /^Encountered error in tool execution:/i.test(withoutTimestamps)
  if (isError) {
    return {
      output: withoutTimestamps.replace(/^Encountered error in tool execution:\s*/i, "").trim() || withoutTimestamps,
      isError: true,
    }
  }

  if (rawName === "run_command" || rawName === "send_command_input") {
    const stripped = withoutTimestamps
      .replace(/^The tool's output was truncated[^\n]*\n+Here is a preview[^\n]*\n+/i, "")
      .replace(/^Command exited with code \d+\.\s*(?:Command output:\n|No output from the command\.)?/i, "")
      .trim()
    return { output: stripped || withoutTimestamps || "Done", isError: false }
  }

  return { output: withoutTimestamps || "Done", isError: false }
}

function extractCodexSingleExecCommand(code: string): string | undefined {
  const execCalls = [...code.matchAll(/tools\.exec_command\s*\(/g)]
  if (execCalls.length !== 1) return undefined
  const otherCalls = [...code.matchAll(/tools\.([a-zA-Z0-9_]+)\s*\(/g)].some((m) => m[1] !== "exec_command")
  if (otherCalls) return undefined
  const cmdMatch = /"cmd"\s*:\s*("(?:\\.|[^"\\])*")/.exec(code) ?? /\bcmd\s*:\s*("(?:\\.|[^"\\])*")/.exec(code)
  if (!cmdMatch?.[1]) return undefined
  const decoded = decodeJson(cmdMatch[1])
  return Option.isSome(decoded) && typeof decoded.value === "string" ? decoded.value : undefined
}

function cleanCodexExecOutput(output: string): string {
  return output.replace(/^Script completed\nWall time [^\n]+\nOutput:\n?/i, "").trim()
}

export function normalizeExternalToolCall(input: {
  readonly id?: string
  readonly seed: string
  readonly rawName: string
  readonly rawArgs: Record<string, unknown>
  readonly rawOutput: string
  readonly isError?: boolean
  readonly time: number
}): ExternalToolItem {
  const toolID = sanitizeToolID(input.id, input.seed)
  const name = input.rawName.trim()
  const lower = name.toLowerCase()
  const args = input.rawArgs
  const time = Math.floor(input.time)

  // 1. Codex CodeMode `exec` tool
  if (lower === "exec" && typeof args.code === "string") {
    const singleCmd = extractCodexSingleExecCommand(args.code)
    if (singleCmd) {
      return {
        id: toolID,
        name: "shell",
        input: { command: singleCmd },
        output: truncateToolOutput(cleanCodexExecOutput(input.rawOutput)) || "Done",
        isError: input.isError,
        metadata: { command: singleCmd, status: "exited" },
        time,
      }
    }
    return {
      id: toolID,
      name: "execute",
      input: { code: args.code },
      output: truncateToolOutput(cleanCodexExecOutput(input.rawOutput)) || "Done",
      isError: input.isError,
      time,
    }
  }

  // 2. Shell / Terminal execution
  if (
    lower === "run_command" ||
    lower === "send_command_input" ||
    lower === "write_stdin" ||
    lower === "manage_task" ||
    lower === "bash" ||
    lower === "shell" ||
    lower === "shell_command" ||
    lower === "exec_command" ||
    lower === "local_shell" ||
    lower === "container.exec" ||
    lower === "run_terminal_cmd"
  ) {
    const rawCmd = args.CommandLine ?? args.command ?? args.cmd ?? args.Input
    const command = (() => {
      if (lower === "write_stdin") {
        const chars = asString(args.chars)?.trim()
        return chars ? `stdin: ${chars}` : "poll terminal output"
      }
      if (lower === "manage_task") {
        const action = asString(args.Action) ?? "status"
        const taskID = asString(args.TaskId)?.split("/").at(-1) ?? ""
        return `task ${action}${taskID ? ` ${taskID}` : ""}`
      }
      if (typeof rawCmd === "string") return rawCmd
      if (Array.isArray(rawCmd)) {
        const strs = rawCmd.filter((item): item is string => typeof item === "string")
        if (strs.length >= 3 && (strs[1] === "-lc" || strs[1] === "-c")) return strs[2]!
        return strs.join(" ")
      }
      return ""
    })()
    const description = asString(args.toolSummary ?? args.description ?? args.explanation)?.trim()
    return {
      id: toolID,
      name: "shell",
      input: {
        command,
        ...(description ? { description } : {}),
      },
      output: truncateToolOutput(input.rawOutput) || "Done",
      isError: input.isError,
      metadata: {
        command,
        status: "exited",
      },
      time,
    }
  }

  // 3. File Read
  if (lower === "read_file" || lower === "view_file" || lower === "read") {
    const rawPath = asString(args.Path ?? args.AbsolutePath ?? args.file_path ?? args.path) ?? ""
    const cleanPath = normalizeCandidatePath(rawPath) || rawPath
    const startLine = asNumber(args.StartLine ?? args.offset ?? args.start_line)
    const endLine = asNumber(args.EndLine ?? args.end_line)
    const explicitLimit = asNumber(args.limit)
    const limit =
      explicitLimit ??
      (startLine !== undefined && endLine !== undefined && endLine >= startLine
        ? endLine - startLine + 1
        : undefined)

    return {
      id: toolID,
      name: "read",
      input: {
        path: cleanPath,
        ...(startLine !== undefined ? { offset: startLine } : {}),
        ...(limit !== undefined ? { limit } : {}),
      },
      output: truncateToolOutput(input.rawOutput) || "Done",
      isError: input.isError,
      ...(cleanPath ? { metadata: { loaded: [cleanPath] } } : {}),
      time,
    }
  }

  // 4. File Edit / MultiEdit
  if (
    lower === "edit_file" ||
    lower === "replace_file_content" ||
    lower === "multi_replace_file_content" ||
    lower === "edit" ||
    lower === "multiedit" ||
    lower === "str_replace_editor"
  ) {
    const rawPath = asString(args.Path ?? args.TargetFile ?? args.file_path ?? args.path) ?? ""
    const cleanPath = normalizeCandidatePath(rawPath) || rawPath
    const chunks = Array.isArray(args.ReplacementChunks)
      ? args.ReplacementChunks
      : Array.isArray(args.edits)
        ? args.edits
        : undefined
    const oldString = chunks
      ? chunks
          .flatMap((c) => (isRecord(c) ? [asString(c.TargetContent ?? c.old_string ?? c.oldString) ?? ""] : []))
          .join("\n...\n")
      : (asString(args.Target ?? args.TargetContent ?? args.old_string ?? args.oldString ?? args.old_str) ?? "")
    const newString = chunks
      ? chunks
          .flatMap((c) => (isRecord(c) ? [asString(c.ReplacementContent ?? c.new_string ?? c.newString) ?? ""] : []))
          .join("\n...\n")
      : (asString(args.Replacement ?? args.ReplacementContent ?? args.new_string ?? args.newString ?? args.new_str) ?? "")

    const diff = cleanPath ? buildUnifiedFileDiff(cleanPath, oldString, newString, "modified") : undefined

    return {
      id: toolID,
      name: "edit",
      input: {
        path: cleanPath,
        oldString,
        newString,
      },
      output: truncateToolOutput(input.rawOutput) || "Edited",
      isError: input.isError,
      ...(diff ? { metadata: { files: [diff as unknown as Schema.Json] } } : {}),
      time,
    }
  }

  // 5. File Write
  if (lower === "write_file" || lower === "write_to_file" || lower === "write") {
    const rawPath = asString(args.Path ?? args.TargetFile ?? args.file_path ?? args.path) ?? ""
    const cleanPath = normalizeCandidatePath(rawPath) || rawPath
    const content = asString(args.Content ?? args.CodeContent ?? args.content) ?? ""
    const diff = cleanPath ? buildUnifiedFileDiff(cleanPath, "", content, "added") : undefined

    return {
      id: toolID,
      name: "write",
      input: {
        path: cleanPath,
        content,
      },
      output: truncateToolOutput(input.rawOutput) || "Written",
      isError: input.isError,
      ...(diff ? { metadata: { files: [diff as unknown as Schema.Json] } } : {}),
      time,
    }
  }

  // 6. Apply Patch
  if (lower === "apply_patch" || lower === "patch") {
    const patchText = asString(args.patchText ?? args.patch ?? args.input) ?? ""
    const diffs = patchText ? parseCodexApplyPatchDiffs(patchText) : []
    return {
      id: toolID,
      name: "patch",
      input: { patchText },
      output: truncateToolOutput(input.rawOutput) || "Applied patch",
      isError: input.isError,
      ...(diffs.length > 0 ? { metadata: { files: diffs as unknown as Schema.Json } } : {}),
      time,
    }
  }

  // 7. Search / Glob / List
  if (lower === "grep_search" || lower === "grep" || lower === "ripgrep") {
    const pattern = asString(args.Query ?? args.pattern ?? args.query) ?? ""
    const rawPath = asString(args.SearchPath ?? args.path ?? args.directory)
    const searchPath = rawPath ? normalizeCandidatePath(rawPath) || rawPath : undefined
    const include = asString(args.include ?? args.glob)
    return {
      id: toolID,
      name: "grep",
      input: {
        pattern,
        ...(searchPath ? { path: searchPath } : {}),
        ...(include ? { include } : {}),
      },
      output: truncateToolOutput(input.rawOutput) || "Done",
      isError: input.isError,
      time,
    }
  }

  if (lower === "find_by_name" || lower === "glob" || lower === "file_search") {
    const pattern = asString(args.Pattern ?? args.pattern ?? args.query) ?? "*"
    const rawPath = asString(args.SearchDirectory ?? args.path ?? args.directory)
    const searchPath = rawPath ? normalizeCandidatePath(rawPath) || rawPath : undefined
    return {
      id: toolID,
      name: "glob",
      input: {
        pattern,
        ...(searchPath ? { path: searchPath } : {}),
      },
      output: truncateToolOutput(input.rawOutput) || "Done",
      isError: input.isError,
      time,
    }
  }

  if (lower === "list_dir" || lower === "ls" || lower === "list" || lower === "list_directory") {
    const rawPath = asString(args.DirectoryPath ?? args.path ?? args.directory)
    const dirPath = rawPath ? normalizeCandidatePath(rawPath) || rawPath : undefined
    return {
      id: toolID,
      name: "list",
      input: {
        ...(dirPath ? { path: dirPath } : {}),
      },
      output: truncateToolOutput(input.rawOutput) || "Done",
      isError: input.isError,
      time,
    }
  }

  // 8. WebSearch & WebFetch
  if (lower === "search_web" || lower === "websearch" || lower === "web_search") {
    const query = asString(args.query ?? args.search_query) ?? ""
    return {
      id: toolID,
      name: "websearch",
      input: { query },
      output: truncateToolOutput(input.rawOutput) || "Done",
      isError: input.isError,
      time,
    }
  }

  if (lower === "read_url_content" || lower === "webfetch" || lower === "web_fetch") {
    const url = asString(args.Url ?? args.url) ?? ""
    return {
      id: toolID,
      name: "webfetch",
      input: { url },
      output: truncateToolOutput(input.rawOutput) || "Done",
      isError: input.isError,
      time,
    }
  }

  // 9. Subagent / Task
  if (
    lower === "invoke_subagent" ||
    lower === "define_subagent" ||
    lower === "manage_subagents" ||
    lower === "send_message" ||
    lower === "swarm" ||
    lower === "agent" ||
    lower === "task" ||
    lower === "subagent" ||
    lower === "browser_subagent"
  ) {
    const agent = asString(args.TypeName ?? args.subagent_type ?? args.agent) ?? "subagent"
    const description =
      asString(args.Role ?? args.TaskName ?? args.description ?? args.Prompt ?? args.prompt)?.slice(0, 120) ?? ""
    return {
      id: toolID,
      name: "subagent",
      input: {
        agent,
        ...(description ? { description } : {}),
      },
      output: truncateToolOutput(input.rawOutput) || "Done",
      isError: input.isError,
      time,
    }
  }

  // 10. Question / Interactive Form
  if (
    lower === "ask_question" ||
    lower === "askuserquestion" ||
    lower === "question" ||
    lower === "request_user_input"
  ) {
    const questions = Array.isArray(args.questions) ? args.questions : []
    return {
      id: toolID,
      name: "question",
      input: { questions },
      output: truncateToolOutput(input.rawOutput) || "Answered",
      isError: input.isError,
      time,
    }
  }

  // 11. Skill
  if (lower === "skill") {
    const skillName = asString(args.skill ?? args.name ?? args.id) ?? "skill"
    return {
      id: toolID,
      name: "skill",
      input: { name: skillName },
      output: truncateToolOutput(input.rawOutput) || "Loaded",
      isError: input.isError,
      metadata: { name: skillName },
      time,
    }
  }

  return {
    id: toolID,
    name: sanitizeToolName(name),
    input: args,
    output: truncateToolOutput(input.rawOutput) || "Done",
    isError: input.isError,
    time,
  }
}

function isContinuationLine(source: SourceApp, line: string): boolean {
  if (source === "agy") {
    return (
      line.includes('"type":"GENERIC"') ||
      line.includes('"type": "GENERIC"') ||
      line.includes('"type":"SYSTEM_MESSAGE"') ||
      line.includes('"type": "SYSTEM_MESSAGE"') ||
      line.includes('"type":"CHECKPOINT"') ||
      line.includes('"type": "CHECKPOINT"')
    )
  }
  if (source === "claude") {
    return line.includes('"tool_result"')
  }
  if (source === "codex") {
    return (
      line.includes('"role":"assistant"') ||
      line.includes('"role": "assistant"') ||
      line.includes('"role":"developer"') ||
      line.includes('"role": "developer"') ||
      line.includes('"AgentMessage"') ||
      line.includes('"agent_message"') ||
      line.includes('"agent_reasoning"') ||
      line.includes('"Reasoning"') ||
      line.includes('"type":"reasoning"') ||
      line.includes('"type": "reasoning"') ||
      line.includes('"UserMessage"') ||
      line.includes('"custom_tool_call"') ||
      line.includes('"custom_tool_call_output"') ||
      line.includes('"function_call"') ||
      line.includes('"function_call_output"') ||
      line.includes('"tool_search_call"') ||
      line.includes('"tool_search_output"') ||
      line.includes('"web_search_call"') ||
      line.includes('"image_generation_call"') ||
      line.includes('"CommandExecution"') ||
      line.includes('"FileChange"') ||
      line.includes('"ContextCompaction"') ||
      line.includes('"context_compacted"') ||
      line.includes('"CollabAgentToolCall"') ||
      line.includes('"ImageView"') ||
      line.includes('"patch_apply_end"') ||
      line.includes('"web_search_end"') ||
      line.includes('"sub_agent_activity"') ||
      line.includes('"token_usage_record"') ||
      line.includes('"token_count"') ||
      line.includes('"task_complete"') ||
      line.includes('"thread_settings_applied"') ||
      line.includes('"turn_aborted"') ||
      line.includes('"world_state"') ||
      line.includes('"turn_context"')
    )
  }
  if (source === "deepseek-harness") {
    return line.includes('"tool/message"')
  }
  return false
}

export function readJsonlHeaderLinesSync(fullPath: string, maxLines = 40): ReadonlyArray<string> {
  if (!fullPath || !nodeFs.existsSync(fullPath)) return []
  if (fullPath.endsWith(".zst") || fullPath.endsWith(".zstd")) return []
  const stat = nodeFs.statSync(fullPath, { throwIfNoEntry: false })
  if (!stat || !stat.isFile() || stat.size <= 0) return []

  const readLen = Math.min(stat.size, HEADER_PEEK_BYTES)
  const buf = Buffer.alloc(readLen)
  const fd = nodeFs.openSync(fullPath, "r")
  const bytesRead = nodeFs.readSync(fd, buf, 0, readLen, 0)
  nodeFs.closeSync(fd)

  const rawText = buf.subarray(0, bytesRead).toString("utf8")
  const split = rawText.split(/\r?\n/)
  const complete = bytesRead < stat.size ? split.slice(0, -1) : split
  return complete.filter((line) => line.trim().length > 0).slice(0, maxLines)
}

export function readJsonlWindowSync(input: {
  readonly fullPath: string
  readonly targetStart: number
  readonly endOffset?: number
  readonly source: SourceApp
}): JsonlWindowResult {
  if (!input.fullPath || !nodeFs.existsSync(input.fullPath)) {
    return { lines: [], startOffset: 0, endOffset: 0, fileSize: 0, mtimeMs: 0 }
  }

  const stat = nodeFs.statSync(input.fullPath, { throwIfNoEntry: false })
  if (!stat || !stat.isFile() || stat.size <= 0) {
    return { lines: [], startOffset: 0, endOffset: 0, fileSize: 0, mtimeMs: 0 }
  }

  const fileSize = stat.size
  const mtimeMs = Math.floor(stat.mtimeMs)

  if (input.fullPath.endsWith(".zst") || input.fullPath.endsWith(".zstd")) {
    const compressed = nodeFs.readFileSync(input.fullPath)
    const decompressed = Option.getOrUndefined(
      Option.liftThrowable(() => zlib.zstdDecompressSync(compressed).toString("utf8"))(),
    )
    if (!decompressed) {
      return { lines: [], startOffset: 0, endOffset: fileSize, fileSize, mtimeMs }
    }
    return {
      lines: decompressed.split(/\r?\n/).filter((line) => line.trim().length > 0),
      startOffset: 0,
      endOffset: fileSize,
      fileSize,
      mtimeMs,
    }
  }

  const end = Math.min(input.endOffset ?? fileSize, fileSize)
  if (end <= 0) {
    return { lines: [], startOffset: 0, endOffset: 0, fileSize, mtimeMs }
  }

  const clampedTarget = Math.max(0, Math.min(input.targetStart, end))
  if (clampedTarget === 0) {
    const buf = Buffer.alloc(end)
    const fd = nodeFs.openSync(input.fullPath, "r")
    const n = nodeFs.readSync(fd, buf, 0, end, 0)
    nodeFs.closeSync(fd)
    const lines = buf
      .subarray(0, n)
      .toString("utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
    return { lines, startOffset: 0, endOffset: n, fileSize, mtimeMs }
  }

  const fd = nodeFs.openSync(input.fullPath, "r")
  const minBoundaryPeek = Math.max(0, clampedTarget - BACKFILL_CHUNK_BYTES * 2)
  let peekStart = Math.max(0, clampedTarget - BOUNDARY_PEEK_BYTES)
  let sliceBuf = Buffer.alloc(0)
  let lineStarts: number[] = []
  let candidateIdx = 0

  for (;;) {
    const span = end - peekStart
    const buf = Buffer.alloc(span)
    const bytesRead = nodeFs.readSync(fd, buf, 0, span, peekStart)
    const firstNl = buf.subarray(0, bytesRead).indexOf(0x0a)
    if (peekStart > 0 && (firstNl < 0 || firstNl + 1 >= bytesRead)) {
      peekStart = Math.max(0, peekStart - BACKFILL_CHUNK_BYTES)
      continue
    }

    sliceBuf = buf.subarray(0, bytesRead)
    lineStarts = peekStart === 0 ? [0] : []
    for (let idx = 0; idx < sliceBuf.length - 1; idx += 1) {
      if (sliceBuf[idx] === 0x0a) lineStarts.push(idx + 1)
    }

    if (lineStarts.length === 0) break

    const desiredInBuf = clampedTarget - peekStart
    candidateIdx = lineStarts.findIndex((pos) => pos >= desiredInBuf)
    if (candidateIdx === -1) candidateIdx = lineStarts.length - 1

    const readLineSample = (idx: number) => {
      const startPos = lineStarts[idx]!
      const nextPos = lineStarts[idx + 1] ?? sliceBuf.length
      const sampleLen = Math.min(nextPos - startPos, 768)
      return sliceBuf.subarray(startPos, startPos + sampleLen).toString("utf8")
    }

    while (candidateIdx > 0) {
      const sample = readLineSample(candidateIdx)
      if (isContinuationLine(input.source, sample)) {
        candidateIdx -= 1
        continue
      }
      if (
        input.source === "codex" &&
        (sample.includes('"role":"user"') ||
          sample.includes('"role": "user"') ||
          sample.includes('"user_message"'))
      ) {
        const prevSample = readLineSample(candidateIdx - 1)
        if (
          prevSample.includes('"user_message"') ||
          prevSample.includes('"role":"user"') ||
          prevSample.includes('"role": "user"') ||
          prevSample.includes('"turn_context"') ||
          prevSample.includes('"world_state"') ||
          prevSample.includes('"role":"developer"') ||
          prevSample.includes('"role": "developer"') ||
          prevSample.includes('"task_started"') ||
          prevSample.includes('"token_count"')
        ) {
          candidateIdx -= 1
          continue
        }
      }
      break
    }

    if (
      candidateIdx === 0 &&
      peekStart > minBoundaryPeek &&
      isContinuationLine(input.source, readLineSample(0))
    ) {
      peekStart = Math.max(minBoundaryPeek, peekStart - BOUNDARY_PEEK_BYTES * 2)
      continue
    }
    break
  }
  nodeFs.closeSync(fd)

  if (lineStarts.length === 0) {
    return { lines: [], startOffset: end, endOffset: end, fileSize, mtimeMs }
  }

  const chosenInBuf = lineStarts[candidateIdx]!
  const actualStart = peekStart + chosenInBuf
  const lines = sliceBuf
    .subarray(chosenInBuf)
    .toString("utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)

  return {
    lines,
    startOffset: actualStart,
    endOffset: peekStart + sliceBuf.length,
    fileSize,
    mtimeMs,
  }
}

export function readJsonlForwardSync(fullPath: string, fromOffset: number): JsonlWindowResult {
  if (!fullPath || !nodeFs.existsSync(fullPath)) {
    return { lines: [], startOffset: fromOffset, endOffset: fromOffset, fileSize: 0, mtimeMs: 0 }
  }
  const stat = nodeFs.statSync(fullPath, { throwIfNoEntry: false })
  if (!stat || !stat.isFile() || stat.size <= fromOffset) {
    return {
      lines: [],
      startOffset: fromOffset,
      endOffset: stat?.size ?? fromOffset,
      fileSize: stat?.size ?? 0,
      mtimeMs: Math.floor(stat?.mtimeMs ?? 0),
    }
  }
  const span = stat.size - fromOffset
  const buf = Buffer.alloc(span)
  const fd = nodeFs.openSync(fullPath, "r")
  const bytesRead = nodeFs.readSync(fd, buf, 0, span, fromOffset)
  nodeFs.closeSync(fd)

  const lastNewline = buf.subarray(0, bytesRead).lastIndexOf(0x0a)
  if (lastNewline < 0) {
    return {
      lines: [],
      startOffset: fromOffset,
      endOffset: fromOffset,
      fileSize: stat.size,
      mtimeMs: Math.floor(stat.mtimeMs),
    }
  }

  const completeEnd = lastNewline + 1
  const lines = buf
    .subarray(0, completeEnd)
    .toString("utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)

  return {
    lines,
    startOffset: fromOffset,
    endOffset: fromOffset + completeEnd,
    fileSize: stat.size,
    mtimeMs: Math.floor(stat.mtimeMs),
  }
}

function readUriMediaAttachment(rawUri: string, rawMime: string | undefined): FileAttachment | undefined {
  const localPath = normalizeCandidatePath(rawUri)
  if (!localPath || !nodeFs.existsSync(localPath)) return undefined
  const stat = nodeFs.statSync(localPath, { throwIfNoEntry: false })
  if (!stat || !stat.isFile() || stat.size <= 0 || stat.size > MAX_INLINE_MEDIA_BYTES) return undefined

  const ext = path.extname(localPath).toLowerCase()
  const mime =
    rawMime?.trim() ||
    (ext === ".png"
      ? "image/png"
      : ext === ".jpg" || ext === ".jpeg"
        ? "image/jpeg"
        : ext === ".gif"
          ? "image/gif"
          : ext === ".webp"
            ? "image/webp"
            : ext === ".pdf"
              ? "application/pdf"
              : "")
  if (!mime.startsWith("image/") && mime !== "application/pdf") return undefined

  const bytes = Option.getOrUndefined(Option.liftThrowable(() => nodeFs.readFileSync(localPath))())
  if (!bytes) return undefined

  const fileUri = rawUri.startsWith("file://") ? rawUri : `file://${localPath}`
  return {
    data: bytes.toString("base64"),
    mime,
    source: { type: "uri", uri: fileUri },
    name: path.basename(localPath),
  }
}

function cleanAgyCompactionSummary(raw: string): string {
  const withoutPreamble = raw
    .replace(
      /^#\s*Resuming from a compaction\s+You are continuing work on the task described above[^\n]*\n+/i,
      "",
    )
    .replace(/\n+#\s*Conversation Logs[\s\S]*$/i, "")
    .trim()
  const summaryMatch = /<summary>\s*([\s\S]*?)\s*<\/summary>/i.exec(withoutPreamble)
  if (summaryMatch?.[1]) {
    const before = withoutPreamble.slice(0, summaryMatch.index).trim()
    return [before, summaryMatch[1].trim()].filter(Boolean).join("\n\n")
  }
  return withoutPreamble || raw.trim()
}

function extractAgyUserText(content: string | undefined): {
  readonly userText: string
  readonly hasRequestTag: boolean
} {
  if (!content) return { userText: "", hasRequestTag: false }
  const withoutSummary = content.replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/gi, "")
  const reqMatch = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(withoutSummary)
  const raw = reqMatch ? reqMatch[1]! : withoutSummary
  return {
    userText: stripIdeMetadataTags(raw),
    hasRequestTag: Boolean(reqMatch),
  }
}

function isAgyAuxiliaryRow(row: Record<string, unknown> | undefined): boolean {
  const rowType = asString(row?.type)
  return rowType === "SYSTEM_MESSAGE" || rowType === "ERROR_MESSAGE"
}

export function parseAgyLines(
  lines: ReadonlyArray<string>,
  fallbackTime: number,
): { readonly entries: ReadonlyArray<ExternalEntry>; readonly createdAt: number; readonly updatedAt: number } {
  const stepRows = new Map<number, Record<string, unknown>>()
  const unindexedRows: Array<Record<string, unknown>> = []

  for (const rawLine of lines) {
    const json = decodeJson(rawLine)
    if (Option.isNone(json) || !isRecord(json.value)) continue
    const row = json.value
    if (typeof row.step_index === "number") {
      stepRows.set(row.step_index, row)
      continue
    }
    unindexedRows.push(row)
  }

  const orderedRows = [
    ...[...stepRows.entries()].toSorted((a, b) => a[0] - b[0]).map((entry) => entry[1]),
    ...unindexedRows,
  ]

  let createdAt = 0
  let updatedAt = 0
  const entries: ExternalEntry[] = []

  for (let i = 0; i < orderedRows.length; i += 1) {
    const row = orderedRows[i]!
    const time = parseTime(asString(row.created_at), updatedAt || fallbackTime)
    if (!createdAt && typeof row.created_at === "string") createdAt = time
    updatedAt = Math.max(updatedAt, time)

    const rowType = asString(row.type)
    const content = asString(row.content)

    if (rowType === "CHECKPOINT") {
      const fallbackCheckpoint = [asString(row.user_intent)?.trim(), asString(row.session_summary)?.trim()]
        .filter(Boolean)
        .join("\n\n")
      const rawSummary = content?.trim() || fallbackCheckpoint
      if (rawSummary) {
        let prevIdx = i - 1
        while (prevIdx >= 0 && isAgyAuxiliaryRow(orderedRows[prevIdx])) {
          prevIdx -= 1
        }
        const prevRow = prevIdx >= 0 ? orderedRows[prevIdx] : undefined
        const isManualCompact =
          asString(prevRow?.type) === "USER_INPUT" &&
          extractAgyUserText(asString(prevRow?.content)).userText === "/compact"

        const inTokens = asNumber(row.input_tokens) ?? 0
        const outTokens = asNumber(row.output_tokens) ?? 0
        const cacheRead = asNumber(row.cache_read_tokens) ?? 0
        const nextCompaction: ExternalEntry = {
          kind: "compaction",
          reason: isManualCompact ? "manual" : "auto",
          summary: cleanAgyCompactionSummary(rawSummary),
          ...(inTokens + outTokens + cacheRead > 0
            ? {
                tokens: {
                  input: Math.max(0, Math.floor(inTokens)),
                  output: Math.max(0, Math.floor(outTokens)),
                  cacheRead: Math.max(0, Math.floor(cacheRead)),
                },
              }
            : {}),
          time,
        }
        if (entries.at(-1)?.kind === "compaction") {
          entries[entries.length - 1] = nextCompaction
          continue
        }
        entries.push(nextCompaction)
      }
      continue
    }

    if (rowType === "USER_INPUT") {
      const extracted = extractAgyUserText(content)
      const userText = extracted.userText
      const files = Array.isArray(row.media)
        ? row.media.flatMap((m) => {
            if (!isRecord(m) || typeof m.uri !== "string") return []
            const attachment = readUriMediaAttachment(m.uri, asString(m.mime_type))
            return attachment ? [attachment] : []
          })
        : []

      let nextSignificantIdx = i + 1
      while (nextSignificantIdx < orderedRows.length && isAgyAuxiliaryRow(orderedRows[nextSignificantIdx])) {
        nextSignificantIdx += 1
      }
      const isBareCompactCmd =
        userText === "/compact" && asString(orderedRows[nextSignificantIdx]?.type) === "CHECKPOINT"
      const isSystemResumeOnly = !extracted.hasRequestTag && (content ?? "").trimStart().startsWith("<CONTEXT_SUMMARY>")
      const isInterruptionNoise =
        /^Error:\s*The stream was interrupted\./.test(userText) && (content ?? "").includes("<SYSTEM_MESSAGE>")

      if (!isBareCompactCmd && !isSystemResumeOnly && !isInterruptionNoise && (userText || files.length > 0)) {
        entries.push({
          kind: "user",
          text: userText,
          ...(files.length > 0 ? { files } : {}),
          time,
        })
      }
      continue
    }

    if (rowType === "PLANNER_RESPONSE") {
      const thinking = asString(row.thinking)?.trim() || undefined
      const text = content?.trim() || undefined
      const rawCalls = Array.isArray(row.tool_calls) ? row.tool_calls.filter(isRecord) : []

      const genericOutputs: Array<Record<string, unknown>> = []
      while (
        i + 1 < orderedRows.length &&
        asString(orderedRows[i + 1]?.type) === "GENERIC" &&
        asString(orderedRows[i + 1]?.source) === "MODEL"
      ) {
        genericOutputs.push(orderedRows[i + 1]!)
        i += 1
        const outTime = parseTime(asString(orderedRows[i]?.created_at), updatedAt)
        updatedAt = Math.max(updatedAt, outTime)
      }

      const stepIdx = typeof row.step_index === "number" ? row.step_index : i
      const tools = rawCalls.map((call, callIdx) => {
        const rawName = asString(call.name) ?? "tool"
        const args = unwrapAgyArgs(call.args)
        const outRow = genericOutputs[callIdx]
        const outStatus = asString(outRow?.status)
        const cleanedOut = cleanAgyToolOutput(rawName, asString(outRow?.content))
        const toolTime = parseTime(asString(outRow?.created_at), time)
        return normalizeExternalToolCall({
          id: asString(call.id),
          seed: `agy:${stepIdx}:${callIdx}:${rawName}`,
          rawName,
          rawArgs: args,
          rawOutput: cleanedOut.output,
          isError: cleanedOut.isError || outStatus === "ERROR",
          time: toolTime,
        })
      })

      if (thinking || text || tools.length > 0) {
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

  return { entries, createdAt, updatedAt }
}

function extractTextFromContentArray(parts: ReadonlyArray<unknown>): string {
  return parts
    .flatMap((part) => {
      if (typeof part === "string") return [part.trim()]
      if (!isRecord(part)) return []
      const kind = asString(part.type)?.toLowerCase()
      if ((kind === "text" || kind === "input_text" || kind === "output_text" || !kind) && typeof part.text === "string") {
        return [part.text.trim()]
      }
      return []
    })
    .filter(Boolean)
    .join("\n\n")
}

function extractInlineImageAttachments(parts: ReadonlyArray<unknown>): FileAttachment[] {
  return parts.flatMap((part): FileAttachment[] => {
    if (!isRecord(part) || part.type !== "image" || !isRecord(part.source)) return []
    const mediaType = asString(part.source.media_type) ?? ""
    const data = asString(part.source.data) ?? ""
    if (!mediaType.startsWith("image/") || !data || data.length > MAX_INLINE_MEDIA_BYTES * 1.37) return []
    if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return []
    return [
      {
        data,
        mime: mediaType,
        source: { type: "inline" },
      },
    ]
  })
}

export function parseClaudeLines(
  lines: ReadonlyArray<string>,
  fallbackTime: number,
): {
  readonly entries: ReadonlyArray<ExternalEntry>
  readonly meta: ParsedTranscriptMeta
} {
  let cwd = ""
  let relocatedCwd = ""
  let customTitle = ""
  let aiTitle = ""
  let detectedModel = ""
  let createdAt = 0
  let updatedAt = 0

  type MutableTool = {
    id: string
    rawName: string
    rawArgs: Record<string, unknown>
    rawOutput: string
    isError: boolean
    time: number
    seed: string
  }
  type MutableAssistant = {
    kind: "assistant"
    messageID?: string
    textParts: string[]
    thinkingParts: string[]
    tools: MutableTool[]
    model?: string
    time: number
  }

  const items: Array<Exclude<ExternalEntry, { kind: "assistant" }> | MutableAssistant> = []
  const toolsByCallID = new Map<string, MutableTool>()
  let pendingCompactTrigger: "auto" | "manual" | undefined
  let pendingCompactTime = 0

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
    const json = decodeJson(lines[lineIdx]!)
    if (Option.isNone(json) || !isRecord(json.value)) continue
    const row = json.value

    if (row.isSidechain === true) continue
    if (typeof row.cwd === "string" && row.cwd && !cwd) cwd = row.cwd
    if (row.type === "relocated" && typeof row.relocatedCwd === "string" && row.relocatedCwd.trim()) {
      relocatedCwd = row.relocatedCwd.trim()
    }
    if (row.type === "custom-title" && typeof row.customTitle === "string" && row.customTitle.trim()) {
      customTitle = row.customTitle.trim()
    }
    if (row.type === "ai-title" && typeof row.aiTitle === "string" && row.aiTitle.trim()) {
      aiTitle = row.aiTitle.trim()
    }

    const time = parseTime(asString(row.timestamp), updatedAt || fallbackTime)
    if (typeof row.timestamp === "string") {
      if (!createdAt) createdAt = time
      updatedAt = Math.max(updatedAt, time)
    }

    if (row.type === "system" && row.subtype === "compact_boundary") {
      if (pendingCompactTrigger !== undefined) {
        items.push({
          kind: "compaction",
          reason: pendingCompactTrigger,
          summary: "Context compacted by Claude Code.",
          time: pendingCompactTime || time,
        })
      }
      const meta = isRecord(row.compactMetadata) ? row.compactMetadata : undefined
      pendingCompactTrigger = meta?.trigger === "manual" ? "manual" : "auto"
      pendingCompactTime = time
      continue
    }

    if (row.isCompactSummary === true) {
      const msg = isRecord(row.message) ? row.message : undefined
      const rawContent = msg?.content
      const summary =
        typeof rawContent === "string"
          ? rawContent.trim()
          : Array.isArray(rawContent)
            ? extractTextFromContentArray(rawContent)
            : ""
      items.push({
        kind: "compaction",
        reason: pendingCompactTrigger ?? "auto",
        summary: summary || "Context compacted by Claude Code.",
        time: pendingCompactTime || time,
      })
      pendingCompactTrigger = undefined
      pendingCompactTime = 0
      continue
    }

    if (pendingCompactTrigger !== undefined && (row.type === "user" || row.type === "assistant")) {
      items.push({
        kind: "compaction",
        reason: pendingCompactTrigger,
        summary: "Context compacted by Claude Code.",
        time: pendingCompactTime || time,
      })
      pendingCompactTrigger = undefined
      pendingCompactTime = 0
    }

    if (row.type === "user") {
      const msg = isRecord(row.message) ? row.message : undefined
      const rawContent = msg?.content

      if (Array.isArray(rawContent)) {
        for (const part of rawContent) {
          if (!isRecord(part) || part.type !== "tool_result") continue
          const toolUseID = asString(part.tool_use_id)
          const matched = toolUseID ? toolsByCallID.get(toolUseID) : undefined
          if (!matched) continue
          const outText =
            typeof part.content === "string"
              ? part.content
              : Array.isArray(part.content)
                ? extractTextFromContentArray(part.content)
                : ""
          matched.rawOutput = outText || "Done"
          matched.isError = part.is_error === true
        }
      }

      if (row.isMeta === true) continue

      const humanText =
        typeof rawContent === "string"
          ? stripIdeMetadataTags(rawContent)
          : Array.isArray(rawContent)
            ? stripIdeMetadataTags(extractTextFromContentArray(rawContent))
            : ""
      const files = Array.isArray(rawContent) ? extractInlineImageAttachments(rawContent) : []

      if ((humanText && !isInjectedPromptBoilerplate(humanText)) || files.length > 0) {
        items.push({
          kind: "user",
          text: humanText,
          ...(files.length > 0 ? { files } : {}),
          time,
        })
      }
      continue
    }

    if (row.type === "assistant") {
      const msg = isRecord(row.message) ? row.message : undefined
      const msgID = asString(msg?.id)
      const rawModel = (asString(msg?.model) ?? "").trim().replace(/-\d{8}$/, "")
      if (rawModel && rawModel !== "<synthetic>" && !rawModel.startsWith("<")) {
        detectedModel = rawModel
      }

      const rawContent = msg?.content
      const textParts: string[] = []
      const thinkingParts: string[] = []
      const newTools: MutableTool[] = []

      if (typeof rawContent === "string" && rawContent.trim()) {
        textParts.push(rawContent.trim())
      }

      if (Array.isArray(rawContent)) {
        for (let pIdx = 0; pIdx < rawContent.length; pIdx += 1) {
          const part = rawContent[pIdx]
          if (!isRecord(part)) continue
          if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
            textParts.push(part.text.trim())
          }
          if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim()) {
            thinkingParts.push(part.thinking.trim())
          }
          if (part.type === "tool_use") {
            const callID = asString(part.id) ?? `claude_${lineIdx}_${pIdx}`
            const rawName = asString(part.name) ?? "tool"
            const rawArgs = isRecord(part.input) ? part.input : {}
            const mutableTool: MutableTool = {
              id: callID,
              rawName,
              rawArgs,
              rawOutput: "Done",
              isError: false,
              time,
              seed: `claude:${lineIdx}:${pIdx}:${rawName}`,
            }
            newTools.push(mutableTool)
            toolsByCallID.set(callID, mutableTool)
          }
        }
      }

      if (textParts.length === 0 && thinkingParts.length === 0 && newTools.length === 0) continue

      const prev = items.at(-1)
      if (prev && prev.kind === "assistant" && msgID && prev.messageID === msgID) {
        prev.textParts.push(...textParts)
        prev.thinkingParts.push(...thinkingParts)
        prev.tools.push(...newTools)
        prev.time = Math.max(prev.time, time)
        if (detectedModel) prev.model = detectedModel
        continue
      }

      items.push({
        kind: "assistant",
        messageID: msgID,
        textParts,
        thinkingParts,
        tools: newTools,
        ...(detectedModel ? { model: detectedModel } : {}),
        time,
      })
    }
  }

  if (pendingCompactTrigger !== undefined) {
    items.push({
      kind: "compaction",
      reason: pendingCompactTrigger,
      summary: "Context compacted by Claude Code.",
      time: pendingCompactTime || updatedAt || fallbackTime,
    })
  }

  const entries: ExternalEntry[] = items.map((item): ExternalEntry => {
    if (item.kind !== "assistant") return item
    const text = item.textParts.join("\n\n").trim() || undefined
    const thinking = item.thinkingParts.join("\n\n").trim() || undefined
    const seenToolIDs = new Set<string>()
    const tools = item.tools.map((t, idx) => {
      const normalized = normalizeExternalToolCall({
        id: t.id,
        seed: t.seed,
        rawName: t.rawName,
        rawArgs: t.rawArgs,
        rawOutput: t.rawOutput,
        isError: t.isError,
        time: t.time,
      })
      const uniqueID = seenToolIDs.has(normalized.id) ? sanitizeToolID(`${normalized.id}_${idx}`, t.seed) : normalized.id
      seenToolIDs.add(uniqueID)
      return uniqueID === normalized.id ? normalized : { ...normalized, id: uniqueID }
    })
    return {
      kind: "assistant",
      ...(text ? { text } : {}),
      ...(thinking ? { thinking } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      ...(item.model ? { model: item.model } : {}),
      time: item.time,
    }
  })

  return {
    entries,
    meta: {
      cwd: relocatedCwd || cwd,
      title: customTitle || aiTitle,
      model: detectedModel,
      createdAt,
      updatedAt,
      isSubagent: false,
    },
  }
}

function cleanCodexCompactionSummary(raw: string): string {
  const stripped = raw
    .replace(
      /^Another language model started to solve this problem[\s\S]*?use the information in this summary to assist with your own analysis:\s*/i,
      "",
    )
    .trim()
  return stripped || raw.trim()
}

export function parseCodexLines(
  lines: ReadonlyArray<string>,
  fallbackTime: number,
): {
  readonly entries: ReadonlyArray<ExternalEntry>
  readonly meta: ParsedTranscriptMeta
} {
  let cwd = ""
  let model = ""
  let createdAt = 0
  let updatedAt = 0
  let isSubagent = false

  type MutableCodexTool = {
    callID: string
    rawName: string
    rawArgs: Record<string, unknown>
    rawOutput: string
    isError: boolean
    time: number
    seed: string
  }

  type DraftItem =
    | Exclude<ExternalEntry, { kind: "assistant" }>
    | {
        kind: "assistant"
        text?: string
        thinking?: string
        tools?: MutableCodexTool[]
        model?: string
        time: number
      }

  const items: DraftItem[] = []
  const toolsByCallID = new Map<string, MutableCodexTool>()
  let pendingThinking: string[] = []
  let turnHasExplicitToolCall = false

  const pushUserDeduped = (text: string, time: number) => {
    const prev = items.at(-1)
    if (prev && prev.kind === "user" && prev.text === text && Math.abs(prev.time - time) <= 10_000) return
    pendingThinking = []
    items.push({ kind: "user", text, time })
  }

  const pushAssistantTextDeduped = (text: string, thinking: string | undefined, time: number) => {
    const combinedThinking = [
      ...(pendingThinking.length > 0 ? [pendingThinking.join("\n\n")] : []),
      ...(thinking ? [thinking] : []),
    ]
      .filter(Boolean)
      .join("\n\n") || undefined
    pendingThinking = []

    const prev = items.at(-1)
    if (
      prev &&
      prev.kind === "assistant" &&
      (!prev.tools || prev.tools.length === 0) &&
      prev.text === text &&
      Math.abs(prev.time - time) <= 10_000
    ) {
      if (combinedThinking && !prev.thinking) prev.thinking = combinedThinking
      return
    }

    items.push({
      kind: "assistant",
      text,
      ...(combinedThinking ? { thinking: combinedThinking } : {}),
      ...(model ? { model } : {}),
      time,
    })
  }

  const pushPendingThinking = (raw: string) => {
    const trimmed = raw.trim()
    if (!trimmed) return
    if (pendingThinking.at(-1) === trimmed) return
    pendingThinking.push(trimmed)
  }

  const attachToolCall = (tool: MutableCodexTool) => {
    toolsByCallID.set(tool.callID, tool)
    const thinking = pendingThinking.length > 0 ? pendingThinking.join("\n\n") : undefined
    pendingThinking = []
    const prev = items.at(-1)
    if (
      !thinking &&
      prev &&
      prev.kind === "assistant" &&
      prev.tools &&
      !prev.text &&
      Math.abs(prev.time - tool.time) <= 5_000
    ) {
      prev.tools.push(tool)
      return
    }
    items.push({
      kind: "assistant",
      ...(thinking ? { thinking } : {}),
      tools: [tool],
      ...(model ? { model } : {}),
      time: tool.time,
    })
  }

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
    const json = decodeJson(lines[lineIdx]!)
    if (Option.isNone(json) || !isRecord(json.value)) continue
    const row = json.value
    const payload = isRecord(row.payload) ? row.payload : undefined
    const time = parseTime(asString(row.timestamp), updatedAt || fallbackTime)
    if (typeof row.timestamp === "string") {
      if (!createdAt) createdAt = time
      updatedAt = Math.max(updatedAt, time)
    }

    if (row.type === "session_meta" || row.type === "turn_context") {
      if (row.type === "session_meta" && isRecord(payload?.source) && "subagent" in payload.source) {
        isSubagent = true
      }
      if (typeof payload?.cwd === "string" && payload.cwd && !cwd) cwd = payload.cwd
      if (typeof payload?.model === "string" && payload.model.trim()) model = payload.model.trim()
      if (row.type === "session_meta" && typeof row.timestamp === "string") createdAt = time
      if (row.type === "turn_context") turnHasExplicitToolCall = false
      continue
    }

    if (row.type === "compacted") {
      const msg = asString(payload?.message)?.trim()
      const replacementSummary = Array.isArray(payload?.replacement_history)
        ? payload.replacement_history
            .flatMap((entry) => {
              if (!isRecord(entry) || !Array.isArray(entry.content)) return []
              const t = extractTextFromContentArray(entry.content)
              return t && !isInjectedPromptBoilerplate(t) ? [t] : []
            })
            .at(-1)
        : undefined
      const rawSummary = msg || replacementSummary || "Context compacted by Codex."
      const usageRec = isRecord(payload?.latest_token_usage_record) ? payload.latest_token_usage_record : undefined
      const usage = usageRec && isRecord(usageRec.usage) ? usageRec.usage : undefined
      const inTokens = asNumber(usage?.input_tokens) ?? 0
      const outTokens = asNumber(usage?.output_tokens) ?? 0
      const cacheRead = asNumber(usage?.cached_input_tokens) ?? 0
      const nextCompaction: ExternalEntry = {
        kind: "compaction",
        reason: "auto",
        summary: cleanCodexCompactionSummary(rawSummary),
        ...(inTokens + outTokens + cacheRead > 0
          ? {
              tokens: {
                input: Math.max(0, Math.floor(inTokens)),
                output: Math.max(0, Math.floor(outTokens)),
                cacheRead: Math.max(0, Math.floor(cacheRead)),
              },
            }
          : {}),
        time,
      }
      if (items.at(-1)?.kind === "compaction") {
        items[items.length - 1] = nextCompaction
        continue
      }
      items.push(nextCompaction)
      continue
    }

    if (row.type === "event_msg" && payload) {
      if (payload.type === "task_started") {
        turnHasExplicitToolCall = false
        continue
      }

      if (typeof payload.message === "string" && payload.message.trim()) {
        const cleaned = stripIdeMetadataTags(payload.message)
        if (payload.type === "user_message" && cleaned && !isInjectedPromptBoilerplate(cleaned)) {
          pushUserDeduped(cleaned, time)
        }
        if (payload.type === "agent_message" && cleaned) {
          pushAssistantTextDeduped(cleaned, undefined, time)
        }
        if (payload.type === "agent_reasoning" && cleaned) {
          pushPendingThinking(cleaned)
        }
      }

      if (payload.type === "item_completed" && isRecord(payload.item)) {
        const item = payload.item
        const itemType = asString(item.type)
        const itemContent = Array.isArray(item.content)
          ? extractTextFromContentArray(item.content)
          : Array.isArray(item.summary_text)
            ? extractTextFromContentArray(item.summary_text)
            : ""
        const cleaned = stripIdeMetadataTags(itemContent)

        if (itemType === "UserMessage" && cleaned && !isInjectedPromptBoilerplate(cleaned)) {
          pushUserDeduped(cleaned, time)
        }
        if (itemType === "AgentMessage" && cleaned) {
          pushAssistantTextDeduped(cleaned, undefined, time)
        }
        if (itemType === "Reasoning" && cleaned) {
          pushPendingThinking(cleaned)
        }
        if (itemType === "CommandExecution" && !turnHasExplicitToolCall) {
          const cmd = item.command
          const stdout = asString(item.stdout) ?? ""
          const stderr = asString(item.stderr) ?? ""
          const combinedOut = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n")
          attachToolCall({
            callID: asString(item.id) ?? `codex_cmd_${lineIdx}`,
            rawName: "shell",
            rawArgs: { command: cmd },
            rawOutput: combinedOut || "Done",
            isError: false,
            time,
            seed: `codex:${lineIdx}:cmd`,
          })
        }
      }
      continue
    }

    if (row.type === "response_item" && payload) {
      const subType = asString(payload.type)

      if (subType === "reasoning") {
        const summaryText = Array.isArray(payload.summary)
          ? extractTextFromContentArray(payload.summary)
          : Array.isArray(payload.content)
            ? extractTextFromContentArray(payload.content)
            : ""
        if (summaryText) pushPendingThinking(summaryText)
        continue
      }

      if (subType === "message") {
        const role = asString(payload.role)
        const rawText = Array.isArray(payload.content) ? extractTextFromContentArray(payload.content) : ""
        const cleaned = stripIdeMetadataTags(rawText)
        if (role === "user" && cleaned && !isInjectedPromptBoilerplate(cleaned)) {
          pushUserDeduped(cleaned, time)
        }
        if (role === "assistant" && cleaned) {
          pushAssistantTextDeduped(cleaned, undefined, time)
        }
        continue
      }

      if (subType === "function_call") {
        turnHasExplicitToolCall = true
        const callID = asString(payload.call_id ?? payload.id) ?? `codex_fn_${lineIdx}`
        const rawName = asString(payload.name) ?? "tool"
        const rawArgStr = asString(payload.arguments) ?? "{}"
        const decodedArgs = Option.getOrUndefined(decodeJson(rawArgStr))
        const rawArgs = isRecord(decodedArgs)
          ? decodedArgs
          : rawName === "apply_patch"
            ? { patchText: rawArgStr }
            : { input: rawArgStr }
        attachToolCall({
          callID,
          rawName,
          rawArgs,
          rawOutput: "Done",
          isError: false,
          time,
          seed: `codex:${lineIdx}:${rawName}`,
        })
        continue
      }

      if (subType === "custom_tool_call") {
        turnHasExplicitToolCall = true
        const callID = asString(payload.call_id ?? payload.id) ?? `codex_ctc_${lineIdx}`
        const rawName = asString(payload.name) ?? "tool"
        const rawInput = payload.input
        const rawArgs = isRecord(rawInput)
          ? rawInput
          : rawName === "apply_patch"
            ? { patchText: asString(rawInput) ?? "" }
            : rawName === "exec"
              ? { code: asString(rawInput) ?? "" }
              : { input: rawInput }
        attachToolCall({
          callID,
          rawName,
          rawArgs,
          rawOutput: "Done",
          isError: false,
          time,
          seed: `codex:${lineIdx}:${rawName}`,
        })
        continue
      }

      if (subType === "function_call_output" || subType === "custom_tool_call_output") {
        const callID = asString(payload.call_id)
        const matched = callID ? toolsByCallID.get(callID) : undefined
        if (!matched) continue
        const out = payload.output
        const outText =
          typeof out === "string"
            ? out
            : Array.isArray(out)
              ? extractTextFromContentArray(out)
              : isRecord(out) && typeof out.output === "string"
                ? out.output
                : ""
        matched.rawOutput = outText || "Done"
      }
    }
  }

  const entries: ExternalEntry[] = items.map((item): ExternalEntry => {
    if (item.kind !== "assistant") return item
    const seenToolIDs = new Set<string>()
    const tools = (item.tools ?? []).map((t, idx) => {
      const normalized = normalizeExternalToolCall({
        id: t.callID,
        seed: t.seed,
        rawName: t.rawName,
        rawArgs: t.rawArgs,
        rawOutput: t.rawOutput,
        isError: t.isError,
        time: t.time,
      })
      const uniqueID = seenToolIDs.has(normalized.id) ? sanitizeToolID(`${normalized.id}_${idx}`, t.seed) : normalized.id
      seenToolIDs.add(uniqueID)
      return uniqueID === normalized.id ? normalized : { ...normalized, id: uniqueID }
    })
    return {
      kind: "assistant",
      ...(item.text ? { text: item.text } : {}),
      ...(item.thinking ? { thinking: item.thinking } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      ...(item.model ? { model: item.model } : {}),
      time: item.time,
    }
  })

  return {
    entries,
    meta: {
      cwd,
      title: "",
      model,
      createdAt,
      updatedAt,
      isSubagent,
    },
  }
}

export function parseDshLines(
  lines: ReadonlyArray<string>,
  fallbackTime: number,
): {
  readonly entries: ReadonlyArray<ExternalEntry>
  readonly meta: ParsedTranscriptMeta
} {
  let cwd = ""
  let title = ""
  let createdAt = 0
  let updatedAt = 0
  const seenMsgIDs = new Set<string>()

  type MutableDshTool = {
    callID: string
    rawName: string
    rawArgs: Record<string, unknown>
    rawOutput: string
    isError: boolean
    time: number
    seed: string
  }

  const items: Array<
    | Exclude<ExternalEntry, { kind: "assistant" }>
    | { kind: "assistant"; text?: string; thinking?: string; tools: MutableDshTool[]; time: number }
  > = []
  const toolsByID = new Map<string, MutableDshTool>()

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
    const json = decodeJson(lines[lineIdx]!)
    if (Option.isNone(json) || !isRecord(json.value)) continue
    const row = json.value
    const surfaceOp = isRecord(row.surfaceOp) ? row.surfaceOp : undefined
    if (surfaceOp?.op === "replace") continue

    const explicitTime =
      typeof row.time === "number" ? row.time : typeof row.createdAt === "number" ? row.createdAt : 0
    const time = Math.floor(explicitTime || updatedAt || fallbackTime)
    if (explicitTime) {
      if (!createdAt) createdAt = Math.floor(explicitTime)
      updatedAt = Math.max(updatedAt, Math.floor(explicitTime))
    }

    if ((row.type === "session" || row.type === "header") && typeof row.cwd === "string" && row.cwd && !cwd) {
      cwd = row.cwd
    }

    const data = isRecord(row.data) ? row.data : undefined
    if (row.type === "session/title" && typeof data?.title === "string" && data.title.trim()) {
      title = data.title.trim()
    }

    if (row.type === "user/message" && data) {
      const msgID = asString(data.id)
      if (msgID) {
        if (seenMsgIDs.has(msgID)) continue
        seenMsgIDs.add(msgID)
      }
      const source = isRecord(data.source) ? data.source : undefined
      if ((!source?.kind || source.kind === "user") && Array.isArray(data.content)) {
        const text = stripIdeMetadataTags(extractTextFromContentArray(data.content))
        if (text && !isInjectedPromptBoilerplate(text)) {
          items.push({ kind: "user", text, time })
        }
      }
      continue
    }

    if (row.type === "assistant/message" && data && isRecord(data.message) && Array.isArray(data.message.content)) {
      const msgID = asString(data.message.id)
      if (msgID) {
        if (seenMsgIDs.has(msgID)) continue
        seenMsgIDs.add(msgID)
      }
      const text = extractTextFromContentArray(data.message.content) || undefined
      const thinking =
        data.message.content
          .flatMap((part) =>
            isRecord(part) &&
            (part.type === "reasoning" || part.type === "thinking") &&
            typeof (part.text ?? part.thinking) === "string"
              ? [String(part.text ?? part.thinking).trim()]
              : [],
          )
          .filter(Boolean)
          .join("\n\n") || undefined

      const tools: MutableDshTool[] = []
      for (let pIdx = 0; pIdx < data.message.content.length; pIdx += 1) {
        const part = data.message.content[pIdx]
        if (!isRecord(part)) continue
        if (part.type === "tool-call" || part.type === "tool_use" || part.type === "tool_call") {
          const callID = asString(part.toolCallId ?? part.id) ?? `dsh_${lineIdx}_${pIdx}`
          const rawName = asString(part.toolName ?? part.name) ?? "tool"
          const rawArgs = isRecord(part.args ?? part.input) ? ((part.args ?? part.input) as Record<string, unknown>) : {}
          const tool: MutableDshTool = {
            callID,
            rawName,
            rawArgs,
            rawOutput: "Done",
            isError: false,
            time,
            seed: `dsh:${lineIdx}:${pIdx}:${rawName}`,
          }
          tools.push(tool)
          toolsByID.set(callID, tool)
        }
      }

      if (text || thinking || tools.length > 0) {
        items.push({
          kind: "assistant",
          ...(text ? { text } : {}),
          ...(thinking ? { thinking } : {}),
          tools,
          time,
        })
      }
      continue
    }

    if (row.type === "tool/message" && data && Array.isArray(data.content)) {
      for (const part of data.content) {
        if (!isRecord(part)) continue
        const callID = asString(part.toolCallId ?? part.tool_use_id ?? part.id)
        const matched = callID ? toolsByID.get(callID) : undefined
        if (!matched) continue
        const resultVal = part.result ?? part.output ?? part.content
        const outText =
          typeof resultVal === "string"
            ? resultVal
            : Array.isArray(resultVal)
              ? extractTextFromContentArray(resultVal)
              : isRecord(resultVal) && typeof resultVal.output === "string"
                ? resultVal.output
                : ""
        matched.rawOutput = outText || "Done"
        matched.isError = part.isError === true || part.is_error === true
      }
    }
  }

  const entries: ExternalEntry[] = items.map((item): ExternalEntry => {
    if (item.kind !== "assistant") return item
    const tools = item.tools.map((t) =>
      normalizeExternalToolCall({
        id: t.callID,
        seed: t.seed,
        rawName: t.rawName,
        rawArgs: t.rawArgs,
        rawOutput: t.rawOutput,
        isError: t.isError,
        time: t.time,
      }),
    )
    return {
      kind: "assistant",
      ...(item.text ? { text: item.text } : {}),
      ...(item.thinking ? { thinking: item.thinking } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      time: item.time,
    }
  })

  return {
    entries,
    meta: { cwd, title, model: "", createdAt, updatedAt, isSubagent: false },
  }
}

export function parseGenericLines(
  lines: ReadonlyArray<string>,
  fallbackTime: number,
): {
  readonly entries: ReadonlyArray<ExternalEntry>
  readonly meta: ParsedTranscriptMeta
} {
  let cwd = ""
  let createdAt = 0
  let updatedAt = 0
  const entries: ExternalEntry[] = []

  for (const rawLine of lines) {
    const json = decodeJson(rawLine)
    if (Option.isNone(json) || !isRecord(json.value)) continue
    const row = json.value

    if (typeof row.cwd === "string" && row.cwd && !cwd) cwd = row.cwd
    const rawTs = asString(row.timestamp)
    const time = rawTs
      ? parseTime(rawTs, updatedAt || fallbackTime)
      : typeof row.ts === "number"
        ? Math.floor(row.ts)
        : updatedAt || fallbackTime

    if (rawTs || typeof row.ts === "number") {
      if (!createdAt) createdAt = time
      updatedAt = Math.max(updatedAt, time)
    }

    const msg = isRecord(row.message) ? row.message : undefined
    const role =
      asString(msg?.role) ??
      asString(row.role) ??
      (row.type === "user" || row.type === "assistant" ? row.type : undefined)
    const rawContent = msg?.content ?? row.content

    if (role !== "user" && role !== "assistant") continue

    const text =
      typeof rawContent === "string"
        ? rawContent.trim()
        : Array.isArray(rawContent)
          ? extractTextFromContentArray(rawContent)
          : ""
    const thinking = Array.isArray(rawContent)
      ? rawContent
          .flatMap((part) =>
            isRecord(part) && part.type === "thinking" && typeof part.thinking === "string"
              ? [part.thinking.trim()]
              : [],
          )
          .filter(Boolean)
          .join("\n\n") || asString(row.thinking)?.trim()
      : asString(row.thinking)?.trim()

    const cleaned = role === "user" ? stripIdeMetadataTags(text) : text
    if (role === "user" && cleaned && !isInjectedPromptBoilerplate(cleaned)) {
      entries.push({ kind: "user", text: cleaned, time })
    }
    if (role === "assistant" && (cleaned || thinking)) {
      entries.push({
        kind: "assistant",
        ...(cleaned ? { text: cleaned } : {}),
        ...(thinking ? { thinking } : {}),
        time,
      })
    }
  }

  return {
    entries,
    meta: { cwd, title: "", model: "", createdAt, updatedAt, isSubagent: false },
  }
}

export function parseSliceBySource(
  source: SourceApp,
  lines: ReadonlyArray<string>,
  fallbackTime: number,
): ReadonlyArray<ExternalEntry> {
  if (source === "agy") return parseAgyLines(lines, fallbackTime).entries
  if (source === "claude") return parseClaudeLines(lines, fallbackTime).entries
  if (source === "codex") return parseCodexLines(lines, fallbackTime).entries
  if (source === "deepseek-harness") return parseDshLines(lines, fallbackTime).entries
  return parseGenericLines(lines, fallbackTime).entries
}
