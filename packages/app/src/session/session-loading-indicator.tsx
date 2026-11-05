import { Loader } from "@opencode/ui/loader"

export function SessionLoadingIndicator() {
  return (
    <div
      data-component="session-loading-indicator"
      role="status"
      aria-label="Loading"
      aria-live="polite"
      class="flex min-h-0 flex-1 items-center justify-center select-none"
    >
      <Loader width={32} height={32} class="text-v2-icon-icon-base" />
    </div>
  )
}
