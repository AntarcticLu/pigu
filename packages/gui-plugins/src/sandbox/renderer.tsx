import { batch, createMemo, lazy, onCleanup, Suspense } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Icon } from "@opencode/ui/icon"
import { showToast } from "@opencode/ui/toast"
import { checksum } from "@opencode/util/encode"
import { Sandbox } from "@opencode/schema/sandbox"
import {
  CodeBlockAction,
  Command,
  createKeyed,
  MenuItem,
  type MountedSession,
  type Plugin,
} from "@opencode/plugin/gui"
import { BuiltinPanel, onIdle, type BuiltinPanelTab } from "@opencode/plugin/gui/builtin"
import type SandboxDefinition from "./index"
import { inferSandboxTitle, normalizeFenceLanguage } from "./runtime"

const EMPTY_TAB_ID = "empty"
const PREVIEW_LANGUAGES = ["html", "htm", "jsx", "tsx", "react", "svg"] as const

const setup: Plugin.Setup<typeof SandboxDefinition> = (ctx) => {
  const SandboxPanelView = lazy(() => import("./panel"))
  onCleanup(onIdle(() => void SandboxPanelView.preload()))

  const [store, setStore] = createStore<{
    bySession: Record<string, readonly Sandbox.Item[] | undefined>
  }>({
    bySession: {},
  })

  const sessionKey = (serverId: string, sessionID: string) => `${serverId}\u0000${sessionID}`

  const itemsOf = (session: Pick<MountedSession, "id" | "server">) =>
    store.bySession[sessionKey(session.server.id, session.id)] ?? []

  const openSandboxTab = (session: MountedSession, tabId: string) => {
    batch(() => {
      ctx.layout.open(`${ctx.id}:${tabId}`, session, { tab: "select" })
      if (!ctx.layout.side.opened(session)) {
        ctx.layout.side.toggle(session)
      }
    })
  }

  createKeyed(
    () => {
      const session = ctx.sessions.current()
      return session?.server.connected ? `${sessionKey(session.server.id, session.id)}\u0000${session.directory}` : undefined
    },
    () => {
      const session = ctx.sessions.current()
      if (!session || session.id.startsWith("ses_draft_")) return

      const sKey = sessionKey(session.server.id, session.id)
      const rpc = session.server.client.rpc(Sandbox.Definition)
      const controller = new AbortController()
      const heard = { value: false }
      onCleanup(() => controller.abort())

      onCleanup(
        rpc.events.on(
          "changed",
          (event) => {
            if (event.data.sessionID !== session.id) return
            heard.value = true
            setStore("bySession", sKey, reconcile([...event.data.items]))
            const focusID = event.data.focusID
            const routed = ctx.sessions.current()
            if (focusID && routed?.key === session.key) {
              openSandboxTab(routed, focusID)
            }
          },
          { signal: controller.signal },
        ),
      )

      void rpc
        .list({ sessionID: session.id }, { location: { directory: session.directory }, signal: controller.signal })
        .then(
          (items) => {
            if (!controller.signal.aborted && !heard.value) {
              setStore("bySession", sKey, reconcile([...items]))
            }
          },
          () => undefined,
        )
    },
  )

  const upsertFromCodeBlock = async (session: MountedSession, language: Sandbox.Language, code: string) => {
    const title = inferSandboxTitle(code, language)
    const hash = checksum(`${language}\n${code}`)
    const sKey = sessionKey(session.server.id, session.id)

    if (session.id.startsWith("ses_draft_")) {
      const localItem: Sandbox.Item = {
        id: `sbx_${hash}`,
        sessionID: session.id,
        title,
        language,
        code,
        hash,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      const existing = (store.bySession[sKey] ?? []).filter((item) => item.id !== localItem.id && item.hash !== hash)
      setStore("bySession", sKey, [...existing, localItem])
      openSandboxTab(session, localItem.id)
      return
    }

    const rpc = session.server.client.rpc(Sandbox.Definition)
    const saved = await rpc
      .upsert(
        {
          sessionID: session.id,
          title,
          language,
          code,
          hash,
          focus: true,
        },
        { location: { directory: session.directory } },
      )
      .catch((cause: unknown) => {
        const fallbackItem: Sandbox.Item = {
          id: `sbx_${hash}`,
          sessionID: session.id,
          title,
          language,
          code,
          hash,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
        const existing = (store.bySession[sKey] ?? []).filter(
          (item) => item.id !== fallbackItem.id && item.hash !== hash,
        )
        setStore("bySession", sKey, [...existing, fallbackItem])
        if (cause instanceof Error && !/unavailable/i.test(cause.message)) {
          showToast({ variant: "error", title: ctx.t("common.requestFailed"), description: cause.message })
        }
        return fallbackItem
      })

    const current = store.bySession[sKey] ?? []
    if (!current.some((item) => item.id === saved.id)) {
      setStore("bySession", sKey, [...current, saved])
    }
    openSandboxTab(session, saved.id)
  }

  const removeSandboxItem = (session: MountedSession, id: string) => {
    const sKey = sessionKey(session.server.id, session.id)
    const next = (store.bySession[sKey] ?? []).filter((item) => item.id !== id)
    setStore("bySession", sKey, next)
    ctx.layout.close(`${ctx.id}:${id}`, session)
    if (!session.id.startsWith("ses_draft_")) {
      void session.server.client
        .rpc(Sandbox.Definition)
        .remove({ sessionID: session.id, id }, { location: { directory: session.directory } })
        .catch(() => undefined)
    }
  }

  ctx.add(CodeBlockAction, {
    id: "preview",
    languages: PREVIEW_LANGUAGES,
    icon: "outline-eye",
    get title() {
      return ctx.t("action.preview")
    },
    order: -10,
    run(input) {
      const session = input.session ?? ctx.sessions.current()
      const normalized = normalizeFenceLanguage(input.language)
      if (!session || !normalized || !input.code.trim()) return
      return upsertFromCodeBlock(session, normalized, input.code)
    },
  })

  const mac = /(Mac|iPhone|iPad)/.test(navigator.platform)

  ctx.add(
    Command,
    (): Command => ({
      id: "open",
      title: ctx.t("tab.title"),
      group: ctx.t("command.category.view"),
      bind: mac ? "ctrl+meta+s" : "ctrl+alt+s",
      editable: true,
      enabled: !!ctx.sessions.current(),
      run: () => {
        const session = ctx.sessions.current()
        if (!session) return
        const latest = itemsOf(session).at(-1)
        openSandboxTab(session, latest?.id ?? EMPTY_TAB_ID)
      },
    }),
  )

  ctx.add(
    MenuItem,
    (): MenuItem | undefined => {
      const session = ctx.sessions.current()
      if (!session) return undefined
      return {
        menu: "session.panel",
        id: "open",
        title: ctx.t("tab.title"),
        icon: "flask",
        keybind: `${ctx.id}.open`,
        order: 18,
        run: () => {
          const latest = itemsOf(session).at(-1)
          openSandboxTab(session, latest?.id ?? EMPTY_TAB_ID)
        },
      }
    },
  )

  const tabCache = new Map<string, Map<string, BuiltinPanelTab>>()

  const makeTab = (session: MountedSession, id: string): BuiltinPanelTab => {
    const item = createMemo(() => itemsOf(session).find((entry) => entry.id === id))
    const labelText = () => item()?.title ?? ctx.t("tab.empty")

    return {
      id,
      get title() {
        return labelText()
      },
      label: () => (
        <div class="flex items-center gap-1.5">
          <Icon name="flask" size="small" />
          <span class="max-w-40 truncate">{labelText()}</span>
        </div>
      ),
      group: "sandbox",
      dom: {
        tab: `session-side-panel-sandbox-tab-${id}`,
        panel: "session-side-panel-sandbox-tabpanel",
      },
    }
  }

  ctx.add(BuiltinPanel, {
    id: "main",
    region: "side",
    list(input) {
      const session = input.session
      if (input.open.length === 0) {
        tabCache.delete(session.key)
        return []
      }
      const prev = tabCache.get(session.key)
      const next = new Map(input.open.map((id) => [id, prev?.get(id) ?? makeTab(session, id)]))
      tabCache.set(session.key, next)
      return [...next.values()]
    },
    close(input) {
      tabCache.get(input.session.key)?.delete(input.tab.id)
    },
    render: (props) => {
      const item = createMemo(() => {
        const list = itemsOf(props.session)
        if (props.tab.id === EMPTY_TAB_ID) return list.at(-1)
        return list.find((entry) => entry.id === props.tab.id)
      })

      return (
        <Suspense>
          <SandboxPanelView
            session={props.session}
            screen={props.screen}
            item={item}
            onDelete={(id) => removeSandboxItem(props.session, id)}
          />
        </Suspense>
      )
    },
  })
}

export default setup
