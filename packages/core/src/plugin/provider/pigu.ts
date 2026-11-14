export * as PiguProvider from "./pigu.js"

import { createHash } from "node:crypto"
import os from "os"
import path from "path"
import { applyEdits, modify, parse } from "jsonc-parser"
import { SystemPart } from "@opencode/ai/effect"
import { define } from "@opencode/plugin/effect/plugin"
import { Form } from "@opencode/schema/form"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { isRecord } from "@opencode/util/record"
import { Duration, Effect, Option, Predicate, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { App } from "../../app.js"
import { Bus } from "../../bus.js"
import { ConfigDiscovery } from "../../config/discovery.js"
import { Credential } from "../../credential.js"
import { Integration } from "../../integration.js"
import { IntegrationConnection } from "../../integration/connection.js"
import { Model } from "../../model.js"
import { Provider } from "../../provider.js"
import { AbsolutePath } from "../../schema.js"
import { SharedCache } from "../../shared-cache.js"
import { Variant } from "../../variant.js"
import type { PluginInternal } from "../internal.js"
import { configuredSettings } from "./configured.js"
import { activeCredential } from "./credential-settings.js"
import {
  buildCatalogLimitMap,
  buildImagegenSkillBridge,
  buildMultimodalProcessEnv,
  buildMultimodalToolEnv,
  CANONICAL_PROVIDER_PRIORITY,
  detectEndpointKind,
  detectModelModality,
  detectModelProtocol,
  IMAGEGEN_BRIDGE_MARKER,
  isNonChatUtilityModel,
  isPiguModality,
  isPiguProtocolID,
  MULTIMODAL_CONFIG_FILE,
  normalizeProviderBaseURL,
  PIGU_MODALITIES,
  PIGU_PROTOCOLS,
  PROTOCOL_OVERRIDES_FILE,
  protocolBaseURL,
  readConfiguredProviderCandidatesSync,
  readModelProtocolOverridesSync,
  readMultimodalConfigSync,
  resolveModelLimit,
  resolveMultimodalConfigSync,
  writeResolvedMultimodalConfigSync,
  type MultimodalConfigFile,
  type MultimodalEndpointConfig,
  type PiguEndpointKind,
  type PiguModality,
  type PiguProtocol,
  type ResolvedModelLimit,
} from "./multimodal.js"
import { LOCAL_PROVIDER_ID, refreshLocalEngineModels, setDshPluginEnabled } from "./native-cli.js"
import { ProviderRefresh } from "./refresh.js"
import { clearMobileTurnContext, getMobileTurnContext, setMobileTurnContext } from "../../mobile/butler.js"

export {
  buildCatalogLimitMap,
  buildImagegenSkillBridge,
  buildMultimodalProcessEnv,
  buildMultimodalToolEnv,
  detectEndpointKind,
  detectModelModality,
  detectModelProtocol,
  isNonChatUtilityModel,
  isPiguModality,
  MULTIMODAL_CONFIG_FILE,
  PIGU_MODALITIES,
  PIGU_PROTOCOLS,
  protocolBaseURL,
  readMultimodalConfigSync,
  resolveModelLimit,
  resolveMultimodalConfigSync,
  type MultimodalConfigFile,
  type MultimodalEndpointConfig,
  type PiguEndpointKind,
  type PiguModality,
  type PiguProtocol,
  type ResolvedModelLimit,
}

const providerID = Provider.ID.make("pigu")
const integrationID = Integration.ID.make("pigu")

const baseURLField = Form.StringField.make({
  type: "string",
  key: "baseURL",
  title: "Enter API Base URL",
  description: "OpenAI-compatible endpoint URL (e.g. https://api.openai.com/v1 or https://api.deepseek.com)",
  placeholder: "https://api.openai.com/v1",
  required: true,
})

const RemoteModelItem = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  display_name: Schema.optional(Schema.NullOr(Schema.String)),
  displayName: Schema.optional(Schema.NullOr(Schema.String)),
  context_length: Schema.optional(Schema.NullOr(Schema.Number)),
  max_model_len: Schema.optional(Schema.NullOr(Schema.Number)),
  inputTokenLimit: Schema.optional(Schema.NullOr(Schema.Number)),
  max_output_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  outputTokenLimit: Schema.optional(Schema.NullOr(Schema.Number)),
  supportedGenerationMethods: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
})

const RemoteModelsPayload = Schema.Union([
  Schema.Struct({ data: Schema.Array(RemoteModelItem) }),
  Schema.Struct({ models: Schema.Array(RemoteModelItem) }),
  Schema.Array(RemoteModelItem),
])

const decodeRemoteModels = Schema.decodeUnknownOption(Schema.fromJsonString(RemoteModelsPayload))

export type DiscoveredModel = {
  readonly id: string
  readonly name: string
  readonly context?: number
  readonly output?: number
}

type DiscoveryState = {
  readonly key?: string
  readonly baseURL: string
  readonly models: readonly DiscoveredModel[]
}

export function protocolPackage(protocol: PiguProtocol): string {
  if (protocol === "gemini") return "@opencode/ai/providers/google"
  if (protocol === "anthropic") return "@opencode/ai/providers/anthropic-compatible"
  if (protocol === "openai-responses") return "@opencode/ai/providers/openai-compatible-responses"
  return "@opencode/ai/providers/openai-compatible"
}

export function protocolVariants(baseURL: string) {
  return PIGU_PROTOCOLS.map((protocol) => ({
    id: Model.VariantID.make(protocol),
    settings: {
      ...(baseURL ? { baseURL: protocolBaseURL(baseURL, protocol) } : {}),
      piguPackage: protocolPackage(protocol),
      piguProtocol: protocol,
    },
  }))
}

function buildConfiguredModelEntry(input: {
  readonly id: string
  readonly name: string
  readonly baseURL: string
  readonly rootKey: "provider" | "providers"
  readonly context?: number
  readonly output?: number
  readonly override?: PiguProtocol
  readonly existing?: unknown
}) {
  const protocol = input.override ?? detectModelProtocol(input.id, input.baseURL)
  const pkg = protocolPackage(protocol)
  const targetURL = protocolBaseURL(input.baseURL, protocol)
  const baseRecord = isRecord(input.existing) ? { ...input.existing } : {}
  const remoteLimit =
    !isRecord(baseRecord.limit) && (input.context !== undefined || input.output !== undefined)
      ? {
          context: input.context ?? 200_000,
          output: input.output ?? Math.min(32_000, input.context ?? 32_000),
        }
      : undefined
  if (input.rootKey === "providers") {
    const existingSettings = isRecord(baseRecord.settings) ? baseRecord.settings : {}
    return {
      ...baseRecord,
      ...(remoteLimit ? { limit: remoteLimit } : {}),
      name: input.name,
      package: pkg,
      settings: {
        ...existingSettings,
        ...(targetURL ? { baseURL: targetURL } : {}),
        piguProtocol: protocol,
      },
    }
  }
  return {
    ...baseRecord,
    ...(remoteLimit ? { limit: remoteLimit } : {}),
    name: input.name,
    provider: {
      npm: pkg,
      ...(targetURL ? { api: targetURL } : {}),
    },
  }
}

export function buildCatalogEffortMap(
  records: readonly {
    provider: { id: string; activation: string }
    models: ReadonlyMap<string, Model.Info>
  }[],
): ReadonlyMap<string, readonly string[]> {
  const map = new Map<string, readonly string[]>()
  const rank = (id: string) => {
    const idx = CANONICAL_PROVIDER_PRIORITY.indexOf(id as (typeof CANONICAL_PROVIDER_PRIORITY)[number])
    return idx === -1 ? CANONICAL_PROVIDER_PRIORITY.length : idx
  }
  const ordered = records
    .filter((record) => record.provider.activation === "auto")
    .toSorted((a, b) => rank(a.provider.id) - rank(b.provider.id))
  ordered.forEach((record) => {
    Array.from(record.models.values()).forEach((model) => {
      const key = model.id.toLowerCase()
      if (map.has(key)) return
      const efforts = model.variants
        .map((variant) => String(variant.id))
        .filter((id) => id !== "none" && id !== "thinking" && !isPiguProtocolID(id))
      map.set(key, efforts)
    })
  })
  return map
}

export function inferModelReasoningEfforts(
  rawModelID: string,
  catalogEfforts?: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  const normalized = rawModelID.trim().toLowerCase().replace(/^models\//, "")
  if (!normalized) return []
  const shortID = normalized.includes("/") ? normalized.slice(normalized.lastIndexOf("/") + 1) : normalized

  // Fixed-tier model endpoints (e.g. gemini-3.5-flash-high, gemini-3.8-flash-low, gemini-3.8-flash-tiered)
  // already bake the reasoning degree into the model ID itself.
  if (/-(none|minimal|low|medium|high|xhigh|max|tiered)$/i.test(shortID)) return []

  const fromCatalog = catalogEfforts?.get(shortID) ?? catalogEfforts?.get(normalized)
  if (fromCatalog !== undefined) return fromCatalog

  if (/gpt-[56789]|codex/i.test(shortID)) return ["low", "medium", "high", "xhigh"]
  if (/^(o1|o3|o4)\b/i.test(shortID)) return ["low", "medium", "high"]

  if (/claude/i.test(shortID)) {
    if (/opus-4[.-]6|sonnet-4[.-]6/i.test(shortID)) return ["low", "medium", "high", "max"]
    if (/(opus|sonnet|fable|mythos)-(4[.-][789]|[56789])/i.test(shortID)) {
      return ["low", "medium", "high", "xhigh", "max"]
    }
    if (/3[.-]7|(opus|sonnet|haiku)-4([.-][0-5])?\b/i.test(shortID)) return ["high", "max"]
    return []
  }

  if (/gemini-(2\.5|[3456789])/i.test(shortID)) return ["low", "medium", "high"]
  if (/deepseek-(r1|reasoner|v4|v3\.2)/i.test(shortID)) return ["low", "high", "max"]
  if (/glm-([56789]|4\.[56789])/i.test(shortID) && !/flash/i.test(shortID)) return ["low", "high", "max"]
  if (/kimi-k[3456789]/i.test(shortID)) return ["low", "high", "max"]
  if (/grok-[456789]/i.test(shortID)) return ["low", "medium", "high", "xhigh"]
  if (/grok-3-mini/i.test(shortID)) return ["low", "high"]
  if (/qwen3|qwq/i.test(shortID)) return ["low", "medium", "xhigh"]

  return []
}

export function resolveModelReasoningVariants(
  model: Model.Info,
  packageName: string | undefined,
  catalogEfforts?: ReadonlyMap<string, readonly string[]>,
): Model.MutableInfo["variants"] {
  const effectivePackage = packageName ?? model.package ?? "@opencode/ai/providers/openai-compatible"
  const efforts = inferModelReasoningEfforts(model.modelID ?? model.id, catalogEfforts)
  if (efforts.length === 0) return []
  return [
    ...Variant.resolve(
      { ...model, package: effectivePackage },
      [{ type: "effort", values: efforts }],
    ),
  ]
}

export function inferModelCompatibility(
  rawModelID: string,
  protocol: PiguProtocol | undefined,
): Model.Info["compatibility"] | undefined {
  if (protocol && protocol !== "openai-chat") return undefined
  const normalized = rawModelID.trim().toLowerCase().replace(/^models\//, "")
  if (!normalized) return undefined
  const shortID = normalized.includes("/") ? normalized.slice(normalized.lastIndexOf("/") + 1) : normalized
  const needsMaxTokens =
    /^(deepseek|kimi|moonshot|glm|chatglm|qwen|qwq|minimax|abab|mistral|devstral|codestral|pixtral|mixtral|doubao|yi-|step-|ernie|hunyuan|baichuan)/i.test(
      shortID,
    )
  const needsReasoningContent =
    /^(deepseek-(r1|reasoner|v3\.2|v[4-9])|kimi-(k2\.[5-9]|k[3-9])|kimi-.*thinking|qwq)/i.test(shortID)
  if (!needsMaxTokens && !needsReasoningContent) return undefined
  return {
    ...(needsMaxTokens ? { maxTokensField: "max_tokens" as const } : {}),
    ...(needsReasoningContent ? { reasoningField: "reasoning_content" as const, requireReasoning: true } : {}),
  }
}

export function resolveChatInputModalities(
  modelID: string,
  protocol: PiguProtocol | undefined,
  existing?: readonly string[],
): string[] {
  const base = existing && existing.length > 0 ? existing : ["text", "image"]
  const set = new Set(base)
  set.add("text")
  if (protocol === "gemini" || (/gemini/i.test(modelID) && protocol === undefined)) {
    set.add("image")
    set.add("audio")
    set.add("video")
    set.add("pdf")
  }
  return Array.from(set)
}

export const PiguProviderPlugin = define({
  id: "pigu.provider.custom",
  effect: Effect.fn(function* (ctx) {
    const globalService = yield* Global.Service
    const cache = yield* SharedCache.Service
    const modelService = yield* Model.Service
    const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
    const configured = yield* configuredSettings(providerID)

    yield* ctx.event
      .subscribe({ types: [Credential.Event.Updated.type] })
      .pipe(
        Stream.runForEach(() =>
          ctx.provider
            .reload()
            .pipe(Effect.andThen(ctx.model.reload()), Effect.andThen(ctx.skill.reload())),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )

    const discovered = yield* ProviderRefresh.start({
      integrationID,
      initial: { baseURL: "", models: [] } as DiscoveryState,
      interval: Duration.minutes(5),
      active: ctx.integration.connection.active(integrationID),
      reload: ctx.provider.reload(),
      load: Effect.fn("PiguProviderPlugin.load")(function* (_current, options) {
        const active = yield* activeCredential(ctx, integrationID)
        const rawURL =
          (active.credential?.type === "key" ? active.credential.metadata?.baseURL : undefined) ??
          process.env.PIGU_BASE_URL ??
          process.env.OPENAI_BASE_URL ??
          configured?.baseURL
        const baseURL = normalizeBaseURL(rawURL)
        const connection = active.connection
        if (!connection || active.credential?.type !== "key" || !baseURL) {
          return { connection, value: { baseURL, models: [] } }
        }
        const cacheKey = `pigu:${IntegrationConnection.key(connection)}:${baseURL}`
        const models = yield* cache
          .get({
            key: cacheKey,
            ...options,
            load: Effect.gen(function* () {
              const latest = yield* ctx.integration.connection.resolve(connection)
              if (latest?.type !== "key") return yield* Effect.fail(new Error("Pigu connection has no API key"))
              const response = yield* http
                .execute(buildDiscoveryRequest(baseURL, latest.key, App.useragent(ctx.app)))
                .pipe(Effect.timeout("15 seconds"))
              const text = yield* response.text
              return parseModels(text)
            }),
          })
          .pipe(Effect.orElseSucceed((): readonly DiscoveredModel[] => []))
        return { connection, value: { key: cacheKey, baseURL, models } }
      }),
    })

    yield* ctx.integration.transform((editor) => {
      editor.update(integrationID, (integration) => {
        integration.name = "Pigu API"
      })
      editor.method.update({
        integrationID,
        method: {
          type: "key",
          label: "API Key",
          form: Form.Fields.make([baseURLField]),
        },
      })
      editor.method.update({
        integrationID,
        method: {
          type: "env",
          names: ["PIGU_API_KEY", "OPENAI_API_KEY"],
        },
      })
    })

    yield* ctx.provider.transform((providers) => {
      const providerRecords = providers.list()
      const catalogEfforts = buildCatalogEffortMap(providerRecords)
      const catalogLimits = buildCatalogLimitMap(providerRecords)
      const baseURL =
        discovered.current.baseURL ||
        normalizeBaseURL(process.env.PIGU_BASE_URL ?? process.env.OPENAI_BASE_URL ?? configured?.baseURL)
      providers.update(providerID, (provider) => {
        provider.name = "Pigu API"
        provider.package = "@opencode/ai/providers/openai-compatible"
        provider.integrationID = integrationID
        if (baseURL) {
          provider.settings = {
            ...provider.settings,
            baseURL,
            provider: providerID,
          }
        }
      })
      const existing = Array.from(providers.get(providerID)?.models.values() ?? [])
      const nextIDs = new Set(discovered.current.models.map((item) => Model.ID.make(item.id)))
      existing
        .filter((model) => !nextIDs.has(model.id))
        .forEach((model) => {
          providers.models.remove(providerID, model.id)
        })
      const overrides = readModelProtocolOverridesSync(globalService.config)
      const multimodal = readMultimodalConfigSync(globalService.config)
      discovered.current.models.forEach((item) => {
        const protocol = overrides[`${providerID}/${item.id}`] ?? detectModelProtocol(item.id, baseURL)
        const modality = multimodal.overrides[`${providerID}/${item.id}`] ?? detectModelModality(item.id)
        const targetURL = protocolBaseURL(baseURL, protocol)
        const inferredCompat = inferModelCompatibility(item.id, protocol)
        providers.models.update(providerID, Model.ID.make(item.id), (draft) => {
          draft.modelID = Model.ID.make(item.id)
          draft.name = item.name
          draft.package = protocolPackage(protocol)
          draft.settings = {
            ...draft.settings,
            ...(targetURL ? { baseURL: targetURL } : {}),
            piguProtocol: protocol,
            piguModality: modality,
          }
          if (inferredCompat) {
            draft.compatibility = { ...inferredCompat, ...draft.compatibility }
          }
          draft.capabilities = {
            tools: true,
            input: resolveChatInputModalities(item.id, protocol),
            output: ["text"],
          }
          draft.limit = resolveModelLimit(item.id, {
            catalogLimits,
            baseURL: targetURL || baseURL,
            explicitContext: item.context,
            explicitOutput: item.output,
          })
          draft.variants = resolveModelReasoningVariants(draft, draft.package, catalogEfforts)
        })
      })
    })

    yield* ctx.model.transform((models) => {
      const overrides = readModelProtocolOverridesSync(globalService.config)
      const multimodal = readMultimodalConfigSync(globalService.config)
      const providerRecords = models.provider.list()
      const catalogEfforts = buildCatalogEffortMap(providerRecords)
      const catalogLimits = buildCatalogLimitMap(providerRecords)
      const catalogProviderIDs = new Set(
        providerRecords.filter((record) => record.provider.activation === "auto").map((record) => record.provider.id),
      )
      models.list().forEach((model) => {
        if (model.providerID === LOCAL_PROVIDER_ID) return
        const override = overrides[`${model.providerID}/${model.id}`]
        const modalityOverride = multimodal.overrides[`${model.providerID}/${model.id}`]
        if (catalogProviderIDs.has(model.providerID) && !override && !modalityOverride) return
        if (model.providerID === providerID && !override && !modalityOverride) return

        const providerInfo = models.provider.get(model.providerID)?.provider
        const providerPackage = providerInfo?.package
        const providerBaseURL =
          typeof providerInfo?.settings?.baseURL === "string" ? providerInfo.settings.baseURL : ""
        const isOpenAICompatProvider =
          !providerPackage ||
          providerPackage === "@opencode/ai/providers/openai-compatible" ||
          providerPackage === "aisdk:@ai-sdk/openai-compatible"
        const hasExplicitNonOpenAIPackage =
          Boolean(model.package) &&
          model.package !== "@opencode/ai/providers/openai-compatible" &&
          model.package !== "aisdk:@ai-sdk/openai-compatible"
        const configuredProtocol = isPiguProtocolID(model.settings?.piguProtocol)
          ? model.settings.piguProtocol
          : undefined
        const targetProtocol =
          override ??
          configuredProtocol ??
          (isOpenAICompatProvider && !hasExplicitNonOpenAIPackage
            ? detectModelProtocol(model.modelID ?? model.id, providerBaseURL)
            : undefined)
        const targetModality = modalityOverride ?? detectModelModality(model.modelID ?? model.id)

        const packageProtocol: PiguProtocol | undefined =
          model.package === "@opencode/ai/providers/google" || model.package === "aisdk:@ai-sdk/google"
            ? "gemini"
            : model.package === "@opencode/ai/providers/anthropic-compatible" ||
                model.package === "@opencode/ai/providers/anthropic"
              ? "anthropic"
              : model.package === "@opencode/ai/providers/openai-compatible-responses" ||
                  model.package === "@opencode/ai/providers/openai-compatible/responses"
                ? "openai-responses"
                : undefined
        const effectiveProtocol = targetProtocol ?? packageProtocol
        const inferredCompat = inferModelCompatibility(model.modelID ?? model.id, effectiveProtocol)
        const needsCompatUpdate =
          inferredCompat !== undefined &&
          ((inferredCompat.maxTokensField !== undefined &&
            model.compatibility?.maxTokensField === undefined) ||
            (inferredCompat.reasoningField !== undefined &&
              model.compatibility?.reasoningField === undefined) ||
            (inferredCompat.requireReasoning !== undefined &&
              model.compatibility?.requireReasoning === undefined))
        const desiredInput = resolveChatInputModalities(
          model.modelID ?? model.id,
          effectiveProtocol,
          model.capabilities.input,
        )
        const needsInputUpdate =
          desiredInput.length !== model.capabilities.input.length ||
          desiredInput.some((item, index) => item !== model.capabilities.input[index])

        const isDefaultLimit =
          model.limit.context === 200_000 && model.limit.output === 32_000 && model.limit.input === undefined
        const effectiveBaseURL =
          typeof model.settings?.baseURL === "string" && model.settings.baseURL
            ? model.settings.baseURL
            : providerBaseURL
        const resolvedLimit = isDefaultLimit
          ? resolveModelLimit(model.modelID ?? model.id, {
              catalogLimits,
              baseURL: effectiveBaseURL,
            })
          : undefined
        const needsLimitUpdate =
          resolvedLimit !== undefined &&
          (resolvedLimit.context !== model.limit.context ||
            resolvedLimit.output !== model.limit.output ||
            resolvedLimit.input !== model.limit.input)

        const currentIDs = model.variants.map((item) => String(item.id))
        const isGenericDefault =
          currentIDs.length === 0 ||
          (currentIDs.length === 3 &&
            currentIDs[0] === "low" &&
            currentIDs[1] === "medium" &&
            currentIDs[2] === "high") ||
          currentIDs.every(isPiguProtocolID)
        if (
          !targetProtocol &&
          !needsCompatUpdate &&
          !needsInputUpdate &&
          !needsLimitUpdate &&
          !isGenericDefault &&
          !modalityOverride &&
          targetModality === "text"
        )
          return
        models.update(model.providerID, model.id, (draft) => {
          draft.settings = {
            ...draft.settings,
            ...(effectiveProtocol ? { piguProtocol: effectiveProtocol } : {}),
            piguModality: targetModality,
          }
          if (targetProtocol) {
            const targetURL = protocolBaseURL(providerBaseURL, targetProtocol)
            draft.package = protocolPackage(targetProtocol)
            draft.settings = {
              ...draft.settings,
              ...(targetURL ? { baseURL: targetURL } : {}),
              piguProtocol: targetProtocol,
              piguModality: targetModality,
            }
          }
          if (inferredCompat) {
            draft.compatibility = { ...inferredCompat, ...draft.compatibility }
          }
          if (needsLimitUpdate && resolvedLimit) {
            draft.limit = resolvedLimit
          }
          if (targetProtocol || needsInputUpdate) {
            const nextInput = resolveChatInputModalities(
              draft.modelID ?? draft.id,
              effectiveProtocol,
              draft.capabilities.input,
            )
            if (
              nextInput.length !== draft.capabilities.input.length ||
              nextInput.some((item, index) => item !== draft.capabilities.input[index])
            ) {
              draft.capabilities = {
                ...draft.capabilities,
                input: nextInput,
              }
            }
          }
          if (targetProtocol || isGenericDefault) {
            draft.variants = resolveModelReasoningVariants(draft, draft.package ?? providerPackage, catalogEfforts)
          }
        })
      })
    })

    yield* ctx.shell.hook("create.before", (event) =>
      Effect.sync(() => {
        const multimodalEnv = buildMultimodalToolEnv(globalService.config)
        Object.entries(multimodalEnv).forEach(([key, value]) => {
          if (event.env[key] === undefined) {
            event.env[key] = value
          }
        })
      }),
    )

    yield* ctx.mcp.transform((editor) => {
      const multimodalEnv = buildMultimodalToolEnv(globalService.config)
      if (Object.keys(multimodalEnv).length === 0) return
      editor.list().forEach(([name, config]) => {
        if (config.type !== "local") return
        editor.update(name, (draft) => {
          if (draft.type !== "local") return
          draft.environment = {
            ...multimodalEnv,
            ...(draft.environment ?? {}),
          }
        })
      })
    })

    yield* ctx.skill.transform((editor) => {
      editor.list().forEach((skill) => {
        if (skill.name !== "imagegen" && skill.id !== "imagegen") return
        const bridge = buildImagegenSkillBridge(globalService.config, skill.path)
        editor.update(skill.id, (draft) => {
          const markerIdx = draft.content.indexOf(IMAGEGEN_BRIDGE_MARKER)
          const cleanContent = markerIdx >= 0 ? draft.content.slice(0, markerIdx).trimEnd() : draft.content.trimEnd()
          draft.content = bridge ? `${cleanContent}\n\n${bridge}` : cleanContent
        })
      })
    })

    yield* ctx.session.hook("prompt", (event) =>
      Effect.sync(() => {
        const meta = event.metadata
        const butler = typeof meta?.mobileButlerPrompt === "string" ? meta.mobileButlerPrompt : undefined
        if (butler) {
          setMobileTurnContext(event.sessionID, butler)
          return
        }
        if (meta?.mobileSteer === true) return
        clearMobileTurnContext(event.sessionID)
      }),
    )

    yield* ctx.session.hook("context", (event) =>
      Effect.gen(function* () {
        const mobilePrompt = getMobileTurnContext(event.sessionID)
        if (mobilePrompt) {
          event.system.push(SystemPart.make(mobilePrompt))
        }
        if (event.model.providerID === Provider.ID.openai) return
        const modelInfo = yield* modelService
          .get(event.model.providerID, event.model.id)
          .pipe(Effect.orElseSucceed(() => undefined))
        if (isOpenAIResponsesTarget(modelInfo)) {
          delete event.options.maxTokens
        }
      }),
    )

    yield* ctx.session.hook("compaction", (event) =>
      Effect.gen(function* () {
        if (event.model.providerID === Provider.ID.openai) return
        const modelInfo = yield* modelService
          .get(event.model.providerID, event.model.id)
          .pipe(Effect.orElseSucceed(() => undefined))
        if (isOpenAIResponsesTarget(modelInfo)) {
          delete event.options.maxTokens
        }
      }),
    )

    yield* ctx.session.hook("model.request", (event) =>
      Effect.gen(function* () {
        if (event.model.providerID === Provider.ID.openai) return
        const modelInfo = yield* modelService
          .get(event.model.providerID, event.model.id)
          .pipe(Effect.orElseSucceed(() => undefined))
        if (!isOpenAIResponsesTarget(modelInfo)) return
        // Codex/ChatGPT account pools bind encrypted reasoning items and prompt caches per upstream account via
        // `session-id` / `thread-id`. Derive a stable RFC-4122 UUID from session affinity so multi-step tool loops
        // stay pinned to the same channel without failing strict UUID header parsers.
        const affinity = event.headers["x-session-affinity"] || event.sessionID
        const stickyID = toDeterministicUUID(affinity)
        event.headers["session-id"] ??= stickyID
        event.headers["thread-id"] ??= stickyID
      }),
    )
  }),
} satisfies PluginInternal.InternalPlugin)

function isOpenAIResponsesTarget(modelInfo: Model.Info | undefined): boolean {
  if (!modelInfo) return false
  const pkg = Provider.packageName(modelInfo.package)
  const isResponsesRoute =
    pkg === "@opencode/ai/providers/openai-compatible-responses" ||
    pkg === "@opencode/ai/providers/openai-compatible/responses" ||
    pkg === "@opencode/ai/providers/openai" ||
    pkg === "@opencode/ai/providers/openai/responses" ||
    modelInfo.settings?.piguProtocol === "openai-responses"
  if (!isResponsesRoute) return false
  const rawID = (modelInfo.modelID ?? modelInfo.id).trim().toLowerCase()
  const shortID = rawID.includes("/") ? rawID.slice(rawID.lastIndexOf("/") + 1) : rawID
  return /^(gpt-|o[134]\b)/i.test(shortID) || /codex/i.test(shortID)
}

function toDeterministicUUID(seed: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seed)) {
    return seed.toLowerCase()
  }
  const hex = createHash("sha256").update(seed).digest("hex")
  const variantNibble = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variantNibble}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export function normalizeBaseURL(input: unknown): string {
  return normalizeProviderBaseURL(input)
}

function buildDiscoveryRequest(baseURL: string, apiKey: string | undefined, userAgent?: string) {
  const initial = HttpClientRequest.get(`${baseURL}/models`).pipe(
    HttpClientRequest.acceptJson,
    (req) => (userAgent ? HttpClientRequest.setHeader(req, "User-Agent", userAgent) : req),
  )
  const cleanKey = apiKey?.trim()
  if (!cleanKey) return initial
  const kind = detectEndpointKind(baseURL)
  if (kind === "anthropic-native") {
    return initial.pipe(
      HttpClientRequest.setHeaders({
        "x-api-key": cleanKey,
        "anthropic-version": "2023-06-01",
      }),
      HttpClientRequest.bearerToken(cleanKey),
    )
  }
  if (kind === "gemini-native") {
    return HttpClientRequest.setHeader(initial, "x-goog-api-key", cleanKey)
  }
  return HttpClientRequest.bearerToken(initial, cleanKey)
}

function parseModels(text: string): readonly DiscoveredModel[] {
  const payload = Option.getOrUndefined(decodeRemoteModels(text))
  if (!payload) return []
  const list = "data" in payload ? payload.data : "models" in payload ? payload.models : payload
  const seen = new Set<string>()
  return list
    .flatMap((item): DiscoveredModel[] => {
      const rawID = (item.id ?? item.name?.replace(/^models\//i, "") ?? "").trim()
      if (!rawID || seen.has(rawID) || isNonChatUtilityModel(rawID)) return []
      const methods = item.supportedGenerationMethods
      if (
        Array.isArray(methods) &&
        methods.length > 0 &&
        detectModelModality(rawID) === "text" &&
        !methods.includes("generateContent")
      ) {
        return []
      }
      seen.add(rawID)
      const displayName =
        item.display_name?.trim() || item.displayName?.trim() || item.name?.replace(/^models\//i, "").trim() || rawID
      const context = item.context_length ?? item.max_model_len ?? item.inputTokenLimit ?? undefined
      const output = item.max_output_tokens ?? item.outputTokenLimit ?? undefined
      return [
        {
          id: rawID,
          name: displayName,
          ...(Predicate.isNumber(context) && context > 0 ? { context } : {}),
          ...(Predicate.isNumber(output) && output > 0 ? { output } : {}),
        },
      ]
    })
    .toSorted((a, b) => a.id.localeCompare(b.id))
}

const RESERVED_BUILTIN_PROVIDER_IDS = new Set([
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "zai",
  "zai-coding-plan",
  "zhipuai",
  "zhipuai-coding-plan",
  "xai",
  "moonshotai",
  "moonshotai-cn",
  "alibaba",
  "alibaba-cn",
  "minimax",
  "minimax-cn",
  "mistral",
  "openrouter",
  "groq",
  "togetherai",
  "fireworks-ai",
  "cerebras",
  "nvidia",
  "poe",
  "ollama",
  "lmstudio",
  "vllm",
  "opencode",
  "opencode-go",
  "azure",
  "amazon-bedrock",
  "google-vertex",
  "github-copilot",
  "gitlab",
  "pigu",
  "local",
  "native-cli",
])

function deriveProviderName(baseURL: string): string {
  if (!URL.canParse(baseURL)) return "Custom API"
  const host = new URL(baseURL).hostname.toLowerCase()
  if (host === "api.openai.com") return "OpenAI"
  if (host === "api.anthropic.com") return "Anthropic"
  if (host === "generativelanguage.googleapis.com") return "Google Gemini"
  if (host === "api.deepseek.com" || host.endsWith(".deepseek.com")) return "DeepSeek"
  if (host === "api.moonshot.cn" || host === "api.moonshot.ai") return "Kimi (Moonshot)"
  if (host === "open.bigmodel.cn" || host === "api.z.ai") return "智谱 GLM"
  if (host.includes("dashscope") && host.endsWith("aliyuncs.com")) return "阿里云百炼 (Qwen)"
  if (host === "api.minimaxi.com" || host === "api.minimax.io" || host === "api.minimax.chat") return "MiniMax"
  if (host === "openrouter.ai") return "OpenRouter"
  if (host.endsWith("siliconflow.cn") || host.endsWith("siliconflow.com")) return "硅基流动"
  if (host.endsWith("volces.com")) return "火山方舟"
  if (host === "api.x.ai") return "xAI"
  if (host === "api.mistral.ai") return "Mistral"
  if (host === "api.groq.com") return "Groq"
  if (host.startsWith("api.together.")) return "Together AI"
  return host.replace(/^api\./i, "") || "Custom API"
}

function fallbackModelsForEndpoint(baseURL: string): readonly DiscoveredModel[] {
  const toEntries = (ids: readonly string[]): readonly DiscoveredModel[] => ids.map((id) => ({ id, name: id }))
  if (!URL.canParse(baseURL)) return toEntries(["gpt-5.4", "claude-sonnet-4-6", "gemini-2.5-pro", "deepseek-chat"])
  const host = new URL(baseURL).hostname.toLowerCase()
  if (host === "api.anthropic.com") {
    return toEntries(["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"])
  }
  if (host === "generativelanguage.googleapis.com") {
    return toEntries(["gemini-2.5-pro", "gemini-2.5-flash"])
  }
  if (host === "api.openai.com") {
    return toEntries(["gpt-5.4", "gpt-4.1", "gpt-4o", "o4-mini"])
  }
  if (host === "api.deepseek.com" || host.endsWith(".deepseek.com")) {
    return toEntries(["deepseek-chat", "deepseek-reasoner"])
  }
  if (host === "api.moonshot.cn" || host === "api.moonshot.ai") {
    return toEntries(["kimi-k2.5", "moonshot-v1-128k"])
  }
  if (host === "open.bigmodel.cn" || host === "api.z.ai") {
    return toEntries(["glm-5", "glm-4.7", "glm-4.5-air"])
  }
  if (host.includes("dashscope") && host.endsWith("aliyuncs.com")) {
    return toEntries(["qwen3-max", "qwen3-coder-plus", "qwen-plus"])
  }
  if (host === "api.minimaxi.com" || host === "api.minimax.io" || host === "api.minimax.chat") {
    return toEntries(["MiniMax-M2.7", "MiniMax-M2.5"])
  }
  if (host === "api.x.ai") {
    return toEntries(["grok-4", "grok-3"])
  }
  if (host === "api.mistral.ai") {
    return toEntries(["mistral-large-latest", "codestral-latest"])
  }
  if (host.endsWith("volces.com")) {
    return toEntries(["doubao-seed-2-0-pro-260215", "deepseek-v3-250324"])
  }
  if (host === "openrouter.ai") {
    return toEntries(["anthropic/claude-sonnet-4.6", "openai/gpt-5.4", "google/gemini-2.5-pro", "deepseek/deepseek-chat"])
  }
  return toEntries(["gpt-5.4", "claude-sonnet-4-6", "gemini-2.5-pro", "deepseek-chat"])
}

function deriveProviderID(name: string, baseURL: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (slug) return slug
  if (URL.canParse(baseURL)) {
    const hostSlug = new URL(baseURL).hostname
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
    if (hostSlug) return hostSlug
  }
  return `pigu-${Date.now()}`
}

export const manageCustomProvider = Effect.fn("PiguProvider.manageCustomProvider")(function* (input: {
  readonly action:
    | "upsert"
    | "delete"
    | "refresh"
    | "toggle-dsh-plugin"
    | "set-model-protocol"
    | "set-model-modality"
    | "set-modality-default"
  readonly providerID?: string
  readonly modelID?: string
  readonly protocol?: string
  readonly modality?: string
  readonly name?: string
  readonly baseURL?: string
  readonly apiKey?: string
  readonly multimodalOnly?: boolean
  readonly customModels?: string
}) {
  const globalService = yield* Global.Service
  const fs = yield* FSUtil.Service
  const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
  const credential = yield* Credential.Service
  const bus = yield* Bus.Service

  if (input.action === "toggle-dsh-plugin") {
    const pluginName = (input.providerID ?? input.name ?? "").trim()
    if (pluginName) {
      setDshPluginEnabled(os.homedir(), pluginName, input.apiKey !== "disabled")
    }
    return
  }

  if (
    input.action === "refresh" &&
    (!input.providerID || input.providerID === "local" || input.providerID.startsWith("local:"))
  ) {
    yield* refreshLocalEngineModels(input.providerID)
    yield* bus.publish(Credential.Event.Updated, {})
    yield* Effect.sleep("120 millis")
    return
  }

  if (input.action === "set-model-modality") {
    const targetProviderID = input.providerID?.trim()
    const targetModelID = input.modelID?.trim()
    if (!targetProviderID || !targetModelID) return
    const current = readMultimodalConfigSync(globalService.config)
    const overrideKey = `${targetProviderID}/${targetModelID}`
    const nextModality = isPiguModality(input.modality) ? input.modality : undefined
    const nextOverrides = Object.fromEntries(
      Object.entries(current.overrides).filter(([key]) => key !== overrideKey),
    )
    if (nextModality) {
      nextOverrides[overrideKey] = nextModality
    }
    writeResolvedMultimodalConfigSync(globalService.config, {
      overrides: nextOverrides,
      userDefaults: current.userDefaults,
    })
    yield* bus.publish(Credential.Event.Updated, {})
    yield* Effect.sleep("120 millis")
    return
  }

  if (input.action === "set-modality-default") {
    if (!isPiguModality(input.modality)) return
    const modality = input.modality
    const current = readMultimodalConfigSync(globalService.config)
    const targetProviderID = input.providerID?.trim()
    const targetModelID = input.modelID?.trim()
    const nextDefaults: Partial<Record<PiguModality, MultimodalEndpointConfig>> = { ...(current.userDefaults ?? {}) }
    if (!targetProviderID || !targetModelID) {
      delete nextDefaults[modality]
      writeResolvedMultimodalConfigSync(globalService.config, {
        overrides: current.overrides,
        userDefaults: nextDefaults,
      })
      yield* bus.publish(Credential.Event.Updated, {})
      yield* Effect.sleep("120 millis")
      return
    }
    const protocolOverrides = readModelProtocolOverridesSync(globalService.config)
    const configuredCandidate = readConfiguredProviderCandidatesSync(globalService.config).find(
      (item) => item.providerID === targetProviderID,
    )
    const resolvedProtocol = isPiguProtocolID(input.protocol)
      ? input.protocol
      : (protocolOverrides[`${targetProviderID}/${targetModelID}`] ??
          detectModelProtocol(targetModelID, input.baseURL || configuredCandidate?.baseURL))
    const allCreds = yield* credential.all()
    const matchedKeyCred = allCreds
      .filter((item) => item.integrationID === targetProviderID && item.value.type === "key")
      .at(-1)
    const credBaseURL =
      matchedKeyCred?.value.type === "key" && Predicate.isString(matchedKeyCred.value.metadata?.baseURL)
        ? matchedKeyCred.value.metadata.baseURL
        : undefined
    const credApiKey = matchedKeyCred?.value.type === "key" ? matchedKeyCred.value.key : undefined
    const catalogBaseURL =
      targetProviderID === "google" ? "https://generativelanguage.googleapis.com/v1beta" : "https://api.openai.com/v1"
    const currentResolved = resolveMultimodalConfigSync(globalService.config)
    const fallbackURL =
      normalizeBaseURL(input.baseURL) ||
      configuredCandidate?.baseURL ||
      normalizeBaseURL(credBaseURL) ||
      (currentResolved.defaults[modality]?.providerID === targetProviderID
        ? currentResolved.defaults[modality]?.baseURL
        : undefined) ||
      catalogBaseURL
    const resolvedApiKey = input.apiKey?.trim() || configuredCandidate?.apiKey || credApiKey?.trim()
    nextDefaults[modality] = {
      providerID: targetProviderID,
      modelID: targetModelID,
      protocol: resolvedProtocol,
      baseURL: protocolBaseURL(fallbackURL, resolvedProtocol),
      ...(resolvedApiKey ? { apiKey: resolvedApiKey } : {}),
    }
    writeResolvedMultimodalConfigSync(globalService.config, {
      overrides: current.overrides,
      userDefaults: nextDefaults,
    })
    yield* bus.publish(Credential.Event.Updated, {})
    yield* Effect.sleep("120 millis")
    return
  }

  const directory = AbsolutePath.make(globalService.config)
  const candidates = ConfigDiscovery.names.map((name) => path.join(directory, name))
  const existingFiles = yield* Effect.filter(candidates, fs.isFile)
  const filepath = existingFiles.at(-1) ?? path.join(directory, "opencode.json")
  const rawText = yield* fs.readFileStringSafe(filepath)
  const text = rawText && rawText.trim().length > 0 ? rawText : "{}\n"
  const overridesPath = path.join(globalService.config, PROTOCOL_OVERRIDES_FILE)

  if (input.action === "set-model-protocol") {
    const targetProviderID = input.providerID?.trim()
    const targetModelID = input.modelID?.trim()
    if (!targetProviderID || !targetModelID) return
    const currentOverrides = readModelProtocolOverridesSync(globalService.config)
    const overrideKey = `${targetProviderID}/${targetModelID}`
    const nextProtocol = isPiguProtocolID(input.protocol) ? input.protocol : undefined
    const nextOverrides = Object.fromEntries(
      Object.entries(currentOverrides).filter(([key]) => key !== overrideKey),
    )
    if (nextProtocol) {
      nextOverrides[overrideKey] = nextProtocol
    }
    yield* fs.writeWithDirs(overridesPath, `${JSON.stringify(nextOverrides, null, 2)}\n`)

    if (existingFiles.length > 0) {
      const parsedDoc = parse(text)
      const docRootKey =
        isRecord(parsedDoc) && isRecord(parsedDoc.providers) && !isRecord(parsedDoc.provider) ? "providers" : "provider"
      const container = isRecord(parsedDoc) && isRecord(parsedDoc[docRootKey]) ? parsedDoc[docRootKey] : undefined
      const providerEntry =
        container && isRecord(container[targetProviderID]) ? container[targetProviderID] : undefined
      const optionsRecord =
        providerEntry && isRecord(providerEntry.options)
          ? providerEntry.options
          : providerEntry && isRecord(providerEntry.settings)
            ? providerEntry.settings
            : undefined
      const providerURL =
        optionsRecord && Predicate.isString(optionsRecord.baseURL) ? normalizeBaseURL(optionsRecord.baseURL) : ""
      const modelsRecord = providerEntry && isRecord(providerEntry.models) ? providerEntry.models : undefined
      if (providerEntry && providerURL && modelsRecord && targetModelID in modelsRecord) {
        const currentModel = modelsRecord[targetModelID]
        const modelName =
          isRecord(currentModel) && Predicate.isString(currentModel.name) ? currentModel.name : targetModelID
        const updatedModel = buildConfiguredModelEntry({
          id: targetModelID,
          name: modelName,
          baseURL: providerURL,
          rootKey: docRootKey,
          override: nextProtocol,
          existing: currentModel,
        })
        const updatedDoc = applyEdits(
          text,
          modify(text, [docRootKey, targetProviderID, "models", targetModelID], updatedModel, {
            formattingOptions: { tabSize: 2, insertSpaces: true },
          }),
        )
        yield* fs.writeWithDirs(filepath, updatedDoc.endsWith("\n") ? updatedDoc : `${updatedDoc}\n`)
      }
    }
    writeResolvedMultimodalConfigSync(globalService.config)
    yield* bus.publish(Credential.Event.Updated, {})
    yield* Effect.sleep("120 millis")
    return
  }

  const cleanShadowConfigs = Effect.fnUntraced(function* (targetID: string) {
    const primaryResolved = yield* fs.resolve(filepath)
    const shadowDirs = [globalService.home, path.join(globalService.home, ".opencode")]
    const shadowCandidates = shadowDirs.flatMap((dir) => ConfigDiscovery.names.map((name) => path.join(dir, name)))
    const existingShadows = yield* Effect.filter(shadowCandidates, fs.isFile)
    yield* Effect.forEach(
      existingShadows,
      (shadowPath) =>
        Effect.gen(function* () {
          const shadowResolved = yield* fs.resolve(shadowPath)
          if (shadowResolved === primaryResolved) return
          const shadowRaw = yield* fs.readFileStringSafe(shadowPath)
          if (shadowRaw === undefined) return
          const cleaned = removeProviderFromJsonc(shadowRaw, targetID)
          if (!cleaned.changed) return
          if (cleaned.empty) {
            yield* fs.remove(shadowPath, { force: true }).pipe(Effect.ignore)
            return
          }
          yield* fs.writeWithDirs(shadowPath, cleaned.text)
        }),
      { discard: true },
    )
  })

  if (input.action === "delete") {
    const targetID = input.providerID?.trim()
    if (!targetID) return
    const allCreds = yield* credential.all()
    yield* Effect.forEach(
      allCreds.filter((item) => item.integrationID === targetID),
      (item) => credential.remove(item.id),
      { discard: true },
    )
    const currentOverrides = readModelProtocolOverridesSync(globalService.config)
    const remainingOverrides = Object.fromEntries(
      Object.entries(currentOverrides).filter(([key]) => !key.startsWith(`${targetID}/`)),
    )
    if (Object.keys(remainingOverrides).length !== Object.keys(currentOverrides).length) {
      yield* fs.writeWithDirs(overridesPath, `${JSON.stringify(remainingOverrides, null, 2)}\n`)
    }
    const cleaned = removeProviderFromJsonc(text, targetID)
    yield* fs.writeWithDirs(filepath, cleaned.text)
    yield* cleanShadowConfigs(targetID)
    const currentMultimodal = readMultimodalConfigSync(globalService.config)
    const remainingModalityOverrides = Object.fromEntries(
      Object.entries(currentMultimodal.overrides).filter(([key]) => !key.startsWith(`${targetID}/`)),
    )
    const remainingUserDefaults = Object.fromEntries(
      Object.entries(currentMultimodal.userDefaults ?? {}).filter(([, value]) => value?.providerID !== targetID),
    ) as Partial<Record<PiguModality, MultimodalEndpointConfig>>
    writeResolvedMultimodalConfigSync(globalService.config, {
      overrides: remainingModalityOverrides,
      userDefaults: remainingUserDefaults,
    })
    yield* bus.publish(Credential.Event.Updated, {})
    yield* Effect.sleep("120 millis")
    return
  }

  const parsed = parse(text)
  const existingProviders = isRecord(parsed)
    ? isRecord(parsed.provider)
      ? parsed.provider
      : isRecord(parsed.providers)
        ? parsed.providers
        : undefined
    : undefined

  const initialTargetID = input.providerID?.trim()
  const initialEntry =
    initialTargetID && existingProviders && isRecord(existingProviders[initialTargetID])
      ? existingProviders[initialTargetID]
      : undefined
  const initialOptions =
    initialEntry && isRecord(initialEntry.options)
      ? initialEntry.options
      : initialEntry && isRecord(initialEntry.settings)
        ? initialEntry.settings
        : undefined
  const savedBaseURL =
    initialOptions && Predicate.isString(initialOptions.baseURL) ? initialOptions.baseURL : undefined
  const savedName = initialEntry && Predicate.isString(initialEntry.name) ? initialEntry.name : undefined

  const baseURL = normalizeBaseURL(input.baseURL || savedBaseURL)
  if (!baseURL) return
  const name = input.name?.trim() || savedName || deriveProviderName(baseURL)
  const baseSlug = deriveProviderID(name, baseURL)
  const resolvedSlug =
    RESERVED_BUILTIN_PROVIDER_IDS.has(baseSlug) && !(existingProviders && baseSlug in existingProviders)
      ? `${baseSlug}-api`
      : baseSlug
  const targetID =
    initialTargetID ||
    (input.multimodalOnly && existingProviders && resolvedSlug in existingProviders
      ? `${resolvedSlug}-media`
      : resolvedSlug)

  const existingEntry =
    existingProviders && isRecord(existingProviders[targetID]) ? existingProviders[targetID] : undefined
  const existingOptions =
    existingEntry && isRecord(existingEntry.options)
      ? existingEntry.options
      : existingEntry && isRecord(existingEntry.settings)
        ? existingEntry.settings
        : undefined
  const isMultimodalOnly = input.multimodalOnly === true || existingOptions?.piguMultimodalOnly === true
  const existingKey = existingOptions && Predicate.isString(existingOptions.apiKey) ? existingOptions.apiKey : ""
  const effectiveApiKey = input.apiKey?.trim() || existingKey

  const existingModels =
    existingEntry && isRecord(existingEntry.models) ? existingEntry.models : {}

  const request = buildDiscoveryRequest(baseURL, effectiveApiKey)

  const discovered = yield* http
    .execute(request)
    .pipe(
      Effect.flatMap((response) => response.text),
      Effect.map(parseModels),
      Effect.timeout("10 seconds"),
      Effect.orElseSucceed((): readonly DiscoveredModel[] => []),
    )

  const rootKey =
    isRecord(parsed) && isRecord(parsed.providers) && !isRecord(parsed.provider) ? "providers" : "provider"

  const currentOverrides = readModelProtocolOverridesSync(globalService.config)
  const currentMultimodal = readMultimodalConfigSync(globalService.config)
  const explicitModelIDs = (input.customModels ?? "")
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean)

  const fallbackModality: PiguModality =
    isPiguModality(input.modality) && input.modality !== "text" ? input.modality : "image"
  const extraModalityOverrides = isMultimodalOnly
    ? Object.fromEntries(
        explicitModelIDs
          .filter((id) => !currentMultimodal.overrides[`${targetID}/${id}`] && detectModelModality(id) === "text")
          .map((id) => [`${targetID}/${id}`, fallbackModality] as const),
      )
    : {}
  const nextModalityOverrides = { ...currentMultimodal.overrides, ...extraModalityOverrides }
  const modalityOverridesChanged = Object.keys(extraModalityOverrides).length > 0

  const multimodalDiscovered = discovered.filter(
    (item) => detectModelModality(item.id) !== "text" || Boolean(nextModalityOverrides[`${targetID}/${item.id}`]),
  )
  const mergedMultimodal: readonly DiscoveredModel[] = [
    ...multimodalDiscovered,
    ...explicitModelIDs
      .filter((id) => !multimodalDiscovered.some((item) => item.id === id))
      .map((id) => ({ id, name: id })),
  ]
  const mergedTextDiscovered: readonly DiscoveredModel[] = [
    ...discovered,
    ...explicitModelIDs
      .filter((id) => !discovered.some((item) => item.id === id))
      .map((id) => ({ id, name: id })),
  ]

  const rawModelsList: readonly DiscoveredModel[] = isMultimodalOnly
    ? mergedMultimodal.length > 0
      ? mergedMultimodal
      : Object.keys(existingModels).length > 0
        ? Object.entries(existingModels).map(([id, value]) => ({
            id,
            name: isRecord(value) && Predicate.isString(value.name) ? value.name : id,
          }))
        : [
            { id: "gpt-image-2", name: "gpt-image-2" },
            { id: "gemini-3-pro-image", name: "gemini-3-pro-image" },
            { id: "grok-imagine-video", name: "grok-imagine-video" },
            { id: "whisper-1", name: "whisper-1" },
          ]
    : mergedTextDiscovered.length > 0
      ? mergedTextDiscovered
      : Object.keys(existingModels).length > 0
        ? Object.entries(existingModels).map(([id, value]) => ({
            id,
            name: isRecord(value) && Predicate.isString(value.name) ? value.name : id,
          }))
        : fallbackModelsForEndpoint(baseURL)

  const modelsMap = Object.fromEntries(
    rawModelsList.map((item) => [
      item.id,
      buildConfiguredModelEntry({
        id: item.id,
        name: item.name,
        baseURL,
        rootKey,
        context: item.context,
        output: item.output,
        override: currentOverrides[`${targetID}/${item.id}`],
        existing: existingModels[item.id],
      }),
    ]),
  )

  const entry =
    rootKey === "providers"
      ? {
          package: "aisdk:@ai-sdk/openai-compatible",
          name,
          settings: {
            baseURL,
            ...(effectiveApiKey ? { apiKey: effectiveApiKey } : {}),
            ...(isMultimodalOnly ? { piguMultimodalOnly: true } : {}),
          },
          models: modelsMap,
        }
      : {
          npm: "@ai-sdk/openai-compatible",
          name,
          options: {
            baseURL,
            ...(effectiveApiKey ? { apiKey: effectiveApiKey } : {}),
            ...(isMultimodalOnly ? { piguMultimodalOnly: true } : {}),
          },
          models: modelsMap,
        }

  const updated = applyEdits(
    text,
    modify(text, [rootKey, targetID], entry, { formattingOptions: { tabSize: 2, insertSpaces: true } }),
  )
  yield* fs.writeWithDirs(filepath, updated.endsWith("\n") ? updated : `${updated}\n`)
  yield* cleanShadowConfigs(targetID)
  writeResolvedMultimodalConfigSync(
    globalService.config,
    modalityOverridesChanged ? { overrides: nextModalityOverrides } : undefined,
  )
  yield* bus.publish(Credential.Event.Updated, {})
  yield* Effect.sleep("120 millis")
})

function removeProviderFromJsonc(rawText: string, targetID: string) {
  const source = rawText.trim().length > 0 ? rawText : "{}\n"
  const parsed = parse(source)
  if (!isRecord(parsed)) return { text: source, changed: false, empty: false }
  const hasProviderEntry = isRecord(parsed.provider) && targetID in parsed.provider
  const hasProvidersEntry = isRecord(parsed.providers) && targetID in parsed.providers
  const clearModel = Predicate.isString(parsed.model) && parsed.model.startsWith(`${targetID}/`)
  if (!hasProviderEntry && !hasProvidersEntry && !clearModel) {
    return { text: source, changed: false, empty: false }
  }
  const format = { formattingOptions: { tabSize: 2, insertSpaces: true } }
  const step1 = hasProviderEntry
    ? applyEdits(source, modify(source, ["provider", targetID], undefined, format))
    : source
  const afterStep1 = parse(step1)
  const step2 =
    isRecord(afterStep1) && isRecord(afterStep1.provider) && Object.keys(afterStep1.provider).length === 0
      ? applyEdits(step1, modify(step1, ["provider"], undefined, format))
      : step1
  const step3 = hasProvidersEntry
    ? applyEdits(step2, modify(step2, ["providers", targetID], undefined, format))
    : step2
  const afterStep3 = parse(step3)
  const step4 =
    isRecord(afterStep3) && isRecord(afterStep3.providers) && Object.keys(afterStep3.providers).length === 0
      ? applyEdits(step3, modify(step3, ["providers"], undefined, format))
      : step3
  const updated = clearModel ? applyEdits(step4, modify(step4, ["model"], undefined, format)) : step4
  const finalParsed = parse(updated)
  const remainingKeys = isRecord(finalParsed)
    ? Object.keys(finalParsed).filter((key) => key !== "$schema")
    : ["unknown"]
  return {
    text: updated.endsWith("\n") ? updated : `${updated}\n`,
    changed: true,
    empty: remainingKeys.length === 0,
  }
}
