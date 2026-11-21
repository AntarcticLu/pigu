import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import {
  MemoryPlugin,
  formatMemoriesInstruction,
  parseExternalMarkdownToMemories,
  selectActiveMemories,
  toClaudeProjectSlug,
} from "@opencode/core/plugin/memory"
import { createBridgeServer, shouldExposeCoreToolToMcp } from "@opencode/core/plugin/provider/mcp-bridge"
import { Rpc } from "@opencode/core/rpc"
import { Tool } from "@opencode/core/tool"
import type { Memory } from "@opencode/schema/memory"
import { Global } from "@opencode/util/global"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)

describe("MemoryPlugin and Visual Long-Term Memory", () => {
  test("exposes memory namespace tools to BuiltinMcpBridge", () => {
    expect(shouldExposeCoreToolToMcp({ name: "save", options: { namespace: "memory", codemode: true } })).toBe(true)
    expect(shouldExposeCoreToolToMcp({ name: "list", options: { namespace: "memory", codemode: true } })).toBe(true)
    expect(shouldExposeCoreToolToMcp({ name: "delete", options: { namespace: "memory", codemode: true } })).toBe(true)
  })

  test("selects enabled global and matching project memories in deterministic cache-friendly order", () => {
    const items: Memory.Item[] = [
      {
        id: "mem_proj_1",
        scope: "project",
        directory: "/work/repo-a",
        title: "Run bun check",
        content: "Always run bun run check before committing.",
        category: "convention",
        tags: ["ci"],
        enabled: true,
        createdAt: 20,
        updatedAt: 20,
      },
      {
        id: "mem_other_proj",
        scope: "project",
        directory: "/work/repo-b",
        title: "Other repo rule",
        content: "Should not match repo-a.",
        category: "context",
        tags: [],
        enabled: true,
        createdAt: 15,
        updatedAt: 15,
      },
      {
        id: "mem_global_disabled",
        scope: "global",
        title: "Disabled pref",
        content: "Muted by user.",
        category: "preference",
        tags: [],
        enabled: false,
        createdAt: 5,
        updatedAt: 5,
      },
      {
        id: "mem_global_1",
        scope: "global",
        title: "Concise Chinese replies",
        content: "Respond concisely in Chinese Markdown.",
        category: "preference",
        tags: ["lang"],
        enabled: true,
        createdAt: 10,
        updatedAt: 10,
      },
      {
        id: "mem_proj_pinned",
        scope: "project",
        directory: "/work/repo-a",
        title: "Core schema rule",
        content: "Keep dependencies directed from Schema to Core.",
        category: "architecture",
        tags: [],
        enabled: true,
        pinned: true,
        createdAt: 30,
        updatedAt: 30,
      },
    ]

    const active = selectActiveMemories(items, "/work/repo-a/packages/app", "/work/repo-a")
    expect(active.map((item) => item.id)).toEqual(["mem_proj_pinned", "mem_global_1", "mem_proj_1"])

    const prompt = formatMemoriesInstruction(active)
    expect(prompt).toContain("<long_term_memory>")
    expect(prompt).toContain("### Global Memory")
    expect(prompt).toContain("### Project Memory")
    expect(prompt).toContain("Concise Chinese replies")
    expect(prompt).toContain("Core schema rule")
    expect(prompt).not.toContain("Other repo rule")
    expect(prompt).not.toContain("Disabled pref")
  })

  test("parses Claude Code YAML frontmatter memory files and Markdown heading files", () => {
    const claudeMd = [
      "---",
      "name: seedance-gateway-quirks",
      'description: "Field formats and pricing for gateway video API"',
      "metadata:",
      "  node_type: memory",
      "  type: reference",
      "---",
      "",
      "reference_images must be plain URL strings.",
    ].join("\n")

    const parsedClaude = parseExternalMarkdownToMemories({
      content: claudeMd,
      fallbackTitle: "seedance",
      scope: "project",
      directory: "/work/video",
      source: "imported:claude-memory",
      now: 1000,
    })

    expect(parsedClaude).toHaveLength(1)
    expect(parsedClaude[0]?.title).toBe("seedance-gateway-quirks")
    expect(parsedClaude[0]?.category).toBe("reference")
    expect(parsedClaude[0]?.content).toContain("Field formats and pricing")
    expect(parsedClaude[0]?.content).toContain("plain URL strings")

    const agentsMd = [
      "# Project Rules",
      "Keep runtime dependencies clean.",
      "## Testing",
      "Never use global mocks; run bun test from package directory.",
    ].join("\n")

    const parsedAgents = parseExternalMarkdownToMemories({
      content: agentsMd,
      fallbackTitle: "AGENTS",
      scope: "project",
      directory: "/work/pigu",
      source: "imported:agents-md",
      now: 2000,
    })

    expect(parsedAgents).toHaveLength(2)
    expect(parsedAgents[0]?.title).toBe("Project Rules")
    expect(parsedAgents[1]?.title).toBe("Testing")
    expect(parsedAgents[1]?.category).toBe("convention")
    expect(toClaudeProjectSlug("/Volumes/AntL/pigu/pigu")).toBe("-Volumes-AntL-pigu-pigu")
  })

  it.live("persists memories, updates InstructionDiscovery live, and exposes memory tools + instructions via MCP bridge", () =>
    Effect.gen(function* () {
      const global = yield* Global.Service
      const discovery = yield* InstructionDiscovery.Service
      const plugin = yield* Plugin.Service
      const rpc = yield* Rpc.Service
      const host = yield* PluginHost.make(plugin, "memory-mcp-test")
      yield* MemoryPlugin.Plugin.effect(host)

      const toolService = yield* Tool.Service
      const context = yield* Effect.context<never>()
      const runPromise = Effect.runPromiseWith(context)

      const bridge = createBridgeServer({
        runEffect: (eff) => runPromise(eff),
        toolService,
        dataDir: global.data,
        homeDir: global.home,
      })

      const tempHome = yield* Effect.promise(() =>
        fs.promises.mkdtemp(path.join(process.env.TMPDIR || "/tmp", "mem-bridge-")),
      )

      const verify = async () => {
        const lease = await bridge.acquireLease({
          sessionID: "ses_mem_live_1",
          cwd: process.cwd(),
          home: tempHome,
        })

        try {
          const listRes = await fetch(lease.mcpUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
          })
          const listJson = (await listRes.json()) as { result: { tools: Array<{ name: string }> } }
          const names = listJson.result.tools.map((t) => t.name)
          expect(names).toContain("memory_save")
          expect(names).toContain("memory_list")
          expect(names).toContain("memory_delete")

          const saveRes = await fetch(lease.mcpUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: {
                name: "memory_save",
                arguments: {
                  title: "Prefer concise Chinese output",
                  content: "Always answer concisely in Chinese with clickable file links.",
                  scope: "global",
                  category: "preference",
                  tags: ["style"],
                },
              },
            }),
          })
          const saveJson = (await saveRes.json()) as {
            result: { isError?: boolean; content: Array<{ type: string; text: string }> }
          }
          expect(saveJson.result.isError).toBe(false)
          const saved = JSON.parse(saveJson.result.content[0]!.text) as Memory.Item
          expect(saved.id.startsWith("mem_")).toBe(true)
          expect(saved.scope).toBe("global")
          expect(saved.fileName?.endsWith(".md")).toBe(true)
          expect(saved.filePath ? fs.existsSync(saved.filePath) : false).toBe(true)

          const initRes = await fetch(lease.mcpUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 3,
              method: "initialize",
              params: { protocolVersion: "2025-03-26" },
            }),
          })
          const initJson = (await initRes.json()) as { result: { instructions: string } }
          expect(initJson.result.instructions).toContain("<long_term_memory>")
          expect(initJson.result.instructions).toContain("Prefer concise Chinese output")

          const discovered = await runPromise(discovery.list())
          if (Array.isArray(discovered) && discovery.global) {
            const virtual = discovered.find((f) => f.path === "pigu://memory/active")
            expect(virtual?.content).toContain("Prefer concise Chinese output")
          }

          const projItem = (await runPromise(
            rpc.call("opencode.memory", "upsert", {
              scope: "project",
              directory: "/work/project-alpha",
              title: "Alpha architecture rule",
              content: "Keep schema and core separated.",
              category: "architecture",
            }),
          )) as Memory.Item
          expect(projItem.scope).toBe("project")

          const globalSnap = (await runPromise(
            rpc.call("opencode.memory", "snapshot", { scope: "global" }),
          )) as Memory.Snapshot
          expect(globalSnap.items.map((item) => item.id)).toEqual([saved.id])
          expect(globalSnap.externalFiles.every((file) => file.scope === "global")).toBe(true)

          const alphaSnap = (await runPromise(
            rpc.call("opencode.memory", "snapshot", { scope: "project", directory: "/work/project-alpha" }),
          )) as Memory.Snapshot
          expect(alphaSnap.items.map((item) => item.id)).toEqual([projItem.id])
          expect(alphaSnap.externalFiles.every((file) => file.scope === "project")).toBe(true)

          const betaSnap = (await runPromise(
            rpc.call("opencode.memory", "snapshot", { scope: "project", directory: "/work/project-beta" }),
          )) as Memory.Snapshot
          expect(betaSnap.items).toHaveLength(0)

          const combinedAlphaSnap = (await runPromise(
            rpc.call("opencode.memory", "snapshot", { directory: "/work/project-alpha" }),
          )) as Memory.Snapshot
          expect(combinedAlphaSnap.items.map((item) => item.scope).toSorted()).toEqual(["global", "project"])

          const projMemIndex = path.join(global.home, ".claude", "projects", "-work-project-alpha", "memory", "MEMORY.md")
          expect(fs.existsSync(projMemIndex)).toBe(true)
          expect(fs.readFileSync(projMemIndex, "utf8")).toContain("Alpha architecture rule")

          await runPromise(rpc.call("opencode.memory", "remove", { id: projItem.id }))
          expect(projItem.filePath ? fs.existsSync(projItem.filePath) : true).toBe(false)

          const delRes = await fetch(lease.mcpUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 4,
              method: "tools/call",
              params: { name: "memory_delete", arguments: { id: saved.id } },
            }),
          })
          const delJson = (await delRes.json()) as {
            result: { content: Array<{ type: string; text: string }> }
          }
          expect(JSON.parse(delJson.result.content[0]!.text)).toEqual({ id: saved.id, deleted: true })
        } finally {
          lease.release()
          await bridge.close()
          await fs.promises.rm(path.join(global.data, "memories"), { recursive: true, force: true })
          await fs.promises.rm(path.join(global.data, "pigu-memory-state.json"), { force: true })
          await fs.promises.rm(tempHome, { recursive: true, force: true })
        }
      }

      yield* Effect.promise(verify)
    }),
  )
})
