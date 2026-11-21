import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import readline from "node:readline"
import { Option, Schema } from "effect"

const LeaseEntrySchema = Schema.Struct({
  url: Schema.String,
  callUrl: Schema.optional(Schema.String),
  pid: Schema.Number,
  cwd: Schema.String,
  expiresAt: Schema.Number,
})

const LeaseFileSchema = Schema.Struct({
  leases: Schema.Array(LeaseEntrySchema),
})

const decodeLeaseFile = Schema.decodeUnknownOption(Schema.fromJsonString(LeaseFileSchema))
const decodeJsonUnknown = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  return Option.isSome(Option.liftThrowable(() => process.kill(pid, 0))())
}

function resolveActiveLeaseUrl(mode: "mcp" | "call"): string | undefined {
  const direct = mode === "call" ? process.env.PIGU_MCP_CALL_URL?.trim() : process.env.PIGU_MCP_URL?.trim()
  if (direct) return direct

  const home = process.env.OPENCODE_TEST_HOME || os.homedir()
  const leasePath = path.join(home, ".cache", "pigu", "active-mcp-leases.json")
  if (!fs.existsSync(leasePath)) return undefined

  const raw = Option.getOrUndefined(Option.liftThrowable(() => fs.readFileSync(leasePath, "utf8"))())
  if (!raw) return undefined

  const parsed = Option.getOrUndefined(decodeLeaseFile(raw))
  if (!parsed) return undefined

  const now = Date.now()
  const cwd = process.cwd()
  const valid = parsed.leases.filter((item) => item.expiresAt > now && isPidAlive(item.pid))
  if (valid.length === 0) return undefined

  const matched =
    valid.findLast((item) => item.cwd === cwd) ??
    valid.findLast((item) => cwd.startsWith(`${item.cwd}${path.sep}`) || item.cwd.startsWith(`${cwd}${path.sep}`)) ??
    valid.at(-1)

  if (!matched) return undefined
  return mode === "call" ? (matched.callUrl ?? matched.url.replace(/\/mcp(\?|$)/, "/call$1")) : matched.url
}

async function postJson(url: string, body: unknown): Promise<{ status: number; text: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, text }
}

function writeStdoutLine(payload: unknown) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

function handleIdleRpcMessage(msg: Record<string, unknown>) {
  const id = msg.id
  const method = typeof msg.method === "string" ? msg.method : ""
  if (id === undefined) return

  if (method === "initialize") {
    const params = isRecord(msg.params) ? msg.params : {}
    const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "2024-11-05"
    const protocolVersion =
      requested === "2025-06-18" || requested === "2025-03-26" || requested === "2024-11-05"
        ? requested
        : "2024-11-05"
    writeStdoutLine({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "pigu-builtin", version: "1.0.4" },
      },
    })
    return
  }

  if (method === "ping") {
    writeStdoutLine({ jsonrpc: "2.0", id, result: {} })
    return
  }

  if (method === "tools/list") {
    writeStdoutLine({ jsonrpc: "2.0", id, result: { tools: [] } })
    return
  }

  writeStdoutLine({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not available outside Pigu session: ${method}` },
  })
}

export async function runMcpStdioBridge(args: ReadonlyArray<string>): Promise<number> {
  if (args[0] === "--call") {
    const toolName = args[1]?.trim()
    const rawArgs = args[2]?.trim() || "{}"
    if (!toolName) {
      process.stderr.write("Usage: pigu mcp-bridge --call <tool_name> [json_args]\n")
      return 1
    }
    const callUrl = resolveActiveLeaseUrl("call")
    if (!callUrl) {
      process.stderr.write("No active Pigu MCP session found in environment.\n")
      return 1
    }
    const parsedArgs = Option.getOrElse(decodeJsonUnknown(rawArgs), () => ({}))
    const res = await postJson(callUrl, {
      name: toolName,
      arguments: isRecord(parsedArgs) ? parsedArgs : {},
    }).catch((err: unknown) => ({
      status: 500,
      text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
    }))
    process.stdout.write(`${res.text}\n`)
    return res.status >= 200 && res.status < 300 ? 0 : 1
  }

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  })

  let pending = Promise.resolve()

  rl.on("line", (line) => {
    const trimmed = line.trim()
    if (!trimmed) return

    pending = pending.then(async () => {
      const parsedOpt = decodeJsonUnknown(trimmed)
      if (Option.isNone(parsedOpt)) return
      const payload = parsedOpt.value

      const targetUrl = resolveActiveLeaseUrl("mcp")
      if (!targetUrl) {
        if (Array.isArray(payload)) {
          payload.forEach((entry) => {
            if (isRecord(entry)) handleIdleRpcMessage(entry)
          })
          return
        }
        if (isRecord(payload)) handleIdleRpcMessage(payload)
        return
      }

      const res = await postJson(targetUrl, payload).catch((err: unknown) => {
        if (isRecord(payload) && payload.id !== undefined) {
          writeStdoutLine({
            jsonrpc: "2.0",
            id: payload.id,
            error: {
              code: -32603,
              message: err instanceof Error ? err.message : String(err),
            },
          })
        }
        return undefined
      })

      if (!res || res.status === 202 || !res.text.trim()) return
      process.stdout.write(`${res.text.trim()}\n`)
    })
  })

  await new Promise<void>((resolve) => {
    rl.on("close", () => resolve())
  })
  await pending
  return 0
}
