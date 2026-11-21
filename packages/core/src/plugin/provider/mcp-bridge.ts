export * as BuiltinMcpBridge from "./mcp-bridge.js"

import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { Effect, Option, Schema } from "effect"
import { Agent } from "../../agent.js"
import { Mcp } from "../../mcp/index.js"
import { SessionMessage } from "../../session/message.js"
import { SessionSchema } from "../../session/schema.js"
import { Tool } from "../../tool.js"
import { definition, effectiveName, execute } from "../../tool/runtime.js"
import { loadActiveMemoriesPromptSync } from "../memory.js"

const LEASE_TTL_MS = 6 * 60 * 60 * 1000
const MAX_BODY_BYTES = 16 * 1024 * 1024

const decodeJsonUnknown = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
type CoreToolInfo = Effect.Success<ReturnType<Tool.Interface["list"]>>[number]

const LeaseEntrySchema = Schema.Struct({
  token: Schema.String,
  url: Schema.String,
  callUrl: Schema.String,
  pid: Schema.Number,
  cwd: Schema.String,
  expiresAt: Schema.Number,
})

const LeaseFileSchema = Schema.Struct({
  leases: Schema.Array(LeaseEntrySchema),
})

const decodeLeaseFile = Schema.decodeUnknownOption(Schema.fromJsonString(LeaseFileSchema))

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  return Option.isSome(Option.liftThrowable(() => process.kill(pid, 0))())
}

export function sanitizeMcpToolName(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_")
  return (cleaned || "tool").slice(0, 64)
}

export function shouldExposeCoreToolToMcp(tool: {
  readonly name: string
  readonly options?: Tool.Options
}): boolean {
  const ns = tool.options?.namespace
  if (ns === "sandbox" || ns === "memory") return true

  const fullName = effectiveName(tool)
  if (fullName.startsWith("opencode_artifact_")) return true

  if (ns === "browser" || ns?.startsWith("browser.")) {
    if (
      ns === "browser.trace" ||
      ns === "browser.cpu" ||
      ns === "browser.heap"
    ) {
      return false
    }
    return true
  }

  return false
}

function ensureObjectInputSchema(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema)) {
    return { type: "object", properties: {} }
  }
  if (schema.type === "object") return schema
  return {
    type: "object",
    properties: isRecord(schema.properties) ? schema.properties : {},
    ...(Array.isArray(schema.required) ? { required: schema.required } : {}),
  }
}

export type McpContentItem =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string }

export function formatCoreToolMcpContent(
  output: unknown,
  content: ReadonlyArray<Tool.Content>,
): readonly McpContentItem[] {
  const items: McpContentItem[] = []
  const seenTexts = new Set<string>()

  if (output !== undefined) {
    const serialized = typeof output === "string" ? output : JSON.stringify(output, null, 2)
    if (serialized) {
      seenTexts.add(serialized)
      items.push({ type: "text", text: serialized })
    }
  }

  content.forEach((part) => {
    if (part.type === "text") {
      if (part.text && !seenTexts.has(part.text)) {
        seenTexts.add(part.text)
        items.push({ type: "text", text: part.text })
      }
      return
    }
    if (part.type === "file" && part.mime.startsWith("image/")) {
      const match = /^data:([^;,]+);base64,(.+)$/s.exec(part.uri)
      if (match?.[1] && match[2]) {
        items.push({ type: "image", mimeType: match[1], data: match[2] })
      }
    }
  })

  if (items.length === 0) {
    return [{ type: "text", text: "OK" }]
  }
  return items
}

export type BridgeLease = {
  readonly token: string
  readonly mcpUrl: string
  readonly callUrl: string
  readonly stdioCommand: string
  readonly stdioArgs: readonly string[]
  readonly release: () => void
}

type ActiveLease = {
  readonly token: string
  readonly sessionID: string
  readonly cwd: string
  readonly home: string
  readonly expiresAt: number
  readonly onToolCall?: (toolName: string) => void
}

const STDIO_RELAY_SCRIPT = `#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveActiveUrl(mode) {
  const direct = mode === "call" ? process.env.PIGU_MCP_CALL_URL?.trim() : process.env.PIGU_MCP_URL?.trim();
  if (direct) return direct;
  const home = process.env.OPENCODE_TEST_HOME || os.homedir();
  const leasePath = path.join(home, ".cache", "pigu", "active-mcp-leases.json");
  if (!fs.existsSync(leasePath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(leasePath, "utf8"));
    const list = Array.isArray(parsed?.leases) ? parsed.leases : [];
    const now = Date.now();
    const cwd = process.cwd();
    const valid = list.filter((item) => item && item.expiresAt > now && isPidAlive(item.pid));
    if (valid.length === 0) return undefined;
    const matched =
      valid.findLast((item) => item.cwd === cwd) ??
      valid.findLast((item) => cwd.startsWith(item.cwd + path.sep) || item.cwd.startsWith(cwd + path.sep)) ??
      valid.at(-1);
    if (!matched) return undefined;
    return mode === "call" ? (matched.callUrl || matched.url.replace(/\\/mcp(\\?|$)/, "/call$1")) : matched.url;
  } catch {
    return undefined;
  }
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

function handleIdle(msg) {
  if (!msg || typeof msg !== "object" || msg.id === undefined) return;
  const method = typeof msg.method === "string" ? msg.method : "";
  if (method === "initialize") {
    const reqVer = msg.params?.protocolVersion;
    const protocolVersion =
      reqVer === "2025-06-18" || reqVer === "2025-03-26" || reqVer === "2024-11-05" ? reqVer : "2024-11-05";
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "pigu-builtin", version: "1.0.4" } }
    }) + "\\n");
    return;
  }
  if (method === "ping") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
    return;
  }
  if (method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id: msg.id,
    error: { code: -32601, message: "No active Pigu session" }
  }) + "\\n");
}

const args = process.argv.slice(2);
if (args[0] === "--call") {
  const toolName = args[1]?.trim();
  const rawArgs = args[2]?.trim() || "{}";
  const callUrl = resolveActiveUrl("call");
  if (!toolName || !callUrl) {
    process.stderr.write("Usage: mcp-stdio --call <tool> [json] (requires active Pigu session)\\n");
    process.exit(1);
  }
  const parsedArgs = JSON.parse(rawArgs);
  const res = await postJson(callUrl, { name: toolName, arguments: parsedArgs });
  process.stdout.write(res.text + "\\n");
  process.exit(res.status >= 200 && res.status < 300 ? 0 : 1);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let chain = Promise.resolve();
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  chain = chain.then(async () => {
    let payload;
    try { payload = JSON.parse(trimmed); } catch { return; }
    const url = resolveActiveUrl("mcp");
    if (!url) {
      if (Array.isArray(payload)) payload.forEach(handleIdle);
      else handleIdle(payload);
      return;
    }
    try {
      const res = await postJson(url, payload);
      if (res.status !== 202 && res.text.trim()) {
        process.stdout.write(res.text.trim() + "\\n");
      }
    } catch (err) {
      if (payload && !Array.isArray(payload) && payload.id !== undefined) {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          error: { code: -32603, message: err instanceof Error ? err.message : String(err) }
        }) + "\\n");
      }
    }
  });
});
`

function resolveStdioLauncher(home: string): { readonly command: string; readonly args: readonly string[] } {
  const exeBase = path.basename(process.execPath).replace(/\.exe$/i, "").toLowerCase()
  const isRuntimeExe = exeBase === "bun" || exeBase === "node" || exeBase.startsWith("bun-")
  if (!isRuntimeExe) {
    return { command: process.execPath, args: ["mcp-bridge"] }
  }
  const cacheDir = path.join(home, ".cache", "pigu")
  const scriptPath = path.join(cacheDir, "pigu-mcp-stdio.mjs")
  Option.liftThrowable(() => {
    fs.mkdirSync(cacheDir, { recursive: true })
    const existing = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, "utf8") : ""
    if (existing !== STDIO_RELAY_SCRIPT) {
      fs.writeFileSync(scriptPath, STDIO_RELAY_SCRIPT, { encoding: "utf8", mode: 0o755 })
    }
  })()
  return { command: process.execPath, args: [scriptPath] }
}

function updateLeaseFile(
  home: string,
  mutate: (current: ReadonlyArray<typeof LeaseEntrySchema.Type>) => ReadonlyArray<typeof LeaseEntrySchema.Type>,
) {
  Option.liftThrowable(() => {
    const cacheDir = path.join(home, ".cache", "pigu")
    fs.mkdirSync(cacheDir, { recursive: true })
    const leasePath = path.join(cacheDir, "active-mcp-leases.json")
    const raw = fs.existsSync(leasePath) ? fs.readFileSync(leasePath, "utf8") : ""
    const decoded = raw ? Option.getOrUndefined(decodeLeaseFile(raw)) : undefined
    const now = Date.now()
    const alive = (decoded?.leases ?? []).filter((item) => item.expiresAt > now && isPidAlive(item.pid))
    const next = mutate(alive)
    fs.writeFileSync(leasePath, `${JSON.stringify({ leases: next }, null, 2)}\n`, "utf8")
  })()
}

export function ensureAgyMcpConfig(home: string, stdioCommand: string, stdioArgs: readonly string[]) {
  Option.liftThrowable(() => {
    const configDir = path.join(home, ".gemini", "config")
    const configPath = path.join(configDir, "mcp_config.json")
    fs.mkdirSync(configDir, { recursive: true })

    const rawText = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8").trim() : ""
    const parsedOpt = rawText ? decodeJsonUnknown(rawText) : Option.none()
    const root = Option.isSome(parsedOpt) && isRecord(parsedOpt.value) ? { ...parsedOpt.value } : {}
    const servers = isRecord(root.mcpServers) ? { ...root.mcpServers } : {}

    const currentEntry = isRecord(servers.pigu) ? servers.pigu : undefined
    const sameCommand = currentEntry?.command === stdioCommand
    const sameArgs =
      Array.isArray(currentEntry?.args) &&
      currentEntry.args.length === stdioArgs.length &&
      currentEntry.args.every((val, idx) => val === stdioArgs[idx])
    const sameEnabled = currentEntry?.disabled !== true

    if (sameCommand && sameArgs && sameEnabled) return

    servers.pigu = {
      command: stdioCommand,
      args: [...stdioArgs],
      disabled: false,
    }
    root.mcpServers = servers
    fs.writeFileSync(configPath, `${JSON.stringify(root, null, 2)}\n`, "utf8")
  })()
}

export type BridgeServer = {
  readonly acquireLease: (input: {
    readonly sessionID: string
    readonly cwd: string
    readonly home: string
    readonly onToolCall?: (toolName: string) => void
  }) => Promise<BridgeLease>
  readonly close: () => Promise<void>
}

export function createBridgeServer(deps: {
  readonly runEffect: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>
  readonly toolService?: Tool.Interface
  readonly mcpService?: Mcp.Interface
  readonly dataDir?: string
  readonly homeDir?: string
}): BridgeServer {
  const leases = new Map<string, ActiveLease>()
  let serverPromise: Promise<{ server: http.Server; port: number }> | undefined

  const listCatalog = async () => {
    type ResolvedEntry =
      | {
          readonly kind: "core"
          readonly mcpName: string
          readonly description: string
          readonly inputSchema: Record<string, unknown>
          readonly tool: CoreToolInfo
        }
      | {
          readonly kind: "mcp"
          readonly mcpName: string
          readonly description: string
          readonly inputSchema: Record<string, unknown>
          readonly server: string
          readonly remoteName: string
        }

    const entries = new Map<string, ResolvedEntry>()

    if (deps.toolService) {
      const coreTools = await deps.runEffect(deps.toolService.list())
      coreTools.forEach((tool) => {
        if (!shouldExposeCoreToolToMcp(tool)) return
        const def = definition(tool)
        const mcpName = sanitizeMcpToolName(def.name)
        entries.set(mcpName, {
          kind: "core",
          mcpName,
          description: def.description,
          inputSchema: ensureObjectInputSchema(def.inputSchema),
          tool,
        })
      })
    }

    if (deps.mcpService) {
      await deps.runEffect(deps.mcpService.awaitStartup()).catch(() => undefined)
      const mcpTools = await deps.runEffect(deps.mcpService.tools()).catch((): Mcp.Tool[] => [])
      mcpTools.forEach((mcpTool) => {
        if (mcpTool.server === "pigu" || mcpTool.server === "pigu-builtin") return
        const mcpName = sanitizeMcpToolName(`${mcpTool.server}_${mcpTool.name}`)
        if (entries.has(mcpName)) return
        entries.set(mcpName, {
          kind: "mcp",
          mcpName,
          description: mcpTool.description ?? `MCP tool ${mcpTool.name} from ${mcpTool.server}`,
          inputSchema: ensureObjectInputSchema(mcpTool.inputSchema),
          server: mcpTool.server,
          remoteName: mcpTool.name,
        })
      })
    }

    return entries
  }

  const executeCall = async (
    lease: ActiveLease,
    toolName: string,
    rawArgs: Record<string, unknown>,
  ): Promise<{ readonly isError?: boolean; readonly content: readonly McpContentItem[] }> => {
    const catalog = await listCatalog()
    const target = catalog.get(toolName)
    if (!target) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown Pigu MCP tool: ${toolName}` }],
      }
    }

    lease.onToolCall?.(toolName)
    const effectiveSessionID = SessionSchema.ID.make(lease.sessionID || "ses_local_mcp")

    if (target.kind === "core") {
      const callID = Tool.CallID.make(`call_mcp_${crypto.randomUUID().slice(0, 12)}`)
      const messageID = SessionMessage.ID.make(`msg_mcp_${crypto.randomUUID().slice(0, 12)}`)
      const toolContext: Tool.Context = {
        id: callID,
        sessionID: effectiveSessionID,
        messageID,
        agent: Agent.ID.make("build"),
        progress: () => Effect.void,
      }

      const outcome = await deps.runEffect(
        execute(target.tool, rawArgs, toolContext).pipe(
          Effect.map((res) => ({
            isError: false as const,
            content: formatCoreToolMcpContent(res.output, res.content),
          })),
          Effect.catchTag("Tool.Error", (err) =>
            Effect.succeed({
              isError: true as const,
              content: [{ type: "text" as const, text: err.message }],
            }),
          ),
        ),
      ).catch((err: unknown) => ({
        isError: true as const,
        content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
      }))

      return outcome
    }

    if (!deps.mcpService) {
      return {
        isError: true,
        content: [{ type: "text", text: "MCP service is unavailable." }],
      }
    }

    return deps
      .runEffect(
        deps.mcpService
          .callTool({
            server: target.server,
            name: target.remoteName,
            args: rawArgs,
            sessionID: effectiveSessionID,
          })
          .pipe(
            Effect.map((res) => ({
              ...(res.isError ? { isError: true } : {}),
              content: res.content.flatMap((part): McpContentItem[] => {
                if (part.type === "text") return [{ type: "text", text: part.text }]
                if (part.type === "media" && part.mimeType.startsWith("image/")) {
                  return [{ type: "image", data: part.data, mimeType: part.mimeType }]
                }
                return [{ type: "text", text: JSON.stringify(part) }]
              }),
            })),
            Effect.catch((err) =>
              Effect.succeed({
                isError: true as const,
                content: [{ type: "text" as const, text: err.message }],
              }),
            ),
          ),
      )
      .catch((err: unknown) => ({
        isError: true as const,
        content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
      }))
  }

  const handleSingleJsonRpc = async (
    lease: ActiveLease,
    msg: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined> => {
    const id = msg.id
    const method = typeof msg.method === "string" ? msg.method : ""
    if (id === undefined) return undefined

    if (method === "initialize") {
      const params = isRecord(msg.params) ? msg.params : {}
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-03-26"
      const protocolVersion =
        requested === "2025-06-18" || requested === "2025-03-26" || requested === "2024-11-05"
          ? requested
          : "2025-03-26"
      const baseInstructions =
        "Pigu Workbench Built-in MCP: use sandbox_preview to live-render interactive HTML, React (TSX/JSX + Tailwind + Lucide + Recharts), or SVG UI directly in Pigu's right-hand Sandbox panel; use memory_save / memory_list / memory_delete to persist or inspect explicit cross-session memories in Pigu Visual Memory; use browser_* tools to open, inspect, click, fill, and screenshot pages in Pigu's right-hand Chromium browser."
      const activeMemories = loadActiveMemoriesPromptSync(deps.dataDir, lease.cwd, deps.homeDir)
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "pigu-builtin", version: "1.0.4" },
          instructions: activeMemories ? `${baseInstructions}\n\n${activeMemories}` : baseInstructions,
        },
      }
    }

    if (method === "ping") {
      return { jsonrpc: "2.0", id, result: {} }
    }

    if (method === "tools/list") {
      const catalog = await listCatalog()
      const tools = [...catalog.values()].map((item) => ({
        name: item.mcpName,
        description: item.description,
        inputSchema: item.inputSchema,
      }))
      return { jsonrpc: "2.0", id, result: { tools } }
    }

    if (method === "tools/call") {
      const params = isRecord(msg.params) ? msg.params : {}
      const toolName = typeof params.name === "string" ? params.name : ""
      const toolArgs = isRecord(params.arguments) ? params.arguments : {}
      if (!toolName) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "Missing tool name in tools/call" },
        }
      }
      const result = await executeCall(lease, toolName, toolArgs)
      return { jsonrpc: "2.0", id, result }
    }

    if (method === "resources/list") {
      return { jsonrpc: "2.0", id, result: { resources: [] } }
    }

    if (method === "prompts/list") {
      return { jsonrpc: "2.0", id, result: { prompts: [] } }
    }

    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    }
  }

  const readRequestBody = (req: http.IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let total = 0
      req.on("data", (chunk: Buffer) => {
        total += chunk.length
        if (total > MAX_BODY_BYTES) {
          reject(new Error("Request body too large"))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
      req.on("error", reject)
    })

  const ensureServer = () => {
    if (serverPromise) return serverPromise
    serverPromise = new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        void (async () => {
          const parsedUrl = new URL(req.url ?? "/", "http://127.0.0.1")
          const token =
            parsedUrl.searchParams.get("token") ??
            (/^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1]?.trim() || "")
          const lease = token ? leases.get(token) : undefined
          if (!lease || lease.expiresAt < Date.now()) {
            if (token) leases.delete(token)
            res.writeHead(401, { "content-type": "application/json" })
            res.end(JSON.stringify({ error: "Unauthorized or expired Pigu MCP lease" }))
            return
          }

          if (req.method === "GET") {
            res.writeHead(405, { allow: "POST, DELETE" })
            res.end()
            return
          }

          if (req.method === "DELETE") {
            res.writeHead(200)
            res.end()
            return
          }

          if (req.method !== "POST") {
            res.writeHead(405, { allow: "POST, DELETE" })
            res.end()
            return
          }

          const bodyText = await readRequestBody(req)
          const parsedBodyOpt = decodeJsonUnknown(bodyText)
          if (Option.isNone(parsedBodyOpt)) {
            res.writeHead(400, { "content-type": "application/json" })
            res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }))
            return
          }
          const body = parsedBodyOpt.value

          if (parsedUrl.pathname === "/call") {
            if (!isRecord(body) || typeof body.name !== "string") {
              res.writeHead(400, { "content-type": "application/json" })
              res.end(JSON.stringify({ error: "Expected { name, arguments }" }))
              return
            }
            const callArgs = isRecord(body.arguments) ? body.arguments : {}
            const outcome = await executeCall(lease, body.name, callArgs)
            res.writeHead(outcome.isError ? 400 : 200, { "content-type": "application/json" })
            res.end(JSON.stringify(outcome))
            return
          }

          if (Array.isArray(body)) {
            const responses = (
              await Promise.all(
                body.map((entry) => (isRecord(entry) ? handleSingleJsonRpc(lease, entry) : Promise.resolve(undefined))),
              )
            ).filter((item): item is Record<string, unknown> => item !== undefined)

            if (responses.length === 0) {
              res.writeHead(202)
              res.end()
              return
            }
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify(responses))
            return
          }

          if (!isRecord(body)) {
            res.writeHead(400, { "content-type": "application/json" })
            res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }))
            return
          }

          const reply = await handleSingleJsonRpc(lease, body)
          if (!reply) {
            res.writeHead(202)
            res.end()
            return
          }
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify(reply))
        })().catch((err: unknown) => {
          if (!res.headersSent) {
            res.writeHead(500, { "content-type": "application/json" })
          }
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
            }),
          )
        })
      })

      srv.unref()
      srv.once("error", reject)
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address()
        if (!addr || typeof addr === "string") {
          reject(new Error("Failed to bind Pigu MCP loopback server"))
          return
        }
        resolve({ server: srv, port: addr.port })
      })
    })
    return serverPromise
  }

  return {
    async acquireLease(input) {
      const { port } = await ensureServer()
      const token = crypto.randomUUID()
      const expiresAt = Date.now() + LEASE_TTL_MS
      const mcpUrl = `http://127.0.0.1:${port}/mcp?token=${encodeURIComponent(token)}`
      const callUrl = `http://127.0.0.1:${port}/call?token=${encodeURIComponent(token)}`
      const stdio = resolveStdioLauncher(input.home)

      const lease: ActiveLease = {
        token,
        sessionID: input.sessionID,
        cwd: input.cwd,
        home: input.home,
        expiresAt,
        onToolCall: input.onToolCall,
      }
      leases.set(token, lease)

      updateLeaseFile(input.home, (current) => [
        ...current,
        {
          token,
          url: mcpUrl,
          callUrl,
          pid: process.pid,
          cwd: input.cwd,
          expiresAt,
        },
      ])

      let released = false
      const release = () => {
        if (released) return
        released = true
        leases.delete(token)
        updateLeaseFile(input.home, (current) => current.filter((item) => item.token !== token))
      }

      return {
        token,
        mcpUrl,
        callUrl,
        stdioCommand: stdio.command,
        stdioArgs: stdio.args,
        release,
      }
    },
    async close() {
      leases.clear()
      if (!serverPromise) return
      const current = await serverPromise.catch(() => undefined)
      serverPromise = undefined
      if (!current) return
      await new Promise<void>((resolve) => {
        current.server.close(() => resolve())
      })
    },
  }
}
