import { Show, type Component, type JSX } from "solid-js"
import "@/settings/settings.css"

export interface SettingsRowProps {
  title: string | JSX.Element
  description?: string | JSX.Element
  children: JSX.Element
  align?: "start"
}

export const SettingsRow: Component<SettingsRowProps> = (props) => {
  return (
    <div data-component="settings-row" data-align={props.align}>
      <div data-slot="settings-row-copy">
        <div data-slot="settings-row-title">{props.title}</div>
        <Show when={props.description}>
          <div data-slot="settings-row-description">{props.description}</div>
        </Show>
      </div>
      <div data-slot="settings-row-control">{props.children}</div>
    </div>
  )
}
