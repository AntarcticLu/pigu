import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Model } from "@opencode/core/model"
import { ModelResolver } from "@opencode/core/model-resolver"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { Provider } from "@opencode/core/provider"
import {
  detectModelProtocol,
  normalizeBaseURL,
  PiguProviderPlugin,
  protocolBaseURL,
} from "@opencode/core/plugin/provider/pigu"
import { drain } from "../lib/clock"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const providerID = Provider.ID.make("pigu")
const integrationID = Integration.ID.make("pigu")

const addPlugin = Effect.fn(function* () {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin, "test")
  yield* PiguProviderPlugin.effect(host)
})

const discovery = Effect.gen(function* () {
  const providers = yield* Provider.Service
  const models = yield* Model.Service
  const integrations = yield* Integration.Service
  const credentials = yield* Credential.Service
  const remote: {
    status: number
    body: unknown
    requests: HttpClientRequest.HttpClientRequest[]
  } = {
    status: 200,
    body: {
      data: [
        { id: "gpt-4o", name: "GPT-4o", context_length: 128_000, max_output_tokens: 16_384 },
        { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
        { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
        { id: "deepseek-r1" },
      ],
    },
    requests: [],
  }
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      remote.requests.push(request)
      return HttpClientResponse.fromWeb(request, Response.json(remote.body, { status: remote.status }))
    }),
  )
  return {
    providers,
    models,
    integrations,
    credentials,
    remote,
    install: addPlugin().pipe(Effect.provideService(HttpClient.HttpClient, http)),
  }
})

describe("PiguProviderPlugin", () => {
  test("normalizes API base URLs across common user inputs", () => {
    expect(normalizeBaseURL("https://api.openai.com")).toBe("https://api.openai.com/v1")
    expect(normalizeBaseURL("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1")
    expect(normalizeBaseURL("https://api.openai.com/v1/chat/completions")).toBe("https://api.openai.com/v1")
    expect(normalizeBaseURL("https://api.openai.com/v1/models")).toBe("https://api.openai.com/v1")
    expect(normalizeBaseURL("api.deepseek.com")).toBe("https://api.deepseek.com/v1")
    expect(normalizeBaseURL("localhost:11434")).toBe("http://localhost:11434/v1")
  })

  test("auto-detects mainstream protocol types and normalizes protocol base URLs", () => {
    expect(detectModelProtocol("gemini-2.5-pro")).toBe("gemini")
    expect(detectModelProtocol("claude-sonnet-4-5")).toBe("anthropic")
    expect(detectModelProtocol("gpt-5-codex")).toBe("openai-responses")
    expect(detectModelProtocol("gpt-4o")).toBe("openai-chat")

    expect(protocolBaseURL("https://pigutoken.com/v1", "gemini")).toBe("https://pigutoken.com/v1beta")
    expect(protocolBaseURL("https://pigutoken.com/v1", "anthropic")).toBe("https://pigutoken.com/v1")
    expect(protocolBaseURL("https://generativelanguage.googleapis.com/v1beta", "openai-chat")).toBe(
      "https://generativelanguage.googleapis.com/v1",
    )
  })

  it.effect("registers the pigu integration with URL + Key form and environment fallback", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      yield* addPlugin()
      const integration = yield* integrations.get(integrationID)
      expect(integration?.name).toBe("Pigu API")
      expect(integration?.methods).toHaveLength(2)
      expect(integration?.methods[0]).toMatchObject({
        type: "key",
        form: [{ key: "baseURL", type: "string", title: "Enter API Base URL" }],
      })
      expect(integration?.methods[1]).toEqual({
        type: "env",
        names: ["PIGU_API_KEY", "OPENAI_API_KEY"],
      })
    }),
  )

  it.effect("discovers models from GET /models when connected with URL and Key", () =>
    Effect.gen(function* () {
      const fixture = yield* discovery
      yield* fixture.install
      yield* drain

      yield* fixture.integrations.connection.key({
        integrationID,
        key: "sk-test-123",
        answer: { baseURL: "https://api.example.com/v1/chat/completions" },
      })
      yield* drain

      const saved = yield* fixture.credentials.list(integrationID)
      expect(saved).toHaveLength(1)
      expect(saved[0]?.label).toBe("https://api.example.com/v1/chat/completions")

      expect(fixture.remote.requests).toHaveLength(1)
      expect(fixture.remote.requests[0]).toMatchObject({
        method: "GET",
        url: "https://api.example.com/v1/models",
        headers: {
          authorization: "Bearer sk-test-123",
          accept: "application/json",
        },
      })

      const gpt4o = yield* fixture.models.get(providerID, Model.ID.make("gpt-4o"))
      expect(gpt4o).toMatchObject({
        id: "gpt-4o",
        name: "GPT-4o",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: "https://api.example.com/v1", provider: "pigu", piguProtocol: "openai-chat" },
        capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
        limit: { context: 128_000, output: 16_384 },
      })

      const gemini = yield* fixture.models.get(providerID, Model.ID.make("gemini-2.5-pro"))
      expect(gemini).toMatchObject({
        id: "gemini-2.5-pro",
        package: "@opencode/ai/providers/google",
        settings: { baseURL: "https://api.example.com/v1beta", provider: "pigu", piguProtocol: "gemini" },
      })

      const claude = yield* fixture.models.get(providerID, Model.ID.make("claude-sonnet-4-5"))
      expect(claude).toMatchObject({
        id: "claude-sonnet-4-5",
        package: "@opencode/ai/providers/anthropic-compatible",
        settings: { baseURL: "https://api.example.com/v1", provider: "pigu", piguProtocol: "anthropic" },
      })

      expect(gpt4o?.variants).toEqual([])
      expect(gemini?.variants.map((v) => String(v.id))).toEqual(["low", "medium", "high"])
      expect(claude?.variants.map((v) => String(v.id))).toEqual(["high", "max"])

      const overridden = yield* ModelResolver.withVariant(gemini!, Model.VariantID.make("high"))
      expect(overridden).toMatchObject({
        package: "@opencode/ai/providers/google",
        settings: {
          baseURL: "https://api.example.com/v1beta",
          provider: "pigu",
          piguProtocol: "gemini",
          thinkingConfig: { includeThoughts: true, thinkingLevel: "high" },
        },
      })

      const r1 = yield* fixture.models.get(providerID, Model.ID.make("deepseek-r1"))
      expect(r1).toMatchObject({
        id: "deepseek-r1",
        name: "deepseek-r1",
        settings: { baseURL: "https://api.example.com/v1", provider: "pigu", piguProtocol: "openai-chat" },
        limit: { context: 128_000, output: 16_384 },
      })
      expect(r1?.variants.map((v) => String(v.id))).toEqual(["low", "high", "max"])
    }),
  )

  it.effect("switches endpoints and refreshes models when activating another saved URL + Key credential", () =>
    Effect.gen(function* () {
      const fixture = yield* discovery
      yield* fixture.install
      yield* drain

      yield* fixture.integrations.connection.key({
        integrationID,
        key: "sk-first",
        answer: { baseURL: "https://first.example.com/v1" },
      })
      yield* drain
      expect(yield* fixture.models.get(providerID, Model.ID.make("gpt-4o"))).toBeDefined()

      fixture.remote.body = { data: [{ id: "qwen-max", name: "Qwen Max" }] }
      yield* fixture.integrations.connection.key({
        integrationID,
        key: "sk-second",
        answer: { baseURL: "https://second.example.com/v1" },
      })
      yield* drain

      expect(fixture.remote.requests.at(-1)?.url).toBe("https://second.example.com/v1/models")
      expect(yield* fixture.models.get(providerID, Model.ID.make("gpt-4o"))).toBeUndefined()
      const qwen = yield* fixture.models.get(providerID, Model.ID.make("qwen-max"))
      expect(qwen?.settings).toEqual({
        baseURL: "https://second.example.com/v1",
        provider: "pigu",
        piguProtocol: "openai-chat",
      })
    }),
  )
})
