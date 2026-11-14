export type CardHeaderColor = "blue" | "wathet" | "turquoise" | "green" | "yellow" | "orange" | "red" | "purple" | "grey"

export interface CardButton {
  readonly text: string
  readonly value: string
  readonly type?: "default" | "primary" | "danger"
}

export interface CardSelectOption {
  readonly text: string
  readonly value: string
}

export type CardElement =
  | { readonly kind: "markdown"; readonly content: string }
  | { readonly kind: "divider" }
  | { readonly kind: "note"; readonly text: string }
  | {
      readonly kind: "list_item"
      readonly text: string
      readonly btnText?: string
      readonly btnValue?: string
      readonly btnType?: "default" | "primary" | "danger"
    }
  | {
      readonly kind: "actions"
      readonly buttons: readonly CardButton[]
      readonly equalColumns?: boolean
    }
  | {
      readonly kind: "select"
      readonly label?: string
      readonly placeholder: string
      readonly initValue?: string
      readonly options: readonly CardSelectOption[]
    }
  | {
      readonly kind: "collapsible"
      readonly title: string
      readonly expanded?: boolean
      readonly content: string
    }

export interface MobileCard {
  readonly header?: {
    readonly title: string
    readonly color?: CardHeaderColor
  }
  readonly elements: readonly CardElement[]
}

export function flattenCollapsibleCard(card: MobileCard): MobileCard {
  const needsFlatten = card.elements.some((e) => e.kind === "collapsible" || e.kind === "actions")
  if (!needsFlatten) return card
  const flattened: CardElement[] = []
  for (const elem of card.elements) {
    if (elem.kind === "collapsible") {
      flattened.push({
        kind: "markdown",
        content: `**${elem.title.trim()}**\n${elem.content.trim()}`.trim(),
      })
      continue
    }
    if (elem.kind === "actions") {
      continue
    }
    flattened.push(elem)
  }
  return {
    ...card,
    elements: flattened,
  }
}

export function renderCardMarkdownFallback(card: MobileCard): string {
  const blocks: string[] = []
  if (card.header?.title) {
    blocks.push(`**${card.header.title}**`)
  }
  const listLines: string[] = []
  const flushList = () => {
    if (listLines.length > 0) {
      blocks.push(listLines.join("\n"))
      listLines.length = 0
    }
  }

  for (const elem of card.elements) {
    if (elem.kind === "list_item") {
      listLines.push(elem.text)
      continue
    }
    flushList()
    if (elem.kind === "markdown" && elem.content.trim()) {
      blocks.push(elem.content.trim())
    }
    if (elem.kind === "collapsible" && elem.content.trim()) {
      const stateHint = elem.expanded === false ? "（已折叠）" : ""
      blocks.push(`**${elem.title.trim()}**${stateHint}\n${elem.content.trim()}`)
    }
    if (elem.kind === "divider") {
      blocks.push("---")
    }
    if (elem.kind === "note" && elem.text.trim()) {
      blocks.push(`*${elem.text.trim()}*`)
    }
  }
  flushList()
  return blocks.join("\n\n").trim()
}

export function renderFeishuCardObject(card: MobileCard, sessionKey = ""): Record<string, unknown> {
  const hasCollapsible = card.elements.some((e) => e.kind === "collapsible")
  const hasActions = card.elements.some((e) => e.kind === "actions" && e.buttons.length > 0)
  if (!hasCollapsible && !hasActions) {
    const bodyOnly = renderCardMarkdownFallback(card.header ? { elements: card.elements } : card)
    return {
      config: { wide_screen_mode: true },
      ...(card.header?.title
        ? {
            header: {
              title: { tag: "plain_text", content: card.header.title },
              template: card.header.color ?? "blue",
            },
          }
        : {}),
      elements: [{ tag: "markdown", content: bodyOnly || " " }],
    }
  }

  if (!hasCollapsible && hasActions) {
    const v1Elements: Record<string, unknown>[] = []
    const pendingV1: CardElement[] = []
    const flushV1 = () => {
      if (pendingV1.length === 0) return
      const md = renderCardMarkdownFallback({ elements: pendingV1 })
      pendingV1.length = 0
      if (md) {
        v1Elements.push({ tag: "markdown", content: md })
      }
    }
    for (const elem of card.elements) {
      if (elem.kind === "actions") {
        flushV1()
        if (elem.buttons.length > 0) {
          v1Elements.push({
            tag: "action",
            actions: elem.buttons.map((btn) => ({
              tag: "button",
              text: { tag: "plain_text", content: btn.text },
              type: btn.type ?? "default",
              value: {
                action: btn.value,
                ...(sessionKey ? { session_key: sessionKey } : {}),
              },
            })),
          })
        }
        continue
      }
      if (elem.kind === "divider") {
        flushV1()
        v1Elements.push({ tag: "hr" })
        continue
      }
      pendingV1.push(elem)
    }
    flushV1()
    return {
      config: { wide_screen_mode: true },
      ...(card.header?.title
        ? {
            header: {
              title: { tag: "plain_text", content: card.header.title },
              template: card.header.color ?? "blue",
            },
          }
        : {}),
      elements: v1Elements.length > 0 ? v1Elements : [{ tag: "markdown", content: " " }],
    }
  }

  const feishuElements: Record<string, unknown>[] = []
  const pendingChunk: CardElement[] = []
  const flushPending = () => {
    if (pendingChunk.length === 0) return
    const md = renderCardMarkdownFallback({ elements: pendingChunk })
    pendingChunk.length = 0
    if (md) {
      feishuElements.push({ tag: "markdown", content: md })
    }
  }

  for (const elem of card.elements) {
    if (elem.kind === "collapsible") {
      flushPending()
      feishuElements.push({
        tag: "collapsible_panel",
        expanded: Boolean(elem.expanded),
        background_color: "grey",
        header: {
          title: {
            tag: "markdown",
            content: `**${elem.title.trim()}**`,
          },
          background_color: "grey",
          vertical_align: "center",
          padding: "4px 8px 4px 8px",
          icon: {
            tag: "standard_icon",
            token: "down-small-ccm_outlined",
            size: "16px 16px",
          },
          icon_position: "right",
          icon_expanded_angle: -180,
        },
        border: {
          color: "grey",
          corner_radius: "6px",
        },
        vertical_spacing: "6px",
        padding: "8px 10px 8px 10px",
        elements: [
          {
            tag: "markdown",
            content: elem.content.trim() || " ",
          },
        ],
      })
      continue
    }
    if (elem.kind === "divider") {
      flushPending()
      feishuElements.push({ tag: "hr" })
      continue
    }
    pendingChunk.push(elem)
  }
  flushPending()

  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    ...(card.header?.title
      ? {
          header: {
            title: { tag: "plain_text", content: card.header.title },
            template: card.header.color ?? "blue",
          },
        }
      : {}),
    body: {
      elements: feishuElements.length > 0 ? feishuElements : [{ tag: "markdown", content: " " }],
    },
  }
}

export function renderFeishuCardJson(card: MobileCard, sessionKey = ""): string {
  return JSON.stringify(renderFeishuCardObject(card, sessionKey))
}
