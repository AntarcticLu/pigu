import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { ai } from "../src/effect.js"
import { LLMClient, mergeTransport } from "../src/route.js"
import { configure } from "../src/providers/openai.js"
import { AnthropicCompatible } from "../src/providers/anthropic-compatible.js"
import { dynamicResponse } from "./lib/http.js"
import { deltaChunk, finishChunk } from "./lib/openai-chunks.js"
import { sseEvents, sseRaw } from "./lib/sse.js"
import { it } from "./lib/effect.js"

const model = configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).chat("gpt-4.1-mini")
const responsesModel = configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).responses("gpt-5")
const anthropicModel = AnthropicCompatible.configure({
  baseURL: "https://api.anthropic.test/v1/",
  apiKey: "test",
  provider: "anthropic-relay",
}).model("claude-sonnet-4-6")
const SSE = { headers: { "content-type": "text/event-stream" } }

const silentServer = dynamicResponse(() => Effect.never)

const slowHeadersServer = dynamicResponse((input) =>
  Effect.sleep("10 minutes").pipe(
    Effect.as(input.respond(sseEvents(deltaChunk({ role: "assistant", content: "Hi" }), finishChunk("stop")), SSE)),
  ),
)

// Sends one chunk, then stalls until `resume` releases the rest of the body.
const stalledServer = Effect.gen(function* () {
  const stalled = yield* Deferred.make<void>()
  let resume = () => {}
  const released = new Promise<void>((resolve) => {
    resume = resolve
  })
  const encoder = new TextEncoder()
  const layer = dynamicResponse((input) =>
    Effect.sync(() =>
      input.respond(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(sseRaw(`data: ${JSON.stringify(deltaChunk({ content: "Hi" }))}`)))
          },
          async pull(controller) {
            Deferred.doneUnsafe(stalled, Effect.void)
            await released
            controller.enqueue(encoder.encode(sseEvents(finishChunk("stop"))))
            controller.close()
          },
        }),
        SSE,
      ),
    ),
  )
  return { layer, stalled, resume: () => resume() }
})

describe("HTTP transport timeouts", () => {
  it.effect("fails when response headers take longer than five minutes", () =>
    Effect.gen(function* () {
      const fiber = yield* LLMClient.generate(ai.request({ model, prompt: "Hello" })).pipe(
        Effect.provide(silentServer),
        Effect.flip,
        Effect.forkChild({ startImmediately: true }),
      )
      yield* TestClock.adjust("5 minutes")
      const error = yield* Fiber.join(fiber)

      expect(error.reason).toMatchObject({
        _tag: "Transport",
        transport: "http",
        operation: "request",
        code: "Timeout",
      })
    }),
  )

  it.effect("fails when the response body stalls for fifteen minutes", () =>
    Effect.gen(function* () {
      const server = yield* stalledServer
      const fiber = yield* LLMClient.generate(ai.request({ model, prompt: "Hello" })).pipe(
        Effect.provide(server.layer),
        Effect.flip,
        Effect.forkChild({ startImmediately: true }),
      )
      yield* Deferred.await(server.stalled)
      yield* Effect.yieldNow
      yield* TestClock.adjust("15 minutes")
      const error = yield* Fiber.join(fiber)

      expect(error.reason).toMatchObject({ _tag: "Transport", transport: "http", operation: "read", code: "Timeout" })
      expect(error.reason.http).toMatchObject({ status: 200 })
    }),
  )

  it.effect("applies a configured header timeout", () =>
    Effect.gen(function* () {
      const fiber = yield* LLMClient.generate(ai.request({ model, prompt: "Hello", timeout: { headers: 1_000 } })).pipe(
        Effect.provide(silentServer),
        Effect.flip,
        Effect.forkChild({ startImmediately: true }),
      )
      yield* TestClock.adjust("1 second")
      const error = yield* Fiber.join(fiber)

      expect(error.reason).toMatchObject({ _tag: "Transport", operation: "request", code: "Timeout" })
    }),
  )

  it.effect("disables the header timeout with false", () =>
    Effect.gen(function* () {
      const fiber = yield* LLMClient.generate(ai.request({ model, prompt: "Hello", timeout: { headers: false } })).pipe(
        Effect.provide(slowHeadersServer),
        Effect.forkChild({ startImmediately: true }),
      )
      yield* TestClock.adjust("10 minutes")
      const response = yield* Fiber.join(fiber)

      expect(response.text).toBe("Hi")
    }),
  )

  it.effect("disables the chunk timeout with false", () =>
    Effect.gen(function* () {
      const server = yield* stalledServer
      const fiber = yield* LLMClient.generate(ai.request({ model, prompt: "Hello", timeout: { chunk: false } })).pipe(
        Effect.provide(server.layer),
        Effect.forkChild({ startImmediately: true }),
      )
      yield* Deferred.await(server.stalled)
      yield* Effect.yieldNow
      yield* TestClock.adjust("10 minutes")
      server.resume()
      const response = yield* Fiber.join(fiber)

      expect(response.text).toBe("Hi")
    }),
  )

  it.effect("applies a whole-request timeout while the body is still streaming", () =>
    Effect.gen(function* () {
      const server = yield* stalledServer
      const fiber = yield* LLMClient.generate(
        ai.request({ model, prompt: "Hello", timeout: { total: 60_000, chunk: false } }),
      ).pipe(Effect.provide(server.layer), Effect.flip, Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(server.stalled)
      yield* Effect.yieldNow
      yield* TestClock.adjust("1 minute")
      const error = yield* Fiber.join(fiber)

      expect(error.reason).toMatchObject({ _tag: "Transport", operation: "read", code: "Timeout" })
    }),
  )

  it.effect("bounds the header wait by a shorter whole-request timeout", () =>
    Effect.gen(function* () {
      const fiber = yield* LLMClient.generate(
        ai.request({ model, prompt: "Hello", timeout: { total: 1_000, headers: false } }),
      ).pipe(Effect.provide(silentServer), Effect.flip, Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust("1 second")
      const error = yield* Fiber.join(fiber)

      expect(error.reason).toMatchObject({ _tag: "Transport", operation: "request", code: "Timeout" })
    }),
  )

  it.effect("merges timeouts with later values winning", () =>
    Effect.sync(() => {
      const merged = mergeTransport(
        { timeout: { total: 5_000, headers: 1_000, chunk: 2_000 } },
        { headers: { a: "b" } },
        { timeout: { chunk: false } },
        { timeout: 3_000 },
      )

      expect(merged).toMatchObject({ headers: { a: "b" }, timeout: { total: 3_000, headers: 1_000, chunk: false } })
      expect(mergeTransport({}, undefined)).toEqual({})
    }),
  )

  it.effect("fails when SSE keepalive ping frames arrive without semantic progress", () =>
    Effect.gen(function* () {
      let waiting = yield* Deferred.make<void>()
      let sendPing = () => {}
      const encoder = new TextEncoder()
      const layer = dynamicResponse((input) =>
        Effect.sync(() =>
          input.respond(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    sseEvents({
                      type: "response.created",
                      response: { id: "resp_ping_only", status: "in_progress", output: [] },
                    }),
                  ),
                )
              },
              async pull(controller) {
                Deferred.doneUnsafe(waiting, Effect.void)
                await new Promise<void>((resolve) => {
                  sendPing = resolve
                })
                controller.enqueue(encoder.encode(sseEvents({ type: "ping", sequence_number: 1 })))
              },
            }),
            SSE,
          ),
        ),
      )

      const fiber = yield* LLMClient.generate(
        ai.request({ model: responsesModel, prompt: "Hello", timeout: { chunk: 60_000 } }),
      ).pipe(Effect.provide(layer), Effect.flip, Effect.forkChild({ startImmediately: true }))

      for (const step of ["25 seconds", "25 seconds"] as const) {
        yield* Deferred.await(waiting)
        yield* Effect.yieldNow
        yield* TestClock.adjust(step)
        waiting = yield* Deferred.make<void>()
        sendPing()
      }

      yield* Deferred.await(waiting)
      yield* Effect.yieldNow
      yield* TestClock.adjust("10 seconds")
      const error = yield* Fiber.join(fiber)

      expect(error.reason).toMatchObject({ _tag: "Transport", transport: "http", operation: "read", code: "Timeout" })
    }),
  )

  it.effect("bounds mid-tool-argument stalls to ninety seconds even when ping frames keep arriving", () =>
    Effect.gen(function* () {
      let waiting = yield* Deferred.make<void>()
      let sendPing = () => {}
      const encoder = new TextEncoder()
      const layer = dynamicResponse((input) =>
        Effect.sync(() =>
          input.respond(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    sseEvents(
                      {
                        type: "response.created",
                        response: { id: "resp_patch_stall", status: "in_progress", output: [] },
                      },
                      {
                        type: "response.output_item.added",
                        output_index: 0,
                        item: {
                          type: "function_call",
                          id: "fc_patch_1",
                          call_id: "call_patch_1",
                          name: "patch",
                          arguments: "",
                        },
                      },
                      {
                        type: "response.function_call_arguments.delta",
                        item_id: "fc_patch_1",
                        output_index: 0,
                        delta: '{"patchText":"*** Begin Patch\\n',
                      },
                    ),
                  ),
                )
              },
              async pull(controller) {
                Deferred.doneUnsafe(waiting, Effect.void)
                await new Promise<void>((resolve) => {
                  sendPing = resolve
                })
                controller.enqueue(encoder.encode(sseEvents({ type: "ping", sequence_number: 2 })))
              },
            }),
            SSE,
          ),
        ),
      )

      const fiber = yield* LLMClient.generate(ai.request({ model: responsesModel, prompt: "Write demo" })).pipe(
        Effect.provide(layer),
        Effect.flip,
        Effect.forkChild({ startImmediately: true }),
      )

      for (const step of ["30 seconds", "30 seconds", "25 seconds"] as const) {
        yield* Deferred.await(waiting)
        yield* Effect.yieldNow
        yield* TestClock.adjust(step)
        waiting = yield* Deferred.make<void>()
        sendPing()
      }

      yield* Deferred.await(waiting)
      yield* Effect.yieldNow
      yield* TestClock.adjust("5 seconds")
      const error = yield* Fiber.join(fiber)

      expect(error.reason).toMatchObject({
        _tag: "Transport",
        transport: "http",
        operation: "read",
        code: "Timeout",
        message: "Timed out waiting for streamed tool arguments",
      })
    }),
  )

  it.effect("completes Anthropic stream cleanly after message_stop when a proxy holds the socket open", () =>
    Effect.gen(function* () {
      const stalled = yield* Deferred.make<void>()
      const encoder = new TextEncoder()
      const layer = dynamicResponse((input) =>
        Effect.sync(() =>
          input.respond(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    [
                      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-6","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
                      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
                      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Done!"}}\n\n',
                      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
                      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}\n\n',
                      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
                    ].join(""),
                  ),
                )
              },
              async pull() {
                Deferred.doneUnsafe(stalled, Effect.void)
                await new Promise<void>(() => {})
              },
            }),
            SSE,
          ),
        ),
      )

      const fiber = yield* LLMClient.generate(ai.request({ model: anthropicModel, prompt: "Hi" })).pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true }),
      )

      yield* Deferred.await(stalled)
      yield* Effect.yieldNow
      yield* TestClock.adjust("5 seconds")
      const response = yield* Fiber.join(fiber)

      expect(response.text).toBe("Done!")
    }),
  )

  it.effect("settles OpenAI Chat cleanly after finish_reason when a compatible proxy omits [DONE]", () =>
    Effect.gen(function* () {
      const stalled = yield* Deferred.make<void>()
      const encoder = new TextEncoder()
      const layer = dynamicResponse((input) =>
        Effect.sync(() =>
          input.respond(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    sseRaw(
                      `data: ${JSON.stringify(deltaChunk({ role: "assistant", content: "Hello from relay" }))}\n\ndata: ${JSON.stringify(finishChunk("stop"))}`,
                    ),
                  ),
                )
              },
              async pull() {
                Deferred.doneUnsafe(stalled, Effect.void)
                await new Promise<void>(() => {})
              },
            }),
            SSE,
          ),
        ),
      )

      const fiber = yield* LLMClient.generate(ai.request({ model, prompt: "Hello" })).pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true }),
      )

      yield* Deferred.await(stalled)
      yield* Effect.yieldNow
      yield* TestClock.adjust("15 seconds")
      const response = yield* Fiber.join(fiber)

      expect(response.text).toBe("Hello from relay")
    }),
  )
})
