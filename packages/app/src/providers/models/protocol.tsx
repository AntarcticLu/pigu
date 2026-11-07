import { Option, Schema } from "effect"
import { createSignal, For, type Component } from "solid-js"
import { tr } from "@/runtime/i18n/language"
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

export function detectModelProtocol(modelID: string): PiguProtocol {
  if (/gemini/i.test(modelID)) return "gemini"

  if (/claude/i.test(modelID)) return "anthropic"

  if (/codex/i.test(modelID)) return "openai-responses"

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
  selection?: ModelSelection
}> = (props) => {
  const variantKey = () => `${props.providerID}/${props.modelID}`
  const detected = () => detectModelProtocol(props.modelID)

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
