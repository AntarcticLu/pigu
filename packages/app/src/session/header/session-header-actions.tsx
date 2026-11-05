import { Show } from "solid-js"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Keybind } from "@opencode/ui/keybind"
import { Tooltip } from "@opencode/ui/tooltip"
import { useCommand } from "@/shell/commands/command"
import { useLanguage } from "@/runtime/i18n/language"
import { useSessionLayout } from "@/session/session-layout"
import { useSettings } from "@/settings/model"

/** The review toggle's pane fill, scaled from the panel's edge to `open` of its width. */
export const reviewGlyphFill = (open: number) => `matrix(${open} 0 0 1 ${2.917 * (1 - open)} 0)`

export function SessionReviewToggle(props: { onToggle: () => void; glyph?: (fill: SVGPathElement) => void }) {
  const command = useCommand()
  const language = useLanguage()
  const settings = useSettings()
  const { view } = useSessionLayout()
  const enabled = () => settings.notifications.agent()

  return (
    <div class="flex items-center gap-1">
      <Tooltip
        class="shrink-0"
        placement="bottom"
        value={
          enabled()
            ? "会话通知：已开启（任务完成或需要关注时提醒，点击关闭）"
            : "会话通知：已关闭（点击开启任务完成或需要关注时的提醒）"
        }
      >
        <IconButton
          data-action="session-notification-bell"
          type="button"
          variant="ghost-muted"
          size="large"
          class={enabled() ? "shrink-0 !text-v2-text-text-base" : "shrink-0 opacity-45"}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => settings.notifications.setAgent(!enabled())}
          aria-label={enabled() ? "关闭会话通知" : "开启会话通知"}
          aria-pressed={enabled()}
          icon={
            <svg data-slot="icon-svg" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M8 2.25C5.92893 2.25 4.25 3.92893 4.25 6V9.25L2.75 11V11.75H13.25V11L11.75 9.25V6C11.75 3.92893 10.0711 2.25 8 2.25Z"
                fill={enabled() ? "currentColor" : "none"}
                stroke="currentColor"
                stroke-linejoin="round"
              />
              <path
                d="M6.5 12.25C6.68 13.1 7.28 13.75 8 13.75C8.72 13.75 9.32 13.1 9.5 12.25"
                stroke="currentColor"
                stroke-linecap="round"
              />
            </svg>
          }
        />
      </Tooltip>
      <SessionHeaderActions
        state={{
          reviewLabel: language.t("command.review.toggle"),
          reviewKeybind: command.keybindParts("review.toggle"),
          reviewVisible: true,
          reviewOpened: view().side.opened(),
          onReviewToggle: props.onToggle,
          reviewGlyph: props.glyph,
        }}
      />
    </div>
  )
}

export type SessionHeaderActionsState = {
  reviewLabel: string
  reviewKeybind: string[]
  reviewVisible: boolean
  reviewOpened: boolean
  onReviewToggle: () => void
  /** Draws the glyph's pane fill from a ref the caller scales as the panel moves; otherwise it follows the state. */
  reviewGlyph?: (fill: SVGPathElement) => void
}

export function SessionHeaderActions(props: { state: SessionHeaderActionsState }) {
  return (
    <div class="flex items-center gap-2">
      <Show when={props.state.reviewVisible}>
        <Tooltip
          class="shrink-0"
          placement="bottom"
          value={
            <>
              {props.state.reviewLabel}
              <Show when={props.state.reviewKeybind.length > 0}>
                <Keybind keys={props.state.reviewKeybind} variant="neutral" />
              </Show>
            </>
          }
        >
          <IconButton
            type="button"
            variant="ghost-muted"
            size="large"
            class="shrink-0"
            onMouseDown={(event) => event.preventDefault()}
            onClick={props.state.onReviewToggle}
            aria-label={props.state.reviewLabel}
            aria-expanded={props.state.reviewOpened}
            aria-controls="review-panel"
            icon={
              props.state.reviewGlyph ? (
                <svg data-slot="icon-svg" width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <g transform="matrix(-1 0 0 1 20 0)">
                    <path ref={props.state.reviewGlyph} d="M2.917 2.916H7.917V17.083H2.917Z" fill="currentColor" />
                    <path
                      d="M2.917 2.916H17.084V17.083H2.917ZM7.917 2.916V17.083"
                      stroke="currentColor"
                      stroke-linecap="square"
                    />
                  </g>
                </svg>
              ) : (
                <Icon name={props.state.reviewOpened ? "layout-right-full" : "layout-right"} />
              )
            }
          />
        </Tooltip>
      </Show>
    </div>
  )
}
