import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { TextInput } from "@opencode/ui/text-input"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import { useGlobal } from "@/runtime/server/runtime"
import { useModels } from "@/providers/models/models"
import {
  MODALITY_OPTIONS,
  ModelModalitySelect,
  type PiguModality,
  currentModalityDefaultKey,
  effectiveModelModality,
  rankModalityCandidate,
  saveModalityDefaultKey,
} from "@/providers/models/protocol"
import { SettingsServerDataScope } from "@/settings/server-scope"
import { settingsServerReachable, useSettingsServers, type SettingsServer } from "@/settings/servers/inventory"

const NON_TEXT_MODALITIES = MODALITY_OPTIONS.filter((opt) => opt.id !== "text")

function MultimodalManagerBody() {
  const language = useLanguage()
  const serverSdk = useServerSDK()
  const models = useModels()

  const [activeTab, setActiveTab] = createSignal<"all" | Exclude<PiguModality, "text">>("all")
  const [showReclassify, setShowReclassify] = createSignal(false)
  const [reclassifyQuery, setReclassifyQuery] = createSignal("")

  const cloudItems = createMemo(() =>
    models.list().filter((item) => item.provider.id !== "local" && item.provider.id !== "native-cli"),
  )

  const nonTextItems = createMemo(() =>
    cloudItems().filter((item) => effectiveModelModality(item.provider.id, item.id) !== "text"),
  )

  const filteredNonTextItems = createMemo(() => {
    const tab = activeTab()

    if (tab === "all") return nonTextItems()

    return nonTextItems().filter((item) => effectiveModelModality(item.provider.id, item.id) === tab)
  })

  const candidatesFor = (modality: PiguModality) =>
    cloudItems()
      .filter((item) => effectiveModelModality(item.provider.id, item.id) === modality)
      .toSorted((a, b) => rankModalityCandidate(modality, a.id) - rankModalityCandidate(modality, b.id))

  createEffect(() => {
    if (currentModalityDefaultKey("image")) return
    const preferred = candidatesFor("image").find((item) => /^gpt-image-2$/i.test(item.id))

    if (!preferred) return
    saveModalityDefaultKey(serverSdk, "image", `${preferred.provider.id}/${preferred.id}`)
  })

  const textCandidatesForReclassify = createMemo(() => {
    const q = reclassifyQuery().trim().toLowerCase()
    const base = cloudItems().filter((item) => effectiveModelModality(item.provider.id, item.id) === "text")

    if (!q) return base.slice(0, 20)

    return base
      .filter(
        (item) =>
          item.name.toLowerCase().includes(q) ||
          item.id.toLowerCase().includes(q) ||
          item.provider.name.toLowerCase().includes(q),
      )
      .slice(0, 30)
  })

  return (
    <div class="flex flex-col gap-4">
      <div class="rounded-lg border border-v2-border-border-muted/70 bg-v2-background-bg-layer-02/40 p-3">
        <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
          <span class="text-12-medium text-v2-text-text-base">
            {language.tr(
              "默认多模态模型（供 Skill / MCP / 插件调用）",
              "Default Multimodal Models (for Skills, MCPs & Plugins)",
            )}
          </span>
          <span class="rounded bg-v2-overlay-simple-overlay-hover px-1.5 py-0.5 font-mono text-[10px] text-v2-text-text-muted">
            PIGU_MULTIMODAL_CONFIG
          </span>
        </div>
        <div class="flex flex-col gap-2">
          <For each={NON_TEXT_MODALITIES}>
            {(opt) => {
              const candidates = createMemo(() => candidatesFor(opt.id))
              const autoCandidate = () => candidates()[0]
              const selectedKey = () => currentModalityDefaultKey(opt.id) ?? ""

              return (
                <div class="flex items-center justify-between gap-3 rounded border border-v2-border-border-muted/50 bg-v2-background-bg-layer-01 px-2.5 py-2">
                  <div class="min-w-0">
                    <div class="text-12-medium text-v2-text-text-base">{language.tr(opt.zh, opt.en)}</div>
                    <div class="truncate font-mono text-[10px] text-v2-text-text-faint">{opt.envVar}</div>
                  </div>
                  <select
                    data-component={`modality-default-${opt.id}`}
                    aria-label={language.tr(`默认${opt.zh}模型`, `Default ${opt.en} model`)}
                    value={selectedKey()}
                    onChange={(event) => saveModalityDefaultKey(serverSdk, opt.id, event.currentTarget.value)}
                    class="h-7 max-w-[280px] shrink-0 cursor-pointer truncate rounded border border-v2-border-border-base bg-v2-background-bg-layer-02 px-2 text-[12px] text-v2-text-text-base focus:outline-none"
                  >
                    <option value="">
                      {autoCandidate()
                        ? `${language.tr("自动", "Auto")} · ${autoCandidate()!.provider.name} / ${autoCandidate()!.name}`
                        : language.tr("暂未识别到对应模型", "No model detected")}
                    </option>
                    <For each={candidates()}>
                      {(candidate) => (
                        <option value={`${candidate.provider.id}/${candidate.id}`}>
                          {`${candidate.provider.name} / ${candidate.name}`}
                        </option>
                      )}
                    </For>
                  </select>
                </div>
              )
            }}
          </For>
        </div>
      </div>

      <div class="flex flex-col gap-2">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="text-12-medium text-v2-text-text-base">
            {language.tr("已识别的非文本模型", "Non-text Models")} ({nonTextItems().length})
          </span>
          <div class="flex flex-wrap items-center gap-1">
            <For
              each={[
                { id: "all" as const, zh: "全部", en: "All", count: () => nonTextItems().length },
                ...NON_TEXT_MODALITIES.map((opt) => ({
                  id: opt.id as Exclude<PiguModality, "text">,
                  zh: opt.zh,
                  en: opt.en,
                  count: () => candidatesFor(opt.id).length,
                })),
              ]}
            >
              {(tab) => {
                const active = () => activeTab() === tab.id

                return (
                  <button
                    type="button"
                    data-action={`multimodal-tab-${tab.id}`}
                    onClick={() => setActiveTab(tab.id)}
                    class={`h-6 cursor-pointer rounded px-2 text-11-medium transition-colors focus:outline-none ${
                      active()
                        ? "bg-v2-text-text-base text-v2-background-bg-layer-01"
                        : "bg-v2-background-bg-layer-02 text-v2-text-text-muted hover:text-v2-text-text-base"
                    }`}
                  >
                    {language.tr(tab.zh, tab.en)} ({tab.count()})
                  </button>
                )
              }}
            </For>
          </div>
        </div>

        <Show
          when={filteredNonTextItems().length > 0}
          fallback={
            <div class="rounded-lg border border-dashed border-v2-border-border-muted px-3 py-5 text-center text-12-regular text-v2-text-text-muted">
              {language.tr(
                "当前分类下暂无非文本模型。若自定义命名的多模态模型未自动识别，可在下方从文本模型手动归入。",
                "No non-text models in this category. Reclassify custom-named models from text models below.",
              )}
            </div>
          }
        >
          <div class="max-h-60 divide-y divide-v2-border-border-muted/40 overflow-y-auto rounded-lg border border-v2-border-border-muted/70 px-3">
            <For each={filteredNonTextItems()}>
              {(item) => (
                <div class="flex min-h-9 items-center justify-between gap-3 py-1.5">
                  <div class="min-w-0">
                    <div class="truncate text-[13px] text-v2-text-text-base">{item.name}</div>
                    <div class="truncate text-[11px] text-v2-text-text-faint">{item.provider.name}</div>
                  </div>
                  <div class="flex shrink-0 items-center">
                    <ModelModalitySelect providerID={item.provider.id} modelID={item.id} />
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>

        <div class="pt-0.5">
          <button
            type="button"
            onClick={() => setShowReclassify((v) => !v)}
            class="flex items-center gap-1 text-12-regular text-v2-text-text-muted hover:text-v2-text-text-base focus:outline-none"
          >
            <Icon
              name="chevron-down"
              size="small"
              class="shrink-0 transition-transform duration-150"
              classList={{ "-rotate-90": !showReclassify() }}
            />
            <span>
              {language.tr(
                "自定义模型未识别？从文本模型中手动归入多模态",
                "Custom model not detected? Reclassify from text models",
              )}
            </span>
          </button>

          <Show when={showReclassify()}>
            <div class="mt-2 flex flex-col gap-2 rounded-lg border border-v2-border-border-muted/60 bg-v2-background-bg-layer-02/30 p-2.5">
              <TextInput
                type="text"
                appearance="base"
                value={reclassifyQuery()}
                placeholder={language.tr("搜索要修改模态归属的模型名称...", "Search text models to reclassify...")}
                onInput={(event) => setReclassifyQuery(event.currentTarget.value)}
              />
              <div class="max-h-40 divide-y divide-v2-border-border-muted/30 overflow-y-auto px-1">
                <For each={textCandidatesForReclassify()}>
                  {(item) => (
                    <div class="flex min-h-8 items-center justify-between gap-2 py-1">
                      <span class="min-w-0 truncate text-[12px] text-v2-text-text-base">
                        {`${item.provider.name} / ${item.name}`}
                      </span>
                      <ModelModalitySelect providerID={item.provider.id} modelID={item.id} />
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Show>
        </div>
      </div>
    </div>
  )
}

export function DialogMultimodalModels(props: { initialServerKey?: string }) {
  const language = useLanguage()
  const global = useGlobal()
  const inventory = useSettingsServers()

  const reachableEntries = createMemo(() =>
    inventory().filter(
      (entry: SettingsServer) => settingsServerReachable(entry, global.servers.health[entry.key]) && !!entry.connection,
    ),
  )

  const [selectedKey, setSelectedKey] = createSignal(props.initialServerKey ?? "")
  const currentEntry = createMemo(
    () => reachableEntries().find((item) => item.key === selectedKey()) ?? reachableEntries()[0],
  )

  return (
    <Dialog fit containerClass="!w-[min(94vw,580px)] !rounded-[12px]">
      <DialogHeader>
        <DialogTitleGroup
          title={language.tr("高级（多模态）", "Advanced (Multimodal)")}
          description={language.tr(
            "选择供 Skill、MCP 与插件调用的默认图片、视频、音频模型；具体生成或编辑接口由各拓展自行调用。",
            "Select default image, video, and audio models for Skills, MCPs, and Plugins.",
          )}
        />
      </DialogHeader>
      <DialogBody class="max-h-[80vh] overflow-y-auto px-4 pb-4 pt-0">
        <Show when={reachableEntries().length > 1}>
          <div class="mb-3 flex items-center justify-between gap-2">
            <span class="text-12-regular text-v2-text-text-muted">{language.tr("目标设备", "Target device")}</span>
            <select
              value={currentEntry()?.key ?? ""}
              onChange={(event) => setSelectedKey(event.currentTarget.value)}
              class="h-7 cursor-pointer rounded border border-v2-border-border-base bg-v2-background-bg-layer-02 px-2 text-[12px] text-v2-text-text-base focus:outline-none"
            >
              <For each={reachableEntries()}>{(entry) => <option value={entry.key}>{entry.name}</option>}</For>
            </select>
          </div>
        </Show>

        <Show
          when={currentEntry()?.connection}
          keyed
          fallback={
            <div class="py-8 text-center text-13-regular text-v2-text-text-muted">
              {language.tr("当前没有已连接的设备。", "No connected device available.")}
            </div>
          }
        >
          {(conn) => (
            <SettingsServerDataScope server={conn}>
              <MultimodalManagerBody />
            </SettingsServerDataScope>
          )}
        </Show>
      </DialogBody>
    </Dialog>
  )
}
