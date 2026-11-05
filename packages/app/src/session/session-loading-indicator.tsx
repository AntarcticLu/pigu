import { createSignal, onCleanup, onMount } from "solid-js"
import { TextShimmer } from "@opencode/ui/text-shimmer"
import "./session-loading-indicator.css"

export function SessionLoadingIndicator(props: {
  label?: string
  subtitle?: string
  initialProgress?: number
}) {
  const [progress, setProgress] = createSignal(props.initialProgress ?? 22)

  onMount(() => {
    const first = setTimeout(() => setProgress((prev) => Math.max(prev, 52)), 120)
    const second = setTimeout(() => setProgress((prev) => Math.max(prev, 76)), 320)
    const third = setTimeout(() => setProgress((prev) => Math.max(prev, 90)), 680)
    const fourth = setTimeout(() => setProgress((prev) => Math.max(prev, 95)), 1200)

    onCleanup(() => {
      clearTimeout(first)
      clearTimeout(second)
      clearTimeout(third)
      clearTimeout(fourth)
    })
  })

  return (
    <div
      data-component="session-loading-indicator"
      role="status"
      aria-live="polite"
      class="relative flex min-h-0 flex-1 flex-col overflow-hidden select-none"
    >
      <div class="relative h-[2px] w-full shrink-0 overflow-hidden bg-v2-border-border-subtle/50">
        <div
          class="h-full bg-v2-icon-icon-base/80 transition-[width] duration-300 ease-out"
          style={{ width: `${progress()}%` }}
        />
        <div
          data-slot="top-progress-sweep"
          class="pointer-events-none absolute inset-y-0 left-0 bg-gradient-to-r from-transparent via-v2-text-text-strong/60 to-transparent"
        />
      </div>

      <div class="relative flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-10">
        <div
          aria-hidden="true"
          class="pointer-events-none mx-auto flex w-full max-w-session flex-col gap-6 opacity-35"
        >
          <div class="flex flex-col items-end gap-2">
            <div
              data-slot="skeleton-block"
              class="h-9 w-56 rounded-2xl border border-v2-border-border-subtle bg-v2-surface-surface-secondary/60"
            />
          </div>
          <div class="flex flex-col gap-2.5">
            <div
              data-slot="skeleton-block"
              class="h-3.5 w-36 rounded-md bg-v2-surface-surface-secondary/70"
            />
            <div
              data-slot="skeleton-block"
              class="h-3 w-full max-w-lg rounded-md bg-v2-surface-surface-secondary/50"
            />
            <div
              data-slot="skeleton-block"
              class="h-3 w-4/5 max-w-md rounded-md bg-v2-surface-surface-secondary/40"
            />
          </div>
        </div>

        <div class="mt-6 flex w-full max-w-[320px] flex-col gap-2.5 rounded-xl border border-v2-border-border-subtle bg-v2-surface-surface-primary/95 px-4 py-3.5 shadow-sm backdrop-blur-sm">
          <div class="flex items-center justify-between gap-3">
            <div class="flex min-w-0 items-center gap-2 text-[13px] font-medium leading-[var(--line-height-compact)] text-v2-text-text-base">
              <span class="size-2 shrink-0 rounded-full bg-v2-icon-icon-base animate-pulse" />
              <TextShimmer text={props.label ?? "正在加载会话内容..."} active />
            </div>
            <span class="shrink-0 font-mono text-[11px] tabular-nums text-v2-text-text-muted">
              {progress()}%
            </span>
          </div>

          <div class="relative h-1.5 w-full overflow-hidden rounded-full bg-v2-surface-surface-secondary">
            <div
              class="h-full rounded-full bg-v2-icon-icon-base transition-[width] duration-300 ease-out"
              style={{ width: `${progress()}%` }}
            />
            <div
              data-slot="card-progress-sweep"
              class="pointer-events-none absolute inset-y-0 left-0 bg-gradient-to-r from-transparent via-white/35 to-transparent"
            />
          </div>

          <div class="text-[11px] leading-relaxed text-v2-text-text-muted">
            {props.subtitle ?? "内容较多时首次同步与排版可能需要片刻，请稍候..."}
          </div>
        </div>
      </div>
    </div>
  )
}
