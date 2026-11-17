import fsSync from "node:fs"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { Credential } from "@opencode/core/credential"
import { Agent } from "@opencode/core/agent"
import { Integration } from "@opencode/core/integration"
import { Model } from "@opencode/core/model"
import { ModelResolver } from "@opencode/core/model-resolver"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginHost } from "@opencode/core/plugin/host"
import { Provider } from "@opencode/core/provider"
import { Session } from "@opencode/core/session"
import {
  detectEndpointKind,
  detectModelProtocol,
  inferModelCompatibility,
  manageCustomProvider,
  normalizeBaseURL,
  PiguProviderPlugin,
  protocolBaseURL,
  resolveModelLimit,
} from "@opencode/core/plugin/provider/pigu"
import {
  buildImagegenSkillBridge,
  buildMultimodalProcessEnv,
  buildMultimodalToolEnv,
  detectModelModality,
} from "@opencode/core/plugin/provider/multimodal"
import { Skill } from "@opencode/core/skill"
import { AbsolutePath } from "@opencode/core/schema"
import {
  buildCliAttachmentFlags,
  buildPromptWithAttachments,
  extractPromptTurns,
  unwrapWindowsCodexBinary,
} from "@opencode/core/plugin/provider/native-cli"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { tmpdir } from "../fixture/tmpdir"
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
    expect(detectModelProtocol("gpt-5.6-sol")).toBe("openai-responses")
    expect(detectModelProtocol("gpt-6.1-sol")).toBe("openai-responses")
    expect(detectModelProtocol("gpt-image-2.6-flare")).toBe("openai-chat")
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
        limit: { context: 1_048_576, output: 65_536 },
      })

      const claude = yield* fixture.models.get(providerID, Model.ID.make("claude-sonnet-4-5"))
      expect(claude).toMatchObject({
        id: "claude-sonnet-4-5",
        package: "@opencode/ai/providers/anthropic-compatible",
        settings: { baseURL: "https://api.example.com/v1", provider: "pigu", piguProtocol: "anthropic" },
        limit: { context: 200_000, output: 64_000 },
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
        limit: { context: 128_000, output: 32_768 },
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
        piguModality: "text",
      })
    }),
  )

  it.effect("deletes from an empty config file without throwing and cleans shadowing home configs", () =>
    Effect.gen(function* () {
      const globalService = yield* Global.Service
      const fs = yield* FSUtil.Service
      const configPath = path.join(globalService.config, "opencode.json")
      const shadowPath = path.join(globalService.home, "opencode.json")

      yield* fs.writeWithDirs(configPath, "")
      yield* fs.writeWithDirs(
        shadowPath,
        JSON.stringify(
          {
            $schema: "https://opencode.ai/config.json",
            provider: {
              pigutoken: {
                npm: "@ai-sdk/openai-compatible",
                name: "PiguToken",
                options: { baseURL: "https://pigutoken.com/v1", apiKey: "" },
                models: { "retired-model": { name: "retired-model" } },
              },
            },
            model: "pigutoken/retired-model",
          },
          null,
          2,
        ),
      )

      const fiber = yield* Effect.forkChild(manageCustomProvider({ action: "delete", providerID: "pigutoken" }))
      yield* drain
      yield* Fiber.join(fiber)

      expect((yield* fs.readFileStringSafe(configPath))?.trim()).toBe("{}")
      expect(yield* fs.isFile(shadowPath)).toBe(false)
    }),
  )

  it.effect("refreshes custom provider models while stripping shadowing home config entries", () =>
    Effect.gen(function* () {
      const globalService = yield* Global.Service
      const fs = yield* FSUtil.Service
      const configPath = path.join(globalService.config, "opencode.json")
      const shadowPath = path.join(globalService.home, "opencode.json")

      yield* fs.writeWithDirs(
        configPath,
        JSON.stringify(
          {
            provider: {
              pigutoken: {
                npm: "@ai-sdk/openai-compatible",
                name: "PiguToken",
                options: { baseURL: "https://pigutoken.com/v1", apiKey: "sk-live" },
                models: { "old-model": { name: "old-model" }, "gemini-4-carbon": { name: "gemini-4-carbon" } },
              },
            },
          },
          null,
          2,
        ),
      )
      yield* fs.writeWithDirs(
        shadowPath,
        JSON.stringify(
          {
            provider: {
              pigutoken: {
                npm: "@ai-sdk/openai-compatible",
                name: "PiguToken",
                options: { baseURL: "https://pigutoken.com/v1", apiKey: "" },
                models: { "stale-only": { name: "stale-only" } },
              },
            },
            theme: "opencode",
          },
          null,
          2,
        ),
      )

      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              data: [{ id: "gemini-4-carbon", name: "gemini-4-carbon" }],
            }),
          ),
        ),
      )

      const fiber = yield* Effect.forkChild(
        manageCustomProvider({ action: "refresh", providerID: "pigutoken" }).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
        ),
      )
      yield* drain
      yield* Fiber.join(fiber)

      const updatedPrimary = JSON.parse((yield* fs.readFileStringSafe(configPath)) ?? "{}")
      expect(updatedPrimary.provider.pigutoken.options).toEqual({
        baseURL: "https://pigutoken.com/v1",
        apiKey: "sk-live",
      })
      expect(Object.keys(updatedPrimary.provider.pigutoken.models)).toEqual(["gemini-4-carbon"])
      expect(updatedPrimary.provider.pigutoken.models["gemini-4-carbon"]).toEqual({
        name: "gemini-4-carbon",
        provider: {
          npm: "@opencode/ai/providers/google",
          api: "https://pigutoken.com/v1beta",
        },
      })

      const updatedShadow = JSON.parse((yield* fs.readFileStringSafe(shadowPath)) ?? "{}")
      expect(updatedShadow).toEqual({ theme: "opencode" })

      const setOverrideFiber = yield* Effect.forkChild(
        manageCustomProvider({
          action: "set-model-protocol",
          providerID: "pigutoken",
          modelID: "gemini-4-carbon",
          protocol: "openai-chat",
        }),
      )
      yield* drain
      yield* Fiber.join(setOverrideFiber)

      const overriddenDoc = JSON.parse((yield* fs.readFileStringSafe(configPath)) ?? "{}")
      expect(overriddenDoc.provider.pigutoken.models["gemini-4-carbon"]).toEqual({
        name: "gemini-4-carbon",
        provider: {
          npm: "@opencode/ai/providers/openai-compatible",
          api: "https://pigutoken.com/v1",
        },
      })

      const resetOverrideFiber = yield* Effect.forkChild(
        manageCustomProvider({
          action: "set-model-protocol",
          providerID: "pigutoken",
          modelID: "gemini-4-carbon",
          protocol: "default",
        }),
      )
      yield* drain
      yield* Fiber.join(resetOverrideFiber)

      const resetDoc = JSON.parse((yield* fs.readFileStringSafe(configPath)) ?? "{}")
      expect(resetDoc.provider.pigutoken.models["gemini-4-carbon"]).toEqual({
        name: "gemini-4-carbon",
        provider: {
          npm: "@opencode/ai/providers/google",
          api: "https://pigutoken.com/v1beta",
        },
      })
    }),
  )

  it.effect("routes custom OpenAI-compatible provider models to detected or overridden protocols", () =>
    Effect.gen(function* () {
      const providers = yield* Provider.Service
      const models = yield* Model.Service
      const customID = Provider.ID.make("pigutoken")

      yield* providers.transform((editor) => {
        editor.update(customID, (provider) => {
          provider.name = "PiguToken"
          provider.activation = "enabled"
          provider.package = "aisdk:@ai-sdk/openai-compatible"
          provider.settings = { baseURL: "https://pigutoken.com/v1", apiKey: "sk-live" }
        })
        editor.models.update(customID, Model.ID.make("gemini-4-carbon"), (draft) => {
          draft.name = "gemini-4-carbon"
        })
        editor.models.update(customID, Model.ID.make("claude-fable-5"), (draft) => {
          draft.name = "claude-fable-5"
        })
        editor.models.update(customID, Model.ID.make("gpt-6.1-sol"), (draft) => {
          draft.name = "gpt-6.1-sol"
        })
        editor.models.update(customID, Model.ID.make("gpt-5.6-sol"), (draft) => {
          draft.name = "gpt-5.6-sol"
        })
        editor.models.update(customID, Model.ID.make("deepseek-v4.1-flash-261017"), (draft) => {
          draft.name = "deepseek-v4.1-flash-261017"
        })
        editor.models.update(customID, Model.ID.make("custom-capped"), (draft) => {
          draft.name = "custom-capped"
          draft.limit = { context: 64_000, output: 8_192 }
        })
      })
      yield* addPlugin()
      yield* drain

      const gemini = yield* models.get(customID, Model.ID.make("gemini-4-carbon"))
      expect(gemini).toMatchObject({
        package: "@opencode/ai/providers/google",
        settings: { baseURL: "https://pigutoken.com/v1beta", piguProtocol: "gemini" },
        limit: { context: 1_048_576, output: 65_536 },
      })
      expect(gemini?.variants.map((v) => String(v.id))).toEqual(["low", "medium", "high"])
      const geminiHigh = yield* ModelResolver.withVariant(gemini!, Model.VariantID.make("high"))
      expect(geminiHigh.settings).toMatchObject({
        baseURL: "https://pigutoken.com/v1beta",
        thinkingConfig: { includeThoughts: true, thinkingLevel: "high" },
      })

      const claude = yield* models.get(customID, Model.ID.make("claude-fable-5"))
      expect(claude).toMatchObject({
        package: "@opencode/ai/providers/anthropic-compatible",
        settings: { baseURL: "https://pigutoken.com/v1", piguProtocol: "anthropic" },
        limit: { context: 1_000_000, output: 128_000 },
      })

      const gpt61 = yield* models.get(customID, Model.ID.make("gpt-6.1-sol"))
      expect(gpt61).toMatchObject({
        package: "@opencode/ai/providers/openai-compatible-responses",
        settings: { baseURL: "https://pigutoken.com/v1", piguProtocol: "openai-responses" },
        limit: { context: 628_000, input: 500_000, output: 128_000 },
      })
      expect(gpt61?.variants.map((v) => String(v.id))).toEqual(["low", "medium", "high", "xhigh"])
      const gpt61High = yield* ModelResolver.withVariant(gpt61!, Model.VariantID.make("high"))
      expect(gpt61High.settings).toMatchObject({
        baseURL: "https://pigutoken.com/v1",
        reasoningEffort: "high",
        reasoningSummary: "auto",
      })

      const gpt56 = yield* models.get(customID, Model.ID.make("gpt-5.6-sol"))
      expect(gpt56?.limit).toEqual({ context: 400_000, input: 272_000, output: 128_000 })

      const dsv41 = yield* models.get(customID, Model.ID.make("deepseek-v4.1-flash-261017"))
      expect(dsv41?.limit).toEqual({ context: 1_048_576, output: 393_216 })

      const customCapped = yield* models.get(customID, Model.ID.make("custom-capped"))
      expect(customCapped?.limit).toEqual({ context: 64_000, output: 8_192 })

      expect(resolveModelLimit("gpt-6.1-sol", { baseURL: "https://api.openai.com/v1" })).toEqual({
        context: 1_050_000,
        input: 922_000,
        output: 128_000,
      })

      const hooks = yield* PluginHooks.Service
      const sessionID = Session.ID.make("ses_affinity_test_123")
      const agentID = Agent.ID.make("build")

      const gptContext = yield* hooks.trigger("session", "context", {
        sessionID,
        agent: agentID,
        model: { providerID: customID, id: Model.ID.make("gpt-6.1-sol") },
        system: [],
        messages: [],
        options: { maxTokens: 128_000 },
        tools: {},
      })
      expect(gptContext.options.maxTokens).toBeUndefined()

      const gptCompaction = yield* hooks.trigger("session", "compaction", {
        sessionID,
        agent: agentID,
        model: { providerID: customID, id: Model.ID.make("gpt-6.1-sol") },
        system: [],
        messages: [],
        options: { maxTokens: 128_000 },
        tools: {},
      })
      expect(gptCompaction.options.maxTokens).toBeUndefined()

      const claudeContext = yield* hooks.trigger("session", "context", {
        sessionID,
        agent: agentID,
        model: { providerID: customID, id: Model.ID.make("claude-fable-5") },
        system: [],
        messages: [],
        options: { maxTokens: 64_000 },
        tools: {},
      })
      expect(claudeContext.options.maxTokens).toBe(64_000)

      const gptReq = yield* hooks.trigger("session", "model.request", {
        sessionID,
        agent: agentID,
        model: { providerID: customID, id: Model.ID.make("gpt-6.1-sol") },
        kind: "primary",
        baseURL: "https://pigutoken.com/v1",
        headers: { "x-session-affinity": "ses_parent_root_001" },
      })
      expect(gptReq.headers["session-id"]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      )
      expect(gptReq.headers["thread-id"]).toBe(gptReq.headers["session-id"])

      const gptChildReq = yield* hooks.trigger("session", "model.request", {
        sessionID: Session.ID.make("ses_child_subagent_002"),
        agent: agentID,
        model: { providerID: customID, id: Model.ID.make("gpt-6.1-sol") },
        kind: "primary",
        baseURL: "https://pigutoken.com/v1",
        headers: { "x-session-affinity": "ses_parent_root_001" },
      })
      expect(gptChildReq.headers["session-id"]).toBe(gptReq.headers["session-id"])

      const claudeReq = yield* hooks.trigger("session", "model.request", {
        sessionID,
        agent: agentID,
        model: { providerID: customID, id: Model.ID.make("claude-fable-5") },
        kind: "primary",
        baseURL: "https://pigutoken.com/v1",
        headers: { "x-session-affinity": "ses_parent_root_001" },
      })
      expect(claudeReq.headers["session-id"]).toBeUndefined()

      const overrideFiber = yield* Effect.forkChild(
        manageCustomProvider({
          action: "set-model-protocol",
          providerID: "pigutoken",
          modelID: "gemini-4-carbon",
          protocol: "openai-chat",
        }),
      )
      yield* drain
      yield* Fiber.join(overrideFiber)
      yield* drain

      const overriddenGemini = yield* models.get(customID, Model.ID.make("gemini-4-carbon"))
      expect(overriddenGemini).toMatchObject({
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: "https://pigutoken.com/v1", piguProtocol: "openai-chat" },
      })
    }),
  )

  test("classifies text, image, video, and audio models across mainstream naming conventions", () => {
    expect(detectModelModality("gpt-6.1-sol")).toBe("text")
    expect(detectModelModality("claude-sonnet-4-5")).toBe("text")
    expect(detectModelModality("gemini-4-carbon")).toBe("text")
    expect(detectModelModality("gpt-image-2.6-flare")).toBe("image")
    expect(detectModelModality("grok-imagine-image")).toBe("image")
    expect(detectModelModality("flux-1.1-pro")).toBe("image")
    expect(detectModelModality("grok-imagine-video")).toBe("video")
    expect(detectModelModality("seedance-2.0")).toBe("video")
    expect(detectModelModality("sora-2")).toBe("video")
    expect(detectModelModality("whisper-large-v3")).toBe("audio")
    expect(detectModelModality("gpt-4o-audio-preview")).toBe("audio")
    expect(detectModelModality("cosyvoice-v2")).toBe("audio")
  })

  it.effect("persists 4-modality config and builds unified Skill/MCP environment variables", () =>
    Effect.gen(function* () {
      const globalService = yield* Global.Service
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              data: [
                { id: "gpt-6.1-sol" },
                { id: "gpt-image-2.6-flare" },
                { id: "seedance-2.0" },
                { id: "whisper-large-v3" },
                { id: "z-custom-model" },
              ],
            }),
          ),
        ),
      )

      const upsertFiber = yield* Effect.forkChild(
        manageCustomProvider({
          action: "upsert",
          providerID: "pigutoken",
          name: "PiguToken",
          baseURL: "https://pigutoken.com/v1",
          apiKey: "sk-mm-test",
        }).pipe(Effect.provideService(HttpClient.HttpClient, http)),
      )
      yield* drain
      yield* Fiber.join(upsertFiber)

      const envBeforeOverride = buildMultimodalProcessEnv(globalService.config)
      expect(envBeforeOverride.PIGU_TEXT_MODEL).toBe("gpt-6.1-sol")
      expect(envBeforeOverride.PIGU_TEXT_PROTOCOL).toBe("openai-responses")
      expect(envBeforeOverride.PIGU_IMAGE_MODEL).toBe("gpt-image-2.6-flare")
      expect(envBeforeOverride.PIGU_VIDEO_MODEL).toBe("seedance-2.0")
      expect(envBeforeOverride.PIGU_AUDIO_MODEL).toBe("whisper-large-v3")
      expect(envBeforeOverride.PIGU_IMAGE_API_KEY).toBe("sk-mm-test")

      const setModalityFiber = yield* Effect.forkChild(
        manageCustomProvider({
          action: "set-model-modality",
          providerID: "pigutoken",
          modelID: "z-custom-model",
          modality: "video",
        }),
      )
      yield* drain
      yield* Fiber.join(setModalityFiber)

      const setDefaultFiber = yield* Effect.forkChild(
        manageCustomProvider({
          action: "set-modality-default",
          modality: "video",
          providerID: "pigutoken",
          modelID: "z-custom-model",
        }),
      )
      yield* drain
      yield* Fiber.join(setDefaultFiber)

      const envAfterOverride = buildMultimodalProcessEnv(globalService.config)
      expect(envAfterOverride.PIGU_VIDEO_MODEL).toBe("z-custom-model")
      const fs = yield* FSUtil.Service
      const parsedConfig = JSON.parse((yield* fs.readFileStringSafe(envAfterOverride.PIGU_MULTIMODAL_CONFIG!)) ?? "{}")
      expect(parsedConfig.defaults?.video).toMatchObject({
        providerID: "pigutoken",
        modelID: "z-custom-model",
        baseURL: "https://pigutoken.com/v1",
      })
    }),
  )

  it.effect("materializes pasted images and PDFs for all local CLI engines and builds native flags", () =>
    Effect.gen(function* () {
      const globalService = yield* Global.Service
      const fs = yield* FSUtil.Service
      const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
      const pdfBytes = new TextEncoder().encode("%PDF-1.4 mock")
      const attachmentsDir = path.join(globalService.cache, "pigu", "attachments", "ses_cli_attach")

      const extracted = extractPromptTurns(
        [
          {
            role: "user",
            content: [
              { type: "text", text: "上一轮截图" },
              {
                type: "file",
                mediaType: "image/png",
                filename: "prev.png",
                data: `data:image/png;base64,${pngBase64}`,
              },
            ],
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "已收到上一轮截图" }],
          },
          {
            role: "user",
            content: [
              {
                type: "file",
                mediaType: "image/png",
                filename: "screen shot.png",
                data: pngBase64,
              },
              {
                type: "file",
                mediaType: "application/pdf",
                filename: "spec.pdf",
                data: pdfBytes,
              },
            ],
          },
        ],
        attachmentsDir,
      )

      expect(extracted.userText).toBe("请查看附带的图片或文件并按内容处理。")
      expect(extracted.attachments).toHaveLength(2)
      expect(extracted.attachments[0]?.isImage).toBe(true)
      expect(extracted.attachments[0]?.filePath.includes("screen-shot")).toBe(true)
      expect(extracted.attachments[0]?.filePath.endsWith(".png")).toBe(true)
      expect(extracted.attachments[1]?.isImage).toBe(false)
      expect(extracted.attachments[1]?.filePath.includes("spec")).toBe(true)
      expect(extracted.attachments[1]?.filePath.endsWith(".pdf")).toBe(true)
      expect(extracted.priorTurns[0]?.text).toContain("prev-")
      expect(yield* fs.exists(extracted.attachments[0]!.filePath)).toBe(true)
      expect(yield* fs.exists(extracted.attachments[1]!.filePath)).toBe(true)

      const decorated = buildPromptWithAttachments(extracted.userText, extracted.attachments)
      expect(decorated).toContain("<attached_files>")
      expect(decorated).toContain(extracted.attachments[0]!.filePath)
      expect(decorated).toContain(extracted.attachments[1]!.filePath)

      expect(buildCliAttachmentFlags("codex", extracted.attachments)).toEqual([
        "-i",
        extracted.attachments[0]!.filePath,
      ])
      expect(buildCliAttachmentFlags("opencode", extracted.attachments)).toEqual([
        "-f",
        extracted.attachments[0]!.filePath,
        "-f",
        extracted.attachments[1]!.filePath,
      ])
      expect(buildCliAttachmentFlags("claude", extracted.attachments)).toEqual([
        "--add-dir",
        path.dirname(extracted.attachments[0]!.filePath),
      ])
      expect(buildCliAttachmentFlags("agy", extracted.attachments)).toEqual([])
      expect(buildCliAttachmentFlags("deepseek-harness", extracted.attachments)).toEqual([])
    }),
  )

  it.effect("isolates multimodal-only providers, prefers gpt-image-2, and links Codex imagegen skill", () =>
    Effect.gen(function* () {
      const globalService = yield* Global.Service
      const fs = yield* FSUtil.Service
      const skills = yield* Skill.Service

      const textHttp = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              data: [
                { id: "claude-sonnet-5-5" },
                { id: "gemini-3-pro-image" },
                { id: "gpt-image-2.6-flare" },
                { id: "gpt-image-2" },
              ],
            }),
          ),
        ),
      )

      const upsertText = yield* Effect.forkChild(
        manageCustomProvider({
          action: "upsert",
          providerID: "pigutoken",
          name: "PiguToken",
          baseURL: "https://pigutoken.com/v1",
          apiKey: "sk-main-key",
        }).pipe(Effect.provideService(HttpClient.HttpClient, textHttp)),
      )
      yield* drain
      yield* Fiber.join(upsertText)

      const toolEnvInitial = buildMultimodalToolEnv(globalService.config)
      expect(toolEnvInitial.PIGU_IMAGE_MODEL).toBe("gpt-image-2")
      expect(toolEnvInitial.OPENAI_IMAGE_MODEL).toBe("gpt-image-2")
      expect(toolEnvInitial.OPENAI_BASE_URL).toBe("https://pigutoken.com/v1")
      expect(toolEnvInitial.OPENAI_API_KEY).toBe("sk-main-key")

      const mediaHttp = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              data: [{ id: "claude-sonnet-5-5" }, { id: "gpt-image-2" }, { id: "seedance-2.5-special" }],
            }),
          ),
        ),
      )

      const upsertMedia = yield* Effect.forkChild(
        manageCustomProvider({
          action: "upsert",
          name: "PiguToken",
          baseURL: "https://media.pigutoken.com/v1",
          apiKey: "sk-media-key",
          multimodalOnly: true,
          customModels: "custom-media-v1",
        }).pipe(Effect.provideService(HttpClient.HttpClient, mediaHttp)),
      )
      yield* drain
      yield* Fiber.join(upsertMedia)

      const configDoc = JSON.parse((yield* fs.readFileStringSafe(path.join(globalService.config, "opencode.json"))) ?? "{}")
      expect(configDoc.provider["pigutoken-media"]?.options?.piguMultimodalOnly).toBe(true)
      expect(Object.keys(configDoc.provider["pigutoken-media"]?.models ?? {})).toEqual([
        "gpt-image-2",
        "seedance-2.5-special",
        "custom-media-v1",
      ])

      const toolEnvMedia = buildMultimodalToolEnv(globalService.config)
      expect(toolEnvMedia.PIGU_TEXT_PROVIDER).toBe("pigutoken")
      expect(toolEnvMedia.PIGU_IMAGE_PROVIDER).toBe("pigutoken-media")
      expect(toolEnvMedia.PIGU_IMAGE_MODEL).toBe("gpt-image-2")
      expect(toolEnvMedia.OPENAI_BASE_URL).toBe("https://media.pigutoken.com/v1")
      expect(toolEnvMedia.OPENAI_API_KEY).toBe("sk-media-key")

      yield* skills.transform((editor) => {
        editor.add({
          id: Skill.ID.make("imagegen"),
          name: Skill.Name.make("imagegen"),
          description: "Codex image generation skill",
          content: "# Image Generation Skill\n\nDefault instructions.",
          path: AbsolutePath.make("/Users/test/.codex/skills/.system/imagegen/SKILL.md"),
        })
      })
      yield* addPlugin()
      yield* drain

      const transformedSkill = yield* skills.get(Skill.ID.make("imagegen"))
      expect(transformedSkill?.content).toContain("Pigu Multimodal Routing (Auto-Linked)")
      expect(transformedSkill?.content).toContain("pigutoken-media/gpt-image-2")
      expect(transformedSkill?.content).toContain("/Users/test/.codex/skills/.system/imagegen/scripts/image_gen.py")
      expect(transformedSkill?.content).toContain("pigu-imagegen.py")
      expect(transformedSkill?.content).toContain("generate")
      expect(transformedSkill?.content).toContain("edit")
      expect(yield* fs.isFile(toolEnvMedia.PIGU_IMAGEGEN_SCRIPT!)).toBe(true)
      expect(buildImagegenSkillBridge(globalService.config)).toContain("gpt-image-2")

      const setExplicitImageDefault = yield* Effect.forkChild(
        manageCustomProvider({
          action: "set-modality-default",
          modality: "image",
          providerID: "pigutoken",
          modelID: "gpt-image-2",
        }),
      )
      yield* drain
      yield* Fiber.join(setExplicitImageDefault)

      const persistedAfterDefault = JSON.parse(
        (yield* fs.readFileStringSafe(path.join(globalService.config, "pigu-multimodal.json"))) ?? "{}",
      )
      expect(persistedAfterDefault.userDefaults?.image).toMatchObject({
        providerID: "pigutoken",
        modelID: "gpt-image-2",
        baseURL: "https://pigutoken.com/v1",
        apiKey: "sk-main-key",
      })
    }),
  )

  test("normalizes mainstream vendor URLs and routes protocols by endpoint kind", () => {
    expect(normalizeBaseURL("https://generativelanguage.googleapis.com")).toBe(
      "https://generativelanguage.googleapis.com/v1beta",
    )
    expect(normalizeBaseURL("https://dashscope.aliyuncs.com")).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1")
    expect(normalizeBaseURL("https://open.bigmodel.cn")).toBe("https://open.bigmodel.cn/api/paas/v4")
    expect(normalizeBaseURL("https://ark.cn-beijing.volces.com")).toBe("https://ark.cn-beijing.volces.com/api/v3")
    expect(normalizeBaseURL("https://openrouter.ai")).toBe("https://openrouter.ai/api/v1")
    expect(normalizeBaseURL("https://api.groq.com")).toBe("https://api.groq.com/openai/v1")
    expect(normalizeBaseURL("https://api.minimaxi.com/anthropic")).toBe("https://api.minimaxi.com/anthropic/v1")
    expect(normalizeBaseURL("https://api.anthropic.com/v1/messages")).toBe("https://api.anthropic.com/v1")
    expect(normalizeBaseURL("https://api.openai.com/v1/responses")).toBe("https://api.openai.com/v1")

    expect(detectEndpointKind("https://api.anthropic.com")).toBe("anthropic-native")
    expect(detectEndpointKind("https://api.minimaxi.com/anthropic")).toBe("anthropic-native")
    expect(detectEndpointKind("https://generativelanguage.googleapis.com")).toBe("gemini-native")
    expect(detectEndpointKind("https://generativelanguage.googleapis.com/v1beta/openai")).toBe("openai-chat-only")
    expect(detectEndpointKind("https://openrouter.ai")).toBe("openai-chat-only")
    expect(detectEndpointKind("https://api.openai.com")).toBe("openai-official")
    expect(detectEndpointKind("https://pigutoken.com/v1")).toBe("multi-protocol")

    // Single-protocol OpenAI-Chat aggregators and LiteLLM slash-namespaced models never rewrite to /v1beta or /v1/messages
    expect(detectModelProtocol("anthropic/claude-sonnet-4.6", "https://openrouter.ai/api/v1")).toBe("openai-chat")
    expect(detectModelProtocol("google/gemini-2.5-pro", "https://openrouter.ai/api/v1")).toBe("openai-chat")
    expect(detectModelProtocol("openai/gpt-5.4", "https://openrouter.ai/api/v1")).toBe("openai-chat")
    expect(detectModelProtocol("anthropic/claude-sonnet-4.6", "https://litellm.internal.corp/v1")).toBe("openai-chat")

    // Anthropic native & Coding Plan endpoints
    expect(detectModelProtocol("claude-sonnet-4-6", "https://api.anthropic.com/v1")).toBe("anthropic")
    expect(detectModelProtocol("MiniMax-M2.7", "https://api.minimaxi.com/anthropic/v1")).toBe("anthropic")
    expect(detectModelProtocol("glm-5", "https://open.bigmodel.cn/api/anthropic/v1")).toBe("anthropic")

    // Official OpenAI
    expect(detectModelProtocol("gpt-5.4", "https://api.openai.com/v1")).toBe("openai-responses")
    expect(detectModelProtocol("o3", "https://api.openai.com/v1")).toBe("openai-responses")
    expect(detectModelProtocol("o4-mini", "https://api.openai.com/v1")).toBe("openai-responses")
    expect(detectModelProtocol("codex-mini-latest", "https://api.openai.com/v1")).toBe("openai-responses")
    expect(detectModelProtocol("gpt-4o", "https://api.openai.com/v1")).toBe("openai-chat")

    // Multi-protocol relay (OneAPI / NewAPI / PiguToken)
    expect(detectModelProtocol("gemini-2.5-pro", "https://pigutoken.com/v1")).toBe("gemini")
    expect(detectModelProtocol("claude-opus-4-6", "https://pigutoken.com/v1")).toBe("anthropic")
    expect(detectModelProtocol("gpt-6.1-sol", "https://pigutoken.com/v1")).toBe("openai-responses")
    expect(detectModelProtocol("deepseek-reasoner", "https://pigutoken.com/v1")).toBe("openai-chat")
  })

  test("strips internal Pigu settings from nativeSettings and infers non-OpenAI chat compatibility", () => {
    const cleaned = Provider.nativeSettings({
      baseURL: "https://api.deepseek.com/v1",
      apiKey: "sk-test",
      piguPackage: "@opencode/ai/providers/openai-compatible",
      piguProtocol: "openai-chat",
      piguModality: "text",
      piguMultimodalOnly: true,
      organization: "org_123",
    })
    expect(cleaned).toEqual({
      apiKey: "sk-test",
      baseURL: "https://api.deepseek.com/v1",
      organization: "org_123",
    })

    expect(inferModelCompatibility("deepseek-reasoner", "openai-chat")).toEqual({
      maxTokensField: "max_tokens",
      reasoningField: "reasoning_content",
      requireReasoning: true,
    })
    expect(inferModelCompatibility("kimi-k2.5", "openai-chat")).toEqual({
      maxTokensField: "max_tokens",
      reasoningField: "reasoning_content",
      requireReasoning: true,
    })
    expect(inferModelCompatibility("qwen3-coder-plus", "openai-chat")).toEqual({
      maxTokensField: "max_tokens",
    })
    expect(inferModelCompatibility("MiniMax-M2.7", "openai-chat")).toEqual({
      maxTokensField: "max_tokens",
    })
    expect(inferModelCompatibility("MiniMax-M2.7", "anthropic")).toBeUndefined()
  })

  it.effect("discovers official Anthropic, official Gemini, OpenRouter, and custom endpoints cleanly", () =>
    Effect.gen(function* () {
      const globalService = yield* Global.Service
      const fs = yield* FSUtil.Service
      const seenHeaders: Record<string, Record<string, string>> = {}

      const vendorHttp = HttpClient.make((request) => {
        const host = new URL(request.url).hostname
        seenHeaders[host] = { ...request.headers }
        if (host === "api.anthropic.com") {
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                data: [
                  { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" },
                  { id: "claude-opus-4-6", display_name: "Claude Opus 4.6" },
                ],
              }),
            ),
          )
        }
        if (host === "generativelanguage.googleapis.com") {
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                models: [
                  {
                    name: "models/gemini-2.5-pro",
                    displayName: "Gemini 2.5 Pro",
                    inputTokenLimit: 1048576,
                    outputTokenLimit: 65536,
                    supportedGenerationMethods: ["generateContent", "countTokens"],
                  },
                  {
                    name: "models/text-embedding-004",
                    displayName: "Text Embedding 004",
                    supportedGenerationMethods: ["embedContent"],
                  },
                ],
              }),
            ),
          )
        }
        if (host === "openrouter.ai") {
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                data: [
                  { id: "google/gemini-2.5-pro", name: "Google: Gemini 2.5 Pro", context_length: 1048576 },
                  { id: "anthropic/claude-sonnet-4.6", name: "Anthropic: Claude Sonnet 4.6", context_length: 1000000 },
                ],
              }),
            ),
          )
        }
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("Not Found", { status: 404 })))
      })

      const runUpsert = (input: Parameters<typeof manageCustomProvider>[0]) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            manageCustomProvider(input).pipe(Effect.provideService(HttpClient.HttpClient, vendorHttp)),
          )
          yield* drain
          yield* Fiber.join(fiber)
        })

      yield* runUpsert({
        action: "upsert",
        name: "Anthropic",
        baseURL: "https://api.anthropic.com",
        apiKey: "sk-ant-test",
      })
      yield* runUpsert({
        action: "upsert",
        name: "Google",
        baseURL: "https://generativelanguage.googleapis.com",
        apiKey: "AIzaSyTest",
      })
      yield* runUpsert({
        action: "upsert",
        name: "OpenRouter",
        baseURL: "https://openrouter.ai",
        apiKey: "sk-or-test",
      })
      yield* runUpsert({
        action: "upsert",
        name: "火山方舟",
        baseURL: "https://ark.cn-beijing.volces.com",
        apiKey: "ark-test",
        customModels: "ep-20261114-doubao, ep-20261114-deepseek",
      })

      expect(seenHeaders["api.anthropic.com"]?.["x-api-key"]).toBe("sk-ant-test")
      expect(seenHeaders["api.anthropic.com"]?.["anthropic-version"]).toBe("2023-06-01")
      expect(seenHeaders["generativelanguage.googleapis.com"]?.["x-goog-api-key"]).toBe("AIzaSyTest")
      expect(seenHeaders["generativelanguage.googleapis.com"]?.authorization).toBeUndefined()
      expect(seenHeaders["openrouter.ai"]?.authorization).toBe("Bearer sk-or-test")

      const configDoc = JSON.parse(
        (yield* fs.readFileStringSafe(path.join(globalService.config, "opencode.json"))) ?? "{}",
      )
      expect(configDoc.provider["anthropic-api"]?.models["claude-sonnet-4-6"]).toMatchObject({
        name: "Claude Sonnet 4.6",
        provider: {
          npm: "@opencode/ai/providers/anthropic-compatible",
          api: "https://api.anthropic.com/v1",
        },
      })
      expect(configDoc.provider["google-api"]?.models["gemini-2.5-pro"]).toMatchObject({
        name: "Gemini 2.5 Pro",
        limit: { context: 1048576, output: 65536 },
        provider: {
          npm: "@opencode/ai/providers/google",
          api: "https://generativelanguage.googleapis.com/v1beta",
        },
      })
      expect(configDoc.provider["google-api"]?.models["text-embedding-004"]).toBeUndefined()

      // OpenRouter slash-prefixed Gemini & Claude models must stay on openai-chat at openrouter.ai/api/v1
      expect(configDoc.provider["openrouter-api"]?.models["google/gemini-2.5-pro"]).toMatchObject({
        name: "Google: Gemini 2.5 Pro",
        limit: { context: 1048576 },
        provider: {
          npm: "@opencode/ai/providers/openai-compatible",
          api: "https://openrouter.ai/api/v1",
        },
      })
      expect(configDoc.provider["openrouter-api"]?.models["anthropic/claude-sonnet-4.6"]).toMatchObject({
        name: "Anthropic: Claude Sonnet 4.6",
        limit: { context: 1000000 },
        provider: {
          npm: "@opencode/ai/providers/openai-compatible",
          api: "https://openrouter.ai/api/v1",
        },
      })

      // Custom endpoint IDs (Volcengine Ark) are preserved even when /models returns 404
      expect(Object.keys(configDoc.provider["ark-cn-beijing-volces-com"]?.models ?? {})).toEqual([
        "ep-20261114-doubao",
        "ep-20261114-deepseek",
      ])
    }),
  )

  test("unwraps Windows codex.cmd shims directly to native codex.exe across npm, pnpm, and Scoop layouts", async () => {
    await using tmp = await tmpdir("pigu-win-codex-")

    // 1. Standard npm global nested layout
    const npmBin = path.join(tmp.path, "npm")
    const npmCmd = path.join(npmBin, "codex.cmd")
    const npmExe = path.join(
      npmBin,
      "node_modules",
      "@openai",
      "codex",
      "node_modules",
      "@openai",
      "codex-win32-x64",
      "vendor",
      "x86_64-pc-windows-msvc",
      "bin",
      "codex.exe",
    )
    fsSync.mkdirSync(path.dirname(npmExe), { recursive: true })
    fsSync.writeFileSync(npmCmd, '@ECHO off\r\n"%dp0%\\node.exe" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n')
    fsSync.writeFileSync(npmExe, "")

    expect(unwrapWindowsCodexBinary(npmCmd, "win32", "x64")).toBe(npmExe)
    expect(unwrapWindowsCodexBinary(npmCmd, "darwin", "x64")).toBe(npmCmd)
    expect(unwrapWindowsCodexBinary(npmExe, "win32", "x64")).toBe(npmExe)

    // 2. pnpm global virtual-store .cmd shim layout (%~dp0\global\5\.pnpm\...)
    const pnpmBin = path.join(tmp.path, "pnpm")
    const pnpmCmd = path.join(pnpmBin, "codex.cmd")
    const pnpmStore = path.join(pnpmBin, "global", "5", ".pnpm", "@openai+codex@0.118.0", "node_modules", "@openai")
    const pnpmJs = path.join(pnpmStore, "codex", "bin", "codex.js")
    const pnpmExe = path.join(pnpmStore, "codex-win32-arm64", "vendor", "aarch64-pc-windows-msvc", "bin", "codex.exe")
    fsSync.mkdirSync(path.dirname(pnpmJs), { recursive: true })
    fsSync.mkdirSync(path.dirname(pnpmExe), { recursive: true })
    fsSync.writeFileSync(
      pnpmCmd,
      '"%_prog%" "%~dp0\\global\\5\\.pnpm\\@openai+codex@0.118.0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
    )
    fsSync.writeFileSync(pnpmJs, "")
    fsSync.writeFileSync(pnpmExe, "")

    expect(unwrapWindowsCodexBinary(pnpmCmd, "win32", "arm64")).toBe(pnpmExe)

    // 3. Scoop .cmd shim directly quoting codex.exe
    const scoopShims = path.join(tmp.path, "scoop", "shims")
    const scoopCmd = path.join(scoopShims, "codex.cmd")
    const scoopExe = path.join(tmp.path, "scoop", "apps", "codex", "current", "codex.exe")
    fsSync.mkdirSync(scoopShims, { recursive: true })
    fsSync.mkdirSync(path.dirname(scoopExe), { recursive: true })
    fsSync.writeFileSync(scoopCmd, `@"${scoopExe}" %*\r\n`)
    fsSync.writeFileSync(scoopExe, "")

    expect(unwrapWindowsCodexBinary(scoopCmd, "win32", "x64")).toBe(scoopExe)

    // 4. Graceful fallback when native binary is absent
    const fallbackBin = path.join(tmp.path, "fallback")
    const fallbackCmd = path.join(fallbackBin, "codex.cmd")
    fsSync.mkdirSync(fallbackBin, { recursive: true })
    fsSync.writeFileSync(fallbackCmd, "@ECHO off\r\n")

    expect(unwrapWindowsCodexBinary(fallbackCmd, "win32", "x64")).toBe(fallbackCmd)
  })
})
