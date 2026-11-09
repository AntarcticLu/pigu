import { createPromptProjectController } from "@/new-session/project/selector"
import { useNewSessionLocationDialog } from "@/new-session/location/dialog"
import { useTabs, type DraftTab } from "@/shell/tabs/tabs"
import { useLayout } from "@/shell/state/layout"
import { useSearchParams } from "@solidjs/router"
import { batch, createEffect, createMemo, createResource, on, onCleanup, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { ResizeHandle } from "@opencode/ui/resize-handle"
import { createComposerModel } from "@/composer/model"
import { useComposerCommands } from "@/composer/commands"
import { useSessionModel } from "@/session/model"
import { SESSION_PANEL_WIDTH_MIN } from "@/session/session-panel-width"
import { createSessionScreenLayout } from "@/session/screen-layout"
import { reviewGlyphFill, SessionReviewToggle } from "@/session/header/session-header-actions"
import { PluginLinks } from "@/runtime/plugin/render"
import { createPanelSidebar, createRegion } from "@/runtime/plugin/panels"
import { usePluginAttachment } from "@/runtime/plugin/host-apis"
import { createMountedSession } from "@/runtime/plugin/mounted-session"
import { SideRegion } from "@/runtime/plugin/side-region"
import { createPaneDrag } from "@/runtime/plugin/pane-drag"
import { createPanelMotion, holdLandingWidth, panelOpacity, setPanelResizing } from "@/shell/panel-motion"
import { createNewSessionComposerAdapter, createNewSessionStartStore } from "./composer-adapter"
import { NewSessionView } from "./view"
import { createNewSessionWorkspaceController } from "./workspace/controller"
import { useNewSessionCommands } from "./commands"
import { createDraftMcpControls } from "./mcp"

/** The draft-only Session page. Submitting promotes the draft into a real Session. */
export default function NewSessionPage(props: { draftId: string }) {
  const [search, setSearch] = useSearchParams<{ draftId?: string; prompt?: string }>()
  const tabs = useTabs()
  const layout = useLayout()
  const session = useSessionModel()
  const mounted = createMountedSession(session)
  const attachment = usePluginAttachment()
  const isDesktop = session.isDesktop
  const sidebar = createPanelSidebar()

  const [store, setStore] = createStore<{ sideMounted: boolean }>({
    sideMounted: false,
  })

  const region = createRegion({
    region: "side",
    view: mounted.view,
    screen: mounted.screen,
    tabs: session.layout.tabs,
    closed: attachment.closed,
    open: (key) => attachment.openTab(key, mounted.view()),
    side: () => session.layout.view().side,
    onEmptied: () => {
      if (!session.layout.view().side.opened()) return
      session.layout.view().side.toggle()
      sideMotion.sync(false)
    },
    settled: (run) => sideMotion.whenSettled(run),
  })

  onCleanup(attachment.region(region))

  const drag = createPaneDrag({
    identity: session.layout.tabKey,
    shown: (pane) => (pane === "bottom" ? false : region.pane(pane).keys().length > 0),
    drop: (key, target) =>
      batch(() => {
        session.layout.tabs().move(key, target.pane, target.before)
      }),
  })

  const screen = createSessionScreenLayout(session, {
    wide: region.wide,
    panel: region.pane("side").selected,
    widths: layout.panelWidth,
  })

  const sideVisible = createMemo(() => isDesktop() && screen.side.open())
  const chatOpenWidth = createMemo<string>((previous) => (sideVisible() ? screen.panel.width() : previous), "100%")
  let chat: HTMLDivElement | undefined
  let sidePresence: HTMLDivElement | undefined
  let sideContent: HTMLDivElement | undefined
  let sideGlyph: SVGPathElement | undefined
  let sideClosed = 0

  holdLandingWidth(
    () => sideContent,
    "blocks",
    () => sideContent?.querySelector<HTMLElement>('[data-slot="session-review-content"]'),
  )

  const paintSideGlyph = () => sideGlyph?.setAttribute("transform", reviewGlyphFill(1 - sideClosed))

  const sideMotion = createPanelMotion({
    open: sideVisible,
    identity: session.layout.tabKey,
    paint: (closed) => {
      sideClosed = closed
      paintSideGlyph()

      if (sideContent) sideContent.style.opacity = panelOpacity(closed)

      if (!chat) return
      const open = chatOpenWidth()

      if (closed === 1) {
        chat.style.width = "100%"

        return
      }

      chat.style.width = closed === 0 ? open : `calc(${open} + (100% - ${open}) * ${closed})`
    },
    element: () => sidePresence,
    distance: screen.side.width,
  })

  createEffect(() => {
    if (screen.side.open()) setStore("sideMounted", true)
  })

  const draftTab = createMemo(() =>
    tabs.store.find((tab): tab is DraftTab => tab.type === "draft" && tab.draftID === search.draftId),
  )

  const workspace = createNewSessionWorkspaceController({
    selectedWorktree: () => draftTab()?.worktree,
    selectedBranch: () => draftTab()?.branch,
    setSelectedWorktree: (worktree) => {
      if (search.draftId) tabs.updateDraft(search.draftId, { worktree })
    },
    setSelectedBranch: (branch) => {
      if (search.draftId) tabs.updateDraft(search.draftId, { branch })
    },
  })

  const start = tabs.state(tabs.draft(props.draftId), "new-session-start", createNewSessionStartStore)

  const mcp = createDraftMcpControls({
    draftID: props.draftId,
    worktree: workspace.selection.value,
    preparing: () => start.view().preparingMcp,
  })

  const composer = createNewSessionComposerAdapter({
    draftID: props.draftId,
    worktree: workspace.selection.value,
    branch: workspace.bar.branch,
    submitted: workspace.selection.remember,
    mcp,
    start,
  })

  const model = createComposerModel(composer.adapter)
  useComposerCommands({ model: composer.model })

  const project = createPromptProjectController({ controls: composer.project })
  const location = useNewSessionLocationDialog({ project, workspace, onDone: model.restoreFocus })

  useNewSessionCommands({
    restoreFocus: model.restoreFocus,
    toggleReview: region.toggle,
    project: {
      empty: project.empty,
      open: () => location(),
    },
    workspace: {
      enabled: workspace.bar.visible,
      cycle: workspace.selection.cycle,
    },
  })
  // Focus once the draft loads. restoreFocus reads the stored cursor, so tracking it here would reapply
  // a stale cursor a frame after every key-up and yank the caret from a key pressed in that frame.
  createEffect(
    on(composer.ready, (ready) => {
      if (!ready) return

      // Search projects opened this draft; the picker returns focus to the composer when it closes.
      if (layout.draft.projectSearch.take()) location()
      else model.restoreFocus()
    }),
  )
  createEffect(() => {
    if (!composer.ready()) return
    untrack(() => {
      const text = search.prompt

      if (!text) return
      composer.adapter.state.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
      setSearch({ ...search, prompt: undefined })
    })
  })
  const ready = Promise.resolve()

  const [suspendUntilPromptReady] = createResource(
    () => composer.ready.promise ?? ready,
    (promise) => promise.then(() => true),
  )

  return (
    <PluginLinks session={mounted.view()}>
      <div class="relative size-full overflow-hidden flex flex-col">
        {suspendUntilPromptReady()}
        <div class="flex-1 min-h-0 flex flex-col gap-2 px-[var(--shell-inline-inset,8px)] pb-[var(--shell-bottom-inset,8px)] pt-[var(--shell-top-inset,8px)]">
          <div ref={screen.panel.ref} data-pane-row class="relative flex-1 min-h-0 flex flex-col md:flex-row gap-0">
            <Show when={isDesktop()}>
              <div
                class="absolute end-[var(--session-header-inset-end,12px)] top-0 z-30 h-12 flex items-center gap-2"
                data-slot="session-review-toggle"
              >
                <SessionReviewToggle
                  onToggle={region.toggle}
                  glyph={(fill) => {
                    sideGlyph = fill
                    paintSideGlyph()
                  }}
                />
              </div>
            </Show>
            <div
              ref={chat}
              class="relative z-10 min-w-0 shrink-0 flex flex-col min-h-0 h-full flex-1 md:flex-none"
              data-slot="session-chat-panel"
            >
              <NewSessionView
                composer={model}
                project={project}
                workspace={workspace}
                location={location}
                connectedEnd={sideMotion.present()}
              />
              <div classList={{ hidden: !screen.panel.resizable() }} onPointerDown={() => screen.size.start()}>
                <ResizeHandle
                  class="end-0"
                  direction="horizontal"
                  size={screen.panel.resizedWidth()}
                  min={SESSION_PANEL_WIDTH_MIN}
                  max={screen.panel.max()}
                  onResize={(width) => {
                    screen.size.touch()
                    screen.panel.resize(width)
                  }}
                  onDraggingChange={setPanelResizing}
                />
              </div>
            </div>
            <Show when={sideMotion.present() || store.sideMounted}>
              <div
                ref={sidePresence}
                data-slot="session-side-panel-presence"
                class={`z-0 min-w-0 h-full overflow-visible ${
                  !sideMotion.present()
                    ? "absolute inset-y-0 end-0 w-0 [content-visibility:hidden]"
                    : "relative flex-1"
                }`}
              >
                <div
                  ref={sideContent}
                  data-slot="session-side-panel-content"
                  class="absolute inset-y-0 start-0 size-full [contain:layout_style] will-change-[opacity]"
                >
                  <div data-slot="session-side-region" class="absolute inset-0 min-h-0 overflow-visible">
                    <Show when={store.sideMounted}>
                      <div data-slot="session-side-region-presence" class="absolute inset-0">
                        <SideRegion
                          screen={mounted.screen}
                          view={mounted.view()}
                          region={region}
                          sidebar={sidebar}
                          present={sideMotion.present()}
                          size={screen.size}
                          contentWidth={screen.side.contentWidth}
                          drag={drag}
                        />
                      </div>
                    </Show>
                  </div>
                </div>
              </div>
            </Show>
          </div>
        </div>
        <drag.Layer />
      </div>
    </PluginLinks>
  )
}
