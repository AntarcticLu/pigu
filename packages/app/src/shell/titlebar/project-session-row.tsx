import { Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useQueryClient } from "@tanstack/solid-query"
import type { SessionInfo } from "@opencode/client/promise"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Loader } from "@opencode/ui/loader"
import { Menu } from "@opencode/ui/menu"
import { TextInput } from "@opencode/ui/text-input"
import { useLanguage } from "@/runtime/i18n/language"
import { ServerConnection } from "@/runtime/server/registry"
import { useGlobal } from "@/runtime/server/runtime"
import { useSessionTabAvatarState } from "@/shell/layout/project-avatar-state"
import { errorMessage } from "@/shell/layout/helpers"
import { showToast } from "@/shell/notifications/toast"
import { isSessionUiLoading, startSessionUiLoading } from "@/session/loading-state"
import { sessionTreeIDs } from "@/session/requests/session-request-tree"
import { sessionLabel } from "@/session/title"
import { notifySessionTabsRemoved } from "./session-events"
import "./tab-nav.css"

export function resolveSessionSource(session: SessionInfo) {
  const raw = String(session.metadata?.source ?? "pigu").toLowerCase()

  if (raw === "codex") {
    return {
      label: "Codex",
      class: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    }
  }

  if (raw === "claude") {
    return {
      label: "Claude",
      class: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    }
  }

  if (raw === "agy") {
    return {
      label: "Antigravity",
      class: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
    }
  }

  if (raw === "deepseek-harness" || raw === "dsh") {
    return {
      label: "DSH",
      class: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400",
    }
  }

  if (raw === "workbuddy") {
    return {
      label: "WorkBuddy",
      class: "bg-teal-500/15 text-teal-600 dark:text-teal-400",
    }
  }

  if (raw === "opencode") {
    return {
      label: "OpenCode",
      class: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400",
    }
  }

  if (raw === "pi") {
    return {
      label: "Pi",
      class: "bg-purple-500/15 text-purple-600 dark:text-purple-400",
    }
  }

  if (raw === "cursor") {
    return {
      label: "Cursor",
      class: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
    }
  }

  if (raw === "grok") {
    return {
      label: "Grok",
      class: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
    }
  }

  return {
    label: "Pigu",
    class: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400",
  }
}

export function ProjectSessionRow(props: {
  server: ServerConnection.Key
  session: SessionInfo
  openTab: boolean
  active: boolean
  archived?: boolean
  onOpen: () => void
  onToggleArchive?: () => void
}) {
  const language = useLanguage()

  const global = useGlobal()

  const dialog = useDialog()

  const queryClient = useQueryClient()

  const connection = () => global.servers.list().find((conn) => ServerConnection.key(conn) === props.server)

  const ctx = () => global.serverCtx(props.server)

  const status = useSessionTabAvatarState(
    () => props.server,
    () => props.session.id,
    () => true,
    () => props.session,
  )

  const rename = (title: string) => {
    const current = ctx()

    if (!current) return Promise.resolve(false)

    const conn = connection()
    queryClient.setQueryData<SessionInfo[]>(["home-sessions", conn], (sessions) =>
      sessions?.map((session) => (session.id === props.session.id ? { ...session, title } : session)),
    )

    return current.sdk.api.session
      .update({ sessionID: props.session.id, title })
      .then(() => {
        current.data.session.remember({ ...(current.data.session.get(props.session.id) ?? props.session), title })
        current.data.session.invalidate(props.session.id)
        void current.data.session.sync(props.session.id).catch(() => undefined)
        void queryClient.invalidateQueries({ queryKey: ["home-sessions", conn], exact: true })

        return true
      })
      .catch((cause) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(cause, language.t("common.requestFailed")),
        })

        return false
      })
  }

  function DeleteDialog() {
    const confirm = () => {
      const current = ctx()

      const server = props.server

      dialog.close()

      if (!current) return

      const ids = sessionTreeIDs(current.data.session.list(), props.session.id)

      const conn = connection()

      queryClient.setQueryData<SessionInfo[]>(["home-sessions", conn], (sessions) =>
        sessions?.filter((session) => !ids.includes(session.id)),
      )
      void current.data.session
        .remove(props.session.id)
        .then(() => {
          notifySessionTabsRemoved({ server, directory: props.session.location.directory, sessionIDs: ids })
        })
        .catch((cause) => {
          showToast({
            title: language.t("session.delete.failed.title"),
            description: errorMessage(cause, language.t("session.delete.failed.title")),
          })
        })
        .finally(() => {
          void queryClient.invalidateQueries({ queryKey: ["home-sessions", conn], exact: true })
        })
    }

    return (
      <Dialog fit>
        <DialogHeader hideClose>
          <DialogTitleGroup
            title={language.t("session.delete.title")}
            description={language.t("session.delete.confirm", { name: sessionLabel(props.session) })}
          />
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" autofocus onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button variant="danger" onClick={confirm}>
            {language.t("session.delete.button")}
          </Button>
        </DialogFooter>
      </Dialog>
    )
  }

  return (
    <Menu.Context modal={false}>
      <Menu.Context.Trigger
        as="div"
        role="button"
        tabIndex={0}
        data-titlebar-tab-action
        data-state={props.active ? "pressed" : undefined}
        class="group/session relative flex h-7 w-full shrink-0 cursor-pointer items-center gap-1.5 rounded-[6px] ps-8 pe-1.5 text-start text-[13px] leading-[var(--line-height-compact)] font-medium focus-visible:outline-none"
        classList={{ "text-v2-text-text-base": props.active, "text-v2-text-text-faint": !props.active }}
        aria-current={props.active ? "page" : undefined}
        title={
          props.session.metadata?.originalCwd
            ? `${sessionLabel(props.session)}\n${language.tr("原项目路径", "Original path")}: ${String(props.session.metadata.originalCwd)}`
            : sessionLabel(props.session)
        }
        onPointerEnter={() => {
          const current = ctx()

          if (!current) return
          current.data.session.remember(props.session)
          void current.data.session.message.sync(props.session.id).catch(() => undefined)
        }}
        onClick={() => {
          if (!props.active) {
            startSessionUiLoading(props.session.id)
            requestAnimationFrame(() => props.onOpen())

            return
          }

          props.onOpen()
        }}
        onKeyDown={(event: KeyboardEvent) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault()

            if (!props.active) {
              startSessionUiLoading(props.session.id)
              requestAnimationFrame(() => props.onOpen())

              return
            }

            props.onOpen()
          }
        }}
      >
        <span class="min-w-0 flex-1 truncate" dir="auto">
          {sessionLabel(props.session)}
        </span>
        <span
          class={`shrink-0 rounded px-1.5 py-0.5 text-[10px] leading-none font-medium group-hover/session:hidden ${resolveSessionSource(props.session).class}`}
        >
          {resolveSessionSource(props.session).label}
        </span>
        <span
          class="hidden shrink-0 items-center gap-0.5 group-hover/session:flex"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <IconButton
            icon={<Icon name="edit" size="small" />}
            variant="ghost-muted"
            size="small"
            aria-label={language.t("common.rename")}
            title={language.t("common.rename")}
            onClick={(event) => {
              event.stopPropagation()
              dialog.show(() => <RenameDialog title={sessionLabel(props.session)} onRename={rename} />)
            }}
          />
          <IconButton
            icon={<Icon name="outline-trash" size="small" />}
            variant="ghost-muted"
            size="small"
            aria-label={language.t("common.delete")}
            title={language.t("common.delete")}
            onClick={(event) => {
              event.stopPropagation()
              dialog.show(() => <DeleteDialog />)
            }}
          />
        </span>
        <Show when={isSessionUiLoading(props.session.id) || status.loading()}>
          <span class="flex size-3.5 shrink-0 items-center justify-center">
            <Loader width={14} height={14} class="text-v2-text-text-base" />
          </span>
        </Show>
      </Menu.Context.Trigger>
      <Menu.Context.Portal>
        <Menu.Context.Content
          onCloseAutoFocus={(event) => {
            if (dialog.active) event.preventDefault()
          }}
        >
          <Show when={props.onToggleArchive}>
            <Menu.Item onSelect={() => props.onToggleArchive?.()}>
              {props.archived ? language.tr("恢复展示会话", "Unarchive session") : language.tr("收纳会话", "Archive session")}
            </Menu.Item>
            <Menu.Separator />
          </Show>
          <Menu.Item
            disabled={!ctx()}
            onSelect={() => dialog.show(() => <RenameDialog title={sessionLabel(props.session)} onRename={rename} />)}
          >
            {language.t("common.rename")}
          </Menu.Item>
          <Menu.Separator />
          <Menu.Item data-variant="critical" disabled={!ctx()} onSelect={() => dialog.show(() => <DeleteDialog />)}>
            {language.t("common.delete")}…
          </Menu.Item>
        </Menu.Context.Content>
      </Menu.Context.Portal>
    </Menu.Context>
  )
}

function RenameDialog(props: { title: string; onRename: (title: string) => Promise<boolean> }) {
  const language = useLanguage()

  const dialog = useDialog()

  const [state, setState] = createStore({ title: props.title, saving: false, selected: false })

  return (
    <Dialog fit>
      <DialogHeader hideClose>
        <DialogTitleGroup title={language.t("command.session.rename")} />
      </DialogHeader>
      <form
        class="contents"
        onSubmit={async (event) => {
          event.preventDefault()
          const title = state.title.trim()

          if (!title || state.saving) return

          if (title === props.title) return dialog.close()

          setState("saving", true)

          if (await props.onRename(title)) return dialog.close()

          setState("saving", false)
        }}
      >
        <DialogBody class="px-4">
          <TextInput
            appearance="large"
            class="!w-full self-stretch"
            aria-label={language.t("command.session.rename")}
            value={state.title}
            disabled={state.saving}
            autofocus
            autocomplete="off"
            onFocus={(event) => {
              if (state.selected) return
              setState("selected", true)
              event.currentTarget.select()
            }}
            onInput={(event) => setState("title", event.currentTarget.value)}
          />
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" disabled={state.saving} onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button type="submit" variant="contrast" disabled={!state.title.trim() || state.saving}>
            {language.t("common.save")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  )
}
