import { Component, Show, createMemo } from "solid-js"
import { Select } from "@opencode/ui/select"
import { useLanguage } from "@/runtime/i18n/language"
import { SettingsList } from "@/settings/list"
import { SettingsRow } from "@/settings/row"
import { createShellOptions } from "./behavior"
import {
  createAppearanceSettingsController,
  type ShellSettingsController,
} from "./controllers"
import "@/settings/settings.css"

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

const LanguageSetting = () => {
  const language = useLanguage()

  const options = createMemo(() =>
    language.locales.map((locale) => ({
      value: locale,
      label: language.label(locale),
    })),
  )

  return (
    <SettingsRow title={language.t("settings.general.row.language.title")}>
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

export const SettingsGeneral: Component = () => {
  const language = useLanguage()
  const appearance = createAppearanceSettingsController()

  const GeneralSection = () => (
    <div class="settings-section">
      <h3 class="settings-section-title">{language.t("settings.general.section.general")}</h3>
      <SettingsList>
        <LanguageSetting />
      </SettingsList>
    </div>
  )

  const AppearanceSection = () => (
    <div class="settings-section">
      <h3 class="settings-section-title">{language.t("settings.general.section.appearance")}</h3>
      <SettingsList>
        <SettingsRow title={language.t("settings.general.row.colorScheme.title")}>
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

        <SettingsRow title={language.t("settings.general.row.theme.title")}>
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

        <Show when={appearance.zoom.available()}>
          <SettingsRow title={language.t("settings.appearance.row.zoom.title")}>
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

  const VersionSection = () => (
    <div class="settings-section">
      <h3 class="settings-section-title">{language.tr("版本", "Version")}</h3>
      <SettingsList>
        <SettingsRow title={language.tr("当前版本", "Current version")}>
          <span data-action="settings-current-version" class="text-13-regular text-v2-text-text-muted">
            v0.0.1
          </span>
        </SettingsRow>
      </SettingsList>
    </div>
  )

  return (
    <>
      <div class="settings-tab-header">
        <div class="settings-tab-header-row">
          <div class="flex flex-col gap-1">
            <h2 class="settings-tab-title">{language.tr("通用与外观", "General & Appearance")}</h2>
          </div>
        </div>
      </div>
      <div class="settings-tab-body settings-tab-body--sectioned">
        <GeneralSection />
        <AppearanceSection />
        <VersionSection />
      </div>
    </>
  )
}
