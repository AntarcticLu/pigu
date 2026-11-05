import { Component, Show, createMemo } from "solid-js"
import { Select } from "@opencode/ui/select"
import { Switch } from "@opencode/ui/switch"
import { TextInput } from "@opencode/ui/text-input"
import { useLanguage } from "@/runtime/i18n/language"
import { PluginSettingsSections } from "@/runtime/plugin/settings-page-view"
import { type FollowUpBehavior, useSettings } from "@/settings/model"
import { formatKeybind } from "@/shell/commands/command"
import { SettingsList } from "@/settings/list"
import { SettingsRow } from "@/settings/row"
import { createShellOptions } from "./behavior"
import {
  createAppearanceSettingsController,
  type AppearanceSettingsController,
  type ShellSettingsController,
} from "./controllers"
import { InterfaceModeSetting } from "./interface-mode"
import "@/settings/settings.css"

const AutoApprovePermissionsSetting: Component = () => {
  const language = useLanguage()
  const settings = useSettings()

  return (
    <SettingsRow
      title={language.t("command.permissions.autoaccept.enable")}
      description={language.t("settings.permissions.autoAccept.default.description")}
    >
      <div data-action="settings-auto-accept-permissions">
        <Switch
          checked={settings.permissions.autoApproveDefault()}
          onChange={(checked) => settings.permissions.setAutoApproveDefault(checked)}
        />
      </div>
    </SettingsRow>
  )
}

export const ShellSetting: Component<{
  controller: ShellSettingsController
  /** Search reveals the row with the default action; the Servers page names the other servers' rows apart. */
  action?: string
}> = (props) => {
  const language = useLanguage()

  const options = createMemo(() =>
    createShellOptions({
      shells: props.controller.shells(),
      current: props.controller.current(),
    }),
  )

  return (
    <SettingsRow
      title={language.t("settings.general.row.shell.title")}
      description={language.t("settings.general.row.shell.description")}
    >
      <Select
        data-action={props.action ?? "settings-shell"}
        options={options()}
        current={options().find((option) => option.value === props.controller.current()) ?? options()[0]}
        placement="bottom-end"
        gutter={6}
        value={(option) => option.id}
        label={(option) => {
          if (option.id === "auto") return language.t("settings.general.row.shell.autoDefault")

          if (!option.terminalOnly) return option.name

          return `${option.name} (${language.t("settings.general.row.shell.terminalOnly")})`
        }}
        onSelect={(option) => option && props.controller.select(option.value)}
      />
    </SettingsRow>
  )
}

const FollowUpBehaviorSetting: Component = () => {
  const language = useLanguage()
  const settings = useSettings()

  const options = createMemo((): { value: FollowUpBehavior; label: string }[] => [
    { value: "queue", label: language.t("settings.general.row.followUpBehavior.queue") },
    { value: "steer", label: language.t("settings.general.row.followUpBehavior.steer") },
  ])

  return (
    <SettingsRow
      title={language.t("settings.general.row.followUpBehavior.title")}
      description={language.t("settings.general.row.followUpBehavior.description", {
        keybind: formatKeybind("mod+enter", language.t),
      })}
    >
      <Select
        data-action="settings-follow-up-behavior"
        options={options()}
        current={options().find((option) => option.value === settings.general.followUpBehavior())}
        value={(option) => option.value}
        label={(option) => option.label}
        placement="bottom-end"
        gutter={6}
        onSelect={(option) => option && settings.general.setFollowUpBehavior(option.value)}
      />
    </SettingsRow>
  )
}

const LanguageSetting = () => {
  const language = useLanguage()

  const options = createMemo(() =>
    language.locales.map((locale) => ({
      value: locale,
      label: language.label(locale),
    })),
  )

  return (
    <SettingsRow
      title={language.t("settings.general.row.language.title")}
      description={language.t("settings.general.row.language.description")}
    >
      <Select
        data-action="settings-language"
        options={options()}
        placement="bottom-end"
        gutter={6}
        current={options().find((option) => option.value === language.locale())}
        value={(option) => option.value}
        label={(option) => option.label}
        onSelect={(option) => option && language.setLocale(option.value)}
      />
    </SettingsRow>
  )
}

const schemeOptions: ("system" | "light" | "dark")[] = ["system", "light", "dark"]

const fontSettings = {
  ui: {
    action: "settings-ui-font",
    title: "settings.general.row.uiFont.title",
    description: "settings.general.row.uiFont.description",
    font: "ui",
    input: "setUI",
  },
  code: {
    action: "settings-code-font",
    title: "settings.general.row.font.title",
    description: "settings.general.row.font.description",
    font: "code",
    input: "setCode",
  },
  terminal: {
    action: "settings-terminal-font",
    title: "settings.general.row.terminalFont.title",
    description: "settings.general.row.terminalFont.description",
    font: "terminal",
    input: "setTerminal",
  },
} as const

const FontSetting: Component<{
  kind: "ui" | "code" | "terminal"
  fonts: AppearanceSettingsController["fonts"]
}> = (props) => {
  const language = useLanguage()
  const config = () => fontSettings[props.kind]

  return (
    <SettingsRow title={language.t(config().title)} description={language.t(config().description)}>
      <div class="w-full sm:w-[220px]">
        <TextInput
          data-action={config().action}
          type="text"
          appearance="base"
          value={props.fonts[config().font]().value}
          onInput={(event) => props.fonts[config().input](event.currentTarget.value)}
          placeholder={props.fonts[config().font]().placeholder}
          spellcheck={false}
          autocorrect="off"
          autocomplete="off"
          autocapitalize="off"
          aria-label={language.t(config().title)}
          style={{ "font-family": props.fonts[config().font]().family }}
        />
      </div>
    </SettingsRow>
  )
}

export const SettingsGeneral: Component = () => {
  const language = useLanguage()
  const settings = useSettings()
  const appearance = createAppearanceSettingsController()

  const GeneralSection = () => (
    <div class="settings-section">
      <h3 class="settings-section-title">{language.t("settings.general.section.general")}</h3>
      <SettingsList>
        <InterfaceModeSetting />
        <LanguageSetting />
        <AutoApprovePermissionsSetting />
        <FollowUpBehaviorSetting />

        <SettingsRow
          title={language.t("settings.timeline.row.turnDiffs.title")}
          description={language.t("settings.timeline.row.turnDiffs.description")}
        >
          <div data-action="settings-show-turn-diffs">
            <Switch
              checked={settings.general.showTurnDiffs()}
              onChange={(checked) => settings.general.setShowTurnDiffs(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.notifications.agent.title")}
          description={language.t("settings.general.notifications.agent.description")}
        >
          <div data-action="settings-notifications-agent">
            <Switch
              checked={settings.notifications.agent()}
              onChange={(checked) => settings.notifications.setAgent(checked)}
            />
          </div>
        </SettingsRow>

        <PluginSettingsSections page="general" section="general" />
      </SettingsList>
    </div>
  )

  const AppearanceSection = () => (
    <div class="settings-section">
      <h3 class="settings-section-title">{language.t("settings.general.section.appearance")}</h3>
      <SettingsList>
        <SettingsRow
          title={language.t("settings.general.row.colorScheme.title")}
          description={language.t("settings.general.row.colorScheme.description")}
        >
          <Select
            data-action="settings-color-scheme"
            options={schemeOptions}
            current={schemeOptions.find((option) => option === appearance.scheme.current())}
            placement="bottom-end"
            gutter={6}
            label={(option) => {
              if (option === "system") return language.t("theme.scheme.system")

              if (option === "light") return language.t("theme.scheme.light")

              return language.t("theme.scheme.dark")
            }}
            onSelect={(option) => option && appearance.scheme.select(option)}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.theme.title")}
          description={language.t("settings.general.row.theme.description")}
        >
          <Select
            data-action="settings-theme"
            options={appearance.theme.options()}
            current={appearance.theme.current()}
            placement="bottom-end"
            gutter={6}
            value={(option) => option.id}
            label={(option) => option.name}
            onSelect={appearance.theme.select}
          />
        </SettingsRow>

        <FontSetting kind="code" fonts={appearance.fonts} />
        <FontSetting kind="terminal" fonts={appearance.fonts} />
        <FontSetting kind="ui" fonts={appearance.fonts} />

        <Show when={appearance.zoom.available()}>
          <SettingsRow
            title={language.t("settings.appearance.row.zoom.title")}
            description={language.t("settings.appearance.row.zoom.description")}
          >
            <Select
              data-action="settings-zoom"
              options={appearance.zoom.options}
              current={appearance.zoom.current()}
              placement="bottom-end"
              gutter={6}
              value={(level) => String(level)}
              label={appearance.zoom.label}
              onSelect={(level) => level && appearance.zoom.select(level)}
            />
          </SettingsRow>
        </Show>
      </SettingsList>
    </div>
  )

  return (
    <>
      <div class="settings-tab-header">
        <div class="settings-tab-header-row">
          <div class="flex flex-col gap-1">
            <h2 class="settings-tab-title">通用与外观</h2>
            <span class="text-11-regular text-v2-text-text-muted">
              配置语言、权限、终端、主题配色与代码字体
            </span>
          </div>
        </div>
      </div>
      <div class="settings-tab-body settings-tab-body--sectioned">
        <GeneralSection />
        <AppearanceSection />
        <PluginSettingsSections page="general" />
      </div>
    </>
  )
}
