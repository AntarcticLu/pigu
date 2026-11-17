import { expect, test } from "bun:test"
import { parseClientSlashCommand } from "./client-slash-command"
import { nativeCommandBadge, nativeEngineSlashItems, resolveLocalCliEngine } from "./native-slash-commands"

const options = [
  { id: "btw.ask", trigger: "btw", arguments: true, type: "builtin" as const },
  { id: "custom.btw", trigger: "custom", type: "custom" as const },
  { id: "model.choose", trigger: "model", type: "builtin" as const },
]

test.each([
  { text: "/btw why this approach?", result: { id: "btw.ask", input: "why this approach?" } },
  { text: "/btw\nwhy this approach?", result: { id: "btw.ask", input: "why this approach?" } },
  { text: "/btw", result: { id: "btw.ask", input: "" } },
  { text: "/btwx nope", result: undefined },
  { text: "/custom nope", result: undefined },
  { text: "/model opus", result: undefined },
  { text: "ask /btw later", result: undefined },
])("parses $text as a client argument command", (row) => {
  expect(parseClientSlashCommand(options, row.text)).toEqual(row.result)
})

test("resolves local CLI engine slash commands and badges only for local provider models", () => {
  expect(resolveLocalCliEngine(undefined)).toBeUndefined()
  expect(resolveLocalCliEngine({ providerID: "openai", modelID: "gpt-5.4" })).toBeUndefined()
  expect(resolveLocalCliEngine({ providerID: "local", modelID: "agy/gemini-3-pro" })).toBe("agy")
  expect(resolveLocalCliEngine({ providerID: "local", modelID: "claude/claude-sonnet-4-6" })).toBe("claude")
  expect(resolveLocalCliEngine({ providerID: "local", modelID: "codex/gpt-5.4" })).toBe("codex")

  expect(nativeCommandBadge("agy", "compact", "zh")).toBe("Antigravity 原生")
  expect(nativeCommandBadge("agy", "goal", "zh")).toBe("Antigravity 原生")
  expect(nativeCommandBadge("claude", "init", "zh")).toBe("Claude 原生")
  expect(nativeCommandBadge("codex", "review", "zh")).toBe("Codex 原生")
  expect(nativeCommandBadge(undefined, "compact", "zh")).toBeUndefined()

  expect(nativeEngineSlashItems("agy", "zh").map((item) => item.trigger)).toContain("boost")
  expect(nativeEngineSlashItems("agy", "zh").map((item) => item.trigger)).toContain("teamwork")
  expect(nativeEngineSlashItems("claude", "zh").map((item) => item.trigger)).toContain("security-review")
  expect(nativeEngineSlashItems("claude", "zh").map((item) => item.trigger)).toContain("simplify")
  expect(nativeEngineSlashItems(undefined, "zh")).toEqual([])
})
