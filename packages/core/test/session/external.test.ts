import SqliteDatabase from "bun:sqlite"
import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import fs from "fs/promises"
import zlib from "node:zlib"
import path from "path"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { KVTable } from "@opencode/core/kv/sql"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Project } from "@opencode/core/project"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionExternal } from "@opencode/core/session/external"
import { SessionExternalParse } from "@opencode/core/session/external-parse"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { toLLMMessages } from "@opencode/core/session/runner/to-llm-message"
import { SessionMessageTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { AbsolutePath } from "@opencode/core/schema"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { tempGlobalLayer } from "../fixture/global"
import { promptLocationNode } from "../fixture/prompt-location"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { globalProjectNode } from "../lib/project"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      Session.node,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      Global.node.replace(tempGlobalLayer),
      Project.node.replace(globalProjectNode),
      LocationServiceMap.node.replace(promptLocationNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
    ],
  ),
)

const withTestHome = <A, E, R>(home: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.OPENCODE_TEST_HOME
      process.env.OPENCODE_TEST_HOME = home
      SessionExternal.resetForTesting()
      return prev
    }),
    () => effect,
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) {
          delete process.env.OPENCODE_TEST_HOME
        }
        if (prev !== undefined) {
          process.env.OPENCODE_TEST_HOME = prev
        }
        SessionExternal.resetForTesting()
      }),
  )

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

describe("SessionExternal rich import, compaction, and lazy backfill", () => {
  it.live(
    "imports Antigravity WAL summary DB, CHECKPOINT compaction, thinking, paired tool diffs, and media without GENERIC spam",
    () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped("ext-agy-")
        const home = path.join(tmp.path, "home")
        const repoDir = path.join(tmp.path, "workspace", "my-app")
        const agyRoot = path.join(home, ".gemini", "antigravity")
        const convID = "1b6c89f2-e4b9-4d8e-b824-eeccf36604c2"
        const logDir = path.join(agyRoot, "brain", convID, ".system_generated", "logs")
        const imgPath = path.join(agyRoot, "brain", convID, "ui-shot.png")

        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(repoDir, ".git"), { recursive: true })
          await fs.mkdir(logDir, { recursive: true })
          await fs.writeFile(imgPath, Buffer.from(TINY_PNG_BASE64, "base64"))

          const summaryDbPath = path.join(agyRoot, "conversation_summaries.db")
          const sqlite = new SqliteDatabase(summaryDbPath)
          sqlite.exec("PRAGMA journal_mode = WAL;")
          sqlite.exec(
            "CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, preview TEXT, workspace_uris TEXT, last_modified_time TEXT);",
          )
          sqlite
            .prepare(
              "INSERT INTO conversation_summaries (conversation_id, title, preview, workspace_uris, last_modified_time) VALUES (?, ?, ?, ?, ?)",
            )
            .run(
              convID,
              "Custom AI Coding Assistant Development",
              "Summary text",
              JSON.stringify([`file://${repoDir}`]),
              "2026-11-12T10:00:00Z",
            )
          sqlite.close()

          const lines = [
            JSON.stringify({
              step_index: 1,
              type: "USER_INPUT",
              source: "USER_EXPLICIT",
              created_at: "2026-11-12T09:50:00Z",
              content: `<USER_REQUEST>\nInitial setup task\n</USER_REQUEST>`,
            }),
            JSON.stringify({
              step_index: 2,
              type: "PLANNER_RESPONSE",
              source: "MODEL",
              created_at: "2026-11-12T09:51:00Z",
              content: "Initial setup completed.",
            }),
            JSON.stringify({
              step_index: 3,
              type: "CHECKPOINT",
              source: "SYSTEM",
              status: "DONE",
              created_at: "2026-11-12T09:55:00Z",
              input_tokens: 256800,
              output_tokens: 4700,
              cache_read_tokens: 180000,
              content:
                "# Resuming from a compaction\n\nYou are continuing work on the task described above, and need to resume work using the summary below:\n\n<summary>\nBuild rich external session sync\nImplemented initial scaffolding and analyzed session transcript schemas.\n</summary>\n\n# Conversation Logs\nStart with the compact transcript: transcript.jsonl",
            }),
            JSON.stringify({
              step_index: 4,
              type: "USER_INPUT",
              source: "USER_EXPLICIT",
              created_at: "2026-11-12T09:56:00Z",
              content: `<USER_REQUEST>\nFix the button alignment shown in the screenshot\n</USER_REQUEST>`,
              media: [{ mime_type: "image/png", uri: imgPath }],
            }),
            JSON.stringify({
              step_index: 5,
              type: "PLANNER_RESPONSE",
              source: "MODEL",
              created_at: "2026-11-12T09:57:00Z",
              thinking: "Inspecting layout styles and updating button padding.",
              content: "Updating the button component and running verification.",
              tool_calls: [
                {
                  id: "call_cmd_1",
                  name: "run_command",
                  args: {
                    CommandLine: "bun run typecheck",
                    toolSummary: "Run package typecheck",
                  },
                },
                {
                  id: "call_edit_1",
                  name: "edit_file",
                  args: {
                    Path: `${repoDir}/src/Button.tsx`,
                    Target: "const pad = 4\n",
                    Replacement: "const pad = 8\nconst gap = 2\n",
                  },
                },
              ],
            }),
            JSON.stringify({
              step_index: 6,
              type: "GENERIC",
              source: "MODEL",
              created_at: "2026-11-12T09:57:05Z",
              content:
                "Created At: 2026-11-12T09:57:01Z\nCompleted At: 2026-11-12T09:57:05Z\nCommand exited with code 0.\n\nCommand output:\nChecked 42 files, 0 errors",
            }),
            JSON.stringify({
              step_index: 7,
              type: "GENERIC",
              source: "MODEL",
              created_at: "2026-11-12T09:57:06Z",
              content:
                "Created At: 2026-11-12T09:57:05Z\nCompleted At: 2026-11-12T09:57:06Z\nMade 1 replacement in Button.tsx",
            }),
          ]

          await fs.writeFile(path.join(logDir, "transcript_full.jsonl"), `${lines.join("\n")}\n`, "utf8")
        })

        yield* withTestHome(
          home,
          Effect.gen(function* () {
            const session = yield* Session.Service
            const listed = yield* session.list({ limit: 20 })
            const expectedID = SessionExternal.makeSessionID("agy", convID)
            const imported = listed.data.find((item) => item.id === expectedID)

            expect(imported).toBeDefined()
            expect(imported?.title).toBe("Custom AI Coding Assistant Development")
            expect(imported?.location.directory).toBe(AbsolutePath.make(repoDir))

            const messagesDesc = yield* session.messages({ sessionID: expectedID, order: "desc", limit: 20 })
            const messages = messagesDesc.toReversed()

            // Exactly 5 timeline items: pre-compact user, pre-compact assistant, compaction, post-compact user, post-compact assistant (zero GENERIC bubbles!)
            expect(messages.map((m) => m.type)).toEqual(["user", "assistant", "compaction", "user", "assistant"])

            const compactionMsg = messages[2]
            expect(compactionMsg?.type).toBe("compaction")
            if (compactionMsg?.type === "compaction" && compactionMsg.status === "completed") {
              expect(compactionMsg.summary).toContain("Build rich external session sync")
              expect(compactionMsg.summary).toContain("Implemented initial scaffolding")
              expect(compactionMsg.summary).not.toContain("# Conversation Logs")
              expect(compactionMsg.tokens?.input).toBe(256800)
              expect(compactionMsg.tokens?.output).toBe(4700)
            }

            const postUser = messages[3]
            expect(postUser?.type).toBe("user")
            if (postUser?.type === "user") {
              expect(postUser.text).toBe("Fix the button alignment shown in the screenshot")
              expect(postUser.files?.length).toBe(1)
              expect(postUser.files?.[0]?.mime).toBe("image/png")
            }

            const postAssistant = messages[4]
            expect(postAssistant?.type).toBe("assistant")
            if (postAssistant?.type === "assistant") {
              const reasoning = postAssistant.content.find((p) => p.type === "reasoning")
              expect(reasoning?.type === "reasoning" ? reasoning.text : "").toContain("Inspecting layout styles")
              expect(reasoning?.type === "reasoning" ? reasoning.time : undefined).toBeUndefined()

              const tools = postAssistant.content.filter((p) => p.type === "tool")
              expect(tools.map((t) => t.name)).toEqual(["shell", "edit"])

              const shellTool = tools[0]
              if (shellTool?.type === "tool" && shellTool.state.status === "completed") {
                const firstPart = shellTool.state.content[0]
                expect(firstPart?.type === "text" ? firstPart.text : "").toBe("Checked 42 files, 0 errors")
              }

              const editTool = tools[1]
              if (editTool?.type === "tool" && editTool.state.status === "completed") {
                const files = editTool.state.metadata?.files
                const diffMeta = Array.isArray(files) ? files[0] : undefined
                expect(diffMeta).toBeDefined()
                if (diffMeta && typeof diffMeta === "object" && "additions" in diffMeta && "deletions" in diffMeta) {
                  expect(diffMeta.additions).toBe(2)
                  expect(diffMeta.deletions).toBe(1)
                }
              }
            }

            // Verify Session.context bounds cleanly at the compaction checkpoint and lowers cleanly to LLM messages
            const ctxMessages = yield* session.context(expectedID)
            expect(ctxMessages.map((m) => m.type)).toEqual(["compaction", "user", "assistant"])

            const lowered = toLLMMessages(ctxMessages, {
              providerID: Provider.ID.make("openai"),
              id: Model.ID.make("gpt-5"),
            })
            expect(lowered.length).toBeGreaterThanOrEqual(4)
            const firstLowered = lowered[0]
            expect(firstLowered?.role).toBe("user")
            expect(JSON.stringify(firstLowered)).toContain("<conversation-checkpoint>")
          }),
        )
      }),
  )

  it.live("imports Claude ai-title, compact_boundary + isCompactSummary, and multi-chunk tool_use/tool_result", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped("ext-claude-")
      const home = path.join(tmp.path, "home")
      const repoDir = path.join(tmp.path, "claude-project")
      const encodedFolder = repoDir.replaceAll("/", "-")
      const claudeSessionDir = path.join(home, ".claude", "projects", encodedFolder)
      const claudeSessionID = "9b2f5a10-1234-4abc-8def-001122334455"

      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(repoDir, ".git"), { recursive: true })
        await fs.mkdir(claudeSessionDir, { recursive: true })

        const lines = [
          JSON.stringify({
            type: "user",
            cwd: repoDir,
            timestamp: "2026-11-12T08:00:00Z",
            message: { role: "user", content: "Explore old architecture" },
          }),
          JSON.stringify({
            type: "assistant",
            cwd: repoDir,
            timestamp: "2026-11-12T08:01:00Z",
            message: { id: "msg_old_1", model: "claude-sonnet-4-6", content: [{ type: "text", text: "Explored." }] },
          }),
          JSON.stringify({
            type: "system",
            subtype: "compact_boundary",
            cwd: repoDir,
            timestamp: "2026-11-12T08:05:00Z",
            compactMetadata: { trigger: "manual", preTokens: 145000 },
          }),
          JSON.stringify({
            type: "user",
            isCompactSummary: true,
            cwd: repoDir,
            timestamp: "2026-11-12T08:05:01Z",
            message: {
              role: "user",
              content: "This session is being continued from a previous conversation. Key module: src/index.ts.",
            },
          }),
          JSON.stringify({
            type: "user",
            cwd: repoDir,
            timestamp: "2026-11-12T08:06:00Z",
            message: { role: "user", content: "Now update src/index.ts" },
          }),
          JSON.stringify({
            type: "assistant",
            cwd: repoDir,
            timestamp: "2026-11-12T08:06:02Z",
            message: {
              id: "msg_turn_2",
              model: "claude-sonnet-4-6",
              content: [{ type: "thinking", thinking: "Need to read and edit src/index.ts." }],
            },
          }),
          JSON.stringify({
            type: "assistant",
            cwd: repoDir,
            timestamp: "2026-11-12T08:06:04Z",
            message: {
              id: "msg_turn_2",
              model: "claude-sonnet-4-6",
              content: [
                {
                  type: "tool_use",
                  id: "toolu_edit_1",
                  name: "Edit",
                  input: {
                    file_path: `${repoDir}/src/index.ts`,
                    old_string: "export const v = 1\n",
                    new_string: "export const v = 2\n",
                  },
                },
              ],
            },
          }),
          JSON.stringify({
            type: "user",
            cwd: repoDir,
            timestamp: "2026-11-12T08:06:05Z",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "toolu_edit_1",
                  content: "The file src/index.ts has been updated.",
                },
              ],
            },
          }),
          JSON.stringify({
            type: "assistant",
            cwd: repoDir,
            timestamp: "2026-11-12T08:06:08Z",
            message: {
              id: "msg_turn_3",
              model: "claude-sonnet-4-6",
              content: [{ type: "text", text: "Updated `src/index.ts` to version 2." }],
            },
          }),
          JSON.stringify({
            type: "ai-title",
            aiTitle: "Upgrade Index Version Constant",
          }),
        ]

        await fs.writeFile(path.join(claudeSessionDir, `${claudeSessionID}.jsonl`), `${lines.join("\n")}\n`, "utf8")
      })

      yield* withTestHome(
        home,
        Effect.gen(function* () {
          const session = yield* Session.Service
          const listed = yield* session.list({ limit: 20 })
          const expectedID = SessionExternal.makeSessionID("claude", claudeSessionID)
          const imported = listed.data.find((item) => item.id === expectedID)

          expect(imported).toBeDefined()
          expect(imported?.title).toBe("Upgrade Index Version Constant")
          expect(imported?.location.directory).toBe(AbsolutePath.make(repoDir))

          const messages = (yield* session.messages({ sessionID: expectedID, order: "desc", limit: 20 })).toReversed()
          expect(messages.map((m) => m.type)).toEqual(["user", "assistant", "compaction", "user", "assistant", "assistant"])

          const compaction = messages[2]
          expect(compaction?.type).toBe("compaction")
          if (compaction?.type === "compaction" && compaction.status === "completed") {
            expect(compaction.reason).toBe("manual")
            expect(compaction.summary).toContain("Key module: src/index.ts")
          }

          const mergedAssistant = messages[4]
          expect(mergedAssistant?.type).toBe("assistant")
          if (mergedAssistant?.type === "assistant") {
            expect(mergedAssistant.content.some((p) => p.type === "reasoning")).toBe(true)
            const tool = mergedAssistant.content.find((p) => p.type === "tool")
            expect(tool?.type === "tool" ? tool.name : "").toBe("edit")
            if (tool?.type === "tool" && tool.state.status === "completed") {
              expect(tool.state.content[0]?.type === "text" ? tool.state.content[0].text : "").toContain(
                "has been updated",
              )
            }
          }
        }),
      )
    }),
  )

  it.live("imports Codex CodeMode exec, apply_patch file diffs, compacted summary, and deduplicates mirrored events", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped("ext-codex-")
      const home = path.join(tmp.path, "home")
      const repoDir = path.join(tmp.path, "codex-repo")
      const sessionDir = path.join(home, ".codex", "sessions", "2026", "11", "12")
      const codexID = "019a0000-1111-7222-8333-444455556666"
      const rolloutPath = path.join(sessionDir, `rollout-2026-11-12T10-00-00-${codexID}.jsonl`)

      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(repoDir, ".git"), { recursive: true })
        await fs.mkdir(sessionDir, { recursive: true })
        await fs.writeFile(
          path.join(home, ".codex", "session_index.jsonl"),
          `${JSON.stringify({ id: codexID, thread_name: "Codex Refactor Pipeline" })}\n`,
          "utf8",
        )

        const patchText = [
          "*** Begin Patch",
          "*** Update File: src/pipeline.ts",
          "@@ -1,2 +1,3 @@",
          " export function run() {",
          "-  return false",
          "+  const ok = true",
          "+  return ok",
          " }",
          "*** End Patch",
        ].join("\n")

        const lines = [
          JSON.stringify({
            timestamp: "2026-11-12T10:00:00Z",
            type: "session_meta",
            payload: { id: codexID, cwd: repoDir, model: "gpt-5.3-codex" },
          }),
          JSON.stringify({
            timestamp: "2026-11-12T10:01:00Z",
            type: "event_msg",
            payload: { type: "context_compacted" },
          }),
          JSON.stringify({
            timestamp: "2026-11-12T10:01:00Z",
            type: "compacted",
            payload: {
              message:
                "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:\nCompacted earlier Codex exploration into summary.",
              latest_token_usage_record: {
                usage: {
                  input_tokens: 248000,
                  cached_input_tokens: 190000,
                  output_tokens: 3600,
                },
              },
            },
          }),
          JSON.stringify({
            timestamp: "2026-11-12T10:02:00Z",
            type: "event_msg",
            payload: { type: "user_message", message: "Run tests and patch pipeline.ts" },
          }),
          JSON.stringify({
            timestamp: "2026-11-12T10:02:00Z",
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "Run tests and patch pipeline.ts" }],
            },
          }),
          JSON.stringify({
            timestamp: "2026-11-12T10:02:02Z",
            type: "response_item",
            payload: {
              type: "custom_tool_call",
              call_id: "call_exec_1",
              name: "exec",
              input: 'const r = await tools.exec_command({cmd:"bun test"});\ntext(r.output);',
            },
          }),
          JSON.stringify({
            timestamp: "2026-11-12T10:02:04Z",
            type: "response_item",
            payload: {
              type: "custom_tool_call_output",
              call_id: "call_exec_1",
              output: "Script completed\nWall time 0.4s\nOutput:\n12 pass, 0 fail",
            },
          }),
          JSON.stringify({
            timestamp: "2026-11-12T10:02:06Z",
            type: "response_item",
            payload: {
              type: "custom_tool_call",
              call_id: "call_patch_1",
              name: "apply_patch",
              input: patchText,
            },
          }),
          JSON.stringify({
            timestamp: "2026-11-12T10:02:07Z",
            type: "response_item",
            payload: {
              type: "custom_tool_call_output",
              call_id: "call_patch_1",
              output: "Success. Updated the following files:\nM src/pipeline.ts",
            },
          }),
          JSON.stringify({
            timestamp: "2026-11-12T10:02:10Z",
            type: "event_msg",
            payload: { type: "agent_message", message: "Pipeline updated and all 12 tests pass." },
          }),
          JSON.stringify({
            timestamp: "2026-11-12T10:02:10Z",
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Pipeline updated and all 12 tests pass." }],
            },
          }),
        ]

        await fs.writeFile(rolloutPath, `${lines.join("\n")}\n`, "utf8")
      })

      yield* withTestHome(
        home,
        Effect.gen(function* () {
          const session = yield* Session.Service
          const listed = yield* session.list({ limit: 20 })
          const expectedID = SessionExternal.makeSessionID("codex", codexID)
          const imported = listed.data.find((item) => item.id === expectedID)

          expect(imported).toBeDefined()
          expect(imported?.title).toBe("Codex Refactor Pipeline")

          const messages = (yield* session.messages({ sessionID: expectedID, order: "desc", limit: 20 })).toReversed()
          // Deduped compaction, user & assistant messages, with consecutive tool calls grouped cleanly!
          expect(messages.map((m) => m.type)).toEqual(["compaction", "user", "assistant", "assistant"])

          const codexCompaction = messages[0]
          if (codexCompaction?.type === "compaction" && codexCompaction.status === "completed") {
            expect(codexCompaction.summary).toBe("Compacted earlier Codex exploration into summary.")
            expect(codexCompaction.summary).not.toContain("Another language model started to solve this problem")
            expect(codexCompaction.tokens?.input).toBe(248000)
            expect(codexCompaction.tokens?.cache.read).toBe(190000)
            expect(codexCompaction.tokens?.output).toBe(3600)
          }

          const toolsMsg = messages[2]
          if (toolsMsg?.type === "assistant") {
            const tools = toolsMsg.content.filter((p) => p.type === "tool")
            expect(tools.map((t) => t.name)).toEqual(["shell", "patch"])

            const execTool = tools[0]
            if (execTool?.type === "tool" && execTool.state.status === "completed") {
              expect(execTool.state.input).toMatchObject({ command: "bun test" })
              expect(execTool.state.content[0]?.type === "text" ? execTool.state.content[0].text : "").toBe(
                "12 pass, 0 fail",
              )
            }

            const patchTool = tools[1]
            if (patchTool?.type === "tool" && patchTool.state.status === "completed") {
              const files = patchTool.state.metadata?.files
              expect(Array.isArray(files) ? files.length : 0).toBe(1)
            }
          }

          const finalReply = messages[3]
          if (finalReply?.type === "assistant") {
            const textPart = finalReply.content.find((p) => p.type === "text")
            expect(textPart?.type === "text" ? textPart.text : "").toBe("Pipeline updated and all 12 tests pass.")
          }
        }),
      )
    }),
  )

  it.live(
    "loads multi-MB JSONL tail fast, backfills upward chunks on cursor scroll to byte 0, appends live tail, bounds uncompacted context, and revives deleted sessions on new activity",
    () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped("ext-large-")
        const home = path.join(tmp.path, "home")
        const repoDir = path.join(tmp.path, "big-repo")
        const sessionDir = path.join(home, ".codex", "sessions", "2026", "11", "12")
        const codexID = "019a9999-8888-7777-6666-555544443333"
        const rolloutPath = path.join(sessionDir, `rollout-2026-11-12T11-00-00-${codexID}.jsonl`)
        const totalTurns = 220
        const padding = "x".repeat(20_000)

        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(repoDir, ".git"), { recursive: true })
          await fs.mkdir(sessionDir, { recursive: true })

          const lines: string[] = [
            JSON.stringify({
              timestamp: "2026-11-12T06:00:00.000Z",
              type: "session_meta",
              payload: { id: codexID, cwd: repoDir, model: "gpt-5.3-codex" },
            }),
          ]

          for (let i = 1; i <= totalTurns; i += 1) {
            const label = `TURN_${String(i).padStart(4, "0")}`
            const ts = new Date(Date.UTC(2026, 10, 12, 6, 0, i)).toISOString()
            lines.push(
              JSON.stringify({
                timestamp: ts,
                type: "event_msg",
                payload: { type: "task_started", turn_id: `turn_${i}` },
              }),
              JSON.stringify({
                timestamp: ts,
                type: "response_item",
                payload: {
                  type: "message",
                  role: "user",
                  content: [{ type: "input_text", text: `${label} user prompt` }],
                },
              }),
              JSON.stringify({
                timestamp: ts,
                type: "turn_context",
                payload: { cwd: repoDir, model: "gpt-6.1-sol" },
              }),
              JSON.stringify({
                timestamp: ts,
                type: "event_msg",
                payload: { type: "user_message", message: `${label} user prompt` },
              }),
              JSON.stringify({
                timestamp: ts,
                type: "event_msg",
                payload: { type: "agent_message", message: `${label} assistant reply ${padding}` },
              }),
              JSON.stringify({
                timestamp: ts,
                type: "response_item",
                payload: {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: `${label} assistant reply ${padding}` }],
                },
              }),
            )
          }

          await fs.writeFile(rolloutPath, `${lines.join("\n")}\n`, "utf8")
          const stat = await fs.stat(rolloutPath)
          // ~4.5 MB > INITIAL_TAIL_BYTES (3 MB), guaranteeing partial tail load!
          expect(stat.size).toBeGreaterThan(4_000_000)
        })

        yield* withTestHome(
          home,
          Effect.gen(function* () {
            const session = yield* Session.Service
            const expectedID = SessionExternal.makeSessionID("codex", codexID)

            const listed = yield* session.list({ limit: 20 })
            const imported = listed.data.find((item) => item.id === expectedID)
            expect(imported).toBeDefined()
            expect(imported?.location.directory).toBe(AbsolutePath.make(repoDir))
            // Header peek picked up TURN_0001 for fallback title even though byte 0 wasn't in the 3 MB tail!
            expect(imported?.title).toContain("TURN_0001")

            // 1. Initial page loads latest messages fast
            const firstPage = yield* session.messages({ sessionID: expectedID, order: "desc", limit: 40 })
            expect(firstPage.length).toBe(40)
            const newest = firstPage[0]
            expect(newest?.type).toBe("assistant")
            if (newest?.type === "assistant") {
              const txt = newest.content.find((p) => p.type === "text")
              expect(txt?.type === "text" ? txt.text : "").toContain("TURN_0220")
            }

            // 2. Scroll upward using cursor pagination until exhausted — backfills older chunks seamlessly to TURN_0001
            const allLoaded = [...firstPage]
            let cursorID = firstPage.at(-1)?.id
            let pages = 0
            while (cursorID && pages < 20) {
              pages += 1
              const nextBatch = yield* session.messages({
                sessionID: expectedID,
                order: "desc",
                limit: 80,
                cursor: { id: cursorID, direction: "next" },
              })
              if (nextBatch.length === 0) break
              allLoaded.push(...nextBatch)
              cursorID = nextBatch.at(-1)?.id
            }

            expect(allLoaded.length).toBe(totalTurns * 2)
            const earliest = allLoaded.at(-1)
            expect(earliest?.type).toBe("user")
            if (earliest?.type === "user") {
              expect(earliest.text).toBe("TURN_0001 user prompt")
            }

            // 3. Uncompacted huge external session bounds Session.context cleanly on a user turn
            const boundedCtx = yield* session.context(expectedID)
            expect(boundedCtx.length).toBeLessThanOrEqual(125)
            expect(boundedCtx.length).toBeGreaterThanOrEqual(100)
            expect(boundedCtx[0]?.type).toBe("user")

            // 4. Live incremental forward append when external CLI writes new lines
            yield* Effect.promise(async () => {
              const liveLines = [
                JSON.stringify({
                  timestamp: "2026-11-12T12:00:00.000Z",
                  type: "response_item",
                  payload: {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "TURN_LIVE_221 user follow-up" }],
                  },
                }),
                JSON.stringify({
                  timestamp: "2026-11-12T12:00:01.000Z",
                  type: "response_item",
                  payload: {
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: "TURN_LIVE_221 live assistant answer" }],
                  },
                }),
              ]
              await fs.appendFile(rolloutPath, `${liveLines.join("\n")}\n`, "utf8")
            })

            const afterAppend = yield* session.messages({ sessionID: expectedID, order: "desc", limit: 4 })
            const latestReply = afterAppend[0]
            expect(latestReply?.type).toBe("assistant")
            if (latestReply?.type === "assistant") {
              const txt = latestReply.content.find((p) => p.type === "text")
              expect(txt?.type === "text" ? txt.text : "").toContain("TURN_LIVE_221 live assistant answer")
            }

            // 5. Deleting hides untouched session, and subsequent external file activity revives it
            yield* session.remove(expectedID)
            SessionExternal.resetForTesting()

            const afterDeleteList = yield* session.list({ limit: 20 })
            expect(afterDeleteList.data.some((item) => item.id === expectedID)).toBe(false)

            yield* Effect.promise(async () => {
              const futureTime = new Date(Date.now() + 15_000)
              await fs.appendFile(
                rolloutPath,
                `${JSON.stringify({
                  timestamp: futureTime.toISOString(),
                  type: "response_item",
                  payload: {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "TURN_REVIVED_222 resumed in CLI" }],
                  },
                })}\n`,
                "utf8",
              )
              await fs.utimes(rolloutPath, futureTime, futureTime)
            })

            SessionExternal.resetForTesting()
            const afterReviveList = yield* session.list({ limit: 20 })
            expect(afterReviveList.data.some((item) => item.id === expectedID)).toBe(true)
          }),
        )
      }),
  )

  it.live("excludes Pigu-spawned child CLI sessions recorded in KVTable and strips DSH conversation_context tags", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped("ext-dsh-child-")
      const home = path.join(tmp.path, "home")
      const repoDir = path.join(tmp.path, "dsh-repo")
      const projCacheDir = path.join(home, ".dsh", "storages", "session_projcache", "sessions")
      const childDshID = "child-dsh-owned-by-native-pigu"
      const retiredDshID = "child-dsh-retired-before-compact"
      const standaloneDshID = "standalone-dsh-session-001"

      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(repoDir, ".git"), { recursive: true })
        await fs.mkdir(projCacheDir, { recursive: true })

        await fs.writeFile(
          path.join(projCacheDir, `${retiredDshID}.json`),
          JSON.stringify({
            record: {
              identity: { cwd: repoDir, createdAt: 1_759_999_990_000 },
              rows: {
                workingDirectory: { val: repoDir },
                titleInput: {
                  val: {
                    first: {
                      text: "Pre-compact child session",
                    },
                  },
                },
              },
            },
          }),
          "utf8",
        )

        await fs.writeFile(
          path.join(projCacheDir, `${childDshID}.json`),
          JSON.stringify({
            record: {
              identity: { cwd: repoDir, createdAt: 1_760_000_000_000 },
              rows: {
                workingDirectory: { val: repoDir },
                titleInput: {
                  val: {
                    first: {
                      text: "<conversation_context>\nUser: 蓝鲸77\n</conversation_context>\n继续测试",
                    },
                  },
                },
              },
            },
          }),
          "utf8",
        )

        await fs.writeFile(
          path.join(projCacheDir, `${standaloneDshID}.json`),
          JSON.stringify({
            record: {
              identity: { cwd: repoDir, createdAt: 1_760_000_010_000 },
              rows: {
                workingDirectory: { val: repoDir },
                titleInput: {
                  val: {
                    first: {
                      text: "<conversation_context>\nPrior context\n</conversation_context>\n独立DSH需求开发",
                    },
                  },
                },
              },
            },
          }),
          "utf8",
        )
      })

      yield* withTestHome(
        home,
        Effect.gen(function* () {
          const session = yield* Session.Service
          const dbSvc = yield* Database.Service
          const native = yield* session.create({
            location: { directory: AbsolutePath.make(repoDir) },
            title: "蓝鲸77暗号测试",
          })

          yield* dbSvc.db
            .insert(KVTable)
            .values({
              key: `plugin:pigu.provider.local:session:${native.id}`,
              value: {
                lastEngine: "deepseek-harness",
                engines: {
                  "deepseek-harness": {
                    sessionId: childDshID,
                  },
                },
                retiredChildSessions: [
                  {
                    source: "deepseek-harness",
                    sessionId: retiredDshID,
                  },
                ],
              },
              time_created: Date.now(),
              time_updated: Date.now(),
            })
            .run()

          SessionExternal.resetForTesting()
          const listed = yield* session.list({ limit: 30 })
          const childExtID = SessionExternal.makeSessionID("deepseek-harness", childDshID)
          const retiredExtID = SessionExternal.makeSessionID("deepseek-harness", retiredDshID)
          const standaloneExtID = SessionExternal.makeSessionID("deepseek-harness", standaloneDshID)

          expect(listed.data.some((item) => item.id === childExtID)).toBe(false)
          expect(listed.data.some((item) => item.id === retiredExtID)).toBe(false)
          const standalone = listed.data.find((item) => item.id === standaloneExtID)
          expect(standalone).toBeDefined()
          expect(standalone?.title).toBe("独立DSH需求开发")
        }),
      )
    }),
  )

  it.live(
    "handles Antigravity /compact + SYSTEM_MESSAGE + CHECKPOINT, bidirectional same-session sync without duplicates, and bridged child exclusion",
    () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped("ext-agy-switch-")
        const home = path.join(tmp.path, "home")
        const repoDir = path.join(tmp.path, "agy-switch-repo")
        const cliConvID = "5bd2e301-714c-4b76-b37c-8edbd3127b97"
        const desktopConvID = "aa00bb11-2233-4455-6677-8899aabbccdd"
        const bridgedChildID = "ff99ee88-7766-5544-3322-1100fedcba98"
        const cliLogPath = path.join(
          home,
          ".gemini",
          "antigravity-cli",
          "brain",
          cliConvID,
          ".system_generated",
          "logs",
          "transcript_full.jsonl",
        )
        const bridgedChildLogPath = path.join(
          home,
          ".gemini",
          "antigravity-cli",
          "brain",
          bridgedChildID,
          ".system_generated",
          "logs",
          "transcript_full.jsonl",
        )
        const desktopLogPath = path.join(
          home,
          ".gemini",
          "antigravity",
          "brain",
          desktopConvID,
          ".system_generated",
          "logs",
          "transcript_full.jsonl",
        )

        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(repoDir, ".git"), { recursive: true })
          await fs.mkdir(path.dirname(cliLogPath), { recursive: true })
          await fs.mkdir(path.dirname(bridgedChildLogPath), { recursive: true })
          await fs.mkdir(path.dirname(desktopLogPath), { recursive: true })

          const cliLines = [
            JSON.stringify({
              step_index: 1,
              type: "USER_INPUT",
              source: "USER_EXPLICIT",
              created_at: "2026-11-15T00:00:00Z",
              content: `<user_information>\nActive Workspaces:\n- ${repoDir}\n</user_information>\n<USER_REQUEST>\nSetup sandbox\n</USER_REQUEST>`,
            }),
            JSON.stringify({
              step_index: 2,
              type: "PLANNER_RESPONSE",
              source: "MODEL",
              created_at: "2026-11-15T00:00:02Z",
              content: "Sandbox ready.",
            }),
            // Auto rolling checkpoint (no preceding /compact command)
            JSON.stringify({
              step_index: 3,
              type: "CHECKPOINT",
              source: "SYSTEM",
              created_at: "2026-11-15T00:01:00Z",
              input_tokens: 180000,
              output_tokens: 2100,
              content: "<summary>\nAuto checkpoint summary.\n</summary>",
            }),
            JSON.stringify({
              step_index: 4,
              type: "USER_INPUT",
              source: "USER_EXPLICIT",
              created_at: "2026-11-15T00:01:30Z",
              content: "<USER_REQUEST>\nVerify build\n</USER_REQUEST>",
            }),
            JSON.stringify({
              step_index: 5,
              type: "PLANNER_RESPONSE",
              source: "MODEL",
              created_at: "2026-11-15T00:01:35Z",
              content: "Build verified.",
            }),
            // Post-checkpoint user input containing <CONTEXT_SUMMARY> (which also embeds <USER_REQUEST> in history) + manual /compact + SYSTEM_MESSAGE + CHECKPOINT
            JSON.stringify({
              step_index: 6,
              type: "USER_INPUT",
              source: "USER_EXPLICIT",
              created_at: "2026-11-15T00:02:00Z",
              content: `<CONTEXT_SUMMARY>\nPrevious <USER_REQUEST>Setup sandbox</USER_REQUEST>\n</CONTEXT_SUMMARY>\n<USER_REQUEST>\n/compact\n</USER_REQUEST>`,
            }),
            JSON.stringify({
              step_index: 7,
              type: "SYSTEM_MESSAGE",
              source: "SYSTEM",
              created_at: "2026-11-15T00:02:01Z",
              content: "Context verification system prompt",
            }),
            JSON.stringify({
              step_index: 8,
              type: "CHECKPOINT",
              source: "SYSTEM",
              created_at: "2026-11-15T00:02:03Z",
              input_tokens: 42000,
              output_tokens: 950,
              content: "<summary>\nManual compact summary.\n</summary>",
            }),
            // Bridged user input with <conversation_context> inside <USER_REQUEST>
            JSON.stringify({
              step_index: 9,
              type: "USER_INPUT",
              source: "USER_EXPLICIT",
              created_at: "2026-11-15T00:03:00Z",
              content: `<USER_REQUEST>\n<conversation_context>\nUser: cloud turn\n</conversation_context>\nContinue after cloud turn\n</USER_REQUEST>`,
            }),
            JSON.stringify({
              step_index: 10,
              type: "PLANNER_RESPONSE",
              source: "MODEL",
              created_at: "2026-11-15T00:03:02Z",
              content: "Continued seamlessly.",
            }),
          ]
          await fs.writeFile(cliLogPath, `${cliLines.join("\n")}\n`, "utf8")

          await fs.writeFile(
            desktopLogPath,
            `${[
              JSON.stringify({
                step_index: 1,
                type: "USER_INPUT",
                source: "USER_EXPLICIT",
                created_at: "2026-11-15T00:04:00Z",
                content: `<user_information>\nActive Workspaces:\n- ${repoDir}\n</user_information>\n<USER_REQUEST>\nDesktop main session\n</USER_REQUEST>`,
              }),
              JSON.stringify({
                step_index: 2,
                type: "PLANNER_RESPONSE",
                source: "MODEL",
                created_at: "2026-11-15T00:04:01Z",
                content: "Desktop reply.",
              }),
            ].join("\n")}\n`,
            "utf8",
          )

          await fs.writeFile(
            bridgedChildLogPath,
            `${[
              JSON.stringify({
                step_index: 1,
                type: "USER_INPUT",
                source: "USER_EXPLICIT",
                created_at: "2026-11-15T00:05:00Z",
                content: `<user_information>\nActive Workspaces:\n- ${repoDir}\n</user_information>\n<USER_REQUEST>\n<conversation_context>\nUser: Desktop main session\n</conversation_context>\nFollow-up from Pigu\n</USER_REQUEST>`,
              }),
              JSON.stringify({
                step_index: 2,
                type: "PLANNER_RESPONSE",
                source: "MODEL",
                created_at: "2026-11-15T00:05:01Z",
                content: "Helper child reply.",
              }),
            ].join("\n")}\n`,
            "utf8",
          )
        })

        yield* withTestHome(
          home,
          Effect.gen(function* () {
            const session = yield* Session.Service
            const dbSvc = yield* Database.Service
            const cliSesID = SessionExternal.makeSessionID("agy", cliConvID)
            const desktopSesID = SessionExternal.makeSessionID("agy", desktopConvID)
            const bridgedChildSesID = SessionExternal.makeSessionID("agy", bridgedChildID)

            // Record bridgedChildID as owned by desktopSesID (external owner != child)
            yield* dbSvc.db
              .insert(KVTable)
              .values({
                key: `plugin:pigu.provider.local:session:${desktopSesID}`,
                value: {
                  lastEngine: "agy",
                  lastPromptCount: 4,
                  engines: {
                    agy: {
                      sessionId: bridgedChildID,
                      filePath: bridgedChildLogPath,
                    },
                  },
                },
                time_created: Date.now(),
                time_updated: Date.now(),
              })
              .run()

            SessionExternal.resetForTesting()
            const listed = yield* session.list({ limit: 30 })
            expect(listed.data.some((s) => s.id === cliSesID)).toBe(true)
            expect(listed.data.some((s) => s.id === desktopSesID)).toBe(true)
            expect(listed.data.some((s) => s.id === bridgedChildSesID)).toBe(false)

            const initialMsgs = (yield* session.messages({ sessionID: cliSesID, order: "desc", limit: 20 })).toReversed()
            // Zero leaked "/compact" bubble; auto checkpoint + manual checkpoint both preserved cleanly
            expect(initialMsgs.map((m) => m.type)).toEqual([
              "user",
              "assistant",
              "compaction",
              "user",
              "assistant",
              "compaction",
              "user",
              "assistant",
            ])

            const autoCompaction = initialMsgs[2]
            if (autoCompaction?.type === "compaction" && autoCompaction.status === "completed") {
              expect(autoCompaction.reason).toBe("auto")
            }
            const manualCompaction = initialMsgs[5]
            if (manualCompaction?.type === "compaction" && manualCompaction.status === "completed") {
              expect(manualCompaction.reason).toBe("manual")
              expect(manualCompaction.summary).toContain("Manual compact summary.")
            }
            const bridgedUser = initialMsgs[6]
            if (bridgedUser?.type === "user") {
              expect(bridgedUser.text).toBe("Continue after cloud turn")
            }

            // Simulate continuing cliSesID inside Pigu via local/agy --conversation:
            // Pigu writes native message rows AND agy appends mirrored lines to cliLogPath, updating KV syncedFileSize
            const piguTurnTime = Date.parse("2026-11-15T00:06:00Z")
            yield* dbSvc.db
              .insert(SessionMessageTable)
              .values([
                {
                  id: SessionMessage.ID.make("msg_native_pigu_user_1"),
                  session_id: cliSesID,
                  type: "user",
                  seq: 1_000_020,
                  time_created: piguTurnTime,
                  time_updated: piguTurnTime,
                  data: {
                    text: "Set token CORAL-99 in Pigu",
                    time: { created: piguTurnTime },
                  },
                },
                {
                  id: SessionMessage.ID.make("msg_native_pigu_asst_1"),
                  session_id: cliSesID,
                  type: "assistant",
                  seq: 1_000_021,
                  time_created: piguTurnTime + 1000,
                  time_updated: piguTurnTime + 1000,
                  data: {
                    agent: Agent.ID.make("build"),
                    model: { providerID: Provider.ID.make("local"), id: Model.ID.make("agy/gemini-3.8-flash") },
                    content: [{ type: "text", text: "Saved CORAL-99." }],
                    finish: "stop",
                    time: {
                      created: piguTurnTime + 1000,
                      streamed: piguTurnTime + 1000,
                      completed: piguTurnTime + 1000,
                    },
                  },
                },
              ])
              .run()

            const postPiguSize = yield* Effect.promise(async () => {
              const mirrored = [
                JSON.stringify({
                  step_index: 9,
                  type: "USER_INPUT",
                  source: "USER_EXPLICIT",
                  created_at: "2026-11-15T00:06:00Z",
                  content: "<USER_REQUEST>\nSet token CORAL-99 in Pigu\n</USER_REQUEST>",
                }),
                JSON.stringify({
                  step_index: 10,
                  type: "PLANNER_RESPONSE",
                  source: "MODEL",
                  created_at: "2026-11-15T00:06:01Z",
                  content: "Saved CORAL-99.",
                }),
              ]
              await fs.appendFile(cliLogPath, `${mirrored.join("\n")}\n`, "utf8")
              return (await fs.stat(cliLogPath)).size
            })

            yield* dbSvc.db
              .insert(KVTable)
              .values({
                key: `plugin:pigu.provider.local:session:${cliSesID}`,
                value: {
                  lastEngine: "agy",
                  lastPromptCount: 6,
                  engines: {
                    agy: {
                      sessionId: cliConvID,
                      filePath: cliLogPath,
                      syncedFileSize: postPiguSize,
                    },
                  },
                },
                time_created: piguTurnTime,
                time_updated: piguTurnTime + 1000,
              })
              .run()

            const afterPiguMsgs = (
              yield* session.messages({ sessionID: cliSesID, order: "desc", limit: 30 })
            ).toReversed()
            const coralUserCount = afterPiguMsgs.filter(
              (m) => m.type === "user" && m.text.includes("CORAL-99"),
            ).length
            expect(coralUserCount).toBe(1)

            // Now simulate user switching BACK to external agy CLI in terminal and sending a new turn
            yield* Effect.promise(async () => {
              const externalAppend = [
                JSON.stringify({
                  step_index: 11,
                  type: "USER_INPUT",
                  source: "USER_EXPLICIT",
                  created_at: "2026-11-15T00:07:00Z",
                  content: "<USER_REQUEST>\nExternal terminal follow-up JADE-77\n</USER_REQUEST>",
                }),
                JSON.stringify({
                  step_index: 12,
                  type: "PLANNER_RESPONSE",
                  source: "MODEL",
                  created_at: "2026-11-15T00:07:02Z",
                  content: "Confirmed JADE-77 in terminal.",
                }),
              ]
              await fs.appendFile(cliLogPath, `${externalAppend.join("\n")}\n`, "utf8")
            })

            const afterExternalMsgs = (
              yield* session.messages({ sessionID: cliSesID, order: "desc", limit: 30 })
            ).toReversed()
            expect(afterExternalMsgs.filter((m) => m.type === "user" && m.text.includes("CORAL-99")).length).toBe(1)
            expect(afterExternalMsgs.filter((m) => m.type === "user" && m.text.includes("JADE-77")).length).toBe(1)

            const updatedKv = yield* dbSvc.db
              .select()
              .from(KVTable)
              .where(eq(KVTable.key, `plugin:pigu.provider.local:session:${cliSesID}`))
              .get()
            const kvVal = updatedKv?.value
            expect(
              kvVal && typeof kvVal === "object" && "lastPromptCount" in kvVal ? kvVal.lastPromptCount : undefined,
            ).toBe(8)

            // Verify native Session events (e.g. switchModel) receive seq strictly AFTER external messages (> 1,000,000)
            yield* session.switchModel({
              sessionID: cliSesID,
              model: { providerID: Provider.ID.make("openai"), id: Model.ID.make("gpt-5") },
            })
            const afterSwitchMsgs = (
              yield* session.messages({ sessionID: cliSesID, order: "desc", limit: 35 })
            ).toReversed()
            expect(afterSwitchMsgs.at(-1)?.type).toBe("model-switched")
          }),
        )
      }),
  )

  it.effect(
    "cleans Claude Code 2.1.170 compaction wrappers, preserves pre/post token counts, and snaps chunk boundaries cleanly",
    () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        const filePath = path.join(tmp.path, "claude-2-170.jsonl")
        const padding = "x".repeat(1200)

        const rawLines = [
          JSON.stringify({
            parentUuid: null,
            isSidechain: false,
            type: "user",
            cwd: tmp.path,
            timestamp: "2026-11-15T10:00:00Z",
            message: { role: "user", content: "Audit the auth service" },
          }),
          // Claude 2.1.170 places `message` (often >768 bytes) before `"type":"assistant"`
          JSON.stringify({
            parentUuid: "u1",
            isSidechain: false,
            message: {
              id: "msg_multi_1",
              model: "claude-sonnet-5-5",
              container: null,
              content: [{ type: "thinking", signature: padding, thinking: "Checking auth endpoints." }],
            },
            type: "assistant",
            timestamp: "2026-11-15T10:00:01Z",
          }),
          JSON.stringify({
            parentUuid: "u2",
            isSidechain: false,
            message: {
              id: "msg_multi_1",
              model: "claude-sonnet-5-5",
              container: null,
              content: [{ type: "text", text: `Auth check complete. ${padding}` }],
            },
            type: "assistant",
            timestamp: "2026-11-15T10:00:02Z",
          }),
          JSON.stringify({
            parentUuid: "u3",
            isSidechain: false,
            type: "user",
            isMeta: true,
            timestamp: "2026-11-15T10:01:00Z",
            message: {
              role: "user",
              content: "<local-command-caveat>Caveat: The messages below were generated locally</local-command-caveat>",
            },
          }),
          JSON.stringify({
            parentUuid: "u4",
            isSidechain: false,
            type: "user",
            timestamp: "2026-11-15T10:01:01Z",
            message: {
              role: "user",
              content: "<command-name>/compact</command-name>\n<command-message>compact</command-message>",
            },
          }),
          JSON.stringify({
            parentUuid: null,
            isSidechain: false,
            type: "system",
            subtype: "compact_boundary",
            timestamp: "2026-11-15T10:01:02Z",
            compactMetadata: { trigger: "manual", preTokens: 516207, postTokens: 8548 },
          }),
          JSON.stringify({
            parentUuid: "cb_1",
            isSidechain: false,
            type: "user",
            message: {
              role: "user",
              content: [
                "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.",
                "",
                "Summary:",
                "1. Primary Request and Intent:",
                "   - Audited auth service and verified token middleware.",
                "",
                `If you need specific details from before compaction (like exact code snippets), read the full transcript at: ${filePath}`,
                'Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary. Pick up the last task as if the break never happened.',
              ].join("\n"),
            },
            isCompactSummary: true,
            timestamp: "2026-11-15T10:01:03Z",
          }),
          JSON.stringify({
            parentUuid: "cb_2",
            isSidechain: false,
            type: "user",
            timestamp: "2026-11-15T10:02:00Z",
            message: { role: "user", content: "Continue with rate limiting" },
          }),
          JSON.stringify({
            parentUuid: "u5",
            isSidechain: false,
            message: {
              id: "msg_multi_2",
              model: "claude-sonnet-5-5",
              container: null,
              content: [{ type: "text", text: "Added rate limiting." }],
            },
            type: "assistant",
            timestamp: "2026-11-15T10:02:02Z",
          }),
        ]

        const fileBytes = yield* Effect.promise(async () => {
          const content = `${rawLines.join("\n")}\n`
          await fs.writeFile(filePath, content, "utf8")
          return Buffer.byteLength(content, "utf8")
        })

        const fullEntries = SessionExternalParse.parseClaudeLines(rawLines, Date.now()).entries
        expect(fullEntries.map((e) => e.kind)).toEqual(["user", "assistant", "compaction", "user", "assistant"])

        const compaction = fullEntries[2]
        expect(compaction?.kind).toBe("compaction")
        if (compaction?.kind === "compaction") {
          expect(compaction.reason).toBe("manual")
          expect(compaction.tokens).toEqual({ input: 516207, output: 8548 })
          expect(compaction.summary.startsWith("Summary:\n1. Primary Request and Intent:")).toBe(true)
          expect(compaction.summary).not.toContain("This session is being continued")
          expect(compaction.summary).not.toContain("If you need specific details from before compaction")
          expect(compaction.summary).not.toContain("Pick up the last task")
        }

        // Target a byte offset right inside the second row of `msg_multi_1` and verify it snaps back to the user turn
        const midAssistantOffset = Buffer.byteLength(`${rawLines.slice(0, 2).join("\n")}\n`, "utf8") + 10
        const tailWin = SessionExternalParse.readJsonlWindowSync({
          fullPath: filePath,
          targetStart: midAssistantOffset,
          endOffset: fileBytes,
          source: "claude",
        })
        expect(tailWin.startOffset).toBe(0)
        expect(SessionExternalParse.parseClaudeLines(tailWin.lines, Date.now()).entries.length).toBe(fullEntries.length)

        // 1) Target a byte offset inside `compact_boundary` (so next line is `isCompactSummary`) -> snaps back onto `compact_boundary`
        const boundaryOffset = Buffer.byteLength(`${rawLines.slice(0, 5).join("\n")}\n`, "utf8")
        const compactWin = SessionExternalParse.readJsonlWindowSync({
          fullPath: filePath,
          targetStart: boundaryOffset + 5,
          endOffset: fileBytes,
          source: "claude",
        })
        expect(compactWin.startOffset).toBe(boundaryOffset)
        const compactSliceEntries = SessionExternalParse.parseClaudeLines(compactWin.lines, Date.now()).entries
        expect(compactSliceEntries.map((e) => e.kind)).toEqual(["compaction", "user", "assistant"])
        if (compactSliceEntries[0]?.kind === "compaction") {
          expect(compactSliceEntries[0].tokens).toEqual({ input: 516207, output: 8548 })
        }

        // 2) Target a byte offset inside `isCompactSummary` -> tail starts at next user turn and preceding backfill chunk keeps boundary+summary intact
        const summaryRowOffset = Buffer.byteLength(`${rawLines.slice(0, 6).join("\n")}\n`, "utf8") + 5
        const afterSummaryWin = SessionExternalParse.readJsonlWindowSync({
          fullPath: filePath,
          targetStart: summaryRowOffset,
          endOffset: fileBytes,
          source: "claude",
        })
        const beforeSummaryWin = SessionExternalParse.readJsonlWindowSync({
          fullPath: filePath,
          targetStart: 0,
          endOffset: afterSummaryWin.startOffset,
          source: "claude",
        })
        const stitched = [
          ...SessionExternalParse.parseClaudeLines(beforeSummaryWin.lines, Date.now()).entries,
          ...SessionExternalParse.parseClaudeLines(afterSummaryWin.lines, Date.now()).entries,
        ]
        expect(stitched).toEqual([...fullEntries])
      }),
  )

  it.live(
    "imports DSH v4 concatenated .jsonl.zstd with JSON-string tool arguments, tool/result outputs, native compaction, clean titles, and live frame append",
    () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped("ext-dsh-v4-")
        const home = path.join(tmp.path, "home")
        const repoDir = path.join(tmp.path, "dsh-v4-repo")
        const dshSessionID = "session-v4-dsh-001"
        const zstdPath = path.join(home, ".dsh", "sessions", "dsh-v4-repo", dshSessionID, "session.v4.jsonl.zstd")

        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(repoDir, ".git"), { recursive: true })
          await fs.mkdir(path.dirname(zstdPath), { recursive: true })

          const frame1Lines = [
            JSON.stringify({
              version: 4,
              sessionId: dshSessionID,
              createdAt: 1_773_980_000_000,
              cwd: repoDir,
            }),
            JSON.stringify({
              type: "request/context",
              time: 1_773_980_000_100,
              data: { provider: "pigutoken", model: "deepseek-v4.1-flash" },
            }),
            JSON.stringify({
              type: "user/message",
              time: 1_773_980_000_200,
              data: {
                id: "u_dsh_1",
                source: { kind: "user" },
                content: [
                  {
                    type: "text",
                    text: "<conversation_context>\n[用户]: 之前的问题\n</conversation_context>\n检查测试套件并更新 app.ts",
                  },
                ],
              },
            }),
            // Broken 40-byte fallback title generated by DSH from bridged <conversation_context>
            JSON.stringify({
              type: "session/title",
              time: 1_773_980_000_250,
              data: {
                title: "<conversation_context> 以下是此前",
                source: { kind: "fallback" },
              },
            }),
            JSON.stringify({
              type: "assistant/message",
              time: 1_773_980_001_000,
              data: {
                message: {
                  id: "a_dsh_1",
                  role: "assistant",
                  source: { provider: "pigutoken", model: "deepseek-v4.1-flash" },
                  content: [
                    { type: "thinking", thinking: "先运行测试并修改文件。" },
                    {
                      type: "tool-call",
                      id: "call_dsh_bash_1",
                      name: "bash",
                      arguments: JSON.stringify({ command: "bun test", description: "Run unit suite" }),
                    },
                    {
                      type: "tool-call",
                      id: "call_dsh_edit_1",
                      name: "edit",
                      arguments: JSON.stringify({
                        file_path: path.join(repoDir, "src/app.ts"),
                        old_string: "const version = 1",
                        new_string: "const version = 2",
                      }),
                    },
                  ],
                },
              },
            }),
            JSON.stringify({
              type: "tool/call",
              time: 1_773_980_001_100,
              data: {
                toolCallId: "call_dsh_bash_1",
                toolName: "bash",
                args: { command: "bun test", description: "Run unit suite" },
              },
            }),
            JSON.stringify({
              type: "tool/result",
              time: 1_773_980_002_000,
              data: {
                toolCallId: "call_dsh_bash_1",
                message: {
                  role: "tool",
                  toolCallId: "call_dsh_bash_1",
                  toolName: "bash",
                  content: [{ type: "text", text: "42 pass, 0 fail" }],
                  isError: false,
                },
              },
            }),
            JSON.stringify({
              type: "tool/result",
              time: 1_773_980_002_500,
              data: {
                toolCallId: "call_dsh_edit_1",
                message: {
                  role: "tool",
                  toolCallId: "call_dsh_edit_1",
                  toolName: "edit",
                  content: [{ type: "text", text: "Updated src/app.ts" }],
                  isError: false,
                },
              },
            }),
            JSON.stringify({
              type: "assistant/message",
              time: 1_773_980_003_000,
              data: {
                message: {
                  id: "a_dsh_2",
                  role: "assistant",
                  source: { provider: "pigutoken", model: "deepseek-v4.1-flash" },
                  content: [{ type: "text", text: "测试全部通过，已更新 app.ts。" }],
                },
              },
            }),
            JSON.stringify({
              type: "compaction/start",
              time: 1_773_980_010_000,
              data: { compactionId: "cmp_dsh_1", sourceCommandId: "cmd_compact_1" },
            }),
            JSON.stringify({
              type: "compaction/summary",
              time: 1_773_980_011_000,
              data: {
                compactionId: "cmp_dsh_1",
                sourceCommandId: "cmd_compact_1",
                shadowedTokenCount: 164_000,
                summary: [{ type: "text", text: "已完成单元测试验证并将 app.ts 升级至 v2。" }],
                usage: {
                  inputTokens: 164_000,
                  outputTokens: 1_200,
                  cacheReadTokens: 120_000,
                },
              },
            }),
            JSON.stringify({
              type: "user/message",
              time: 1_773_980_011_100,
              surfaceOp: { op: "replace", startSeq: 1, endSeq: 8 },
              data: {
                id: "u_dsh_ckpt_1",
                source: {
                  kind: "compact-checkpoint",
                  compactionId: "cmp_dsh_1",
                  sourceCommandId: "cmd_compact_1",
                },
                content: [
                  {
                    type: "text",
                    text: "The messages above have been compacted into the summary below.\n<compacted-summary>\n已完成单元测试验证并将 app.ts 升级至 v2。\n</compacted-summary>",
                  },
                ],
              },
            }),
          ]

          const frame1 = zlib.zstdCompressSync(Buffer.from(`${frame1Lines.join("\n")}\n`, "utf8"))
          await fs.writeFile(zstdPath, frame1)
        })

        yield* withTestHome(
          home,
          Effect.gen(function* () {
            const session = yield* Session.Service
            const expectedID = SessionExternal.makeSessionID("deepseek-harness", dshSessionID)

            const listed = yield* session.list({ limit: 20 })
            const imported = listed.data.find((item) => item.id === expectedID)
            expect(imported).toBeDefined()
            expect(imported?.location.directory).toBe(AbsolutePath.make(repoDir))
            expect(imported?.title).toBe("检查测试套件并更新 app.ts")
            expect(imported?.model).toMatchObject({
              providerID: Provider.ID.make("local"),
              id: Model.ID.make("deepseek-harness/deepseek-v4.1-flash"),
            })

            const initialMsgs = (
              yield* session.messages({ sessionID: expectedID, order: "desc", limit: 20 })
            ).toReversed()
            expect(initialMsgs.map((m) => m.type)).toEqual(["user", "assistant", "assistant", "compaction"])

            const toolsAsst = initialMsgs[1]
            if (toolsAsst?.type === "assistant") {
              const tools = toolsAsst.content.filter((p) => p.type === "tool")
              expect(tools.map((t) => t.name)).toEqual(["shell", "edit"])

              const bashTool = tools[0]
              if (bashTool?.type === "tool" && bashTool.state.status === "completed") {
                expect(bashTool.state.input).toMatchObject({
                  command: "bun test",
                  description: "Run unit suite",
                })
                expect(bashTool.state.content[0]?.type === "text" ? bashTool.state.content[0].text : "").toBe(
                  "42 pass, 0 fail",
                )
              }

              const editTool = tools[1]
              if (editTool?.type === "tool" && editTool.state.status === "completed") {
                const files = editTool.state.metadata?.files
                expect(Array.isArray(files) ? files.length : 0).toBe(1)
              }
            }

            const dshCompaction = initialMsgs[3]
            if (dshCompaction?.type === "compaction" && dshCompaction.status === "completed") {
              expect(dshCompaction.reason).toBe("manual")
              expect(dshCompaction.summary).toBe("已完成单元测试验证并将 app.ts 升级至 v2。")
              expect(dshCompaction.summary).not.toContain("<compacted-summary>")
              expect(dshCompaction.tokens?.input).toBe(164_000)
              expect(dshCompaction.tokens?.cache.read).toBe(120_000)
              expect(dshCompaction.tokens?.output).toBe(1_200)
            }

            // Append a second concatenated Zstandard frame (simulating external `dsh --session-id` resume)
            yield* Effect.promise(async () => {
              const frame2Lines = [
                JSON.stringify({
                  type: "user/message",
                  time: 1_773_980_020_000,
                  data: {
                    id: "u_dsh_2",
                    source: { kind: "user" },
                    content: [{ type: "text", text: "外部 DSH CLI 追加暗号 ONYX-88" }],
                  },
                }),
                JSON.stringify({
                  type: "assistant/message",
                  time: 1_773_980_021_000,
                  data: {
                    message: {
                      id: "a_dsh_3",
                      role: "assistant",
                      source: { provider: "pigutoken", model: "deepseek-v4.1-flash" },
                      content: [{ type: "text", text: "已收到外部追加暗号 ONYX-88。" }],
                    },
                  },
                }),
              ]
              const frame2 = zlib.zstdCompressSync(Buffer.from(`${frame2Lines.join("\n")}\n`, "utf8"))
              await fs.appendFile(zstdPath, frame2)
            })

            const afterAppend = (
              yield* session.messages({ sessionID: expectedID, order: "desc", limit: 20 })
            ).toReversed()
            expect(afterAppend.map((m) => m.type)).toEqual([
              "user",
              "assistant",
              "assistant",
              "compaction",
              "user",
              "assistant",
            ])
            const latestAsst = afterAppend.at(-1)
            if (latestAsst?.type === "assistant") {
              const txt = latestAsst.content.find((p) => p.type === "text")
              expect(txt?.type === "text" ? txt.text : "").toBe("已收到外部追加暗号 ONYX-88。")
            }
          }),
        )
      }),
  )
})
