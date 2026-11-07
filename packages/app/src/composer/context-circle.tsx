import { createMemo } from "solid-js"
import { useParams } from "@solidjs/router"
import { lastAssistantWithUsage } from "@opencode/client/solid"
import { ProgressCircle } from "@opencode/ui/progress-circle"
import { Tooltip } from "@opencode/ui/tooltip"
import { tr } from "@/runtime/i18n/language"
import { useData } from "@/runtime/server/current"
import type { ComposerModel } from "./model"

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

export function ComposerContextCircle(props: { model: ComposerModel }) {
  const params = useParams<{ id?: string }>()
  const data = useData()

  const sessionID = () => params.id

  const info = createMemo(() => {
    const id = sessionID()

    return id ? data.session.get(id) : undefined
  })

  const messages = createMemo(() => {
    const id = sessionID()

    return id ? data.session.message.list(id) : []
  })

  const context = createMemo(() => {
    const message = lastAssistantWithUsage(messages(), info()?.revert?.messageID)

    if (!message) {
      return { total: 0, usage: 0 }
    }

    const total =
      message.tokens.input +
      message.tokens.output +
      message.tokens.reasoning +
      message.tokens.cache.read +
      message.tokens.cache.write

    const directory = info()?.location.directory
    const catalog = data.location.model.list(directory ? { directory } : undefined)

    const matched =
      catalog?.find((item) => item.providerID === message.model.providerID && item.id === message.model.id) ??
      props.model.model.selection.current()

    const limit = matched?.limit.context ?? 0
    const usage = limit > 0 ? Math.min(100, Math.round((total / limit) * 100)) : 0

    return { total, usage }
  })

  const tokensLabel = createMemo(() => context().total.toLocaleString("zh-CN"))

  const costLabel = createMemo(() => {
    const id = sessionID()
    const spent = id ? data.session.cost(id) : 0

    return usd.format(spent)
  })

  return (
    <Tooltip
      placement="top"
      value={
        <div class="flex min-w-[140px] flex-col gap-1 py-0.5 text-[12px]">
          <div class="flex items-center justify-between gap-4">
            <span class="opacity-75">{tr("上下文", "Context")}</span>
            <span class="font-mono tabular-nums">
              {tokensLabel()} ({context().usage}%)
            </span>
          </div>
          <div class="flex items-center justify-between gap-4">
            <span class="opacity-75">{tr("金额", "Cost")}</span>
            <span class="font-mono tabular-nums">{costLabel()}</span>
          </div>
        </div>
      }
    >
      <div
        data-slot="composer-context-circle"
        class="flex size-7 shrink-0 cursor-default items-center justify-center rounded-md text-v2-text-text-faint transition-colors hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base"
        aria-label={tr(
          `上下文 ${tokensLabel()} (${context().usage}%) · 金额 ${costLabel()}`,
          `Context ${tokensLabel()} (${context().usage}%) · Cost ${costLabel()}`,
        )}
      >
        <ProgressCircle appearance="compact" size={16} percentage={context().usage} />
      </div>
    </Tooltip>
  )
}
