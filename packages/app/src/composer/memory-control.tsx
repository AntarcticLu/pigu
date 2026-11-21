import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Memory } from "@opencode/schema/memory"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { displayName } from "@opencode/ui/project-avatar"
import { Switch } from "@opencode/ui/switch"
import { TextInput } from "@opencode/ui/text-input"
import { Tooltip } from "@opencode/ui/tooltip"
import { getFilename } from "@opencode/util/path"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import { useServer } from "@/runtime/server/current"
import { serverName } from "@/runtime/server/registry"
import { showToast } from "@/shell/notifications/toast"
import { useWorkspaceLocation } from "@/workspaces/location"
import type { ComposerModel } from "./model"
import "@/settings/settings.css"

export function ComposerMemoryControl(props: { model: ComposerModel }) {
  const dialog = useDialog()
  const language = useLanguage()
  const server = useServer()
  const serverSDK = useServerSDK()
  const location = useWorkspaceLocation()

  const projectDirectory = () => location().current?.project.directory ?? location().directory
  const isLocalServer = () => server.ctx.isLocal

  const projectName = createMemo(() => {
    const id = location().current?.project.id
    const dir = projectDirectory()
    const match = server.ctx.projects.list().find((item) => (id && item.id === id) || item.worktree === dir)
    if (match) return displayName(match)
    return getFilename(dir) || dir || language.tr("当前项目", "Current Project")
  })

  const deviceLabel = () =>
    isLocalServer() ? language.tr("本地", "Local") : serverName(serverSDK.server) || language.tr("远程", "Remote")

  const [counts, setCounts] = createStore({
    globalActive: 0,
    projectActive: 0,
  })

  createEffect(() => {
    if (serverSDK.connection.status() !== "connected") return
    const dir = projectDirectory()
    const controller = new AbortController()
    onCleanup(() => controller.abort())

    const rpc = serverSDK.api.rpc(Memory.Definition)

    const refreshCounts = () => {
      void rpc
        .snapshot({ directory: dir }, { location: { directory: dir }, signal: controller.signal })
        .then(
          (res) => {
            if (controller.signal.aborted) return
            const globalActive = res.items.filter((item) => item.scope === "global" && item.enabled).length
            const projectActive = res.items.filter((item) => item.scope === "project" && item.enabled).length
            setCounts({ globalActive, projectActive })
          },
          () => undefined,
        )
    }

    onCleanup(
      rpc.events.on(
        "changed",
        () => {
          refreshCounts()
        },
        { signal: controller.signal },
      ),
    )

    refreshCounts()
  })

  const tooltipLabel = () =>
    language.tr(
      `全局记忆 ${counts.globalActive} · 项目记忆 ${counts.projectActive}`,
      `Global ${counts.globalActive} · Project ${counts.projectActive}`,
    )

  return (
    <Tooltip placement="top" value={tooltipLabel()}>
      <Button
        data-action="composer-memory"
        variant="ghost-muted"
        size="normal"
        class="size-7 shrink-0 !p-0 ![font-weight:440]"
        aria-label={tooltipLabel()}
        onMouseDown={(event: MouseEvent) => event.preventDefault()}
        onClick={() =>
          void dialog.show(
            () => (
              <DialogSessionMemory
                projectDirectory={projectDirectory()}
                projectName={projectName()}
                deviceLabel={deviceLabel()}
                isLocal={isLocalServer()}
              />
            ),
            props.model.restoreFocus,
          )
        }
      >
        <Icon name="brain" size="small" class="text-v2-icon-icon-muted" />
      </Button>
    </Tooltip>
  )
}

function MemoryColumn(props: {
  scope: Memory.Scope
  projectDirectory?: string
  projectName?: string
  deviceLabel: string
  items: readonly Memory.Item[]
  onUpsert: (input: Memory.UpsertInput) => Promise<boolean>
  onToggle: (id: string, patch: { enabled?: boolean; pinned?: boolean }) => void
  onDelete: (id: string) => void
}) {
  const language = useLanguage()
  const [query, setQuery] = createSignal("")
  const [expandedIDs, setExpandedIDs] = createSignal<Record<string, boolean>>({})

  const [editor, setEditor] = createStore<{
    open: boolean
    editingID: string
    title: string
    fileName: string
    content: string
    pinned: boolean
    saving: boolean
  }>({
    open: false,
    editingID: "",
    title: "",
    fileName: "",
    content: "",
    pinned: false,
    saving: false,
  })

  let titleInputRef: HTMLInputElement | undefined

  const focusTitle = () => {
    queueMicrotask(() => titleInputRef?.focus())
  }

  const openCreate = () => {
    setEditor({
      open: true,
      editingID: "",
      title: "",
      fileName: "",
      content: "",
      pinned: false,
      saving: false,
    })
    focusTitle()
  }

  const openEdit = (item: Memory.Item) => {
    setEditor({
      open: true,
      editingID: item.id,
      title: item.title,
      fileName: item.fileName ?? "",
      content: item.content,
      pinned: Boolean(item.pinned),
      saving: false,
    })
    focusTitle()
  }

  const closeEditor = () => {
    setEditor({
      open: false,
      editingID: "",
      title: "",
      fileName: "",
      content: "",
      pinned: false,
      saving: false,
    })
  }

  const submitEditor = async () => {
    const title = editor.title.trim()
    const content = editor.content.trim()
    if (!title || !content || editor.saving) return
    setEditor("saving", true)
    const ok = await props.onUpsert({
      ...(editor.editingID ? { id: editor.editingID } : {}),
      scope: props.scope,
      ...(props.scope === "project" && props.projectDirectory ? { directory: props.projectDirectory } : {}),
      ...(editor.fileName.trim() ? { fileName: editor.fileName.trim() } : {}),
      title,
      content,
      pinned: editor.pinned,
      source: "user",
    })
    setEditor("saving", false)
    if (ok) closeEditor()
  }

  const filteredItems = createMemo(() => {
    const q = query().trim().toLowerCase()
    return props.items
      .filter((item) => {
        if (!q) return true
        return (
          item.title.toLowerCase().includes(q) ||
          (item.fileName?.toLowerCase().includes(q) ?? false) ||
          (item.description?.toLowerCase().includes(q) ?? false) ||
          item.content.toLowerCase().includes(q)
        )
      })
      .toSorted((a, b) => {
        const pinDiff = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
        if (pinDiff !== 0) return pinDiff
        return b.updatedAt - a.updatedAt
      })
  })

  const enabledCount = createMemo(() => props.items.filter((item) => item.enabled).length)

  const toggleExpanded = (id: string) => {
    setExpandedIDs((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  return (
    <div
      data-slot={`memory-column-${props.scope}`}
      class="flex min-h-0 flex-col overflow-hidden rounded-[8px] bg-v2-background-bg-base shadow-[inset_0_0_0_0.5px_var(--v2-border-border-muted)]"
    >
      <div class="flex shrink-0 items-center justify-between gap-2 border-b border-v2-border-border-base px-4 py-3">
        <div class="flex min-w-0 items-center gap-2">
          <Icon
            name={props.scope === "global" ? "brain" : "folder"}
            size="small"
            class="shrink-0 text-v2-icon-icon-muted"
          />
          <span class="shrink-0 text-13-medium text-v2-text-text-base">
            {props.scope === "global"
              ? language.tr("全局记忆", "Global Memory")
              : language.tr("项目记忆", "Project Memory")}
          </span>
          <Show
            when={props.scope === "project" && props.projectName}
            fallback={
              <span class="max-w-[110px] truncate rounded bg-emerald-500/10 px-1.5 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                {props.deviceLabel}
              </span>
            }
          >
            <span
              class="max-w-[140px] truncate rounded bg-blue-500/10 px-1.5 py-0.5 text-[11px] font-medium text-blue-600 dark:text-blue-400"
              title={props.projectDirectory}
            >
              {props.projectName}
            </span>
          </Show>
          <span class="shrink-0 rounded bg-v2-background-bg-layer-02 px-1.5 py-0.5 text-11-regular text-v2-text-text-muted">
            {enabledCount()} / {props.items.length}
          </span>
        </div>

        <Button
          variant="outline"
          size="small"
          icon="plus"
          data-action={`memory-new-${props.scope}`}
          onClick={openCreate}
        >
          {language.tr("新建", "New")}
        </Button>
      </div>

      <Show when={props.items.length > 0 || query().length > 0}>
        <div class="shrink-0 border-b border-v2-border-border-muted/60 px-3 py-2">
          <TextInput
            type="search"
            class="!w-full self-stretch"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            placeholder={
              props.scope === "global"
                ? language.tr("搜索全局记忆文件…", "Search global memories…")
                : language.tr("搜索当前项目记忆文件…", "Search project memories…")
            }
            showClearButton={query().length > 0}
            onClearClick={() => setQuery("")}
          />
        </div>
      </Show>

      <div class="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
        <div class="flex flex-col gap-2">
          <Show when={editor.open}>
            <div
              data-slot="memory-inline-editor"
              class="flex flex-col gap-2 rounded-[8px] border border-v2-border-border-base bg-v2-background-bg-layer-02/80 p-3"
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault()
                  void submitEditor()
                }
              }}
            >
              <div class="flex items-center justify-between gap-2">
                <span class="text-[12px] font-semibold text-v2-text-text-base">
                  {editor.editingID
                    ? language.tr("编辑记忆文件", "Edit Memory File")
                    : props.scope === "global"
                      ? language.tr("新建全局记忆文件", "New Global Memory File")
                      : language.tr("新建项目记忆文件", "New Project Memory File")}
                </span>
                <button
                  type="button"
                  class={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
                    editor.pinned
                      ? "bg-amber-500/20 text-amber-600 ring-1 ring-amber-500/60 dark:text-amber-400"
                      : "bg-v2-background-bg-layer-03 text-v2-text-text-muted hover:text-v2-text-text-base"
                  }`}
                  onClick={() => setEditor("pinned", !editor.pinned)}
                >
                  {language.tr("置顶", "Pin")}
                </button>
              </div>

              <input
                ref={titleInputRef}
                type="text"
                class="h-8 w-full rounded-[6px] border border-v2-border-border-muted bg-v2-background-bg-base px-2.5 text-[13px] font-medium text-v2-text-text-base outline-none focus:border-v2-border-border-base"
                placeholder={
                  props.scope === "global"
                    ? language.tr("标题（如：默认用精炼中文回答）", "Title (e.g. Concise responses)")
                    : language.tr("标题（如：Go 工具链位置 / 接口踩坑）", "Title (e.g. Build & API notes)")
                }
                value={editor.title}
                onInput={(event) => setEditor("title", event.currentTarget.value)}
              />

              <textarea
                rows={4}
                class="w-full resize-y rounded-[6px] border border-v2-border-border-muted bg-v2-background-bg-base p-2.5 font-mono text-[12px] leading-relaxed text-v2-text-text-base outline-none focus:border-v2-border-border-base"
                placeholder={
                  props.scope === "global"
                    ? language.tr("输入跨项目通用的偏好与规范（保存为 .md 记忆文件）…", "Write global memory content (.md)…")
                    : language.tr("输入该项目专属的架构约定、环境说明或踩坑经验（保存为 .md 记忆文件）…", "Write project memory content (.md)…")
                }
                value={editor.content}
                onInput={(event) => setEditor("content", event.currentTarget.value)}
              />

              <div class="flex items-center justify-between gap-2">
                <input
                  type="text"
                  class="h-7 min-w-0 flex-1 rounded-[6px] border border-v2-border-border-muted bg-v2-background-bg-base px-2 font-mono text-[11px] text-v2-text-text-muted outline-none focus:border-v2-border-border-base"
                  placeholder={language.tr("文件名（可选，默认按标题自动生成 .md）", "Filename.md (optional)")}
                  value={editor.fileName}
                  onInput={(event) => setEditor("fileName", event.currentTarget.value)}
                />
                <div class="flex shrink-0 items-center gap-1.5">
                  <Button size="small" variant="ghost" onClick={closeEditor}>
                    {language.t("common.cancel")}
                  </Button>
                  <Button
                    size="small"
                    variant="contrast"
                    disabled={!editor.title.trim() || !editor.content.trim() || editor.saving}
                    onClick={() => void submitEditor()}
                  >
                    {language.t("common.save")}
                  </Button>
                </div>
              </div>
            </div>
          </Show>

          <Show
            when={filteredItems().length > 0}
            fallback={
              <Show when={!editor.open}>
                <div class="flex flex-col items-center justify-center gap-2 py-14 text-center">
                  <span class="text-13-regular text-v2-text-text-faint">
                    {query().trim()
                      ? language.tr("未找到匹配的记忆文件", "No matching memory files")
                      : props.scope === "global"
                        ? language.tr("暂无全局记忆文件", "No global memory files")
                        : language.tr("当前项目暂无记忆文件", "No memory files for this project")}
                  </span>
                  <Show when={!query().trim()}>
                    <Button variant="ghost-muted" size="small" icon="plus" onClick={openCreate}>
                      {props.scope === "global"
                        ? language.tr("新建全局记忆", "Create Global Memory")
                        : language.tr("新建项目记忆", "Create Project Memory")}
                    </Button>
                  </Show>
                </div>
              </Show>
            }
          >
            <For each={filteredItems()}>
              {(item) => {
                const isExpanded = () => Boolean(expandedIDs()[item.id])
                return (
                  <div
                    data-slot="memory-file-row"
                    class={`group flex flex-col gap-1.5 rounded-[8px] border p-2.5 transition-colors ${
                      editor.editingID === item.id
                        ? "border-v2-border-border-base bg-v2-background-bg-layer-02/70"
                        : "border-v2-border-border-muted/70 bg-v2-background-bg-layer-01/50 hover:bg-v2-background-bg-layer-02/40"
                    } ${item.enabled ? "" : "opacity-55"}`}
                  >
                    <div class="flex items-start justify-between gap-2">
                      <button
                        type="button"
                        class="flex min-w-0 flex-1 flex-col gap-0.5 text-start outline-none"
                        onClick={() => toggleExpanded(item.id)}
                      >
                        <div class="flex min-w-0 flex-wrap items-center gap-1.5">
                          <span class="settings-mcp-status shrink-0">
                            <span
                              class="mcp-status-dot"
                              data-status={item.enabled ? "connected" : "disabled"}
                              aria-hidden="true"
                            />
                          </span>
                          <Show when={item.pinned}>
                            <span class="inline-flex shrink-0 text-amber-500" title={language.tr("已置顶", "Pinned")}>
                              <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                                <path d="M9.8 1.5L14.5 6.2L13.1 7.6L11.6 6.8L8.8 9.6L9.4 12.4L8 13.8L5.2 11L1.8 14.4L1.1 13.7L4.5 10.3L1.7 7.5L3.1 6.1L5.9 6.7L8.7 3.9L7.9 2.4L9.8 1.5Z" />
                              </svg>
                            </span>
                          </Show>
                          <span class="min-w-0 truncate text-[13px] font-medium text-v2-text-text-base">
                            {item.title}
                          </span>
                          <Show when={item.fileName}>
                            <span class="max-w-[140px] shrink-0 truncate rounded bg-v2-background-bg-layer-02 px-1.5 py-0.2 font-mono text-[10px] text-v2-text-text-faint">
                              {item.fileName}
                            </span>
                          </Show>
                        </div>

                        <div
                          class={`text-[12px] leading-relaxed text-v2-text-text-muted ${
                            isExpanded() ? "mt-1 whitespace-pre-wrap font-mono text-[11.5px]" : "line-clamp-2"
                          }`}
                        >
                          {isExpanded() ? item.content : item.description || item.content}
                        </div>
                      </button>

                      <div class="flex shrink-0 items-center gap-1 pt-0.5">
                        <div class="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                          <IconButton
                            variant="ghost-muted"
                            size="small"
                            icon={<Icon name="edit" size="small" />}
                            aria-label={language.tr("编辑", "Edit")}
                            title={language.tr("编辑", "Edit")}
                            onClick={() => openEdit(item)}
                          />
                          <IconButton
                            variant="ghost-muted"
                            size="small"
                            icon={<Icon name="trash" size="small" />}
                            aria-label={language.tr("删除", "Delete")}
                            title={language.tr("删除", "Delete")}
                            onClick={() => {
                              if (editor.editingID === item.id) closeEditor()
                              props.onDelete(item.id)
                            }}
                          />
                        </div>
                        <Switch
                          checked={item.enabled}
                          hideLabel
                          onChange={(checked) => props.onToggle(item.id, { enabled: checked })}
                        >
                          {item.title}
                        </Switch>
                      </div>
                    </div>
                  </div>
                )
              }}
            </For>
          </Show>
        </div>
      </div>
    </div>
  )
}

function DialogSessionMemory(props: {
  projectDirectory: string
  projectName: string
  deviceLabel: string
  isLocal: boolean
}) {
  const language = useLanguage()
  const serverSDK = useServerSDK()

  const [unsupported, setUnsupported] = createSignal(false)
  const [snapshot, setSnapshot] = createStore<{
    items: Memory.Item[]
  }>({
    items: [],
  })

  const rpcLocation = () => ({ directory: props.projectDirectory })

  const refresh = (signal?: AbortSignal) => {
    if (serverSDK.connection.status() !== "connected") return
    void serverSDK.api
      .rpc(Memory.Definition)
      .snapshot({ directory: props.projectDirectory }, { location: rpcLocation(), signal })
      .then(
        (res) => {
          if (signal?.aborted) return
          setUnsupported(false)
          setSnapshot(reconcile({ items: [...res.items] }))
        },
        (cause: unknown) => {
          if (signal?.aborted) return
          const msg = cause instanceof Error ? cause.message : String(cause)
          if (msg.includes("method_not_found") || msg.includes("opencode.memory") || msg.includes("404")) {
            setUnsupported(true)
          }
        },
      )
  }

  createEffect(() => {
    if (serverSDK.connection.status() !== "connected") return
    const dir = props.projectDirectory
    void dir

    const controller = new AbortController()
    onCleanup(() => controller.abort())

    const rpc = serverSDK.api.rpc(Memory.Definition)
    onCleanup(
      rpc.events.on(
        "changed",
        () => {
          refresh(controller.signal)
        },
        { signal: controller.signal },
      ),
    )

    refresh(controller.signal)
  })

  const globalItems = createMemo(() => snapshot.items.filter((item) => item.scope === "global"))
  const projectItems = createMemo(() => snapshot.items.filter((item) => item.scope === "project"))

  const handleUpsert = async (input: Memory.UpsertInput): Promise<boolean> =>
    serverSDK.api
      .rpc(Memory.Definition)
      .upsert(input, { location: rpcLocation() })
      .then(() => {
        refresh()
        showToast({
          variant: "success",
          title: input.id
            ? language.tr("记忆文件已更新", "Memory file updated")
            : language.tr("记忆文件已创建", "Memory file created"),
        })
        return true
      })
      .catch((cause: unknown) => {
        showToast({
          variant: "error",
          title: cause instanceof Error ? cause.message : language.t("common.requestFailed"),
        })
        return false
      })

  const handleToggle = (id: string, patch: { enabled?: boolean; pinned?: boolean }) => {
    void serverSDK.api
      .rpc(Memory.Definition)
      .toggle({ id, ...patch }, { location: rpcLocation() })
      .then(() => refresh())
      .catch(() => undefined)
  }

  const handleDelete = (id: string) => {
    void serverSDK.api
      .rpc(Memory.Definition)
      .remove({ id }, { location: rpcLocation() })
      .then(() => {
        refresh()
        showToast({ variant: "success", title: language.tr("记忆文件已删除", "Memory file deleted") })
      })
      .catch(() => undefined)
  }

  return (
    <Dialog size="x-large" containerClass="!w-[min(94vw,940px)] !h-[min(82vh,600px)] !rounded-[10px]">
      <DialogHeader>
        <div class="flex min-w-0 items-center gap-2">
          <DialogTitle>{language.tr("记忆管理", "Memory")}</DialogTitle>
          <span
            class={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${
              props.isLocal
                ? "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400"
                : "bg-blue-500/12 text-blue-600 dark:text-blue-400"
            }`}
          >
            {props.deviceLabel}
          </span>
        </div>
      </DialogHeader>

      <DialogBody class="min-h-0 flex-1 px-4 pb-4 pt-0">
        <Show
          when={!unsupported()}
          fallback={
            <div class="flex h-full flex-col items-center justify-center gap-2 rounded-[8px] bg-v2-background-bg-base p-8 text-center shadow-[inset_0_0_0_0.5px_var(--v2-border-border-muted)]">
              <Icon name="brain" size="normal" class="text-v2-icon-icon-muted" />
              <div class="text-[13px] font-medium text-v2-text-text-base">
                {language.tr("该远程服务器暂未升级记忆管理模块", "Remote server does not support Memory yet")}
              </div>
              <div class="text-[12px] text-v2-text-text-muted">
                {language.tr(
                  "升级远程 SSH 设备上的 opencode 服务后即可同步管理其全局与项目记忆文件。",
                  "Upgrade the opencode service on this SSH host to manage its global and project memory files.",
                )}
              </div>
            </div>
          }
        >
          <div class="grid h-full min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-2">
            <MemoryColumn
              scope="global"
              deviceLabel={props.deviceLabel}
              items={globalItems()}
              onUpsert={handleUpsert}
              onToggle={handleToggle}
              onDelete={handleDelete}
            />
            <MemoryColumn
              scope="project"
              projectDirectory={props.projectDirectory}
              projectName={props.projectName}
              deviceLabel={props.deviceLabel}
              items={projectItems()}
              onUpsert={handleUpsert}
              onToggle={handleToggle}
              onDelete={handleDelete}
            />
          </div>
        </Show>
      </DialogBody>
    </Dialog>
  )
}
