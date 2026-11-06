export * as PiguProvider from "./pigu.js"

import path from "path"
import { applyEdits, modify, parse } from "jsonc-parser"
import { define } from "@opencode/plugin/effect/plugin"
import { Form } from "@opencode/schema/form"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { isRecord } from "@opencode/util/record"
import { Duration, Effect, Option, Predicate, Schema } from "effect"
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
import type { PluginInternal } from "../internal.js"
import { configuredSettings } from "./configured.js"
import { activeCredential } from "./credential-settings.js"
import { ProviderRefresh } from "./refresh.js"

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
  context_length: Schema.optional(Schema.NullOr(Schema.Number)),
  max_model_len: Schema.optional(Schema.NullOr(Schema.Number)),
  max_output_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
})

const RemoteModelsPayload = Schema.Union([
  Schema.Struct({ data: Schema.Array(RemoteModelItem) }),
  Schema.Struct({ models: Schema.Array(RemoteModelItem) }),
  Schema.Array(RemoteModelItem),
])

const decodeRemoteModels = Schema.decodeUnknownOption(Schema.fromJsonString(RemoteModelsPayload))

export const PIGU_PROTOCOLS = ["openai-chat", "gemini", "anthropic", "openai-responses"] as const
export type PiguProtocol = (typeof PIGU_PROTOCOLS)[number]

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

export function detectModelProtocol(modelID: string): PiguProtocol {
  if (/gemini/i.test(modelID)) return "gemini"
  if (/claude/i.test(modelID)) return "anthropic"
  if (/codex/i.test(modelID)) return "openai-responses"
  return "openai-chat"
}

export function protocolPackage(protocol: PiguProtocol): string {
  if (protocol === "gemini") return "@opencode/ai/providers/google"
  if (protocol === "anthropic") return "@opencode/ai/providers/anthropic-compatible"
  if (protocol === "openai-responses") return "@opencode/ai/providers/openai-compatible-responses"
  return "@opencode/ai/providers/openai-compatible"
}

export function protocolBaseURL(baseURL: string, protocol: PiguProtocol): string {
  const normalized = normalizeBaseURL(baseURL)
  if (!normalized) return ""
  if (protocol === "gemini") {
    return /\/v1$/i.test(normalized) ? normalized.replace(/\/v1$/i, "/v1beta") : normalized
  }
  return /\/v1beta$/i.test(normalized) ? normalized.replace(/\/v1beta$/i, "/v1") : normalized
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

export const PiguProviderPlugin = define({
  id: "pigu.provider.custom",
  effect: Effect.fn(function* (ctx) {
    const cache = yield* SharedCache.Service
    const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
    const configured = yield* configuredSettings(providerID)

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
                .execute(
                  HttpClientRequest.get(`${baseURL}/models`).pipe(
                    HttpClientRequest.bearerToken(latest.key),
                    HttpClientRequest.acceptJson,
                    HttpClientRequest.setHeader("User-Agent", App.useragent(ctx.app)),
                  ),
                )
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
      discovered.current.models.forEach((item) => {
        const protocol = detectModelProtocol(item.id)
        const targetURL = protocolBaseURL(baseURL, protocol)
        providers.models.update(providerID, Model.ID.make(item.id), (draft) => {
          draft.modelID = Model.ID.make(item.id)
          draft.name = item.name
          draft.package = protocolPackage(protocol)
          draft.settings = {
            ...draft.settings,
            ...(targetURL ? { baseURL: targetURL } : {}),
            piguProtocol: protocol,
          }
          draft.variants = protocolVariants(baseURL)
          draft.capabilities = {
            tools: true,
            input: ["text", "image"],
            output: ["text"],
          }
          draft.limit = {
            context: item.context ?? 128_000,
            output: item.output ?? 16_384,
          }
        })
      })
      providers
        .list()
        .filter((record) => record.provider.id !== providerID)
        .forEach((record) => {
          const providerURL =
            Predicate.isString(record.provider.settings?.baseURL)
              ? normalizeBaseURL(record.provider.settings.baseURL)
              : ""
          Array.from(record.models.values()).forEach((model) => {
            const protocol = detectModelProtocol(model.id)
            const targetURL = protocolBaseURL(providerURL, protocol)
            providers.models.update(record.provider.id, model.id, (draft) => {
              draft.package = protocolPackage(protocol)
              draft.settings = {
                ...draft.settings,
                ...(targetURL ? { baseURL: targetURL } : {}),
                piguProtocol: protocol,
              }
              draft.variants = protocolVariants(providerURL)
            })
          })
        })
    })
  }),
} satisfies PluginInternal.InternalPlugin)

export function normalizeBaseURL(input: unknown): string {
  if (!Predicate.isString(input)) return ""
  const trimmed = input.trim().replace(/\/+$/, "")
  if (!trimmed) return ""
  const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(trimmed)
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `${isLocal ? "http" : "https"}://${trimmed}`
  const stripped = withProtocol
    .replace(/\/chat\/completions$/i, "")
    .replace(/\/completions$/i, "")
    .replace(/\/models$/i, "")
    .replace(/\/+$/, "")
  if (!URL.canParse(stripped)) return stripped
  const parsed = new URL(stripped)
  if (parsed.pathname === "" || parsed.pathname === "/") {
    parsed.pathname = "/v1"
    return parsed.toString().replace(/\/+$/, "")
  }
  return stripped
}

function parseModels(text: string): readonly DiscoveredModel[] {
  const payload = Option.getOrUndefined(decodeRemoteModels(text))
  if (!payload) return []
  const list = "data" in payload ? payload.data : "models" in payload ? payload.models : payload
  const seen = new Set<string>()
  return list
    .flatMap((item): DiscoveredModel[] => {
      const rawID = (item.id ?? item.name?.replace(/^models\//i, "") ?? "").trim()
      if (!rawID || seen.has(rawID)) return []
      seen.add(rawID)
      const context = item.context_length ?? item.max_model_len ?? undefined
      const output = item.max_output_tokens ?? undefined
      return [
        {
          id: rawID,
          name: item.name?.replace(/^models\//i, "").trim() || rawID,
          ...(Predicate.isNumber(context) && context > 0 ? { context } : {}),
          ...(Predicate.isNumber(output) && output > 0 ? { output } : {}),
        },
      ]
    })
    .toSorted((a, b) => a.id.localeCompare(b.id))
}

function deriveProviderName(baseURL: string): string {
  if (!URL.canParse(baseURL)) return "Custom API"
  const host = new URL(baseURL).hostname.replace(/^api\./i, "")
  return host || "Custom API"
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
  readonly action: "upsert" | "delete"
  readonly providerID?: string
  readonly name?: string
  readonly baseURL?: string
  readonly apiKey?: string
}) {
  const globalService = yield* Global.Service
  const fs = yield* FSUtil.Service
  const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
  const credential = yield* Credential.Service
  const bus = yield* Bus.Service

  const directory = AbsolutePath.make(globalService.config)
  const candidates = ConfigDiscovery.names.map((name) => path.join(directory, name))
  const existingFiles = yield* Effect.filter(candidates, fs.isFile)
  const filepath = existingFiles.at(-1) ?? path.join(directory, "opencode.json")
  const text = (yield* fs.readFileStringSafe(filepath)) ?? "{}\n"

  if (input.action === "delete") {
    const targetID = input.providerID?.trim()
    if (!targetID) return
    const allCreds = yield* credential.all()
    yield* Effect.forEach(
      allCreds.filter((item) => item.integrationID === targetID),
      (item) => credential.remove(item.id),
      { discard: true },
    )
    const parsed = parse(text)
    const clearModel =
      isRecord(parsed) && Predicate.isString(parsed.model) && parsed.model.startsWith(`${targetID}/`)
    const step1 = applyEdits(
      text,
      modify(text, ["provider", targetID], undefined, { formattingOptions: { tabSize: 2, insertSpaces: true } }),
    )
    const step2 = applyEdits(
      step1,
      modify(step1, ["providers", targetID], undefined, { formattingOptions: { tabSize: 2, insertSpaces: true } }),
    )
    const updated = clearModel
      ? applyEdits(
          step2,
          modify(step2, ["model"], undefined, { formattingOptions: { tabSize: 2, insertSpaces: true } }),
        )
      : step2
    yield* fs.writeWithDirs(filepath, updated.endsWith("\n") ? updated : `${updated}\n`)
    yield* bus.publish(Credential.Event.Updated, {})
    yield* Effect.sleep("120 millis")
    return
  }

  const baseURL = normalizeBaseURL(input.baseURL)
  if (!baseURL) return
  const name = input.name?.trim() || deriveProviderName(baseURL)
  const targetID = input.providerID?.trim() || deriveProviderID(name, baseURL)

  const parsed = parse(text)
  const existingProviders = isRecord(parsed)
    ? isRecord(parsed.provider)
      ? parsed.provider
      : isRecord(parsed.providers)
        ? parsed.providers
        : undefined
    : undefined
  const existingEntry = existingProviders && isRecord(existingProviders[targetID]) ? existingProviders[targetID] : undefined
  const existingOptions =
    existingEntry && isRecord(existingEntry.options)
      ? existingEntry.options
      : existingEntry && isRecord(existingEntry.settings)
        ? existingEntry.settings
        : undefined
  const existingKey = existingOptions && Predicate.isString(existingOptions.apiKey) ? existingOptions.apiKey : ""
  const effectiveApiKey = input.apiKey?.trim() || existingKey

  const existingModels =
    existingEntry && isRecord(existingEntry.models) ? existingEntry.models : {}

  const baseRequest = HttpClientRequest.get(`${baseURL}/models`).pipe(HttpClientRequest.acceptJson)
  const request = effectiveApiKey ? HttpClientRequest.bearerToken(baseRequest, effectiveApiKey) : baseRequest

  const discovered = yield* http
    .execute(request)
    .pipe(
      Effect.flatMap((response) => response.text),
      Effect.map(parseModels),
      Effect.timeout("10 seconds"),
      Effect.orElseSucceed((): readonly DiscoveredModel[] => []),
    )

  const modelsMap =
    discovered.length > 0
      ? Object.fromEntries(discovered.map((item) => [item.id, { name: item.name }]))
      : Object.keys(existingModels).length > 0
        ? existingModels
        : {
            "gpt-4o": { name: "gpt-4o" },
            "claude-sonnet-4-5": { name: "claude-sonnet-4-5" },
            "gemini-2.5-pro": { name: "gemini-2.5-pro" },
          }

  const rootKey =
    isRecord(parsed) && isRecord(parsed.providers) && !isRecord(parsed.provider) ? "providers" : "provider"

  const entry =
    rootKey === "providers"
      ? {
          package: "aisdk:@ai-sdk/openai-compatible",
          name,
          settings: {
            baseURL,
            apiKey: effectiveApiKey,
          },
          models: modelsMap,
        }
      : {
          npm: "@ai-sdk/openai-compatible",
          name,
          options: {
            baseURL,
            apiKey: effectiveApiKey,
          },
          models: modelsMap,
        }

  const updated = applyEdits(
    text,
    modify(text, [rootKey, targetID], entry, { formattingOptions: { tabSize: 2, insertSpaces: true } }),
  )
  yield* fs.writeWithDirs(filepath, updated.endsWith("\n") ? updated : `${updated}\n`)
  yield* bus.publish(Credential.Event.Updated, {})
  yield* Effect.sleep("120 millis")
})
