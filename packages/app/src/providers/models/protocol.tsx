import { For, type Component } from "solid-js"
import { useGlobal } from "@/runtime/server/runtime"
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

export function formatProtocolVariantLabel(variant: string, modelID?: string): string {
  if (variant === "default") {
    const detected = detectModelProtocol(modelID ?? "")

    return `自动 (${protocolShortLabel(detected)})`
  }

  if (isPiguProtocol(variant)) {
    return protocolShortLabel(variant)
  }

  return variant
}

export const ModelProtocolSelect: Component<{
  providerID: string
  modelID: string
  selection?: ModelSelection
}> = (props) => {
  const models = useGlobal().models
  const variantKey = () => `${props.providerID}/${props.modelID}`
  const detected = () => detectModelProtocol(props.modelID)

  const current = () => {
    const saved = models.store.variant?.[variantKey()]

    return isPiguProtocol(saved) ? saved : "default"
  }

  const update = (next: string) => {
    const key = variantKey()
    const value = isPiguProtocol(next) ? next : "default"

    if (!models.store.variant) {
      models.set("variant", { [key]: value })
    }

    if (models.store.variant) {
      models.set("variant", key, value)
    }

    const active = props.selection?.current()

    if (active && active.provider.id === props.providerID && active.id === props.modelID) {
      props.selection?.variant.set(value === "default" ? undefined : value)
    }
  }

  return (
    <select
      data-component="model-protocol-select"
      aria-label={`${props.modelID} 接口类型`}
      title="选择该模型的接口类型（自动识别或手动指定）"
      value={current()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => update(event.currentTarget.value)}
      class="h-6 shrink-0 cursor-pointer rounded border border-v2-border-border-base bg-v2-background-bg-layer-02 px-1.5 text-[11px] font-[480] text-v2-text-text-muted hover:border-v2-border-border-hover hover:text-v2-text-text-base focus:outline-none"
    >
      <option value="default">{`自动 · ${protocolShortLabel(detected())}`}</option>
      <For each={PROTOCOL_OPTIONS}>{(opt) => <option value={opt.id}>{opt.label}</option>}</For>
    </select>
  )
}
