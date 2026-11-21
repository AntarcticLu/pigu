export * as SandboxPlugin from "./sandbox.js"

import { define } from "@opencode/plugin/effect/plugin"
import type { RpcRegistration } from "@opencode/plugin/effect/rpc"
import { Sandbox } from "@opencode/schema/sandbox"
import { optional } from "@opencode/schema/schema"
import { Tool } from "@opencode/schema/tool"
import { Clock, Effect, Option, Schema, Stream } from "effect"

const PREFIX = "session:"
const MAX_ITEMS_PER_SESSION = 40
const MAX_CODE_CHARS = 512_000

const StoredList = Schema.Array(Sandbox.Item)
const decodeStoredList = Schema.decodeUnknownOption(StoredList)

export const PreviewToolInput = Schema.Struct({
  id: optional(Schema.String).annotate({
    description: "Existing sandbox preview ID (sbx_...) to update in place. Omit to create a new preview.",
  }),
  title: Schema.String.annotate({
    description: "Short display title shown on the right-hand Sandbox tab (for example 'Compound Interest Calculator').",
  }),
  language: Sandbox.Language.annotate({
    description:
      "Runtime language: 'tsx' or 'jsx' for interactive React + Tailwind + Lucide/Recharts components, 'html' for standalone HTML/CSS/JS pages, or 'svg' for vector graphics.",
  }),
  code: Schema.String.annotate({
    description:
      "Complete runnable source code for the entry component or document. For tsx/jsx, export default a React component.",
  }),
  files: optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "Optional extra UTF-8 files keyed by relative path (for example {'styles.css': '...', 'data.json': '...'}).",
  }),
  entry: optional(Schema.String).annotate({
    description: "Optional entry filename when files are provided (for example 'index.html' or 'App.tsx').",
  }),
})

export const IdToolInput = Schema.Struct({
  id: Schema.String.annotate({ description: "Sandbox preview ID (sbx_...)." }),
})

const ListToolOutput = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      language: Sandbox.Language,
      updatedAt: Schema.Number,
    }),
  ),
})

const DeleteToolOutput = Schema.Struct({
  id: Schema.String,
  deleted: Schema.Boolean,
})

function makeSandboxId() {
  return `sbx_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`
}

export const Plugin = define({
  id: "opencode.sandbox",
  effect: Effect.fn("SandboxPlugin.Plugin")(function* (ctx) {
    const readList = Effect.fn("SandboxPlugin.readList")(function* (sessionID: string) {
      const raw = yield* ctx.storage.get(PREFIX + sessionID)
      return Option.getOrElse(decodeStoredList(raw), (): readonly Sandbox.Item[] => [])
    })

    const writeList = Effect.fn("SandboxPlugin.writeList")(function* (
      sessionID: string,
      items: readonly Sandbox.Item[],
    ) {
      if (items.length === 0) {
        yield* ctx.storage.remove(PREFIX + sessionID)
        return
      }
      yield* ctx.storage.set(PREFIX + sessionID, items)
    })

    const upsertItem = Effect.fn("SandboxPlugin.upsert")(function* (
      input: Sandbox.UpsertInput,
      emitChange: (event: Sandbox.ChangedEvent) => Effect.Effect<void>,
    ) {
      const now = yield* Clock.currentTimeMillis
      const current = yield* readList(input.sessionID)
      const trimmedTitle = input.title.trim() || "Sandbox Preview"
      const boundedCode = input.code.length > MAX_CODE_CHARS ? input.code.slice(0, MAX_CODE_CHARS) : input.code

      const existing =
        (input.id ? current.find((item) => item.id === input.id) : undefined) ??
        (input.hash ? current.find((item) => item.hash === input.hash) : undefined)

      const saved: Sandbox.Item = existing
        ? {
            ...existing,
            title: trimmedTitle,
            language: input.language,
            code: boundedCode,
            ...(input.files !== undefined ? { files: input.files } : {}),
            ...(input.entry !== undefined ? { entry: input.entry } : {}),
            ...(input.hash !== undefined ? { hash: input.hash } : {}),
            updatedAt: now,
          }
        : {
            id: input.id && input.id.startsWith("sbx_") ? input.id : makeSandboxId(),
            sessionID: input.sessionID,
            title: trimmedTitle,
            language: input.language,
            code: boundedCode,
            ...(input.files !== undefined ? { files: input.files } : {}),
            ...(input.entry !== undefined ? { entry: input.entry } : {}),
            ...(input.hash !== undefined ? { hash: input.hash } : {}),
            createdAt: now,
            updatedAt: now,
          }

      const withoutSaved = current.filter((item) => item.id !== saved.id)
      const next = [...withoutSaved, saved].slice(-MAX_ITEMS_PER_SESSION)
      yield* writeList(input.sessionID, next)
      yield* emitChange({
        sessionID: input.sessionID,
        items: next,
        ...(input.focus === false ? {} : { focusID: saved.id }),
      })
      return saved
    })

    const removeItem = Effect.fn("SandboxPlugin.remove")(function* (
      sessionID: string,
      id: string,
      emitChange: (event: Sandbox.ChangedEvent) => Effect.Effect<void>,
    ) {
      const current = yield* readList(sessionID)
      const next = current.filter((item) => item.id !== id)
      if (next.length === current.length) return false
      yield* writeList(sessionID, next)
      yield* emitChange({ sessionID, items: next })
      return true
    })

    let emitChanged: (event: Sandbox.ChangedEvent) => Effect.Effect<void> = () => Effect.void

    const publish = (event: Sandbox.ChangedEvent): Effect.Effect<void> => emitChanged(event)

    const rpc: RpcRegistration<typeof Sandbox.Definition> = yield* ctx.rpc
      .register(Sandbox.Definition, {
        list: (input) => readList(input.sessionID).pipe(Effect.map((items) => [...items])),
        get: (input) =>
          readList(input.sessionID).pipe(Effect.map((items) => items.find((item) => item.id === input.id) ?? null)),
        upsert: (input) => upsertItem(input, publish),
        remove: (input) => removeItem(input.sessionID, input.id, publish),
      })
      .pipe(Effect.orDie)

    emitChanged = (event) =>
      rpc.events
        .emit("changed", event)
        .pipe(Effect.catchCause((cause) => Effect.logWarning("failed to publish sandbox change", { cause })))

    yield* ctx.event.subscribe({ types: ["session.deleted"] }).pipe(
      Stream.runForEach((event) => ctx.storage.remove(PREFIX + event.data.sessionID)),
      Effect.forkScoped({ startImmediately: true }),
    )

    yield* ctx.tool
      .transform((editor) => {
        editor.namespace({
          name: "sandbox",
          description:
            "Interactive right-hand Sandbox preview in Pigu Desktop. Renders standalone HTML/CSS/JS, React (JSX/TSX with Tailwind CSS, Lucide icons, Recharts, Framer Motion, Three.js), and SVG live in the side panel without requiring a local dev server.",
        })

        editor.add({
          name: "preview",
          description:
            "Render or update an interactive live Artifact in Pigu's right-hand Sandbox panel and automatically open it for the user. Supports 'tsx' / 'jsx' (React 18 + Tailwind CSS + Lucide + Recharts, zero setup—export default your root component), 'html' (standalone HTML/CSS/JS), and 'svg'. Pass `id` to update an existing preview in place.",
          input: PreviewToolInput,
          output: Sandbox.Item,
          options: { namespace: "sandbox", codemode: true },
          execute: (input, toolCtx) =>
            upsertItem(
              {
                sessionID: toolCtx.sessionID,
                id: input.id,
                title: input.title,
                language: input.language,
                code: input.code,
                files: input.files,
                entry: input.entry,
                focus: true,
              },
              publish,
            ).pipe(
              Effect.map((saved) => ({
                output: saved,
                content: `Opened interactive sandbox preview "${saved.title}" (${saved.id}, ${saved.language}) in the right-hand Sandbox panel.`,
              })),
            ),
        })

        editor.add({
          name: "list",
          description: "List interactive Sandbox previews created in this session.",
          input: Schema.Struct({}),
          output: ListToolOutput,
          options: { namespace: "sandbox", codemode: true },
          execute: (_input, toolCtx) =>
            readList(toolCtx.sessionID).pipe(
              Effect.map((items) => ({
                output: {
                  items: items.map((item) => ({
                    id: item.id,
                    title: item.title,
                    language: item.language,
                    updatedAt: item.updatedAt,
                  })),
                },
                content: JSON.stringify(
                  items.map((item) => ({ id: item.id, title: item.title, language: item.language })),
                ),
              })),
            ),
        })

        editor.add({
          name: "get",
          description: "Read the source code and metadata of a Sandbox preview in this session by ID.",
          input: IdToolInput,
          output: Sandbox.Item,
          options: { namespace: "sandbox", codemode: true },
          execute: (input, toolCtx) =>
            readList(toolCtx.sessionID).pipe(
              Effect.flatMap((items) => {
                const found = items.find((item) => item.id === input.id)
                if (!found) {
                  return Effect.fail(new Tool.Error({ message: `Sandbox preview not found: ${input.id}` }))
                }
                return Effect.succeed({
                  output: found,
                  content: found.code,
                })
              }),
            ),
        })

        editor.add({
          name: "delete",
          description: "Delete a Sandbox preview in this session by ID.",
          input: IdToolInput,
          output: DeleteToolOutput,
          options: { namespace: "sandbox", codemode: true },
          execute: (input, toolCtx) =>
            removeItem(toolCtx.sessionID, input.id, publish).pipe(
              Effect.map((deleted) => ({
                output: { id: input.id, deleted },
                content: deleted ? `Deleted sandbox preview ${input.id}.` : `Sandbox preview ${input.id} not found.`,
              })),
            ),
        })
      })
      .pipe(Effect.orDie)
  }),
})
