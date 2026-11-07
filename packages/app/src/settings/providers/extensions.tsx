import { Predicate } from "effect"
import { Component, For, Show, createEffect, createMemo, createResource, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useDialog } from "@opencode/ui/context/dialog"
import { Icon } from "@opencode/ui/icon"
import { Button } from "@opencode/ui/button"
import { Switch } from "@opencode/ui/switch"
import { Tabs } from "@opencode/ui/tabs"
import { TextInput } from "@opencode/ui/text-input"
import { TruncatedText } from "@opencode/ui/truncated-text"
import { pluginLabel } from "@/providers/catalog/plugin"
import { useLanguage } from "@/runtime/i18n/language"
import { useData } from "@/runtime/server/current"
import { useServerSDK } from "@/runtime/server/client"
import { ServerConnection } from "@/runtime/server/registry"
import { useMcpToggle } from "@/providers/connect/mcp"
import { DialogMcp } from "@/providers/connect/mcp-dialog"
import { builtins } from "@/runtime/plugin/builtins"
import { usePluginHost } from "@/runtime/plugin/host"
import { usePlatform } from "@/runtime/platform/platform"
import { SettingsList } from "@/settings/list"
import type { SettingsView } from "@/settings/surface"
import { showToast } from "@/shell/notifications/toast"
import {
  BUILTIN_LOCAL_AGENT_PLUGINS,
  localizeSkillDescription,
  resolveSkillOrigin,
  skillScopeKey,
  stripLegacyLocalPluginSuffix,
  useExtensionScopeStore,
  type ScopedSkillInfo,
} from "@/shell/titlebar/extension-scope-store"
import "@/settings/settings.css"
import "@/shell/search-list.css"

const statusLabels = {
  connected: "mcp.status.connected",
  failed: "mcp.status.failed",
  needs_auth: "mcp.status.needs_auth",
  disabled: "mcp.status.disabled",
} as const

type McpDisplayRow = {
  name: string
  status: "connected" | "failed" | "needs_auth" | "disabled" | "pending"
  integrationID?: string
  type: "local" | "remote"
  command: string
  url: string
  custom: boolean
}

type PluginDisplayRow = {
  id: string
  name: string
  target: string
  description: string
  enabled: boolean
  custom: boolean
}

export const SettingsExtensions: Component<{
  directory?: string
  subtab?: SettingsView["subtab"]
  onSubtab: (value: SettingsView["subtab"]) => void
  headerAction?: JSX.Element
}> = (props) => {
  const language = useLanguage()
  const serverSdk = useServerSDK()
  const data = useData()
  const dialog = useDialog()
  const platform = usePlatform()
  const host = usePluginHost()
  const scopeStore = useExtensionScopeStore()
  const location = () => (props.directory ? { directory: props.directory } : data.location.default())
  const toggleMcp = useMcpToggle(() => props.directory)

  const [mcpForm, setMcpForm] = createStore<{
    open: boolean
    editingName: string
    name: string
    type: "local" | "remote"
    command: string
    url: string
    query: string
    saving: boolean
  }>({
    open: false,
    editingName: "",
    name: "",
    type: "local",
    command: "",
    url: "",
    query: "",
    saving: false,
  })

  const [pluginForm, setPluginForm] = createStore({
    open: false,
    editingID: "",
    name: "",
    target: "",
    description: "",
    query: "",
  })

  const [skillForm, setSkillForm] = createStore({
    open: false,
    editingKey: "",
    name: "",
    description: "",
    content: "",
    query: "",
  })

  createEffect(() => {
    if (serverSdk.connection.status() !== "connected") return
    void data.location.mcp.server.sync(data.location.default()).catch(() => undefined)

    if (props.directory) void data.location.mcp.server.sync(location()).catch(() => undefined)
  })

  // Ensure custom MCP servers saved in the store are registered with the live backend.
  createEffect(() => {
    if (serverSdk.connection.status() !== "connected") return

    for (const custom of scopeStore.customMcps()) {
      const config =
        custom.type === "remote"
          ? { type: "remote" as const, url: custom.url ?? "", disabled: !custom.enabled }
          : {
              type: "local" as const,
              command: (custom.command ?? "").trim().split(/\s+/).filter(Boolean),
              disabled: !custom.enabled,
            }

      void serverSdk.api.experimental.mcp
        .add({
          server: custom.name,
          config,
          location: data.location.default(),
        })
        .catch(() => undefined)
    }
  })

  const mcps = createMemo<McpDisplayRow[]>(() => {
    const active = data.location.mcp.server.list(location())

    const serverItems = (data.location.mcp.server.list(data.location.default()) ?? []).map(
      (server) => active?.find((item) => item.name === server.name) ?? server,
    )

    const customByName = new Map(scopeStore.customMcps().map((item) => [item.name, item]))
    const byName = new Map<string, McpDisplayRow>()

    for (const item of serverItems) {
      if (scopeStore.isMcpRemoved(item.name)) continue
      const custom = customByName.get(item.name)
      byName.set(item.name, {
        name: item.name,
        status: item.status.status,
        integrationID: item.integrationID,
        type: custom?.type ?? "local",
        command: custom?.command ?? "",
        url: custom?.url ?? "",
        custom: Boolean(custom),
      })
    }

    for (const custom of scopeStore.customMcps()) {
      if (scopeStore.isMcpRemoved(custom.name) || byName.has(custom.name)) continue
      byName.set(custom.name, {
        name: custom.name,
        status: custom.enabled ? "connected" : "disabled",
        type: custom.type,
        command: custom.command ?? "",
        url: custom.url ?? "",
        custom: true,
      })
    }

    return Array.from(byName.values()).toSorted((a, b) => a.name.localeCompare(b.name))
  })

  const filteredMcps = createMemo(() => {
    const q = mcpForm.query.trim().toLowerCase()

    if (!q) return mcps()

    return mcps().filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        item.command.toLowerCase().includes(q) ||
        item.url.toLowerCase().includes(q),
    )
  })

  const toggle = (name: string) => {
    if (toggleMcp.isPending) return
    toggleMcp.mutate(name)
  }

  const resetMcpForm = () => {
    setMcpForm({
      open: false,
      editingName: "",
      name: "",
      type: "local",
      command: "",
      url: "",
      saving: false,
    })
  }

  const openEditMcp = (item: McpDisplayRow) => {
    setMcpForm({
      open: true,
      editingName: item.name,
      name: item.name,
      type: item.type,
      command: item.command,
      url: item.url,
    })
  }

  const saveMcp = async () => {
    const name = mcpForm.name.trim()
    const command = mcpForm.command.trim()
    const url = mcpForm.url.trim()

    if (!name) return

    if (mcpForm.type === "local" && !command) return

    if (mcpForm.type === "remote" && !url) return

    setMcpForm("saving", true)

    const config =
      mcpForm.type === "remote"
        ? { type: "remote" as const, url }
        : { type: "local" as const, command: command.split(/\s+/).filter(Boolean) }

    if (mcpForm.editingName && mcpForm.editingName !== name) {
      await serverSdk.api.experimental.mcp
        .remove({ server: mcpForm.editingName, location: location() })
        .catch(() => undefined)
    }

    await serverSdk.api.experimental.mcp.add({ server: name, config, location: location() }).catch(() => undefined)
    scopeStore.saveCustomMcp(
      {
        name,
        type: mcpForm.type,
        command: mcpForm.type === "local" ? command : undefined,
        url: mcpForm.type === "remote" ? url : undefined,
        enabled: true,
      },
      mcpForm.editingName || undefined,
    )
    data.location.mcp.server.invalidate(data.location.default())
    void data.location.mcp.server.sync(data.location.default()).catch(() => undefined)
    resetMcpForm()
    showToast({ variant: "success", title: "MCP 已保存" })
  }

  const deleteMcp = async (name: string) => {
    scopeStore.removeMcp(name)
    await serverSdk.api.experimental.mcp.remove({ server: name, location: location() }).catch(() => undefined)
    data.location.mcp.server.invalidate(data.location.default())
    void data.location.mcp.server.sync(data.location.default()).catch(() => undefined)
    showToast({ variant: "success", title: "MCP 已删除" })
  }

  const [pluginList] = createResource(
    () => serverSdk.connection.status() === "connected",
    () =>
      serverSdk.api.plugin
        .list()
        .then((result) => result.data)
        .catch(() => []),
    { initialValue: [] },
  )

  const own = () => !!platform.plugins && ServerConnection.builtin(serverSdk.server)

  const plugins = createMemo<PluginDisplayRow[]>(() => {
    const byID = new Map<string, PluginDisplayRow>()
    const builtinSet = new Set(builtins.map((item) => item.id))
    const localOrder = new Map(BUILTIN_LOCAL_AGENT_PLUGINS.map((item, idx) => [item.id, idx]))

    for (const localItem of BUILTIN_LOCAL_AGENT_PLUGINS) {
      if (scopeStore.isPluginRemoved(localItem.id)) continue
      byID.set(localItem.id, {
        id: localItem.id,
        name: localItem.name,
        target: localItem.target,
        description: localItem.description,
        enabled: true,
        custom: true,
      })
    }

    for (const item of pluginList.latest ?? []) {
      if (item.source.type === "builtin") continue
      const label = pluginLabel(item)
      const id = item.id ?? label

      if (scopeStore.isPluginRemoved(id)) continue
      const installed = host.installed().find((inst) => inst.id === id && !inst.builtin)
      const target =
        item.source.type === "package"
          ? item.source.target
          : item.source.type === "local"
            ? item.source.path
            : id
      byID.set(id, {
        id,
        name: label,
        target,
        description: target,
        enabled: installed?.enabled ?? true,
        custom: false,
      })
    }

    if (own()) {
      for (const inst of host.installed()) {
        if (inst.builtin || builtinSet.has(inst.id) || byID.has(inst.id) || scopeStore.isPluginRemoved(inst.id)) continue
        byID.set(inst.id, {
          id: inst.id,
          name: inst.id,
          target: inst.id,
          description: inst.error ?? "",
          enabled: inst.enabled,
          custom: false,
        })
      }
    }

    for (const custom of scopeStore.customPlugins()) {
      if (scopeStore.isPluginRemoved(custom.id)) continue
      const builtinLocal = BUILTIN_LOCAL_AGENT_PLUGINS.find((item) => item.id === custom.id)
      const cleanedName = builtinLocal ? stripLegacyLocalPluginSuffix(custom.name) : custom.name
      const isOldDefaultDesc = custom.description?.includes("桥接")
      byID.set(custom.id, {
        id: custom.id,
        name: cleanedName,
        target: custom.target,
        description:
          (!isOldDefaultDesc && custom.description) || builtinLocal?.description || custom.target,
        enabled: custom.enabled,
        custom: true,
      })
    }

    return Array.from(byID.values())
      .map((item) => ({
        ...item,
        enabled: props.directory
          ? scopeStore.isProjectPluginEnabled(props.directory, item.id, item.enabled)
          : item.enabled,
      }))
      .toSorted((a, b) => {
        const aRank = localOrder.get(a.id)
        const bRank = localOrder.get(b.id)

        if (aRank !== undefined && bRank !== undefined) return aRank - bRank

        if (aRank !== undefined) return -1

        if (bRank !== undefined) return 1

        return a.name.localeCompare(b.name)
      })
  })

  const filteredPlugins = createMemo(() => {
    const q = pluginForm.query.trim().toLowerCase()

    if (!q) return plugins()

    return plugins().filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        item.target.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q),
    )
  })

  const resetPluginForm = () => {
    setPluginForm({
      open: false,
      editingID: "",
      name: "",
      target: "",
      description: "",
    })
  }

  const openEditPlugin = (item: PluginDisplayRow) => {
    setPluginForm({
      open: true,
      editingID: item.id,
      name: item.name,
      target: item.target,
      description: item.description === item.target ? "" : item.description,
    })
  }

  const savePlugin = () => {
    const name = pluginForm.name.trim()
    const target = pluginForm.target.trim() || name

    if (!name) return
    const id = pluginForm.editingID || name
    scopeStore.saveCustomPlugin(
      {
        id,
        name,
        target,
        description: pluginForm.description.trim() || undefined,
        enabled: true,
      },
      pluginForm.editingID || undefined,
    )
    resetPluginForm()
    showToast({ variant: "success", title: "插件已保存" })
  }

  const togglePlugin = (item: PluginDisplayRow, enabled: boolean) => {
    if (props.directory) {
      scopeStore.setProjectPluginEnabled(props.directory, item.id, enabled)

      return
    }

    if (item.custom) {
      scopeStore.saveCustomPlugin({
        id: item.id,
        name: item.name,
        target: item.target,
        description: item.description || undefined,
        enabled,
      })

      return
    }

    const manager = platform.plugins?.manager

    if (manager) {
      void (enabled ? manager.enable(item.id) : manager.disable(item.id)).catch(() => undefined)
    }

    scopeStore.saveCustomPlugin({
      id: item.id,
      name: item.name,
      target: item.target,
      description: item.description || undefined,
      enabled,
    })
  }

  const deletePlugin = (id: string) => {
    scopeStore.removePlugin(id)
    showToast({ variant: "success", title: "插件已删除" })
  }

  createEffect(() => {
    if (serverSdk.connection.status() !== "connected") return
    void data.location.skill.sync().catch(() => undefined)
  })

  const skills = createMemo<ScopedSkillInfo[]>(() => scopeStore.mergeSkills(data.location.skill.list() ?? []))

  const filteredSkills = createMemo(() => {
    const q = skillForm.query.trim().toLowerCase()

    if (!q) return skills()

    return skills().filter((skill) => {
      const desc = localizeSkillDescription(skill, language.locale()).toLowerCase()

      return skill.name.toLowerCase().includes(q) || desc.includes(q) || skill.path.toLowerCase().includes(q)
    })
  })

  const resetSkillForm = () => {
    setSkillForm({
      open: false,
      editingKey: "",
      name: "",
      description: "",
      content: "",
    })
  }

  const openEditSkill = (skill: ScopedSkillInfo) => {
    const key = skillScopeKey(skill)
    const custom = scopeStore.customSkills().find((item) => item.id === key || item.name === skill.name)
    setSkillForm({
      open: true,
      editingKey: key,
      name: skill.name,
      description: custom?.description ?? localizeSkillDescription(skill, language.locale()),
      content: custom?.content ?? skill.content ?? "",
    })
  }

  const saveSkill = () => {
    const name = skillForm.name.trim()

    if (!name) return
    const id = `custom:${name}`
    scopeStore.saveCustomSkill(
      {
        id,
        name,
        description: skillForm.description.trim(),
        content: skillForm.content.trim(),
        path: `custom://${name}/SKILL.md`,
      },
      skillForm.editingKey || undefined,
    )
    resetSkillForm()
    showToast({ variant: "success", title: "技能已保存" })
  }

  const deleteSkill = (skill: ScopedSkillInfo) => {
    scopeStore.removeSkill(skill)
    showToast({ variant: "success", title: "技能已删除" })
  }

  return (
    <>
      <div class="settings-tab-header">
        <div class="settings-tab-header-row">
          <div class="flex min-w-0 flex-col gap-1">
            <h2 class="settings-tab-title">{language.t("settings.tab.extensions")}</h2>
          </div>
          <div class="settings-tab-header-actions">{props.headerAction}</div>
        </div>
      </div>

      <div class="settings-tab-body">
        <Tabs
          variant="pill"
          value={props.subtab ?? "mcps"}
          onChange={(value) => {
            if (value === "mcps" || value === "plugins" || value === "skills") props.onSubtab(value)
          }}
          class="settings-extensions-tabs settings-subtabs"
        >
          <Tabs.List>
            <Tabs.Trigger value="mcps">
              {language.t("settings.extensions.tab.mcps")} ({mcps().length})
            </Tabs.Trigger>
            <Tabs.Trigger value="plugins">
              {language.t("settings.extensions.tab.plugins")} ({plugins().length})
            </Tabs.Trigger>
            <Tabs.Trigger value="skills">
              {language.t("settings.extensions.tab.skills")} ({skills().length})
            </Tabs.Trigger>
          </Tabs.List>

          <Tabs.Content value="mcps">
            <div class="settings-section flex flex-col gap-3">
              <div class="flex items-center justify-between gap-2">
                <div class="min-w-0 flex-1 max-w-[260px]">
                  <TextInput
                    type="search"
                    value={mcpForm.query}
                    onInput={(event) => setMcpForm("query", event.currentTarget.value)}
                    placeholder="搜索 MCP..."
                    showClearButton={mcpForm.query.length > 0}
                    onClearClick={() => setMcpForm("query", "")}
                  />
                </div>
                <Button
                  size="small"
                  variant={mcpForm.open ? "ghost" : "outline"}
                  onClick={() => {
                    if (mcpForm.open) {
                      resetMcpForm()

                      return
                    }

                    setMcpForm({
                      open: true,
                      editingName: "",
                      name: "",
                      type: "local",
                      command: "",
                      url: "",
                    })
                  }}
                >
                  {mcpForm.open ? "收起" : "+ 新增 MCP"}
                </Button>
              </div>

              <Show when={mcpForm.open}>
                <div class="flex flex-col gap-2.5 rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-01 p-3">
                  <div class="flex items-center justify-between">
                    <span class="text-12-medium text-v2-text-text-base">
                      {mcpForm.editingName ? `编辑 MCP：${mcpForm.editingName}` : "新增 MCP 服务"}
                    </span>
                    <div class="flex items-center gap-1">
                      <Button
                        size="small"
                        variant={mcpForm.type === "local" ? "outline" : "ghost"}
                        onClick={() => setMcpForm("type", "local")}
                      >
                        本地命令
                      </Button>
                      <Button
                        size="small"
                        variant={mcpForm.type === "remote" ? "outline" : "ghost"}
                        onClick={() => setMcpForm("type", "remote")}
                      >
                        远程 URL
                      </Button>
                    </div>
                  </div>
                  <TextInput
                    value={mcpForm.name}
                    onInput={(event) => setMcpForm("name", event.currentTarget.value)}
                    placeholder="MCP 名称（例如 filesystem）"
                  />
                  <Show
                    when={mcpForm.type === "local"}
                    fallback={
                      <TextInput
                        value={mcpForm.url}
                        onInput={(event) => setMcpForm("url", event.currentTarget.value)}
                        placeholder="远程 MCP 地址（例如 https://example.com/mcp）"
                      />
                    }
                  >
                    <TextInput
                      value={mcpForm.command}
                      onInput={(event) => setMcpForm("command", event.currentTarget.value)}
                      placeholder="启动命令（例如 npx -y @modelcontextprotocol/server-filesystem /path）"
                    />
                  </Show>
                  <div class="flex items-center justify-end gap-2">
                    <Button size="small" variant="ghost" onClick={resetMcpForm}>
                      取消
                    </Button>
                    <Button size="small" variant="contrast" disabled={mcpForm.saving} onClick={() => void saveMcp()}>
                      保存配置
                    </Button>
                  </div>
                </div>
              </Show>

              <SettingsList variant="catalog">
                <For each={filteredMcps()}>
                  {(item) => {
                    const busy = () => {
                      const target = toggleMcp.isPending ? toggleMcp.variables : undefined

                      return (Predicate.isString(target) ? target : target?.name) === item.name
                    }

                    const label = () =>
                      item.status === "pending" ? undefined : language.t(statusLabels[item.status])

                    return (
                      <div class="settings-extension-row settings-mcp-row" data-status={item.status}>
                        <div class="settings-extension-lead min-w-0 flex-1">
                          <span class="settings-mcp-status">
                            <span class="mcp-status-dot" data-status={item.status} aria-hidden="true" />
                          </span>
                          <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                            <TruncatedText text={item.name} class="settings-extension-name" />
                            <Show when={item.command || item.url}>
                              <span class="truncate text-11-regular text-v2-text-text-faint">
                                {item.type === "remote" ? item.url : item.command}
                              </span>
                            </Show>
                          </div>
                        </div>
                        <div class="settings-extension-trailing flex items-center gap-1.5">
                          <Show when={item.status === "failed"}>
                            <Button
                              size="small"
                              variant="ghost-muted"
                              class="mcp-status-action"
                              aria-label={language.t("dialog.mcp.error.viewLabel", { name: item.name })}
                              onClick={() =>
                                dialog.show(() => <DialogMcp directory={location().directory} server={item.name} />)
                              }
                            >
                              {language.t("dialog.mcp.error.view")}
                            </Button>
                          </Show>
                          <Button size="small" variant="ghost-muted" onClick={() => openEditMcp(item)}>
                            编辑
                          </Button>
                          <Button size="small" variant="ghost-muted" onClick={() => void deleteMcp(item.name)}>
                            删除
                          </Button>
                          <Show
                            when={item.status === "needs_auth" && item.integrationID}
                            fallback={
                              <Switch
                                checked={item.status !== "disabled"}
                                disabled={item.status === "pending" || busy()}
                                description={label()}
                                class="[&_[data-slot=switch-description]]:sr-only"
                                onChange={(enabled) => {
                                  if (toggleMcp.isPending) return
                                  toggleMcp.mutate({ name: item.name, enabled })
                                }}
                              >
                                <span class="sr-only">{item.name}</span>
                              </Switch>
                            }
                          >
                            <Button
                              size="small"
                              variant="ghost-muted"
                              class="mcp-status-action"
                              disabled={busy()}
                              aria-busy={busy()}
                              aria-label={language.t("dialog.mcp.signIn.open", { name: item.name })}
                              onClick={() => toggle(item.name)}
                            >
                              {language.t(busy() ? "dialog.mcp.signingIn" : "dialog.mcp.signIn")}
                            </Button>
                          </Show>
                        </div>
                      </div>
                    )
                  }}
                </For>
              </SettingsList>
            </div>
          </Tabs.Content>

          <Tabs.Content value="plugins">
            <div class="settings-section flex flex-col gap-3">
              <div class="flex items-center justify-between gap-2">
                <div class="min-w-0 flex-1 max-w-[260px]">
                  <TextInput
                    type="search"
                    value={pluginForm.query}
                    onInput={(event) => setPluginForm("query", event.currentTarget.value)}
                    placeholder="搜索插件..."
                    showClearButton={pluginForm.query.length > 0}
                    onClearClick={() => setPluginForm("query", "")}
                  />
                </div>
                <Button
                  size="small"
                  variant={pluginForm.open ? "ghost" : "outline"}
                  onClick={() => {
                    if (pluginForm.open) {
                      resetPluginForm()

                      return
                    }

                    setPluginForm({
                      open: true,
                      editingID: "",
                      name: "",
                      target: "",
                      description: "",
                    })
                  }}
                >
                  {pluginForm.open ? "收起" : "+ 新增插件"}
                </Button>
              </div>

              <Show when={pluginForm.open}>
                <div class="flex flex-col gap-2.5 rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-01 p-3">
                  <span class="text-12-medium text-v2-text-text-base">
                    {pluginForm.editingID ? `编辑插件：${pluginForm.name}` : "新增插件"}
                  </span>
                  <TextInput
                    value={pluginForm.name}
                    onInput={(event) => setPluginForm("name", event.currentTarget.value)}
                    placeholder="插件名称（例如 my-plugin）"
                  />
                  <TextInput
                    value={pluginForm.target}
                    onInput={(event) => setPluginForm("target", event.currentTarget.value)}
                    placeholder="NPM 包名或本地路径（例如 @scope/plugin）"
                  />
                  <TextInput
                    value={pluginForm.description}
                    onInput={(event) => setPluginForm("description", event.currentTarget.value)}
                    placeholder="插件说明（可选）"
                  />
                  <div class="flex items-center justify-end gap-2">
                    <Button size="small" variant="ghost" onClick={resetPluginForm}>
                      取消
                    </Button>
                    <Button size="small" variant="contrast" onClick={savePlugin}>
                      保存插件
                    </Button>
                  </div>
                </div>
              </Show>

              <SettingsList variant="catalog">
                <For each={filteredPlugins()}>
                  {(item) => (
                    <div class="settings-extension-row">
                      <div class="settings-extension-lead min-w-0 flex-1">
                        <Icon name="cube" class="text-v2-icon-icon-muted shrink-0" />
                        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                          <div class="flex items-center gap-1.5">
                            <span class="settings-extension-name truncate">{item.name}</span>
                            <Show when={item.id.startsWith("local:")}>
                              <span class="shrink-0 rounded bg-indigo-500/15 px-1.5 py-0.5 text-[10px] leading-none font-medium text-indigo-600 dark:text-indigo-400">
                                本地模型 + 会话识别
                              </span>
                            </Show>
                          </div>
                          <Show when={item.description}>
                            <span class="truncate text-11-regular text-v2-text-text-faint">{item.description}</span>
                          </Show>
                        </div>
                      </div>
                      <div class="settings-extension-trailing flex items-center gap-1.5">
                        <Button size="small" variant="ghost-muted" onClick={() => openEditPlugin(item)}>
                          编辑
                        </Button>
                        <Button size="small" variant="ghost-muted" onClick={() => deletePlugin(item.id)}>
                          删除
                        </Button>
                        <Switch
                          hideLabel
                          checked={item.enabled}
                          onChange={(next) => togglePlugin(item, next)}
                        >
                          {item.name}
                        </Switch>
                      </div>
                    </div>
                  )}
                </For>
              </SettingsList>
            </div>
          </Tabs.Content>

          <Tabs.Content value="skills">
            <div class="settings-section flex flex-col gap-3">
              <div class="flex items-center justify-between gap-2">
                <div class="min-w-0 flex-1 max-w-[260px]">
                  <TextInput
                    type="search"
                    value={skillForm.query}
                    onInput={(event) => setSkillForm("query", event.currentTarget.value)}
                    placeholder="搜索技能..."
                    showClearButton={skillForm.query.length > 0}
                    onClearClick={() => setSkillForm("query", "")}
                  />
                </div>
                <Button
                  size="small"
                  variant={skillForm.open ? "ghost" : "outline"}
                  onClick={() => {
                    if (skillForm.open) {
                      resetSkillForm()

                      return
                    }

                    setSkillForm({
                      open: true,
                      editingKey: "",
                      name: "",
                      description: "",
                      content: "",
                    })
                  }}
                >
                  {skillForm.open ? "收起" : "+ 新增技能"}
                </Button>
              </div>

              <Show when={skillForm.open}>
                <div class="flex flex-col gap-2.5 rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-01 p-3">
                  <span class="text-12-medium text-v2-text-text-base">
                    {skillForm.editingKey ? `编辑技能：${skillForm.name}` : "新增技能"}
                  </span>
                  <TextInput
                    value={skillForm.name}
                    onInput={(event) => setSkillForm("name", event.currentTarget.value)}
                    placeholder="技能标识名称（例如 code-review）"
                  />
                  <TextInput
                    value={skillForm.description}
                    onInput={(event) => setSkillForm("description", event.currentTarget.value)}
                    placeholder="技能简短描述"
                  />
                  <textarea
                    rows={4}
                    value={skillForm.content}
                    onInput={(event) => setSkillForm("content", event.currentTarget.value)}
                    placeholder="输入技能指令内容 (SKILL.md)..."
                    class="w-full rounded-md border border-v2-border-border-base bg-v2-background-bg-base px-2.5 py-2 text-12-regular text-v2-text-text-base outline-none focus:border-v2-border-border-focus"
                  />
                  <div class="flex items-center justify-end gap-2">
                    <Button size="small" variant="ghost" onClick={resetSkillForm}>
                      取消
                    </Button>
                    <Button size="small" variant="contrast" onClick={saveSkill}>
                      保存技能
                    </Button>
                  </div>
                </div>
              </Show>

              <SettingsList variant="catalog">
                <For each={filteredSkills()}>
                  {(skill) => {
                    const origin = () => resolveSkillOrigin(skill.path)
                    const enabled = () => scopeStore.isGlobalSkillEnabled(skill)
                    const desc = () => localizeSkillDescription(skill, language.locale())

                    return (
                      <div class="settings-extension-row">
                        <div class="settings-extension-lead min-w-0 flex-1">
                          <Icon name="post-skill" class="text-v2-icon-icon-muted shrink-0" />
                          <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                            <div class="flex items-center gap-2">
                              <span
                                class="settings-extension-name truncate"
                                classList={{
                                  "text-v2-text-text-base": enabled(),
                                  "text-v2-text-text-faint": !enabled(),
                                }}
                              >
                                {skill.name}
                              </span>
                              <span
                                class={`shrink-0 rounded px-1.5 py-0.5 text-[10px] leading-none font-medium ${origin().class}`}
                              >
                                {origin().label}
                              </span>
                            </div>
                            <Show when={desc()}>
                              <span class="truncate text-11-regular text-v2-text-text-faint" title={desc()}>
                                {desc()}
                              </span>
                            </Show>
                          </div>
                        </div>
                        <div class="settings-extension-trailing flex items-center gap-1.5">
                          <Button size="small" variant="ghost-muted" onClick={() => openEditSkill(skill)}>
                            编辑
                          </Button>
                          <Button size="small" variant="ghost-muted" onClick={() => deleteSkill(skill)}>
                            删除
                          </Button>
                          <Switch
                            checked={enabled()}
                            hideLabel
                            onChange={(next) => scopeStore.setGlobalSkillEnabled(skill, next)}
                          >
                            {skill.name}
                          </Switch>
                        </div>
                      </div>
                    )
                  }}
                </For>
              </SettingsList>
            </div>
          </Tabs.Content>
        </Tabs>
      </div>
    </>
  )
}
