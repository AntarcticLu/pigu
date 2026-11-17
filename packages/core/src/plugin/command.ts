export * as CommandPlugin from "./command.js"

import os from "node:os"
import { define } from "@opencode/plugin/effect/plugin"
import type { Session } from "@opencode/schema/session"
import { Effect, Exit, Option, Stream } from "effect"
import { Bus } from "../bus.js"
import { Config } from "../config.js"
import { Location } from "../location.js"
import { Mcp } from "../mcp/index.js"
import { LOCAL_PROVIDER_ID, normalizeEngine, supportsNativeSlashCommand } from "./provider/native-cli.js"
import PROMPT_INITIALIZE from "./command/initialize.txt"
import PROMPT_REVIEW from "./command/review.txt"

export const Plugin = define({
  id: "opencode.command",
  effect: Effect.fn(function* (ctx) {
    const location = yield* Location.Service
    const configOpt = yield* Effect.serviceOption(Config.Service)
    const mcp = yield* Mcp.Service
    const bus = yield* Bus.Service
    const loaded = { prompts: [] as Mcp.Prompt[] }
    yield* bus.subscribe(Mcp.PromptsChanged).pipe(
      Stream.runForEach(() =>
        mcp.prompts().pipe(
          Effect.tap((prompts) => Effect.sync(() => (loaded.prompts = prompts))),
          Effect.andThen(ctx.command.reload()),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
    loaded.prompts = yield* mcp.prompts()

    const resolveEffectiveModel = (sessionID: Session.ID) =>
      Effect.gen(function* () {
        const sessionExit = yield* Effect.exit(ctx.session.get({ sessionID }))
        if (Exit.isSuccess(sessionExit)) {
          const session = sessionExit.value
          if (session.model) return session.model
          if (session.agent) {
            const agentExit = yield* Effect.exit(ctx.agent.get({ agentID: session.agent }))
            if (Exit.isSuccess(agentExit) && agentExit.value.data?.model) return agentExit.value.data.model
          }
        }
        const cfgModel = Option.isSome(configOpt) ? Config.latest(configOpt.value.snapshot(), "model") : undefined
        if (cfgModel) return { providerID: cfgModel.providerID, id: cfgModel.model }
        return undefined
      })

    yield* ctx.command.transform((editor) => {
      editor.add({
        name: "init",
        description: "guided AGENTS.md setup",
        execute: (input) =>
          Effect.gen(function* () {
            const activeModel = yield* resolveEffectiveModel(input.sessionID)
            const useNative =
              activeModel?.providerID === LOCAL_PROVIDER_ID &&
              supportsNativeSlashCommand(
                normalizeEngine(activeModel.id),
                "init",
                os.homedir(),
                location.project.directory,
              )
            const text = useNative
              ? formatNativeSlash("init", input.prompt.text)
              : append(PROMPT_INITIALIZE.replace("${path}", location.project.directory), input.prompt.text)
            yield* ctx.session.prompt({
              ...input.prompt,
              sessionID: input.sessionID,
              text,
              delivery: input.delivery,
            })
          }).pipe(Effect.asVoid),
      })
      editor.add({
        name: "review",
        description: "review changes [commit|branch|pr], defaults to uncommitted",
        execute: (input) =>
          Effect.gen(function* () {
            const activeModel = yield* resolveEffectiveModel(input.sessionID)
            const useNative =
              activeModel?.providerID === LOCAL_PROVIDER_ID &&
              supportsNativeSlashCommand(
                normalizeEngine(activeModel.id),
                "review",
                os.homedir(),
                location.project.directory,
              )
            const text = useNative
              ? formatNativeSlash("review", input.prompt.text)
              : append(PROMPT_REVIEW.replace("${path}", location.project.directory), input.prompt.text)
            yield* ctx.session.prompt({
              ...input.prompt,
              sessionID: input.sessionID,
              text,
              delivery: input.delivery,
            })
          }).pipe(Effect.asVoid),
      })
      for (const prompt of loaded.prompts) {
        editor.add({
          name: mcpCommandName(prompt.server, prompt.name),
          description: prompt.description,
          execute: (input) =>
            Effect.gen(function* () {
              const args = parseArguments(input.prompt.text)
              const result = yield* mcp.prompt({
                server: prompt.server,
                name: prompt.name,
                args: Object.fromEntries(
                  (prompt.arguments ?? []).map((argument, index) => [argument.name, args[index] ?? ""]),
                ),
              })
              if (!result) return yield* Effect.fail(new Error(`MCP prompt not found: ${prompt.server}:${prompt.name}`))
              yield* ctx.session.prompt({
                ...input.prompt,
                sessionID: input.sessionID,
                text: result.messages
                  .map((message) => promptMessageText(message.content))
                  .join("\n")
                  .trim(),
                delivery: input.delivery,
              })
            }).pipe(Effect.asVoid),
        })
      }
    })
  }),
})

function formatNativeSlash(name: string, input: string) {
  const value = input.trim()
  return value ? `/${name} ${value}` : `/${name}`
}

function append(template: string, input: string) {
  const value = input.trim()
  if (template.includes("$ARGUMENTS")) return template.replaceAll("$ARGUMENTS", () => value)
  return [template, value].filter(Boolean).join("\n\n")
}

function parseArguments(input: string) {
  return (input.match(argsRegex) ?? []).map((argument) => argument.replace(quoteTrimRegex, ""))
}

function promptMessageText(content: unknown) {
  if (typeof content === "string") return content
  if (!content || typeof content !== "object") return ""
  if (!("type" in content) || content.type !== "text") return ""
  if (!("text" in content) || typeof content.text !== "string") return ""
  return content.text
}

function mcpCommandName(server: string, prompt: string) {
  return `${sanitize(server)}:${sanitize(prompt)}`
}

function sanitize(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_")
}

const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const quoteTrimRegex = /^["']|["']$/g
