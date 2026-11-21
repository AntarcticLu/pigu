import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Tooltip } from "@opencode/ui/tooltip"
import { showToast } from "@opencode/ui/toast"
import { usePlugin, type MountedSession, type SessionScreen } from "@opencode/plugin/gui"
import type { Sandbox } from "@opencode/schema/sandbox"
import { uuid } from "@opencode/util/uuid"
import type SandboxDefinition from "./index"
import { buildSandboxDocument } from "./runtime"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export default function SandboxPanelView(props: {
  session: MountedSession
  screen: SessionScreen
  item: () => Sandbox.Item | undefined
  onDelete: (id: string) => void
}) {
  const ctx = usePlugin<typeof SandboxDefinition>()
  const [mode, setMode] = createSignal<"preview" | "source">("preview")
  const [reloadNonce, setReloadNonce] = createSignal(0)
  const [errorRecord, setErrorRecord] = createSignal<{ readonly token: string; readonly message: string }>()

  const frameToken = createMemo(() => {
    const current = props.item()
    const rev = reloadNonce()
    return current ? `${current.id}:${current.updatedAt}:${rev}:${uuid().slice(0, 8)}` : ""
  })

  const runtimeError = () => {
    const record = errorRecord()
    return record?.token === frameToken() ? record.message : undefined
  }

  makeEventListener(window, "message", (event: MessageEvent) => {
    const data = event.data
    if (!isRecord(data)) return
    const currentToken = frameToken()
    if (data.source !== "pigu-sandbox" || data.token !== currentToken) return
    if (data.kind === "error" && typeof data.message === "string" && data.message.trim()) {
      setErrorRecord({ token: currentToken, message: data.message.trim().slice(0, 2_000) })
    }
  })

  const blobUrl = createMemo(() => {
    const current = props.item()
    const token = frameToken()
    if (!current || !token) return undefined
    const html = buildSandboxDocument(current, token)
    const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }))
    onCleanup(() => URL.revokeObjectURL(url))
    return url
  })

  const copyCode = () => {
    const current = props.item()
    if (!current) return
    void ctx.system
      .copy(current.code)
      .then(() => {
        if (!ctx.signal.aborted) showToast({ variant: "success", title: ctx.t("common.copied") })
      })
      .catch(() => {
        if (!ctx.signal.aborted) showToast({ variant: "error", title: ctx.t("common.requestFailed") })
      })
  }

  const downloadHtml = () => {
    const current = props.item()
    if (!current) return
    const safeBase = current.title
      .trim()
      .replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "sandbox-preview"
    const html = buildSandboxDocument(current, "standalone")
    void ctx.system.save({ name: `${safeBase}.html`, content: html }).catch(() => {
      if (!ctx.signal.aborted) showToast({ variant: "error", title: ctx.t("common.requestFailed") })
    })
  }

  const quoteErrorToComposer = () => {
    const err = runtimeError()
    const current = props.item()
    if (!err || !current) return
    const commentID = uuid()
    const text = `[${current.title} (${current.id}, ${current.language}) 沙盒运行报错]\n${err}`
    props.screen.composer.attach({
      type: "quote",
      commentID,
      text,
      source: {
        label: ctx.t("quote.label"),
        icon: "flask",
        subject: current.title,
      },
    })
    props.screen.composer.focus(commentID)
  }

  return (
    <Show
      when={props.item()}
      fallback={
        <div class="flex h-full flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <div class="flex size-10 items-center justify-center rounded-lg bg-surface-raised-base text-icon-weak">
            <Icon name="flask" size="normal" />
          </div>
          <div class="text-14-medium text-text-strong">{ctx.t("empty.title")}</div>
          <div class="max-w-xs text-13-regular text-text-weak">{ctx.t("empty.description")}</div>
        </div>
      }
    >
      {(current) => (
        <div data-slot="sandbox-panel" class="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div class="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border-weak-base px-3">
            <div class="flex min-w-0 items-center gap-2">
              <Icon name="flask" size="small" class="shrink-0 text-icon-weak" />
              <span class="truncate text-13-medium text-text-strong" title={current().title}>
                {current().title}
              </span>
              <span class="shrink-0 rounded bg-surface-raised-base px-1.5 py-0.5 font-mono text-11-regular uppercase text-text-weak">
                {current().language}
              </span>
            </div>
            <div class="flex shrink-0 items-center gap-0.5">
              <Tooltip value={ctx.t(mode() === "preview" ? "view.viewSource" : "view.viewPreview")}>
                <IconButton
                  variant="ghost-muted"
                  size="normal"
                  aria-label={ctx.t(mode() === "preview" ? "view.viewSource" : "view.viewPreview")}
                  onClick={() => setMode((prev) => (prev === "preview" ? "source" : "preview"))}
                  icon={<Icon name={mode() === "preview" ? "outline-code-brackets" : "outline-eye"} size="small" />}
                />
              </Tooltip>
              <Tooltip value={ctx.t("view.reload")}>
                <IconButton
                  variant="ghost-muted"
                  size="normal"
                  aria-label={ctx.t("view.reload")}
                  onClick={() => {
                    setMode("preview")
                    setReloadNonce((n) => n + 1)
                  }}
                  icon={<Icon name="refresh" size="small" />}
                />
              </Tooltip>
              <Tooltip value={ctx.t("view.copy")}>
                <IconButton
                  variant="ghost-muted"
                  size="normal"
                  aria-label={ctx.t("view.copy")}
                  onClick={copyCode}
                  icon={<Icon name="outline-copy" size="small" />}
                />
              </Tooltip>
              <Tooltip value={ctx.t("view.download")}>
                <IconButton
                  variant="ghost-muted"
                  size="normal"
                  aria-label={ctx.t("view.download")}
                  onClick={downloadHtml}
                  icon={<Icon name="download" size="small" />}
                />
              </Tooltip>
              <Tooltip value={ctx.t("view.delete")}>
                <IconButton
                  variant="ghost-muted"
                  size="normal"
                  aria-label={ctx.t("view.delete")}
                  onClick={() => props.onDelete(current().id)}
                  icon={<Icon name="outline-trash" size="small" />}
                />
              </Tooltip>
            </div>
          </div>

          <Show
            when={mode() === "preview"}
            fallback={
              <div class="min-h-0 flex-1 overflow-auto p-3" data-scrollable>
                <ctx.ui.Code content={current().code} language={current().language} />
              </div>
            }
          >
            <div class="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-white">
              <Show when={blobUrl()} keyed>
                {(src) => (
                  <iframe
                    class="block h-full w-full flex-1 border-0 bg-white"
                    title={current().title}
                    src={src}
                    sandbox="allow-scripts allow-popups allow-forms allow-modals allow-downloads"
                    referrerPolicy="no-referrer"
                  />
                )}
              </Show>

              <Show when={runtimeError()}>
                {(err) => (
                  <div class="flex max-h-44 shrink-0 flex-col gap-2 border-t border-border-weak-base bg-surface-raised-base p-3">
                    <div class="flex items-center justify-between gap-2">
                      <div class="flex items-center gap-1.5 text-12-medium text-text-strong">
                        <Icon name="circle-exclamation" size="small" />
                        <span>{ctx.t("error.title")}</span>
                      </div>
                      <div class="flex items-center gap-1.5">
                        <Button size="small" variant="outline" onClick={quoteErrorToComposer}>
                          {ctx.t("error.quote")}
                        </Button>
                        <Button size="small" variant="ghost" onClick={() => setErrorRecord(undefined)}>
                          {ctx.t("error.dismiss")}
                        </Button>
                      </div>
                    </div>
                    <pre class="max-h-24 overflow-auto whitespace-pre-wrap font-mono text-11-regular text-text-weak">
                      {err()}
                    </pre>
                  </div>
                )}
              </Show>
            </div>
          </Show>
        </div>
      )}
    </Show>
  )
}
