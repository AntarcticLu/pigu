import { useDialog } from "@opencode/ui/context/dialog"
import { useFilteredList } from "@opencode/ui/hooks"
import { Icon } from "@opencode/ui/icon"
import { Switch } from "@opencode/ui/switch"
import { type Component, createMemo, createSignal, For, type JSX, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Schema } from "effect"
import { useLanguage } from "@/runtime/i18n/language"
import { Persistence } from "@/runtime/persistence/schema"
import { useGlobal } from "@/runtime/server/runtime"
import { ServerConnection } from "@/runtime/server/registry"
import { useModels } from "@/providers/models/models"
import { popularProviders } from "@/providers/catalog/providers"
import { DialogServer } from "@/servers/connect/dialog"
import { AddServerMenu } from "@/servers/registry/add-menu"
import { SettingsList } from "@/settings/list"
import { SettingsRow } from "@/settings/row"
import { ModelProtocolSelect } from "@/providers/models/protocol"
import { providerGroupKey } from "@/providers/models/select-dialog"
import { SettingsProviders } from "@/settings/providers/providers"
import { SettingsSearchField } from "@/settings/search-field"
import { SettingsServerDataScope } from "@/settings/server-scope"
import { settingsServerReachable, useSettingsServers, type SettingsServer } from "@/settings/servers/inventory"
import { ServerConnectionRow, ServerShell } from "@/settings/servers/servers"
import { useSettingsSurface } from "@/settings/surface"

import "@/settings/settings.css"

type ModelItem = ReturnType<ReturnType<typeof useModels>["list"]>[number]

export const ModelProvidersSchema = Schema.Struct({
  collapsed: Persistence.record(Persistence.fallback(Schema.Boolean, () => false)),
})

function DeviceProvidersSection(props: {
  server: ServerConnection.Any
  query: string
  deviceMatched: boolean
}) {
  const models = useModels()
  const effectiveFilter = createMemo(() => {
    const q = props.query.trim()

    if (!q) return ""

    const lower = q.toLowerCase()
    const anyModelOrProviderMatch = models
      .list()
      .filter((item) => item.provider.id !== "native-cli")
      .some(
        (item) =>
          item.name.toLowerCase().includes(lower) ||
          item.id.toLowerCase().includes(lower) ||
          item.provider.name.toLowerCase().includes(lower) ||
          item.provider.id.toLowerCase().includes(lower),
      )

    if (!anyModelOrProviderMatch && props.deviceMatched) return ""

    return q
  })

  const list = useFilteredList<ModelItem>({
    get filter() {
      return effectiveFilter()
    },
    items: (_filter) => models.list().filter((item) => item.provider.id !== "native-cli"),
    key: (x) => `${x.provider.id}:${x.id}`,
    filterKeys: ["provider.name", "name", "id"],
    sortBy: (a, b) => {
      if (a.provider.id === "local" && b.provider.id === "local") {
        const aIsDefault = !a.id.includes("/")
        const bIsDefault = !b.id.includes("/")

        if (aIsDefault && !bIsDefault) return -1

        if (!aIsDefault && bIsDefault) return 1

        return 0
      }

      return a.name.localeCompare(b.name)
    },
    groupBy: (x) => providerGroupKey(x),
    sortGroupsBy: (a, b) => {
      const aIndex = popularProviders.indexOf(a.category)
      const bIndex = popularProviders.indexOf(b.category)
      const aPopular = aIndex >= 0
      const bPopular = bIndex >= 0

      if (aPopular && !bPopular) return -1

      if (!aPopular && bPopular) return 1

      if (aPopular && bPopular) return aIndex - bIndex

      const aName = a.items[0].provider.name
      const bName = a.items[0] ? (b.items[0]?.provider.name ?? "") : ""

      return aName.localeCompare(bName)
    },
  })

  function ProviderModelsInline(inlineProps: { providerID: string }) {
    const items = () => list.grouped.latest.find((group) => group.category === inlineProps.providerID)?.items ?? []

    return (
      <Show when={items().length > 0}>
        <div data-component="provider-inline-models" class="border-t border-v2-border-border-muted/60 pl-4">
          <For each={items()}>
            {(item) => {
              const key = { providerID: item.provider.id, modelID: item.id }

              return (
                <SettingsRow title={item.name} description="">
                  <div class="flex items-center gap-2.5">
                    <Show when={item.provider.id !== "local"}>
                      <ModelProtocolSelect providerID={item.provider.id} modelID={item.id} />
                    </Show>
                    <Switch
                      checked={models.visible(key)}
                      onChange={(checked) => models.setVisibility(key, checked)}
                      hideLabel
                    >
                      {item.name}
                    </Switch>
                  </div>
                </SettingsRow>
              )
            }}
          </For>
        </div>
      </Show>
    )
  }

  return (
    <div class="flex flex-col gap-3">
      <SettingsProviders
        directory={undefined}
        embedded
        filter={effectiveFilter()}
        hasMatchingModels={(providerID) =>
          list.grouped.latest.some((group) => group.category === providerID && group.items.length > 0)
        }
        renderModels={(providerID) => <ProviderModelsInline providerID={providerID} />}
      />
      <div class="border-t border-v2-border-border-muted/50 pt-2">
        <SettingsList>
          <ServerShell server={props.server} />
        </SettingsList>
      </div>
    </div>
  )
}

export const SettingsModels: Component<{
  active?: boolean
  provider?: string
  onReveal?: () => void
  headerAction?: JSX.Element
}> = (props) => {
  const language = useLanguage()
  const dialog = useDialog()
  const global = useGlobal()
  const surface = useSettingsSurface()
  const inventory = useSettingsServers()

  const [query, setQuery] = createSignal("")
  const [expandedDevices, setExpandedDevices] = createStore<Record<string, boolean>>({})

  const selectServer = (server: ServerConnection.Any) => {
    const key = ServerConnection.key(server)
    surface.selectServer(key)
    setExpandedDevices(key, true)
  }

  const addServer = () => void dialog.push(() => <DialogServer mode="add" onSave={selectServer} />)

  const isReachable = (entry: SettingsServer) =>
    settingsServerReachable(entry, global.servers.health[entry.key]) && !!entry.connection

  const deviceMatches = (entry: SettingsServer) => {
    const q = query().trim().toLowerCase()

    if (!q) return true

    return entry.name.toLowerCase().includes(q) || entry.key.toLowerCase().includes(q)
  }

  const isDeviceExpanded = (entry: SettingsServer) =>
    Boolean(query().trim()) || Boolean(expandedDevices[entry.key])

  const toggleDevice = (key: string) => {
    setExpandedDevices(key, !expandedDevices[key])
  }

  return (
    <>
      <div class="settings-tab-header settings-tab-header--stacked">
        <div class="settings-tab-header-row">
          <div class="flex min-w-0 flex-col gap-0.5">
            <h2 class="settings-tab-title">{language.tr("模型", "Models")}</h2>
            <span class="text-11-regular text-v2-text-text-muted">
              {language.tr(
                "设备 → 供应商 → 模型（点击设备展开对应供应商，再点击供应商展开模型）",
                "Device → Provider → Model (click a device to expand its providers, then click a provider to expand models)",
              )}
            </span>
          </div>
          <div class="settings-tab-header-actions">
            <AddServerMenu onAddServer={addServer} />
          </div>
        </div>
        <SettingsSearchField
          value={query()}
          active={props.active ?? true}
          onInput={setQuery}
          placeholder={language.tr("搜索设备、供应商或模型...", "Search devices, providers, or models...")}
        />
      </div>

      <div class="settings-tab-body settings-models flex flex-col gap-3">
        <For each={inventory()}>
          {(entry) => (
            <section
              class="settings-section overflow-hidden rounded-lg border border-v2-border-border-base bg-v2-background-bg-surface/30"
              data-component="settings-device-model-group"
              aria-label={entry.name}
            >
              <div
                class="flex cursor-pointer select-none items-center gap-2 px-3 py-1.5 transition-colors hover:bg-v2-overlay-simple-overlay-hover/50"
                onClick={(event) => {
                  if (
                    event.target instanceof Element &&
                    event.target.closest(".settings-servers-actions, button, [role='button'], [role='menuitem']")
                  ) {
                    return
                  }
                  toggleDevice(entry.key)
                }}
              >
                <button
                  type="button"
                  data-action={`device-toggle-${entry.key}`}
                  aria-expanded={isDeviceExpanded(entry)}
                  class="flex size-6 shrink-0 items-center justify-center rounded text-v2-icon-icon-muted hover:text-v2-icon-icon-base focus-visible:outline-none"
                  onClick={() => toggleDevice(entry.key)}
                >
                  <Icon
                    name="chevron-down"
                    size="small"
                    class="shrink-0 transition-transform duration-150"
                    classList={{ "-rotate-90": !isDeviceExpanded(entry) }}
                  />
                </button>
                <div class="min-w-0 flex-1">
                  <ServerConnectionRow entry={entry} onServerChange={selectServer} />
                </div>
              </div>

              <Show when={isDeviceExpanded(entry)}>
                <div class="border-t border-v2-border-border-muted/60 bg-v2-background-bg-base/40 py-3 pe-3 ps-7">
                  <Show
                    when={isReachable(entry) ? entry.connection : undefined}
                    keyed
                    fallback={
                      <div class="py-3 text-12-regular text-v2-text-text-muted">
                        {language.tr(
                          "该设备当前未连接，请先在上方点击连接或检查 SSH 配置。",
                          "This device is currently disconnected. Please connect above or check your SSH configuration.",
                        )}
                      </div>
                    }
                  >
                    {(conn) => (
                      <SettingsServerDataScope server={conn}>
                        <DeviceProvidersSection
                          server={conn}
                          query={query()}
                          deviceMatched={deviceMatches(entry)}
                        />
                      </SettingsServerDataScope>
                    )}
                  </Show>
                </div>
              </Show>
            </section>
          )}
        </For>
      </div>
    </>
  )
}
