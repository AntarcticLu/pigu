import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Menu } from "@opencode/ui/menu"
import { Loader } from "@opencode/ui/loader"
import { cleanReleaseSemver, compareReleaseSemver } from "@opencode/util/semver"
import { createMemo, createSignal, Show } from "solid-js"
import { createKeyed, usePlugin, type ServerRow } from "@opencode/plugin/gui"
import type { SshUpdateInfo } from "./contract"
import { sshName } from "./name"
import type { SshController } from "./state"

export default function SshRow(props: { row: ServerRow; id: string; ssh: SshController }) {
  const plugin = usePlugin()
  const pending = () => props.ssh.pending(props.id)
  const [updateInfo, setUpdateInfo] = createSignal<SshUpdateInfo | undefined>(undefined)
  const [checking, setChecking] = createSignal(false)
  const [upgrading, setUpgrading] = createSignal(false)
  const tracker = { token: 0 }

  const liveHealthVer = createMemo(() => cleanReleaseSemver(props.row.health()?.version))
  const displayVersion = createMemo(() => liveHealthVer() ?? updateInfo()?.currentVersion)

  const runCheck = (knownVer?: string) => {
    const reqToken = ++tracker.token
    setChecking(true)
    void props.ssh
      .checkUpdate(props.id, knownVer ?? liveHealthVer())
      .then((next) => {
        if (tracker.token !== reqToken) return
        setUpdateInfo(next)
      })
      .finally(() => {
        if (tracker.token === reqToken) setChecking(false)
      })
  }

  return (
    <Show when={props.ssh.item(props.id)}>
      {(item) => {
        createKeyed(
          () => (item().stage === "ready" ? `ready:${liveHealthVer() ?? ""}` : undefined),
          () => runCheck(liveHealthVer()),
        )

        const indicator = () => {
          if (item().stage === "ready") return props.row.health() ?? { healthy: true }

          if (item().stage === "incompatible") return { healthy: false, incompatible: true }

          if (item().stage === "failed") return { healthy: false }

          return undefined
        }

        const availableVersion = createMemo(() => {
          const latest = updateInfo()?.latestVersion
          const cur = displayVersion()
          if (!latest || !cur) return undefined
          return compareReleaseSemver(cur, latest) === -1 ? latest : undefined
        })

        const isOffline = () =>
          item().stage === "disconnected" ||
          item().stage === "failed" ||
          props.row.health()?.healthy === false ||
          updateInfo()?.status === "offline"

        const handleRetry = () => {
          if (item().stage !== "ready" || props.row.health()?.healthy === false) {
            props.ssh.connect(item().config, {
              onConnected: (ready) => {
                if (ready) {
                  runCheck()
                  return
                }
                setUpdateInfo({ status: "offline", currentVersion: displayVersion() })
              },
            })
            return
          }
          runCheck()
        }

        const handleUpgrade = (version: string) => {
          setUpgrading(true)
          props.ssh.upgrade(item().config, version, (ready) => {
            setUpgrading(false)
            if (ready) {
              runCheck()
              return
            }
            setUpdateInfo({ status: "offline", currentVersion: displayVersion() })
          })
        }

        return (
          <div class="settings-servers-row">
            <div class="settings-servers-lead !items-center">
              <props.row.Indicator
                health={indicator()}
                connecting={item().stage === "connecting"}
                auth={item().stage === "authentication"}
              />
              <div class="settings-servers-copy">
                <span class="flex min-w-0 items-center gap-1.5">
                  <bdi class="settings-servers-name truncate" dir={item().config.name ? "auto" : "ltr"}>
                    {sshName(item().config)}
                  </bdi>
                  <span class="shrink-0 rounded-[3px] border border-v2-border-border-base px-1 py-0.5 text-[9px] leading-none text-v2-text-text-muted">
                    {plugin.t("label")}
                  </span>
                  <Show when={displayVersion()}>
                    {(ver) => (
                      <span
                        data-slot="ssh-server-version"
                        class="shrink-0 rounded-[3px] bg-v2-overlay-simple-overlay-hover/60 px-1.5 py-0.5 font-mono text-[10px] leading-none text-v2-text-text-muted tabular-nums"
                      >
                        v{ver()}
                      </span>
                    )}
                  </Show>
                </span>
                <Show when={item().stage === "authentication"}>
                  <span class="settings-servers-meta">{plugin.t("stage.authentication")}</span>
                </Show>
              </div>
            </div>
            <div class="settings-servers-actions">
              <Show
                when={item().stage === "authentication"}
                fallback={
                  <Show
                    when={upgrading()}
                    fallback={
                      <Show
                        when={pending() || item().stage === "connecting" || checking()}
                        fallback={
                          <Show
                            when={isOffline()}
                            fallback={
                              <Show
                                when={availableVersion()}
                                fallback={
                                  <Button size="small" variant="ghost-muted" disabled>
                                    {plugin.t("update.latest")}
                                  </Button>
                                }
                              >
                                {(ver) => (
                                  <Button size="small" variant="contrast" onClick={() => handleUpgrade(ver())}>
                                    {plugin.t("update.available", { version: ver() })}
                                  </Button>
                                )}
                              </Show>
                            }
                          >
                            <Button size="small" variant="outline" onClick={handleRetry}>
                              {plugin.t("update.offlineRetry")}
                            </Button>
                          </Show>
                        }
                      >
                        <Button size="small" variant="outline" disabled aria-busy={true}>
                          <Loader class="size-3.5" />
                          {pending() || item().stage === "connecting"
                            ? plugin.t("session.connecting")
                            : plugin.t("update.checking")}
                        </Button>
                      </Show>
                    }
                  >
                    <Button size="small" variant="contrast" disabled aria-busy={true}>
                      <Loader class="size-3.5" />
                      {plugin.t("update.upgrading")}
                    </Button>
                  </Show>
                }
              >
                <Button size="small" variant="ghost-muted" onClick={() => props.ssh.connect(item().config)}>
                  {plugin.t("action.authenticate")}
                </Button>
              </Show>
              <Menu gutter={4} modal={false} placement="bottom-end">
                <Menu.Trigger
                  as={IconButton}
                  variant="ghost-muted"
                  size="small"
                  icon={<Icon name="outline-dots" />}
                  aria-label={plugin.t("common.moreOptions")}
                />
                <Menu.Portal>
                  <Menu.Content>
                    <Menu.Group>
                      <props.row.Items />
                      <Menu.Separator />
                      <Menu.Item onSelect={() => void props.row.remove()}>{plugin.t("menu.delete")}</Menu.Item>
                    </Menu.Group>
                  </Menu.Content>
                </Menu.Portal>
              </Menu>
            </div>
          </div>
        )
      }}
    </Show>
  )
}
