import { Logo } from "@opencode/ui/logo"
import { For } from "solid-js"
import "./wordmark.css"

const LETTERS = [
  {
    weak: "M18 30H6V18H18V30Z",
    fill: "var(--icon-base)",
    stem: "M6 30H18V12H6V30ZM24 36H6V42H0V6H24V36Z",
  },
  {
    weak: "M48 30H36V18H48V30Z",
    fill: "var(--icon-base)",
    stem: "M48 6H36V0H48V6ZM48 36H36V12H48V36Z",
  },
  {
    weak: "M78 24H66V18H78V24Z",
    fill: "var(--icon-strong-base)",
    stem: "M78 12H66V24H78V12ZM84 42H60V36H78V30H60V6H84V42Z",
  },
  {
    weak: "M108 30H96V18H108V30Z",
    fill: "var(--icon-strong-base)",
    stem: "M96 6V30H108V6H114V36H90V6H96Z",
  },
] as const

export type LodgerBall = {
  radius: () => number
  at: () => { x: number; y: number }
  place: (
    x: number,
    y: number,
    pose: { look: number; lookAngle: number; stretch: number; angle: number; squint: number; curl: number },
  ) => void
  blink: () => void
  done: () => void
}

export function NewSessionWordmark(props: {
  ref?: (element: HTMLDivElement) => void
  pins?: boolean
  sound?: () => boolean
  onOpen?: () => void
  onClose?: () => void
  onFlat?: () => void
  onPlay?: (ball: LodgerBall) => void
}) {
  return (
    <div
      data-component="new-session-wordmark"
      aria-hidden="true"
      class="pointer-events-none mx-auto w-full max-w-[720px] text-v2-background-bg-inverse"
    >
      <div
        ref={(el) => props.ref?.(el)}
        data-slot="wordmark-box"
        class="relative mx-auto aspect-[114/42] w-2/5 max-w-[260px]"
      >
        <div data-slot="wordmark-flat" class="absolute inset-0">
          <svg viewBox="0 0 114 42" fill="none" class="block size-full overflow-visible">
            <For each={LETTERS}>
              {(item) => (
                <g class="opacity-[0.16]">
                  <path d={item.weak} fill="var(--icon-weak-base)" />
                  <path d={item.stem} fill={item.fill} />
                </g>
              )}
            </For>
          </svg>
          <Logo class="wordmark-shimmer absolute inset-0 size-full" />
        </div>
      </div>
    </div>
  )
}
