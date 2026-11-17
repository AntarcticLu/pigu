import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Command } from "@opencode/core/command"
import { Bus } from "@opencode/core/bus"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { Mcp } from "@opencode/core/mcp/index"
import { CommandPlugin } from "@opencode/core/plugin/command"
import { AbsolutePath } from "@opencode/core/schema"
import { Model } from "@opencode/schema/model"
import { Money } from "@opencode/schema/money"
import { Project } from "@opencode/schema/project"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { SessionMessage } from "@opencode/schema/session-message"
import { TokenUsage } from "@opencode/schema/token-usage"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { DateTime } from "effect"
import { emptyMcpLayer } from "../fixture/mcp"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { host } from "./host"
import PROMPT_INITIALIZE from "../../src/plugin/command/initialize.txt"
import PROMPT_REVIEW from "../../src/plugin/command/review.txt"

const directory = AbsolutePath.make("/repo/packages/app")
const project = AbsolutePath.make("/repo")
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory }, { projectDirectory: project })),
)
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Command.node, Mcp.node, Bus.node]), [
    Mcp.node.replace(emptyMcpLayer),
    Location.node.replace(locationLayer),
  ]),
)

describe("CommandPlugin.Plugin", () => {
  it.effect("registers built-in init and review commands", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const prompts: {
        text: string
        files?: readonly { readonly uri: string }[]
        delivery?: "steer" | "queue"
      }[] = []
      yield* CommandPlugin.Plugin.effect(
        host({
          command: {
            list: () => Effect.die("unused command.list"),
            transform: command.transform,
            reload: command.reload,
          },
          session: {
            prompt: (input) =>
              Effect.sync(() => {
                prompts.push({ text: input.text, files: input.files, delivery: input.delivery })
                return SessionInbox.User.make({
                  id: SessionMessage.ID.make("msg_test"),
                  sessionID: input.sessionID,
                  time: { created: DateTime.makeUnsafe(0) },
                  type: "user",
                  payload: { text: input.text },
                  delivery: input.delivery ?? "steer",
                })
              }),
          },
        }),
      ).pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory }, { projectDirectory: project })),
        ),
      )

      expect(yield* command.get("init")).toMatchObject({
        name: "init",
        description: "guided AGENTS.md setup",
      })
      expect(yield* command.get("review")).toMatchObject({
        name: "review",
        description: "review changes [commit|branch|pr], defaults to uncommitted",
      })
      yield* command.execute({
        name: "init",
        invocation: {
          sessionID: Session.ID.make("ses_test"),
          prompt: { text: "extra context", files: [{ uri: "file:///tmp/context.md" }] },
          delivery: "queue",
        },
      })
      yield* command.execute({
        name: "review",
        invocation: {
          sessionID: Session.ID.make("ses_test"),
          prompt: { text: "  branch $& $$ $` $'  " },
          delivery: "steer",
        },
      })
      yield* command.execute({
        name: "init",
        invocation: {
          sessionID: Session.ID.make("ses_test"),
          prompt: { text: "" },
          delivery: "steer",
        },
      })
      yield* command.execute({
        name: "review",
        invocation: {
          sessionID: Session.ID.make("ses_test"),
          prompt: { text: "   " },
          delivery: "steer",
        },
      })
      expect(prompts).toEqual([
        {
          text: PROMPT_INITIALIZE.replace("${path}", project).replaceAll("$ARGUMENTS", "extra context"),
          files: [{ uri: "file:///tmp/context.md" }],
          delivery: "queue",
        },
        {
          text: PROMPT_REVIEW.replace("${path}", project).replaceAll("$ARGUMENTS", () => "branch $& $$ $` $'"),
          files: undefined,
          delivery: "steer",
        },
        {
          text: PROMPT_INITIALIZE.replace("${path}", project).replaceAll("$ARGUMENTS", ""),
          files: undefined,
          delivery: "steer",
        },
        {
          text: PROMPT_REVIEW.replace("${path}", project).replaceAll("$ARGUMENTS", ""),
          files: undefined,
          delivery: "steer",
        },
      ])
    }),
  )

  it.effect("delegates /init and /review to native CLI commands when session uses local provider", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const prompts: string[] = []
      const modelsBySession = new Map<string, { providerID: string; id: string }>([
        ["ses_claude", { providerID: "local", id: "claude/claude-sonnet-4-6" }],
        ["ses_codex", { providerID: "local", id: "codex/gpt-5.4" }],
        ["ses_api", { providerID: "openai", id: "gpt-5.4" }],
      ])

      yield* CommandPlugin.Plugin.effect(
        host({
          command: {
            list: () => Effect.die("unused command.list"),
            transform: command.transform,
            reload: command.reload,
          },
          session: {
            get: ({ sessionID }) =>
              Effect.sync(() => {
                const chosen = modelsBySession.get(sessionID)
                return Session.Info.make({
                  id: sessionID,
                  projectID: Project.ID.make("proj_test"),
                  model: chosen
                    ? Model.Ref.make({
                        providerID: Provider.ID.make(chosen.providerID),
                        id: Model.ID.make(chosen.id),
                      })
                    : undefined,
                  cost: Money.USD.make(0),
                  tokens: TokenUsage.Info.make({
                    input: 0,
                    output: 0,
                    reasoning: 0,
                    cache: { read: 0, write: 0 },
                  }),
                  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
                  location: { directory },
                })
              }),
            prompt: (input) =>
              Effect.sync(() => {
                prompts.push(input.text)
                return SessionInbox.User.make({
                  id: SessionMessage.ID.make("msg_test"),
                  sessionID: input.sessionID,
                  time: { created: DateTime.makeUnsafe(0) },
                  type: "user",
                  payload: { text: input.text },
                  delivery: input.delivery ?? "steer",
                })
              }),
          },
        }),
      ).pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory }, { projectDirectory: project })),
        ),
      )

      // Claude gets native /init and /review
      yield* command.execute({
        name: "init",
        invocation: { sessionID: Session.ID.make("ses_claude"), prompt: { text: "" }, delivery: "steer" },
      })
      yield* command.execute({
        name: "review",
        invocation: { sessionID: Session.ID.make("ses_claude"), prompt: { text: "main" }, delivery: "steer" },
      })

      // Codex gets native /review, while /init stays on AGENTS.md template
      yield* command.execute({
        name: "review",
        invocation: { sessionID: Session.ID.make("ses_codex"), prompt: { text: "dev" }, delivery: "steer" },
      })
      yield* command.execute({
        name: "init",
        invocation: { sessionID: Session.ID.make("ses_codex"), prompt: { text: "" }, delivery: "steer" },
      })

      // API models keep Pigu's own /review template
      yield* command.execute({
        name: "review",
        invocation: { sessionID: Session.ID.make("ses_api"), prompt: { text: "" }, delivery: "steer" },
      })

      expect(prompts[0]).toBe("/init")
      expect(prompts[1]).toBe("/review main")
      expect(prompts[2]).toBe("/review dev")
      expect(prompts[3]).toContain("Create or update `AGENTS.md`")
      expect(prompts[4]).toContain("You are a code reviewer.")
    }),
  )
})
