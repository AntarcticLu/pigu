import { useFilteredList } from "@opencode/ui/hooks"
import { Switch } from "@opencode/ui/switch"
import { type Component, For, type JSX, Show } from "solid-js"

import { Schema } from "effect"
import { Persistence } from "@/runtime/persistence/schema"
import { useModels } from "@/providers/models/models"
import { popularProviders } from "@/providers/catalog/providers"
import { SettingsRow } from "@/settings/row"
import { ModelProtocolSelect } from "@/providers/models/protocol"
import { SettingsProviders } from "@/settings/providers/providers"
import { SettingsSearchEmpty } from "@/settings/search-empty"
import { SettingsSearchField } from "@/settings/search-field"

import "@/settings/settings.css"

type ModelItem = ReturnType<ReturnType<typeof useModels>["list"]>[number]

export const ModelProvidersSchema = Schema.Struct({
  collapsed: Persistence.record(Persistence.fallback(Schema.Boolean, () => false)),
})

export const SettingsModels: Component<{
  active?: boolean
  provider?: string
  onReveal?: () => void
  headerAction?: JSX.Element
}> = (props) => {
  const models = useModels()

  const list = useFilteredList<ModelItem>({
    items: (_filter) => models.list().filter((item) => item.provider.id !== "native-cli"),
    key: (x) => `${x.provider.id}:${x.id}`,
    filterKeys: ["provider.name", "name", "id"],
    sortBy: (a, b) => a.name.localeCompare(b.name),
    groupBy: (x) => x.provider.id,
    sortGroupsBy: (a, b) => {
      const aIndex = popularProviders.indexOf(a.category)
      const bIndex = popularProviders.indexOf(b.category)
      const aPopular = aIndex >= 0
      const bPopular = bIndex >= 0

      if (aPopular && !bPopular) return -1

      if (!aPopular && bPopular) return 1

      if (aPopular && bPopular) return aIndex - bIndex

      const aName = a.items[0].provider.name
      const bName = b.items[0].provider.name

      return aName.localeCompare(bName)
    },
  })

  function ProviderModelsInline(inlineProps: { providerID: string }) {
    const items = () => list.grouped.latest.find((group) => group.category === inlineProps.providerID)?.items ?? []

    return (
      <Show when={items().length > 0}>
        <div data-component="provider-inline-models" class="border-t border-v2-border-border-muted/60">
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
    <>
      <div class="settings-tab-header settings-tab-header--stacked">
        <div class="settings-tab-header-row">
          <div class="flex min-w-0 items-center">
            <h2 class="settings-tab-title">模型</h2>
          </div>
          <div class="settings-tab-header-actions">{props.headerAction}</div>
        </div>
        <SettingsSearchField
          value={list.filter()}
          active={props.active ?? true}
          onInput={list.onInput}
          placeholder="搜索供应商或模型..."
        />
      </div>

      <div class="settings-tab-body settings-models">
        <SettingsProviders
          directory={undefined}
          embedded
          filter={list.filter()}
          hasMatchingModels={(providerID) =>
            list.grouped.latest.some((group) => group.category === providerID && group.items.length > 0)
          }
          renderModels={(providerID) => <ProviderModelsInline providerID={providerID} />}
        />
        <Show when={!list.grouped.loading && list.flat().length === 0 && list.filter().length > 0}>
          <div class="settings-tab-search-empty">
            <SettingsSearchEmpty query={list.filter()} />
          </div>
        </Show>
      </div>
    </>
  )
}
