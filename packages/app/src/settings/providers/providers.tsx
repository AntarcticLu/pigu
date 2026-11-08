import { Button } from "@opencode/ui/button"
import { Badge } from "@opencode/ui/badge"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Menu } from "@opencode/ui/menu"
import { TextField } from "@opencode/ui/text-field"
import { OpenCodeLogo } from "@/providers/opencode-logo"
import { showToast } from "@/shell/notifications/toast"
import { popularProviders, useProviders } from "@/providers/catalog/providers"
import { consoleProviderGroup } from "@/providers/catalog/console"
import { useIntegrations } from "@/providers/catalog/integrations"
import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onMount,
  untrack,
  type Component,
  For,
  type JSX,
  Show,
} from "solid-js"
import { createStore } from "solid-js/store"
import { Predicate } from "effect"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import { useData, useServer } from "@/runtime/server/current"
import { formatServerError } from "@/runtime/server/errors"
import { CONSOLE_INTEGRATION } from "@/providers/connect/controller"
import { DialogConnectProvider, useProviderConnectController } from "@/providers/connect/dialog"
import { ProviderModelIcon } from "@/providers/models/provider-group"
import { SettingsList } from "@/settings/list"
import {
  BUILTIN_LOCAL_AGENT_PLUGINS,
  localBaseEngineID,
  localEngineCanonicalIcon,
  localEngineDefaultLabel,
  useExtensionScopeStore,
} from "@/shell/titlebar/extension-scope-store"
import { activeProviderAccount, providerAccounts, type ProviderAccount } from "./accounts"
import { AccountNameInput } from "./account-name"
import { useProviderAccountActions } from "./account-actions"
import {
  connectedProviders,
  createProviderDisconnectState,
  transitionProviderDisconnect,
  type ProviderDisconnectEffect,
  type ProviderDisconnectEvent,
} from "./machine"
import "@/settings/settings.css"

type ProviderSource = "env" | "api" | "account" | "config" | "custom"

type ProviderItem = ReturnType<ReturnType<typeof useProviders>["connected"]>[number]

const PROVIDER_NOTES = [
  { match: (id: string) => id === "opencode", key: "dialog.provider.opencode.note" },
  { match: (id: string) => id === "opencode-go", key: "dialog.provider.opencodeGo.tagline" },
  { match: (id: string) => id === "anthropic", key: "dialog.provider.anthropic.note" },
  { match: (id: string) => id === "claude-agent", key: "dialog.provider.claudeAgent.note" },
  { match: (id: string) => id.startsWith("github-copilot"), key: "dialog.provider.copilot.note" },
  { match: (id: string) => id === "openai", key: "dialog.provider.openai.note" },
  { match: (id: string) => id === "google", key: "dialog.provider.google.note" },
  { match: (id: string) => id === "openrouter", key: "dialog.provider.openrouter.note" },
  { match: (id: string) => id === "vercel", key: "dialog.provider.vercel.note" },
] as const

export const SettingsProviders: Component<{
  directory: string | undefined
  onSelectProvider?: (providerID: string) => void
  headerAction?: JSX.Element
  embedded?: boolean
  filter?: string
  hasMatchingModels?: (providerID: string) => boolean
  renderModels?: (providerID: string) => JSX.Element
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const server = useServer()
  const serverSdk = useServerSDK()
  const data = useData()
  const providers = useProviders(() => props.directory)
  const integrations = useIntegrations(() => props.directory)
  const providerConnect = useProviderConnectController()
  const accountActions = useProviderAccountActions(() => props.directory)
  const scopeStore = useExtensionScopeStore()

  const [configuredMap, setConfiguredMap] = createSignal<
    Record<string, { name?: string; baseURL?: string; apiKey?: string }>
  >({})

  const refetchConfigured = async () => {
    const entries = await serverSdk.api.config.get().catch(() => [])
    const map: Record<string, { name?: string; baseURL?: string; apiKey?: string }> = {}
    entries.forEach((entry) => {
      if (entry.type !== "document" || !entry.info.providers) return
      Object.entries(entry.info.providers).forEach(([id, info]) => {
        const baseURL = Predicate.isString(info.settings?.baseURL) ? info.settings.baseURL : undefined
        const apiKey = Predicate.isString(info.settings?.apiKey) ? info.settings.apiKey : undefined
        map[id] = {
          name: info.name ?? map[id]?.name,
          baseURL: baseURL ?? map[id]?.baseURL,
          apiKey: apiKey ?? map[id]?.apiKey,
        }
      })
    })
    setConfiguredMap(map)
  }

  onMount(() => {
    void refetchConfigured()
  })

  const refreshProviderData = async () => {
    const loc = props.directory ? { directory: props.directory } : undefined
    data.location.provider.invalidate(loc)
    data.location.model.invalidate(loc)
    data.location.integration.invalidate(loc)
    await Promise.all([
      data.location.provider.sync(loc).catch(() => undefined),
      data.location.model.sync(loc).catch(() => undefined),
      data.location.integration.sync(loc).catch(() => undefined),
      refetchConfigured(),
    ])
  }

  const openManageProvider = (initial?: {
    providerID?: string
    name?: string
    baseURL?: string
    apiKey?: string
  }) => {
    const isEditing = !!initial?.providerID
    void dialog.show(() => {
      const [form, setForm] = createStore<{
        name: string
        baseURL: string
        apiKey: string
        saving: boolean
        error?: string
      }>({
        name: initial?.name ?? "",
        baseURL: initial?.baseURL ?? "",
        apiKey: initial?.apiKey ?? "",
        saving: false,
      })

      const submit = async (event: SubmitEvent) => {
        event.preventDefault()
        const cleanURL = form.baseURL.trim()
        const cleanKey = form.apiKey.trim()
        const cleanName = form.name.trim()

        if (!cleanURL) {
          setForm("error", language.tr("请输入 API 地址 (Base URL)", "Please enter API Base URL"))

          return
        }

        if (!cleanKey && !isEditing) {
          setForm("error", language.tr("请输入 API 密钥 (API Key)", "Please enter API Key"))

          return
        }

        setForm({ saving: true, error: undefined })

        try {
          await serverSdk.api.credential.create({
            integrationID: "pigu",
            label: cleanName || cleanURL,
            value: {
              type: "key",
              key: cleanKey,
              metadata: {
                piguAction: "upsert",
                ...(initial?.providerID ? { providerID: initial.providerID } : {}),
                ...(cleanName ? { name: cleanName } : {}),
                baseURL: cleanURL,
              },
            },
          })
          await refreshProviderData()
          dialog.close()
          showToast({
            variant: "success",
            icon: "circle-check",
            title: isEditing
              ? language.tr("已更新供应商", "Provider updated")
              : language.tr("已添加供应商", "Provider added"),
            description: cleanName || cleanURL,
          })
        } catch (error) {
          setForm({
            saving: false,
            error: error instanceof Error ? error.message : language.tr("保存供应商失败", "Failed to save provider"),
          })
        }
      }

      return (
        <Dialog containerClass="!w-[min(calc(100vw_-_16px),520px)] !rounded-[12px] !bg-v2-background-bg-base">
          <DialogHeader closeLabel={language.t("common.close")}>
            <DialogTitle>
              {isEditing
                ? `${language.tr("编辑供应商", "Edit Provider")} · ${initial?.name ?? initial?.providerID}`
                : language.tr("新增供应商 (API)", "Add Provider (API)")}
            </DialogTitle>
          </DialogHeader>
          <DialogBody class="px-5 pb-5 pt-2">
            <form data-component="provider-manage-form" class="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
              <div class="flex flex-col gap-1.5">
                <label class="text-[13px] font-[530] leading-5 text-v2-text-text-base">
                  {language.tr("供应商名称", "Provider Name")}
                </label>
                <TextField
                  data-input="manage-provider-name"
                  type="text"
                  placeholder={language.tr(
                    "例如：PiguToken / DeepSeek（留空自动根据域名命名）",
                    "e.g. PiguToken / DeepSeek (leave empty to name by domain)",
                  )}
                  value={form.name}
                  onChange={(value) => setForm({ name: value, error: undefined })}
                />
              </div>

              <div class="flex flex-col gap-1.5">
                <label class="text-[13px] font-[530] leading-5 text-v2-text-text-base">
                  {language.tr("API 地址 (URL)", "API Base URL")}
                </label>
                <TextField
                  data-input="manage-provider-url"
                  type="text"
                  placeholder="https://api.openai.com/v1"
                  value={form.baseURL}
                  onChange={(value) => setForm({ baseURL: value, error: undefined })}
                />
              </div>

              <div class="flex flex-col gap-1.5">
                <label class="text-[13px] font-[530] leading-5 text-v2-text-text-base">
                  {language.tr("API 密钥 (Key)", "API Key")}
                </label>
                <TextField
                  data-input="manage-provider-key"
                  type="text"
                  placeholder={
                    isEditing
                      ? language.tr("留空则保留原密钥，或输入新密钥 sk-...", "Leave empty to keep existing key, or enter new sk-...")
                      : "sk-..."
                  }
                  value={form.apiKey}
                  onChange={(value) => setForm({ apiKey: value, error: undefined })}
                />
              </div>

              <Show when={form.error}>
                {(err) => <div class="text-xs text-[var(--v2-state-fg-danger)]">{err()}</div>}
              </Show>

              <div class="flex items-center justify-end gap-2 pt-1">
                <Button type="button" variant="ghost-muted" onClick={() => dialog.close()}>
                  {language.tr("取消", "Cancel")}
                </Button>
                <Button type="submit" variant="contrast" disabled={form.saving}>
                  {form.saving
                    ? language.tr("正在保存并拉取模型...", "Saving and fetching models...")
                    : isEditing
                      ? language.tr("保存修改", "Save Changes")
                      : language.tr("保存并连接", "Save & Connect")}
                </Button>
              </div>
            </form>
          </DialogBody>
        </Dialog>
      )
    })
  }

  const deleteCustomProvider = async (item: ProviderItem) => {
    try {
      await serverSdk.api.credential.create({
        integrationID: "pigu",
        label: item.id,
        value: {
          type: "key",
          key: "__delete__",
          metadata: {
            piguAction: "delete",
            providerID: item.id,
          },
        },
      })

      if (canDisconnect(item)) {
        disconnect(item, item.name)
      }

      await refreshProviderData()
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.tr("已删除供应商", "Provider deleted"),
        description: item.name,
      })
    } catch (error) {
      showToast({
        variant: "error",
        title: language.tr("删除供应商失败", "Failed to delete provider"),
        description: error instanceof Error ? error.message : item.name,
      })
    }
  }

  const [state, setState] = createStore<{
    consoleExpanded: boolean
    collapsed: Record<string, boolean>
    refreshingID?: string
    credentialID?: string
    renaming?: string
    held?: ProviderItem[]
  }>({
    consoleExpanded: false,
    collapsed: {},
  })

  const refreshSingleProvider = async (item: ProviderItem) => {
    const cfg = configuredMap()[item.id]
    setState("refreshingID", item.id)
    await serverSdk.api.credential
      .create({
        integrationID: "pigu",
        label: item.name,
        value: {
          type: "key",
          key: cfg?.apiKey ?? "",
          metadata: {
            piguAction: "refresh",
            providerID: item.id,
            ...(cfg?.name ? { name: cfg.name } : {}),
            ...(cfg?.baseURL ? { baseURL: cfg.baseURL } : {}),
          },
        },
      })
      .catch(() => undefined)
    await refreshProviderData()
    setState("refreshingID", undefined)
    showToast({
      variant: "success",
      icon: "circle-check",
      title: language.tr(`已刷新 ${item.name} 的模型列表`, `Refreshed models for ${item.name}`),
    })
  }

  const [disconnects, setDisconnects] = createSignal(createProviderDisconnectState())

  const dispatch = (event: ProviderDisconnectEvent) => {
    const result = transitionProviderDisconnect(untrack(disconnects), event)
    setDisconnects(result.state)
    result.effects.forEach(run)
  }

  // Results that arrive after Settings closes still report through a toast, as the user asked for the change.
  const run = (effect: ProviderDisconnectEffect) => {
    if (effect.type === "disconnect.run") {
      void serverSdk.api.integration
        .get({
          integrationID: effect.integrationID,
          location: props.directory ? { directory: props.directory } : undefined,
        })
        .then(async (integration) => {
          const credentials = integration.data?.connections.filter((item) => item.type === "credential") ?? []

          if (credentials.length === 0) {
            dispatch({ type: "disconnect.failed", attempt: effect.attempt, reason: { kind: "no-credentials" } })

            return
          }

          await Promise.all(
            credentials.map((credential) => serverSdk.api.credential.remove({ credentialID: credential.id })),
          )
          dispatch({ type: "disconnect.succeeded", attempt: effect.attempt })
        })
        .catch((error) =>
          dispatch({ type: "disconnect.failed", attempt: effect.attempt, reason: { kind: "request", error } }),
        )

      return
    }

    if (effect.type === "toast.disconnected") {
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("provider.disconnect.toast.disconnected.title", { provider: effect.providerName }),
        description: language.t("provider.disconnect.toast.disconnected.description", {
          provider: effect.providerName,
        }),
      })

      return
    }

    showToast({
      title: language.t("common.requestFailed"),
      description:
        effect.reason.kind === "no-credentials"
          ? language.t("provider.disconnect.toast.noCredentials.description", { provider: effect.providerName })
          : language.tDynamic(
              "provider.disconnect.toast.failed.description",
              formatServerError(effect.reason.error, language.t),
              { provider: effect.providerName },
            ),
    })
  }

  // Console-managed providers (`opencode-go`, `console-*`) connect through the `opencode`
  // integration, so the lookup must follow `integrationID` rather than the provider id.
  const integration = (item: ProviderItem) => {
    const id = item.integrationID ?? item.id

    return integrations.list().find((entry) => entry.id === id)
  }

  const connect = (provider?: string) => {
    // The list stays as it was while the dialog connects, so a new sign-in that briefly drops the
    // Console workspace providers from the catalog can't flash rows behind the dialog.
    setState("held", available())
    providerConnect.select(provider)
    void dialog.show(
      () => (
        <DialogConnectProvider
          directory={props.directory}
          defaultLocation={props.directory === undefined}
          controller={providerConnect}
          onConnected={(providerID) => dispatch({ type: "provider.reconnected", providerID })}
        />
      ),
      () =>
        void accountActions
          .refresh()
          .catch(() => undefined)
          .finally(() => setState("held", undefined)),
    )
  }

  const localPluginOrder = BUILTIN_LOCAL_AGENT_PLUGINS.map((plugin) => plugin.id)

  const available = createMemo(() => {
    if (state.held) return state.held
    const connected = providers.connected()
    const managedConsole = consoleProviderGroup(connected)

    const consoleConnected = integrations
      .list()
      .find((item) => item.id === CONSOLE_INTEGRATION)
      ?.connections.some((connection) => connection.type === "credential" || connection.type === "env")

    return connected
      .filter(
        (provider) =>
          provider.id !== "native-cli" &&
          (provider.id !== "opencode" ||
            managedConsole !== undefined ||
            consoleConnected ||
            Object.values(provider.models).some((model) => model.cost.input > 0)),
      )
      .flatMap((provider): ProviderItem[] => {
        if (provider.id !== "local") return [provider]

        const byEngine = new Map<string, Record<string, ProviderItem["models"][string]>>()

        for (const [key, model] of Object.entries(provider.models)) {
          const base = localBaseEngineID(model.id)

          if (!scopeStore.isLocalAgentEnabled(base, props.directory)) continue
          const current = byEngine.get(base) ?? {}
          current[key] = model
          byEngine.set(base, current)
        }

        return Array.from(byEngine.entries()).map(([base, models]) => {
          const name = scopeStore.localAgentLabel(base, localEngineDefaultLabel(base))
          const canonical = localEngineCanonicalIcon(base)

          if (canonical) {
            return {
              ...provider,
              id: `local:${base}`,
              name,
              canonical,
              models,
            }
          }

          return {
            ...provider,
            id: `local:${base}`,
            name,
            models,
          }
        })
      })
      .toSorted((a, b) => {
        const isPigu = (id: string) => id === "pigutoken" || id === "pigu"

        if (isPigu(a.id) && !isPigu(b.id)) return -1

        if (!isPigu(a.id) && isPigu(b.id)) return 1

        const aLocal = localPluginOrder.indexOf(a.id)
        const bLocal = localPluginOrder.indexOf(b.id)

        if (aLocal >= 0 && bLocal >= 0) return aLocal - bLocal

        if (aLocal >= 0) return 1

        if (bLocal >= 0) return -1

        return Number(b.id === "opencode-go") - Number(a.id === "opencode-go")
      })
  })

  // Tells the machine which providers the server catalog lists, so a confirmed removal stops hiding a
  // provider once the server drops it and shows it again if it is later reconnected.
  createEffect(
    on(
      () => available().map((item) => item.id),
      (providerIDs) => dispatch({ type: "catalog.synced", providerIDs }),
    ),
  )

  const connected = createMemo(() => connectedProviders(disconnects(), available()))

  const consoleGroup = createMemo(() => consoleProviderGroup(available()))

  const displayed = createMemo(() => {
    const group = consoleGroup()

    const base = group
      ? (() => {
          const grouped = new Set(group.providers.filter((item) => item.id !== group.root.id).map((item) => item.id))

          return connected().filter((item) => !grouped.has(item.id))
        })()
      : connected()

    const query = props.filter?.trim().toLowerCase() ?? ""

    if (!query) return base

    return base.filter((item) => {
      const cfg = configuredMap()[item.id]

      const matchesMeta =
        item.name.toLowerCase().includes(query) ||
        item.id.toLowerCase().includes(query) ||
        (cfg?.baseURL?.toLowerCase().includes(query) ?? false)

      return matchesMeta || (props.hasMatchingModels?.(item.id) ?? false)
    })
  })

  const popular = createMemo(() => {
    const connectedIDs = new Set(connected().map((p) => p.id))
    // The Console account (integration `opencode`) shares its id with the Zen provider. A stored API
    // key, including one imported from a v1 auth.json, makes Zen "connected" without any account, so
    // the Popular list keeps the sign-in row until the active credential is an OAuth grant. Until the
    // integration list arrives the row is still the models.dev Zen provider, so dedupe it as before.
    const account = integrations.list().find((entry) => entry.id === CONSOLE_INTEGRATION)

    const items = providers
      .popular()
      .filter((p) => {
        if (p.id !== CONSOLE_INTEGRATION || !account) return !connectedIDs.has(p.id)

        return account.connections.find((connection) => connection.type === "credential")?.method !== "oauth"
      })
      .slice()

    items.sort((a, b) => popularProviders.indexOf(a.id) - popularProviders.indexOf(b.id))

    return items
  })

  // Connection state comes from the integration list like the TUI: credential
  // connections mean an API key or an account login, env connections mean detected
  // environment variables, and a connectionless integration is config-provided.
  const source = (item: ProviderItem): ProviderSource | undefined => {
    const current = integration(item)
    const credential = current?.connections.find((connection) => connection.type === "credential")

    if (credential) return credential.method === "key" ? "api" : "account"

    if (current?.connections.some((connection) => connection.type === "env")) return "env"

    if (current) return "config"

    if (!("source" in item)) return
    const value = item.source

    if (value === "env" || value === "api" || value === "config" || value === "custom") return value

    return
  }

  const type = (item: ProviderItem) => {
    if (item.id === "local" || item.id.startsWith("local:")) {
      return server.isLocal ? language.tr("本机 CLI", "Local CLI") : language.tr("远程 CLI", "Remote CLI")
    }

    const current = source(item)

    if (current === "env") return language.t("settings.providers.tag.environment")

    if (current === "api") return language.t("provider.connect.method.apiKey")

    if (current === "account") return language.t("settings.providers.tag.account")

    if (current === "config") return language.t("settings.providers.tag.config")

    if (current === "custom") return language.t("settings.providers.tag.custom")

    return language.t("settings.providers.tag.other")
  }

  const canDisconnect = (item: ProviderItem) => {
    const current = integration(item)

    if (current) return current.connections.some((connection) => connection.type === "credential")
    const currentSource = source(item)

    return currentSource !== "env" && currentSource !== "config"
  }

  const canManageAccounts = (item: ProviderItem) => providerAccounts(integration(item)).length > 0

  const note = (id: string) => PROVIDER_NOTES.find((item) => item.match(id))?.key

  const disconnect = (item: ProviderItem, name: string) => {
    const group = consoleGroup()
    dispatch({
      type: "disconnect.requested",
      providerIDs: group?.root.id === item.id ? group.providers.map((provider) => provider.id) : [item.id],
      integrationID: item.integrationID ?? item.id,
      providerName: name,
    })
  }

  const activate = async (provider: ProviderItem, providerName: string, account: ProviderAccount) => {
    if (activeProviderAccount(integration(provider))?.id === account.id) return
    setState({ credentialID: account.id, held: available() })
    await accountActions.activate({ integrationID: provider.integrationID ?? provider.id, provider: providerName, account })
    setState({ credentialID: undefined, held: undefined })
  }

  const remove = async (provider: ProviderItem, providerName: string, account: ProviderAccount) => {
    setState({ credentialID: account.id, held: available() })
    await accountActions.remove({
      integrationID: provider.integrationID ?? provider.id,
      provider: providerName,
      account,
      final: providerAccounts(integration(provider)).length === 1,
    })
    setState({ credentialID: undefined, held: undefined })
  }

  function AccountMenu(menuProps: { provider: ProviderItem; name?: string }) {
    const accounts = () => providerAccounts(integration(menuProps.provider))
    const active = () => activeProviderAccount(integration(menuProps.provider))
    const name = () => menuProps.name ?? menuProps.provider.name
    const renaming = () => accounts().find((account) => account.id === state.renaming)

    return (
      <Show
        when={renaming()}
        fallback={
          <AccountMenuTrigger provider={menuProps.provider} name={name()} accounts={accounts()} active={active()} />
        }
      >
        {(account) => (
          <AccountNameInput
            value={account().label}
            class="settings-provider-account-input"
            onSave={(label) => accountActions.rename(account(), label)}
            onClose={() => setState("renaming", undefined)}
          />
        )}
      </Show>
    )
  }

  function AccountMenuTrigger(menuProps: {
    provider: ProviderItem
    name: string
    accounts: ProviderAccount[]
    active: ProviderAccount | undefined
  }) {
    const accounts = () => menuProps.accounts
    const active = () => menuProps.active
    const name = () => menuProps.name

    return (
      <div class="settings-provider-account-actions">
        <Menu placement="bottom-end" gutter={6}>
          <Menu.Trigger
            as={Button}
            size="normal"
            variant="ghost-muted"
            class="settings-provider-account-trigger"
            aria-label={language.t("settings.providers.account.manage", { provider: name() })}
          >
            <span>{active()?.label}</span>
            <Icon name="chevron-down" size="small" />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Content class="settings-provider-account-menu" onEscapeKeyDown={(event) => event.stopPropagation()}>
              <Menu.Group>
                <Menu.GroupLabel>{language.t("settings.providers.account.group")}</Menu.GroupLabel>
                <Menu.RadioGroup
                  class="settings-provider-account-list"
                  value={active()?.id}
                  onChange={(credentialID) => {
                    const account = accounts().find((item) => item.id === credentialID)

                    if (account) void activate(menuProps.provider, name(), account)
                  }}
                >
                  <For each={accounts()}>
                    {(account) => (
                      <Menu.RadioItem value={account.id} closeOnSelect disabled={state.credentialID !== undefined}>
                        <span class="settings-provider-account-label">{account.label}</span>
                      </Menu.RadioItem>
                    )}
                  </For>
                </Menu.RadioGroup>
              </Menu.Group>
              <Menu.Separator />
              <Menu.Item disabled={state.credentialID !== undefined} onSelect={() => connect(menuProps.provider.id)}>
                <Icon name="plus" size="small" class="shrink-0" />
                {language.t("settings.providers.account.add")}
              </Menu.Item>
            </Menu.Content>
          </Menu.Portal>
        </Menu>
        <Menu placement="bottom-end" gutter={6}>
          <Menu.Trigger
            as={IconButton}
            variant="ghost-muted"
            size="large"
            icon={<Icon name="outline-dots" />}
            disabled={state.credentialID !== undefined || !active()}
            aria-label={language.t("dialog.provider.accounts.options", { account: active()?.label ?? "" })}
          />
          <Menu.Portal>
            <Menu.Content onCloseAutoFocus={(event) => state.renaming && event.preventDefault()}>
              <Menu.Item onSelect={() => setState("renaming", active()?.id)}>
                {language.t("common.rename")}
              </Menu.Item>
              <Menu.Item
                onSelect={() => {
                  const account = active()

                  if (account) void remove(menuProps.provider, name(), account)
                }}
              >
                {language.t("dialog.provider.accounts.remove")}
              </Menu.Item>
            </Menu.Content>
          </Menu.Portal>
        </Menu>
      </div>
    )
  }

  return (
    <>
      <Show when={!props.embedded}>
        <div class="settings-tab-header">
          <div class="settings-tab-header-row">
            <div class="flex min-w-0 flex-col gap-1">
              <h2 class="settings-tab-title">{language.t("settings.providers.title")}</h2>
              <span class="text-11-regular text-v2-text-text-muted">{language.t("settings.providers.description")}</span>
            </div>
            <div class="settings-tab-header-actions">{props.headerAction}</div>
          </div>
        </div>
      </Show>

      <div class={props.embedded ? "settings-providers mb-6" : "settings-tab-body settings-tab-body--sectioned settings-providers"}>
        <div class="settings-section" data-component="connected-providers-section">
          <div class="flex items-center justify-between">
            <h3 class="settings-section-title">{language.t("settings.providers.section.connected")}</h3>
            <Show when={props.embedded}>
              <Button
                size="small"
                variant="neutral"
                icon="plus"
                data-action="provider-add"
                onClick={() => openManageProvider()}
              >
                {language.tr("新增供应商", "Add Provider")}
              </Button>
            </Show>
          </div>
          <SettingsList variant="catalog">
            <Show
              when={displayed().length > 0}
              fallback={<div class="settings-provider-empty">{language.t("settings.providers.connected.empty")}</div>}
            >
              <For each={displayed()}>
                {(item) => {
                  const managedGroup = () => (consoleGroup()?.root.id === item.id ? consoleGroup() : undefined)
                  const cfg = () => configuredMap()[item.id]
                  const isExpanded = () =>
                    Boolean(props.filter?.trim()) || state.collapsed[item.id] === false

                  return (
                    <Show
                      when={managedGroup()}
                      fallback={
                        <div class="flex flex-col">
                          <div class="settings-provider-row group">
                            <button
                              type="button"
                              data-action={`provider-toggle-${item.id}`}
                              aria-expanded={isExpanded()}
                              class="settings-provider-lead cursor-pointer text-left focus-visible:outline-none"
                              onClick={() =>
                                setState(
                                  "collapsed",
                                  item.id,
                                  state.collapsed[item.id] === false,
                                )
                              }
                            >
                              <Show when={props.renderModels}>
                                <Icon
                                  name="chevron-down"
                                  size="small"
                                  class="shrink-0 text-v2-icon-icon-muted transition-transform"
                                  classList={{ "-rotate-90": !isExpanded() }}
                                />
                              </Show>
                              <ProviderModelIcon provider={item} class="settings-provider-icon shrink-0" />

                              <div class="settings-provider-main">
                                <span class="settings-provider-name truncate">
                                  {item.name}
                                </span>
                                <Badge>{type(item)}</Badge>
                                <span class="shrink-0 text-11-regular text-v2-text-text-faint">
                                  {language.tr(
                                    `${Object.keys(item.models).length} 个模型`,
                                    `${Object.keys(item.models).length} models`,
                                  )}
                                </span>
                                <Show when={cfg()?.baseURL}>
                                  {(url) => (
                                    <span class="truncate text-11-regular text-v2-text-text-muted">
                                      {url()}
                                    </span>
                                  )}
                                </Show>
                              </div>
                            </button>
                            <div class="flex items-center gap-1.5">
                              <Button
                                size="small"
                                variant="ghost-muted"
                                disabled={state.refreshingID === item.id}
                                data-action={`provider-refresh-${item.id}`}
                                onClick={() => void refreshSingleProvider(item)}
                              >
                                {state.refreshingID === item.id
                                  ? language.tr("刷新中...", "Refreshing...")
                                  : language.tr("刷新", "Refresh")}
                              </Button>
                              <Show when={item.id !== "local" && !item.id.startsWith("local:")}>
                                <Button
                                  size="small"
                                  variant="ghost-muted"
                                  data-action={`provider-edit-${item.id}`}
                                  onClick={() =>
                                    openManageProvider({
                                      providerID: item.id,
                                      name: cfg()?.name ?? item.name,
                                      baseURL: cfg()?.baseURL ?? "",
                                      apiKey: cfg()?.apiKey ?? "",
                                    })
                                  }
                                >
                                  {language.tr("编辑", "Edit")}
                                </Button>
                                <Button
                                  size="small"
                                  variant="ghost-muted"
                                  data-action={`provider-delete-${item.id}`}
                                  class="text-v2-text-text-muted hover:text-[var(--v2-state-fg-danger)]"
                                  onClick={() => void deleteCustomProvider(item)}
                                >
                                  {language.tr("删除", "Delete")}
                                </Button>
                              </Show>
                            </div>
                          </div>
                          <Show when={isExpanded()}>
                            {props.renderModels?.(item.id)}
                          </Show>
                        </div>
                      }
                    >
                      {(group) => (
                        <div class="settings-provider-console group">
                          <div class="settings-provider-console-header">
                            <div class="settings-provider-lead">
                              <OpenCodeLogo class="settings-provider-icon size-4 shrink-0" />
                              <div class="settings-provider-console-summary">
                                <div class="settings-provider-main">
                                  <span class="settings-provider-name truncate">
                                    {language.t("provider.connect.opencode.name")}
                                  </span>
                                  <Badge>{group().workspace}</Badge>
                                </div>
                                <Show when={group().providers.length > 1}>
                                  <button
                                    type="button"
                                    class="settings-provider-console-toggle"
                                    aria-expanded={state.consoleExpanded}
                                    onClick={() => setState("consoleExpanded", (value) => !value)}
                                  >
                                    <span>
                                      {language.plural(
                                        "settings.providers.console.available",
                                        group().providers.length,
                                        { count: group().providers.length },
                                      )}
                                    </span>
                                    <Icon
                                      name="chevron-right"
                                      size="small"
                                      classList={{
                                        "settings-provider-console-chevron": true,
                                        open: state.consoleExpanded,
                                      }}
                                    />
                                  </button>
                                </Show>
                              </div>
                            </div>
                            <Show
                              when={canManageAccounts(item)}
                              fallback={
                                <Button
                                  size="normal"
                                  variant="ghost-muted"
                                  onClick={() => disconnect(item, language.t("provider.connect.opencode.name"))}
                                >
                                  {language.t("common.disconnect")}
                                </Button>
                              }
                            >
                              <AccountMenu provider={item} name={language.t("provider.connect.opencode.name")} />
                            </Show>
                          </div>
                          <Show when={state.consoleExpanded}>
                            <div class="settings-provider-console-list">
                              <div class="settings-provider-console-separator" aria-hidden="true" />
                              <For each={group().providers}>
                                {(provider) => (
                                  <button
                                    type="button"
                                    class="settings-provider-console-item"
                                    onClick={() => props.onSelectProvider?.(provider.id)}
                                  >
                                    <span>{provider.name.slice(group().prefix.length)}</span>
                                    <Icon
                                      name="chevron-right"
                                      size="small"
                                      class="settings-provider-console-item-chevron"
                                    />
                                  </button>
                                )}
                              </For>
                            </div>
                          </Show>
                        </div>
                      )}
                    </Show>
                  )
                }}
              </For>
            </Show>
          </SettingsList>
        </div>

        <Show when={!props.embedded}>
          <div class="settings-section">
            <h3 class="settings-section-title">{language.t("settings.providers.section.popular")}</h3>
            <SettingsList variant="catalog">
              <For each={popular()}>
                {(item) => (
                  <div class="settings-provider-row">
                    <div class="settings-provider-lead">
                      <ProviderModelIcon provider={item} class="settings-provider-icon shrink-0" />

                      <div class="settings-provider-copy">
                        <div class="settings-provider-main">
                          <span class="settings-provider-name">
                            {item.name}
                          </span>
                          <Show when={item.id === "opencode" || item.id === "opencode-go"}>
                            <Badge>{language.t("dialog.provider.tag.recommended")}</Badge>
                          </Show>
                        </div>
                        <Show when={note(item.id)}>
                          {(key) => <p class="settings-provider-description">{language.t(key())}</p>}
                        </Show>
                      </div>
                    </div>
                    <Button size="normal" variant="neutral" icon="plus" onClick={() => connect(item.id)}>
                      {language.t("common.connect")}
                    </Button>
                  </div>
                )}
              </For>
            </SettingsList>

            <button type="button" class="settings-providers-view-all" onClick={() => connect()}>
              {language.t("dialog.provider.viewAll")}
            </button>
          </div>
        </Show>
      </div>
    </>
  )
}
