import { Component, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { Button } from "@opencode/ui/button"
import { Select } from "@opencode/ui/select"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform, type SelfUpdateState } from "@/runtime/platform/platform"
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
  const platform = usePlatform()
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

  const VersionSection = () => {
    const currentVer = () => (platform.version ?? "1.0.2").replace(/^v/i, "")
    const [updateState, setUpdateState] = createSignal<SelfUpdateState>({
      status: "idle",
      currentVersion: currentVer(),
    })

    const runCheck = () => {
      if (!platform.checkSelfUpdate) return
      void platform
        .checkSelfUpdate()
        .then((next) => setUpdateState(next))
        .catch(() => setUpdateState({ status: "offline", currentVersion: currentVer() }))
    }

    const runInstall = () => {
      if (!platform.installSelfUpdate) return
      void platform
        .installSelfUpdate()
        .then((next) => setUpdateState(next))
        .catch((err: unknown) =>
          setUpdateState({
            status: "error",
            currentVersion: currentVer(),
            message: err instanceof Error && err.message ? err.message : undefined,
          }),
        )
    }

    onMount(() => {
      if (!platform.getSelfUpdateState) return
      const unsub = platform.onSelfUpdateChanged?.((next) => setUpdateState(next))
      if (unsub) onCleanup(unsub)
      void platform
        .getSelfUpdateState()
        .then((initial) => {
          setUpdateState(initial)
          if (initial.status === "idle") runCheck()
        })
        .catch(() => runCheck())
    })

    const statusTitle = createMemo(() => {
      const state = updateState()

      if (state.status === "checking") {
        return language.tr("正在检测 GitHub 连接与新版本…", "Checking GitHub connectivity & updates…")
      }

      if (state.status === "offline") {
        return language.tr(
          "无法连接 GitHub 下载源，请检查网络或代理",
          "Cannot reach GitHub Releases, check network or proxy",
        )
      }

      if (state.status === "up-to-date") {
        return language.tr("网络正常 · 当前已是最新版本", "Network OK · Already up to date")
      }

      if (state.status === "available") {
        return language.tr(
          `网络正常 · 可更新至 v${state.latestVersion ?? ""}`,
          `Network OK · Update v${state.latestVersion ?? ""} available`,
        )
      }

      if (state.status === "downloading") {
        const pct = state.percent !== undefined ? ` ${state.percent}%` : ""

        return language.tr(
          `正在下载 v${state.latestVersion ?? ""} 安装包${pct}…`,
          `Downloading v${state.latestVersion ?? ""}${pct}…`,
        )
      }

      if (state.status === "installing") {
        return language.tr("下载校验完成，正在替换并自动重启…", "Verified, installing & restarting…")
      }

      if (state.status === "microsoft-store") {
        return language.tr("通过 Microsoft Store 自动更新", "Managed via Microsoft Store")
      }

      if (state.status === "error") {
        const reason = state.message ? `（${state.message}）` : ""

        return language.tr(`更新失败${reason}`, `Update failed${reason}`)
      }

      return language.tr("版本更新", "Software update")
    })

    return (
      <div class="settings-section">
        <h3 class="settings-section-title">{language.tr("版本", "Version")}</h3>
        <SettingsList>
          <SettingsRow title={language.tr("当前版本", "Current version")}>
            <span data-action="settings-current-version" class="text-13-regular text-v2-text-text-muted">
              v{currentVer()}
            </span>
          </SettingsRow>
          <Show when={platform.checkSelfUpdate}>
            <SettingsRow title={statusTitle()}>
              <div class="flex items-center gap-2">
                <Show when={updateState().status === "checking"}>
                  <Button size="small" variant="outline" disabled>
                    {language.tr("检测中…", "Checking…")}
                  </Button>
                </Show>
                <Show when={updateState().status === "offline" || updateState().status === "error"}>
                  <Button data-action="settings-recheck-update" size="small" variant="outline" onClick={runCheck}>
                    {language.tr("重新检测", "Retry")}
                  </Button>
                </Show>
                <Show when={updateState().status === "idle" || updateState().status === "up-to-date"}>
                  <Button data-action="settings-check-update" size="small" variant="outline" onClick={runCheck}>
                    {language.tr("检查更新", "Check for updates")}
                  </Button>
                </Show>
                <Show when={updateState().status === "available"}>
                  <Button size="small" variant="ghost-muted" onClick={runCheck}>
                    {language.tr("重测", "Recheck")}
                  </Button>
                  <Button data-action="settings-install-update" size="small" variant="contrast" onClick={runInstall}>
                    {language.tr("立即更新", "Update now")}
                  </Button>
                </Show>
                <Show when={updateState().status === "downloading"}>
                  <Button size="small" variant="outline" disabled>
                    {updateState().percent !== undefined
                      ? language.tr(`下载中 ${updateState().percent}%`, `Downloading ${updateState().percent}%`)
                      : language.tr("下载中…", "Downloading…")}
                  </Button>
                </Show>
                <Show when={updateState().status === "installing"}>
                  <Button size="small" variant="contrast" disabled>
                    {language.tr("重启更新中…", "Restarting…")}
                  </Button>
                </Show>
                <Show when={updateState().status === "microsoft-store"}>
                  <Button data-action="settings-open-ms-store" size="small" variant="outline" onClick={runInstall}>
                    {language.tr("打开商店", "Open Store")}
                  </Button>
                </Show>
              </div>
            </SettingsRow>
          </Show>
        </SettingsList>
      </div>
    )
  }

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
