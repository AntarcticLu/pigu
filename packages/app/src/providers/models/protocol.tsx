import { Option, Predicate, Schema } from "effect"
import { createSignal, For, type Component } from "solid-js"
import { tr } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import { useData } from "@/runtime/server/current"
import type { ModelSelection } from "./selection"

export const PIGU_PROTOCOLS = ["openai-chat", "gemini", "anthropic", "openai-responses"] as const

export type PiguProtocol = (typeof PIGU_PROTOCOLS)[number]

export const PROTOCOL_OPTIONS: readonly {
  readonly id: PiguProtocol
  readonly label: string
  readonly short: string
}[] = [
  { id: "openai-chat", label: "OpenAI (/v1/chat/completions)", short: "OpenAI /v1" },
  { id: "gemini", label: "Gemini (/v1beta)", short: "Gemini /v1beta" },
  { id: "anthropic", label: "Anthropic (/v1/messages)", short: "Anthropic /v1" },
  { id: "openai-responses", label: "OpenAI Responses (/v1/responses)", short: "Responses /v1" },
]

type EndpointKind = "anthropic-native" | "gemini-native" | "openai-chat-only" | "openai-official" | "multi-protocol"

function detectEndpointKind(baseURL?: string): EndpointKind {
  const trimmed = (baseURL ?? "").trim().replace(/\/+$/, "")

  if (!trimmed) return "multi-protocol"
  const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(trimmed)
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `${isLocal ? "http" : "https"}://${trimmed}`

  if (!URL.canParse(withScheme)) return "multi-protocol"
  const parsed = new URL(withScheme)
  const host = parsed.hostname.toLowerCase()
  const pathname = parsed.pathname.replace(/\/+$/, "")

  if (host === "api.anthropic.com" || /\/anthropic(\/v1)?(\/messages)?$/i.test(pathname)) return "anthropic-native"

  if (host === "generativelanguage.googleapis.com") {
    return /\/openai(\/|$)/i.test(pathname) ? "openai-chat-only" : "gemini-native"
  }

  if (host === "api.openai.com") return "openai-official"

  if (
    host === "openrouter.ai" ||
    host.endsWith("siliconflow.cn") ||
    host.endsWith("siliconflow.com") ||
    (host.includes("dashscope") && host.endsWith("aliyuncs.com")) ||
    host === "open.bigmodel.cn" ||
    host === "api.z.ai" ||
    host.endsWith("volces.com") ||
    host === "api.deepseek.com" ||
    host.endsWith(".deepseek.com") ||
    host === "api.moonshot.cn" ||
    host === "api.moonshot.ai" ||
    host === "api.minimaxi.com" ||
    host === "api.minimax.io" ||
    host === "api.minimax.chat" ||
    host === "api.x.ai" ||
    host === "api.groq.com" ||
    host === "api.together.xyz" ||
    host === "api.together.ai" ||
    host === "api.fireworks.ai" ||
    host === "integrate.api.nvidia.com" ||
    host === "api.cerebras.ai" ||
    host === "api.mistral.ai" ||
    host === "qianfan.baidubce.com" ||
    host === "api.stepfun.com" ||
    host === "api.baichuan-ai.com" ||
    host === "api.lingyiwanwu.com" ||
    host === "models.inference.ai.azure.com" ||
    host === "models.github.ai"
  ) {
    return "openai-chat-only"
  }

  return "multi-protocol"
}

function isOpenAIResponsesModel(modelID: string): boolean {
  if (detectModelModality(modelID) !== "text") return false

  return /(^|\/)(gpt-([5-9]|\d{2,})|o[134](\b|-))/i.test(modelID) || /codex/i.test(modelID)
}

export function detectModelProtocol(modelID: string, baseURL?: string): PiguProtocol {
  const kind = detectEndpointKind(baseURL)

  if (kind === "anthropic-native") return "anthropic"

  if (kind === "gemini-native") return "gemini"

  if (kind === "openai-chat-only") return "openai-chat"

  if (kind === "openai-official") {
    return isOpenAIResponsesModel(modelID) ? "openai-responses" : "openai-chat"
  }

  if (modelID.includes("/") && !/^models\//i.test(modelID)) return "openai-chat"

  if (/gemini/i.test(modelID)) return "gemini"

  if (/claude/i.test(modelID)) return "anthropic"

  if (isOpenAIResponsesModel(modelID)) return "openai-responses"

  return "openai-chat"
}

export function isPiguProtocol(value: string | undefined): value is PiguProtocol {
  return value === "openai-chat" || value === "gemini" || value === "anthropic" || value === "openai-responses"
}

export function protocolShortLabel(protocol: PiguProtocol): string {
  return PROTOCOL_OPTIONS.find((item) => item.id === protocol)?.short ?? protocol
}

export function formatProtocolVariantLabel(variant: string, _modelID?: string): string {
  if (variant === "default") {
    return tr("默认", "Default")
  }

  if (isPiguProtocol(variant)) {
    return protocolShortLabel(variant)
  }

  return variant
}

const PROTOCOL_STORAGE_KEY = "pigu.model.protocol.v1"

const decodeSavedProtocols = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
)

function readSavedProtocols(): Record<string, PiguProtocol> {
  if (!("localStorage" in globalThis)) return {}
  const raw = globalThis.localStorage.getItem(PROTOCOL_STORAGE_KEY)

  if (!raw) return {}
  const parsed = Option.getOrUndefined(decodeSavedProtocols(raw))

  if (!parsed) return {}

  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, PiguProtocol] => isPiguProtocol(entry[1])),
  )
}

const [savedProtocols, setSavedProtocols] = createSignal<Record<string, PiguProtocol>>(readSavedProtocols())

export const ModelProtocolSelect: Component<{
  providerID: string
  modelID: string
  baseURL?: string
  selection?: ModelSelection
}> = (props) => {
  const serverSdk = useServerSDK()
  const data = useData()
  const variantKey = () => `${props.providerID}/${props.modelID}`

  const resolvedBaseURL = () => {
    if (props.baseURL) return props.baseURL
    const found = data.location.provider.list()?.find((item) => item.id === props.providerID)
    const raw = found?.settings?.baseURL

    if (Predicate.isString(raw) && raw) return raw

    if (props.providerID === "anthropic" || props.providerID.endsWith("-coding-plan")) {
      return "https://api.anthropic.com/v1"
    }

    if (props.providerID === "google") return "https://generativelanguage.googleapis.com/v1beta"

    if (props.providerID === "openai") return "https://api.openai.com/v1"

    if (
      props.providerID === "openrouter" ||
      props.providerID === "deepseek" ||
      props.providerID.startsWith("moonshot") ||
      props.providerID.startsWith("alibaba") ||
      props.providerID.startsWith("minimax") ||
      props.providerID.startsWith("zhipu") ||
      props.providerID === "zai" ||
      props.providerID.startsWith("siliconflow") ||
      props.providerID === "xai" ||
      props.providerID === "mistral" ||
      props.providerID === "groq" ||
      props.providerID === "togetherai"
    ) {
      return "https://openrouter.ai/api/v1"
    }

    return undefined
  }

  const detected = () => detectModelProtocol(props.modelID, resolvedBaseURL())

  const current = () => {
    const saved = savedProtocols()[variantKey()]

    return isPiguProtocol(saved) ? saved : "default"
  }

  const update = (next: string) => {
    const key = variantKey()
    const currentMap = { ...savedProtocols() }

    if (isPiguProtocol(next)) {
      currentMap[key] = next
    }

    if (!isPiguProtocol(next)) {
      delete currentMap[key]
    }

    setSavedProtocols(currentMap)

    if ("localStorage" in globalThis) {
      globalThis.localStorage.setItem(PROTOCOL_STORAGE_KEY, JSON.stringify(currentMap))
    }

    void serverSdk.api.credential
      .create({
        integrationID: "pigu",
        label: key,
        value: {
          type: "key",
          key: next,
          metadata: {
            piguAction: "set-model-protocol",
            providerID: props.providerID,
            modelID: props.modelID,
            protocol: next,
          },
        },
      })
      .then(() => {
        data.location.provider.invalidate()
        data.location.model.invalidate()
        return Promise.all([
          data.location.provider.sync().catch(() => undefined),
          data.location.model.sync().catch(() => undefined),
        ])
      })
      .catch(() => undefined)
  }

  return (
    <select
      data-component="model-protocol-select"
      aria-label={tr(`${props.modelID} 接口类型`, `${props.modelID} API protocol`)}
      title={tr("选择该模型的接口类型（自动识别或手动指定）", "Select API protocol for this model (auto-detect or manual override)")}
      value={current()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => update(event.currentTarget.value)}
      class="h-6 shrink-0 cursor-pointer rounded border border-v2-border-border-base bg-v2-background-bg-layer-02 px-1.5 text-[11px] font-[480] text-v2-text-text-muted hover:border-v2-border-border-hover hover:text-v2-text-text-base focus:outline-none"
    >
      <option value="default">{`${tr("自动", "Auto")} · ${protocolShortLabel(detected())}`}</option>
      <For each={PROTOCOL_OPTIONS}>{(opt) => <option value={opt.id}>{opt.label}</option>}</For>
    </select>
  )
}

export const PIGU_MODALITIES = ["text", "image", "video", "audio"] as const

export type PiguModality = (typeof PIGU_MODALITIES)[number]

export const MODALITY_OPTIONS: readonly {
  readonly id: PiguModality
  readonly zh: string
  readonly en: string
  readonly envVar: string
}[] = [
  { id: "text", zh: "文本", en: "Text", envVar: "PIGU_TEXT_MODEL" },
  { id: "image", zh: "图片", en: "Image", envVar: "PIGU_IMAGE_MODEL" },
  { id: "video", zh: "视频", en: "Video", envVar: "PIGU_VIDEO_MODEL" },
  { id: "audio", zh: "音频", en: "Audio", envVar: "PIGU_AUDIO_MODEL" },
]

export function isPiguModality(value: string | undefined): value is PiguModality {
  return value === "text" || value === "image" || value === "video" || value === "audio"
}

export function modalityLabel(modality: PiguModality): string {
  const found = MODALITY_OPTIONS.find((item) => item.id === modality)

  if (!found) return modality

  return tr(found.zh, found.en)
}

const VIDEO_MODEL_PATTERNS = [
  /(^|[-_/])(sora|veo|seedance|kling|hailuo|vidu|wan[-_]?2|luma|runway|pika|hunyuan[-_]?video|cogvideo|mochi)($|[-_/.0-9])/i,
  /grok-imagine.*video/i,
  /[-_/]t2v($|[-_/])|[-_/]i2v($|[-_/])|[-_/]video[-_]?gen/i,
]

const AUDIO_MODEL_PATTERNS = [
  /(^|[-_/])(whisper|tts|cosyvoice|fish[-_]?speech|elevenlabs|suno|udio|bark|kokoro|f5[-_]?tts|seed[-_]?tts|minimax[-_]?speech)($|[-_/.0-9])/i,
  /gpt-.*audio|gemini-.*tts|[-_/](asr|stt)($|[-_/.0-9])|[-_/]speech[-_/]/i,
]

const IMAGE_MODEL_PATTERNS = [
  /(^|[-_/])(dall[-_]?e|gpt-image|imagen|flux|midjourney|mj|ideogram|recraft|seedream|kolors|qwen[-_]?image|hunyuan[-_]?image|wanx|playground[-_]?v)($|[-_/.0-9])/i,
  /stable[-_]?diffusion|(^|[-_/])sdxl($|[-_/.0-9])|(^|[-_/])sd3($|[-_/.0-9])/i,
  /grok-imagine/i,
  /gemini-.*-image|banana/i,
]

export function detectModelModality(modelID: string): PiguModality {
  const id = modelID.trim()

  if (!id) return "text"

  if (VIDEO_MODEL_PATTERNS.some((pattern) => pattern.test(id))) return "video"

  if (AUDIO_MODEL_PATTERNS.some((pattern) => pattern.test(id))) return "audio"

  if (IMAGE_MODEL_PATTERNS.some((pattern) => pattern.test(id))) return "image"

  return "text"
}

const MODALITY_STORAGE_KEY = "pigu.model.modality.v1"
const MODALITY_DEFAULTS_STORAGE_KEY = "pigu.modality.defaults.v1"

const decodeSavedStringMap = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
)

function readSavedModalities(): Record<string, PiguModality> {
  if (!("localStorage" in globalThis)) return {}
  const raw = globalThis.localStorage.getItem(MODALITY_STORAGE_KEY)

  if (!raw) return {}
  const parsed = Option.getOrUndefined(decodeSavedStringMap(raw))

  if (!parsed) return {}

  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, PiguModality] => isPiguModality(entry[1])),
  )
}

function readSavedModalityDefaults(): Partial<Record<PiguModality, string>> {
  if (!("localStorage" in globalThis)) return {}
  const raw = globalThis.localStorage.getItem(MODALITY_DEFAULTS_STORAGE_KEY)

  if (!raw) return {}
  const parsed = Option.getOrUndefined(decodeSavedStringMap(raw))

  if (!parsed) return {}
  const out: Partial<Record<PiguModality, string>> = {}

  for (const modality of PIGU_MODALITIES) {
    const val = parsed[modality]

    if (typeof val === "string" && val.includes("/")) out[modality] = val
  }

  return out
}

const [savedModalities, setSavedModalities] = createSignal<Record<string, PiguModality>>(readSavedModalities())
const [savedModalityDefaults, setSavedModalityDefaults] =
  createSignal<Partial<Record<PiguModality, string>>>(readSavedModalityDefaults())

export function effectiveModelModality(providerID: string, modelID: string): PiguModality {
  if (providerID === "local" || providerID === "native-cli") return "text"
  const saved = savedModalities()[`${providerID}/${modelID}`]

  if (isPiguModality(saved)) return saved

  return detectModelModality(modelID)
}

export function rankModalityCandidate(modality: PiguModality, modelID: string): number {
  if (modality !== "image") return 0

  if (/^gpt-image-2$/i.test(modelID)) return 0

  if (/^gpt-image-2/i.test(modelID)) return 1

  if (/^gpt-image-/i.test(modelID)) return 2

  if (/gemini-.*-image/i.test(modelID)) return 3

  return 4
}

export function currentModalityDefaultKey(modality: PiguModality): string | undefined {
  return savedModalityDefaults()[modality]
}

export function saveModalityDefaultKey(
  serverSdk: ReturnType<typeof useServerSDK>,
  modality: PiguModality,
  value: string,
) {
  const nextMap = { ...savedModalityDefaults() }
  const slashIndex = value.indexOf("/")
  const providerID = slashIndex > 0 ? value.slice(0, slashIndex) : ""
  const modelID = slashIndex > 0 ? value.slice(slashIndex + 1) : ""

  if (providerID && modelID) nextMap[modality] = value

  if (!providerID || !modelID) delete nextMap[modality]

  setSavedModalityDefaults(nextMap)

  if ("localStorage" in globalThis) {
    globalThis.localStorage.setItem(MODALITY_DEFAULTS_STORAGE_KEY, JSON.stringify(nextMap))
  }

  void serverSdk.api.credential
    .create({
      integrationID: "pigu",
      label: `modality:${modality}`,
      value: {
        type: "key",
        key: value || "auto",
        metadata: {
          piguAction: "set-modality-default",
          modality,
          providerID,
          modelID,
        },
      },
    })
    .catch(() => undefined)
}

export const ModelModalitySelect: Component<{
  providerID: string
  modelID: string
}> = (props) => {
  const serverSdk = useServerSDK()
  const data = useData()
  const key = () => `${props.providerID}/${props.modelID}`
  const detected = () => detectModelModality(props.modelID)

  const current = () => {
    const saved = savedModalities()[key()]

    return isPiguModality(saved) ? saved : "default"
  }

  const update = (next: string) => {
    const targetKey = key()
    const currentMap = { ...savedModalities() }

    if (isPiguModality(next)) currentMap[targetKey] = next

    if (!isPiguModality(next)) delete currentMap[targetKey]

    setSavedModalities(currentMap)

    if ("localStorage" in globalThis) {
      globalThis.localStorage.setItem(MODALITY_STORAGE_KEY, JSON.stringify(currentMap))
    }

    void serverSdk.api.credential
      .create({
        integrationID: "pigu",
        label: targetKey,
        value: {
          type: "key",
          key: next,
          metadata: {
            piguAction: "set-model-modality",
            providerID: props.providerID,
            modelID: props.modelID,
            modality: next,
          },
        },
      })
      .then(() => {
        data.location.provider.invalidate()
        data.location.model.invalidate()
        return Promise.all([
          data.location.provider.sync().catch(() => undefined),
          data.location.model.sync().catch(() => undefined),
        ])
      })
      .catch(() => undefined)
  }

  return (
    <select
      data-component="model-modality-select"
      aria-label={tr(`${props.modelID} 模态分类`, `${props.modelID} modality`)}
      title={tr("设置模型模态分类（供主对话过滤与 Skill/MCP 统一路由）", "Set model modality (used for chat filtering and Skill/MCP routing)")}
      value={current()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => update(event.currentTarget.value)}
      class="h-6 shrink-0 cursor-pointer rounded border border-v2-border-border-base bg-v2-background-bg-layer-02 px-1.5 text-[11px] font-[480] text-v2-text-text-muted hover:border-v2-border-border-hover hover:text-v2-text-text-base focus:outline-none"
    >
      <option value="default">{`${tr("模态", "Modality")} · ${modalityLabel(detected())}`}</option>
      <For each={MODALITY_OPTIONS}>{(opt) => <option value={opt.id}>{tr(opt.zh, opt.en)}</option>}</For>
    </select>
  )
}
