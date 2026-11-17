import { Button } from "@opencode/ui/button"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { Switch } from "@opencode/ui/switch"
import { TextInput, type TextInputProps } from "@opencode/ui/text-input"
import { useDialog } from "@opencode/ui/context/dialog"
import { type Component, createEffect, createMemo, createSignal, For, onCleanup, Show, splitProps } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { useGlobal, type ServerCtx } from "@/runtime/server/runtime"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { SettingsList } from "@/settings/list"
import { SettingsRow } from "@/settings/row"
import { showToast } from "@/shell/notifications/toast"
import "@/settings/settings.css"

type SdkApi = ServerCtx["sdk"]["api"]
type MobileRobotView = Awaited<ReturnType<SdkApi["experimental"]["mobile"]["list"]>>[number]
type MobileSettingsView = Awaited<ReturnType<SdkApi["experimental"]["mobile"]["settings"]>>
type MobilePlatform = "feishu" | "weixin" | "dingtalk" | "wecom" | "qqbot"

const LabeledInput: Component<TextInputProps & { label: string }> = (props) => {
  const [local, inputProps] = splitProps(props, ["label", "class"])

  return (
    <div class="flex flex-col gap-1.5">
      <label class="text-[13px] font-[530] leading-5 text-v2-text-text-base">{local.label}</label>
      <TextInput {...inputProps} class={local.class ? `!w-full self-stretch ${local.class}` : "!w-full self-stretch"} />
    </div>
  )
}

const PLATFORMS: ReadonlyArray<{
  id: MobilePlatform
  shortZh: string
  shortEn: string
  zhName: string
  enName: string
  badgeZh: string
  badgeEn: string
}> = [
  {
    id: "feishu",
    shortZh: "飞书",
    shortEn: "Feishu",
    zhName: "飞书 / Lark",
    enName: "Feishu / Lark",
    badgeZh: "推荐 · 手机扫码即连",
    badgeEn: "Recommended · Scan QR",
  },
  {
    id: "weixin",
    shortZh: "个人微信",
    shortEn: "WeChat",
    zhName: "个人微信",
    enName: "WeChat (iLink)",
    badgeZh: "推荐 · 手机扫码即连",
    badgeEn: "Recommended · Scan QR",
  },
  {
    id: "dingtalk",
    shortZh: "钉钉",
    shortEn: "DingTalk",
    zhName: "钉钉机器人",
    enName: "DingTalk",
    badgeZh: "免公网 Stream 长连接",
    badgeEn: "Stream WebSocket",
  },
  {
    id: "wecom",
    shortZh: "企业微信",
    shortEn: "WeCom",
    zhName: "企业微信",
    enName: "WeCom",
    badgeZh: "智能机器人长连接",
    badgeEn: "Smart Bot WebSocket",
  },
  {
    id: "qqbot",
    shortZh: "QQ",
    shortEn: "QQ Bot",
    zhName: "QQ 机器人",
    enName: "QQ Bot",
    badgeZh: "官方长连接",
    badgeEn: "Official WebSocket",
  },
]

const COMMAND_CHEAT_SHEET = [
  {
    cmds: [".p", ".p new"],
    titleZh: "查看并切换本机或 SSH 服务器项目",
    titleEn: "List and switch local or SSH server projects",
  },
  {
    cmds: [".c", ".new", ".undo"],
    titleZh: "切换项目会话、新建会话或撤回上一轮修改",
    titleEn: "Switch session, create a new chat, or revert last turn",
  },
  {
    cmds: [".m", ".m 1.1"],
    titleZh: "查看当前设备的厂家列表并按编号切换模型",
    titleEn: "Browse device vendors and switch model by index",
  },
  {
    cmds: [".send"],
    titleZh: "将电脑或远程服务器上的文件直接发回手机",
    titleEn: "Send files from desktop or SSH server to phone chat",
  },
  {
    cmds: [".sh"],
    titleZh: "直接在当前项目目录执行终端命令",
    titleEn: "Run shell commands directly in active project directory",
  },
  {
    cmds: [".access", ".whoami"],
    titleZh: "管理群聊白名单成员权限与查看当前身份",
    titleEn: "Manage group allowlist permissions and check user role",
  },
  {
    cmds: [".log", ".ps"],
    titleZh: "抽查实时执行步骤 / 在运行中途补充指令",
    titleEn: "Inspect live execution steps or steer mid-run",
  },
  {
    cmds: [".stop", ".skip"],
    titleZh: "立即停止当前任务 / 按推荐方案跳过待确认提问",
    titleEn: "Stop active generation or skip pending question",
  },
  {
    cmds: [".help"],
    titleZh: "打开手机端控制中心状态面板",
    titleEn: "Open mobile control center overview card",
  },
] as const

function platformMeta(platform: string) {
  const normalized = platform === "lark" ? "feishu" : platform

  return PLATFORMS.find((p) => p.id === normalized) ?? PLATFORMS[0]
}

export const SettingsMobile: Component<{ active: boolean }> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()
  const dialog = useDialog()
  const global = useGlobal()
  const servers = useServers()

  const [robots, setRobots] = createSignal<MobileRobotView[]>([])
  const [mobileSettings, setMobileSettings] = createSignal<MobileSettingsView>({
    preventSleep: true,
    active: false,
  })

  const localApi = createMemo(() => {
    const localConn = servers.list.find((conn) => servers.local(conn))

    if (!localConn) return undefined

    return global.serverCtx(ServerConnection.key(localConn))?.sdk.api
  })

  const refresh = async () => {
    const api = localApi()

    if (!api) return
    const [list, settings] = await Promise.all([
      api.experimental.mobile.list().catch(() => undefined),
      api.experimental.mobile.settings().catch(() => undefined),
    ])

    if (list) setRobots(list)
    if (settings) {
      setMobileSettings(settings)
      void platform.setPreventSleep?.(settings.active).catch(() => undefined)
    }
  }

  createEffect(() => {
    if (!props.active) return
    void refresh()
    const timer = setInterval(() => {
      void refresh()
    }, 3000)
    onCleanup(() => clearInterval(timer))
  })

  const copyMigrationCode = async (robot: MobileRobotView) => {
    if (!robot.migrationCode) return
    await navigator.clipboard.writeText(robot.migrationCode).catch(() => undefined)
    showToast({
      variant: "success",
      title: language.tr("已复制迁移码", "Migration code copied"),
      description: language.tr(
        `机器人「${robot.name}」配置已复制到剪贴板。`,
        `Robot "${robot.name}" configuration copied to clipboard.`,
      ),
    })
  }

  const togglePreventSleep = async (preventSleep: boolean) => {
    const api = localApi()

    if (!api) return
    const next = await api.experimental.mobile.updateSettings({ preventSleep }).catch((err) => {
      showToast({
        variant: "error",
        title: language.tr("保存设置失败", "Failed to save setting"),
        description: err instanceof Error ? err.message : String(err),
      })

      return undefined
    })

    if (!next) return
    setMobileSettings(next)
    void platform.setPreventSleep?.(next.active).catch(() => undefined)
  }

  const toggleRobot = async (robot: MobileRobotView, enabled: boolean) => {
    const api = localApi()

    if (!api) return
    await api.experimental.mobile.update({ robotID: robot.id, enabled }).catch((err) => {
      showToast({
        variant: "error",
        title: language.tr("切换状态失败", "Failed to toggle robot"),
        description: err instanceof Error ? err.message : String(err),
      })
    })
    await refresh()
  }

  const deleteRobot = async (robot: MobileRobotView) => {
    const api = localApi()

    if (!api) return
    await api.experimental.mobile.delete({ robotID: robot.id }).catch((err) => {
      showToast({
        variant: "error",
        title: language.tr("删除失败", "Failed to remove robot"),
        description: err instanceof Error ? err.message : String(err),
      })
    })
    showToast({
      variant: "success",
      title: language.tr("已删除机器人", "Robot removed"),
      description: robot.name,
    })
    await refresh()
  }

  const openAddWizard = () => {
    const api = localApi()

    if (!api) return
    void dialog.show(() => (
      <DialogAddMobileRobot
        api={api}
        onSaved={() => {
          void refresh()
        }}
      />
    ))
  }

  const openImportDialog = () => {
    const api = localApi()

    if (!api) return
    void dialog.show(() => (
      <DialogImportMigrationCode
        api={api}
        onSaved={() => {
          void refresh()
        }}
      />
    ))
  }

  const openEditDialog = (robot: MobileRobotView) => {
    const api = localApi()

    if (!api) return
    void dialog.show(() => (
      <DialogEditMobileRobot
        api={api}
        robot={robot}
        onSaved={() => {
          void refresh()
        }}
      />
    ))
  }

  return (
    <>
      <div class="settings-tab-header">
        <div class="settings-tab-header-row">
          <div class="flex min-w-0 flex-col">
            <h2 class="settings-tab-title">{language.tr("手机端", "Mobile")}</h2>
          </div>
          <div class="settings-tab-header-actions">
            <Button size="small" variant="neutral" icon="download" onClick={openImportDialog}>
              {language.tr("导入迁移码", "Import Code")}
            </Button>
            <Button size="small" variant="outline" icon="plus" onClick={openAddWizard}>
              {language.tr("添加机器人", "Add Robot")}
            </Button>
          </div>
        </div>
      </div>

      <div class="settings-tab-body settings-tab-body--sectioned">
        <section class="settings-section">
          <h3 class="settings-section-title">
            {language.tr("机器人通道", "Robot Channels")}
            <Show when={robots().length > 0}>{` (${robots().length})`}</Show>
          </h3>

          <Show
            when={robots().length > 0}
            fallback={
              <SettingsList>
                <SettingsRow
                  title={language.tr(
                    "添加飞书、微信、钉钉、企业微信或 QQ 机器人远程控制本机与 SSH 服务器",
                    "Connect Feishu, WeChat, DingTalk, WeCom, or QQ to control local and SSH projects",
                  )}
                >
                  <Button size="small" variant="outline" onClick={openAddWizard}>
                    {language.tr("添加机器人", "Add Robot")}
                  </Button>
                </SettingsRow>
              </SettingsList>
            }
          >
            <SettingsList variant="catalog">
              <For each={robots()}>
                {(robot) => {
                  const meta = () => platformMeta(robot.platform)
                  const isStopped = () => !robot.enabled || robot.status.state === "stopped"
                  const isConnected = () => !isStopped() && robot.status.state === "connected"
                  const isConnecting = () => !isStopped() && robot.status.state === "connecting"
                  const isError = () => !isStopped() && robot.status.state === "error"

                  const statusText = () => {
                    if (isStopped()) return language.tr("已停用", "Stopped")

                    if (isConnected()) return language.tr("已连接", "Connected")

                    if (isConnecting()) return language.tr("连接中", "Connecting")

                    return language.tr("连接异常", "Error")
                  }

                  return (
                    <div
                      class="settings-extension-row settings-mcp-row"
                      data-status={isStopped() ? "disabled" : isConnected() ? "connected" : "pending"}
                    >
                      <div class="settings-extension-lead min-w-0 flex-1">
                        <span class="settings-mcp-status">
                          <span
                            classList={{
                              "size-1.5 rounded-full shrink-0": true,
                              "bg-icon-success-base": isConnected(),
                              "bg-icon-warning-base": isConnecting(),
                              "bg-icon-critical-base": isError(),
                              "bg-v2-icon-icon-faint": isStopped(),
                            }}
                            aria-hidden="true"
                          />
                        </span>

                        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                          <div class="flex min-w-0 items-center gap-2">
                            <span class="settings-extension-name truncate">{robot.name}</span>
                            <span class="shrink-0 rounded-[3px] border border-v2-border-border-base px-1.5 py-0.5 text-[11px] leading-none text-v2-text-text-muted">
                              {language.tr(meta().shortZh, meta().shortEn)}
                            </span>
                            <span
                              class="shrink-0 text-[12px]"
                              classList={{
                                "text-v2-text-text-muted": !isError(),
                                "text-[var(--v2-state-fg-danger)]": isError(),
                              }}
                            >
                              {statusText()}
                            </span>
                            <Show when={!robot.ownerID}>
                              <span class="shrink-0 rounded-[3px] border border-v2-border-border-base px-1.5 py-0.5 text-[11px] leading-none text-v2-text-text-muted">
                                {language.tr("待手机首条消息认领", "Send first message to claim")}
                              </span>
                            </Show>
                          </div>

                          <Show when={isError() && robot.status.error}>
                            <span class="truncate font-mono text-[11px] text-[var(--v2-state-fg-danger)]">
                              {robot.status.error}
                            </span>
                          </Show>
                        </div>
                      </div>

                      <div class="settings-extension-trailing flex items-center gap-1.5">
                        <Show when={robot.migrationCode}>
                          <Button size="small" variant="ghost-muted" onClick={() => void copyMigrationCode(robot)}>
                            {language.tr("迁移码", "Code")}
                          </Button>
                        </Show>
                        <Button size="small" variant="ghost-muted" onClick={() => openEditDialog(robot)}>
                          {language.tr("编辑", "Edit")}
                        </Button>
                        <Button size="small" variant="ghost-muted" onClick={() => void deleteRobot(robot)}>
                          {language.tr("删除", "Delete")}
                        </Button>
                        <Switch
                          checked={robot.enabled}
                          class="[&_[data-slot=switch-description]]:sr-only"
                          onChange={(checked) => void toggleRobot(robot, checked)}
                          aria-label={language.tr("启用机器人", "Enable robot")}
                        >
                          <span class="sr-only">{robot.name}</span>
                        </Switch>
                      </div>
                    </div>
                  )
                }}
              </For>
            </SettingsList>
          </Show>
        </section>

        <section class="settings-section">
          <h3 class="settings-section-title">{language.tr("运行守护", "Keep-Awake")}</h3>
          <SettingsList>
            <SettingsRow
              title={
                <span class="inline-flex items-center gap-2">
                  <span>
                    {language.tr(
                      "远控在线时阻止电脑自动休眠（不影响屏幕正常息屏）",
                      "Prevent computer sleep while mobile bots are active (display still sleeps)",
                    )}
                  </span>
                  <Show when={mobileSettings().active}>
                    <span class="rounded-[3px] border border-v2-border-border-base px-1.5 py-0.5 text-[11px] leading-none text-icon-success-base">
                      {language.tr("守护中", "Active")}
                    </span>
                  </Show>
                </span>
              }
            >
              <Switch
                checked={mobileSettings().preventSleep}
                class="[&_[data-slot=switch-description]]:sr-only"
                onChange={(checked) => void togglePreventSleep(checked)}
                aria-label={language.tr("阻止电脑自动休眠", "Prevent computer sleep")}
              >
                <span class="sr-only">{language.tr("阻止电脑自动休眠", "Prevent computer sleep")}</span>
              </Switch>
            </SettingsRow>
          </SettingsList>
        </section>

        <section class="settings-section">
          <h3 class="settings-section-title">
            {language.tr("手机聊天指令（直接发文字即可对话）", "Chat Commands (Plain text chats directly)")}
          </h3>

          <SettingsList variant="catalog">
            <For each={COMMAND_CHEAT_SHEET}>
              {(item) => (
                <div class="flex min-h-10 items-center justify-between gap-4 border-b-[0.5px] border-v2-border-border-base py-2 last:border-b-0">
                  <span class="truncate text-[13px] font-[530] leading-5 text-v2-text-text-base">
                    {language.tr(item.titleZh, item.titleEn)}
                  </span>
                  <div class="flex shrink-0 items-center gap-1.5">
                    <For each={item.cmds}>
                      {(c) => (
                        <code class="rounded border border-v2-border-border-base bg-v2-background-bg-layer-02 px-2 py-0.5 font-mono text-[12px] text-v2-text-text-base">
                          {c}
                        </code>
                      )}
                    </For>
                  </div>
                </div>
              )}
            </For>
          </SettingsList>
        </section>
      </div>
    </>
  )
}

/* ============================================================================
 * Dialog: Import AL-ROBOT-1 Migration Code
 * ========================================================================== */

const DialogImportMigrationCode: Component<{
  api: SdkApi
  onSaved: () => void
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const [code, setCode] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")

  const submit = async () => {
    const raw = code().trim()

    if (!raw) {
      setError(language.tr("请粘贴 AL-ROBOT-1 或 AL-FEISHU-1 迁移码", "Please paste an AL-ROBOT-1 migration code"))

      return
    }

    setBusy(true)
    setError("")
    const res = await props.api.experimental.mobile
      .importCode({
        code: raw,
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err))

        return undefined
      })
    setBusy(false)

    if (!res) return
    showToast({
      variant: "success",
      title: language.tr("迁移码导入成功", "Migration code imported"),
      description: `${res.name} (${res.platform})`,
    })
    dialog.close()
    props.onSaved()
  }

  return (
    <Dialog fit containerClass="!w-[min(94vw,480px)] !rounded-[12px]">
      <DialogHeader>
        <DialogTitle>{language.tr("粘贴迁移码导入机器人", "Import Robot via Migration Code")}</DialogTitle>
      </DialogHeader>
      <DialogBody class="flex flex-col gap-3 px-4 pb-2 pt-0">
        <div class="flex flex-col gap-1.5">
          <label class="text-[13px] font-[530] leading-5 text-v2-text-text-base">
            {language.tr("迁移码", "Migration Code")}
          </label>
          <textarea
            value={code()}
            onInput={(e) => setCode(e.currentTarget.value)}
            placeholder="AL-ROBOT-1.eyJwIj..."
            rows={4}
            class="w-full rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-01 p-2.5 font-mono text-xs text-v2-text-text-base focus:outline-none"
          />
        </div>

        <Show when={error()}>
          <div class="text-xs text-[var(--v2-state-fg-danger)]">{error()}</div>
        </Show>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost-muted" onClick={() => dialog.close()}>
          {language.tr("取消", "Cancel")}
        </Button>
        <Button variant="contrast" disabled={busy()} onClick={() => void submit()}>
          {busy() ? language.tr("正在导入...", "Importing...") : language.tr("导入并启动", "Import & Start")}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

/* ============================================================================
 * Dialog: 2-Step Add Mobile Robot Wizard
 * ========================================================================== */

const DialogAddMobileRobot: Component<{
  api: SdkApi
  onSaved: () => void
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()

  const [step, setStep] = createSignal<1 | 2>(1)
  const [platform, setPlatform] = createSignal<MobilePlatform>("feishu")
  const [mode, setMode] = createSignal<"qr" | "manual">("qr")

  const [name, setName] = createSignal("")
  const [ownerId, setOwnerId] = createSignal("")
  const [feishuAppId, setFeishuAppId] = createSignal("")
  const [feishuAppSecret, setFeishuAppSecret] = createSignal("")
  const [feishuDomain, setFeishuDomain] = createSignal("feishu")
  const [weixinToken, setWeixinToken] = createSignal("")
  const [weixinBaseUrl, setWeixinBaseUrl] = createSignal("https://ilinkai.weixin.qq.com")
  const [weixinAccountId, setWeixinAccountId] = createSignal("")
  const [dingtalkClientId, setDingtalkClientId] = createSignal("")
  const [dingtalkClientSecret, setDingtalkClientSecret] = createSignal("")
  const [wecomBotId, setWecomBotId] = createSignal("")
  const [wecomSecret, setWecomSecret] = createSignal("")
  const [qqbotAppId, setQqbotAppId] = createSignal("")
  const [qqbotAppSecret, setQqbotAppSecret] = createSignal("")
  const [qqbotSandbox, setQqbotSandbox] = createSignal(false)

  const [qrUrl, setQrUrl] = createSignal("")
  const [qrStatus, setQrStatus] = createSignal("")
  const [qrBusy, setQrBusy] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")

  const pollRef = { seq: 0, timer: undefined as ReturnType<typeof setTimeout> | undefined }
  const stopPolling = () => {
    pollRef.seq += 1

    if (pollRef.timer) {
      clearTimeout(pollRef.timer)
      pollRef.timer = undefined
    }
  }
  onCleanup(stopPolling)

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      pollRef.timer = setTimeout(() => {
        pollRef.timer = undefined
        resolve()
      }, ms)
    })

  const choosePlatform = (p: MobilePlatform) => {
    stopPolling()
    setPlatform(p)
    setError("")
    setQrUrl("")
    setQrStatus("")
    const meta = platformMeta(p)
    const trimmedName = name().trim()
    const isPresetName = !trimmedName || PLATFORMS.some((item) => item.zhName === trimmedName || item.enName === trimmedName)

    if (isPresetName) setName(language.tr(meta.zhName, meta.enName))
    const supportsQr = p === "feishu" || p === "weixin"
    setMode(supportsQr ? "qr" : "manual")
    setStep(2)

    if (p === "feishu") void startFeishuQr()

    if (p === "weixin") void startWeixinQr()
  }

  const startFeishuQr = async () => {
    stopPolling()
    const seq = pollRef.seq
    setQrBusy(true)
    setError("")
    setQrStatus(language.tr("正在向飞书开放平台申请扫码通道...", "Requesting Feishu QR registration session..."))
    const begin = await props.api.experimental.mobile.feishuQrBegin().catch((err) => {
      setError(err instanceof Error ? err.message : String(err))

      return undefined
    })

    if (pollRef.seq !== seq) return
    setQrBusy(false)

    if (!begin) return
    setQrUrl(begin.qrUrl || begin.verificationUrl)
    setQrStatus(
      language.tr(
        "使用手机飞书扫描二维码并确认，即可自动创建并接入机器人。",
        "Scan the QR code with the Feishu app and confirm to auto-create your bot.",
      ),
    )

    let currentBaseUrl = begin.baseUrl
    const delayMs = Math.max(2000, (begin.interval || 3) * 1000)

    while (pollRef.seq === seq) {
      await sleep(delayMs)

      if (pollRef.seq !== seq) return
      const res = await props.api.experimental.mobile
        .feishuQrPoll({ deviceCode: begin.deviceCode, baseUrl: currentBaseUrl })
        .catch(() => undefined)

      if (pollRef.seq !== seq) return

      if (!res) continue

      if (res.baseUrl) currentBaseUrl = res.baseUrl

      if (res.status === "completed" && res.appId && res.appSecret) {
        stopPolling()
        setFeishuAppId(res.appId)
        setFeishuAppSecret(res.appSecret)

        if (res.ownerOpenId) setOwnerId(res.ownerOpenId)

        if (res.botName) setName(res.botName)

        if (res.domain) setFeishuDomain(res.domain)
        setQrStatus(language.tr("扫码成功，正在保存并启动飞书机器人...", "Scan complete, saving robot..."))
        await saveRobot({
          platform: "feishu",
          name: res.botName || name() || "飞书机器人",
          ownerID: res.ownerOpenId || ownerId(),
          feishu: {
            appId: res.appId,
            appSecret: res.appSecret,
            domain: res.domain || "feishu",
          },
        })

        return
      }

      if (res.status === "expired" || res.status === "denied") {
        stopPolling()
        setError(res.message || language.tr("二维码已过期，请点击刷新重试", "QR code expired, please refresh"))

        return
      }
    }
  }

  const startWeixinQr = async () => {
    stopPolling()
    const seq = pollRef.seq
    setQrBusy(true)
    setError("")
    setQrStatus(language.tr("正在获取微信 iLink 登录二维码...", "Fetching WeChat iLink QR code..."))
    const begin = await props.api.experimental.mobile.weixinQrBegin().catch((err) => {
      setError(err instanceof Error ? err.message : String(err))

      return undefined
    })

    if (pollRef.seq !== seq) return
    setQrBusy(false)

    if (!begin) return
    setQrUrl(begin.qrUrl)
    setQrStatus(
      language.tr(
        "使用手机微信扫描二维码并在手机上确认授权。",
        "Scan the QR code with WeChat on your phone and confirm login.",
      ),
    )

    while (pollRef.seq === seq) {
      const res = await props.api.experimental.mobile
        .weixinQrPoll({ qrcodeKey: begin.qrcodeKey })
        .catch(() => undefined)

      if (pollRef.seq !== seq) return

      if (!res) {
        await sleep(2000)

        continue
      }

      if (res.status === "scanned") {
        setQrStatus(language.tr("已扫码，请在手机微信上点击确认登录...", "Scanned, please confirm on your phone..."))
        await sleep(1000)

        continue
      }

      if (res.status === "completed" && res.token) {
        stopPolling()
        setWeixinToken(res.token)

        if (res.baseUrl) setWeixinBaseUrl(res.baseUrl)

        if (res.botId) setWeixinAccountId(res.botId)

        if (res.userId) setOwnerId(res.userId)
        setQrStatus(language.tr("微信授权成功，正在启动个人微信通道...", "WeChat connected, starting bot..."))
        await saveRobot({
          platform: "weixin",
          name: name() || (res.botId ? `微信 (${res.botId})` : "个人微信助手"),
          ownerID: res.userId || ownerId(),
          weixin: {
            token: res.token,
            baseUrl: res.baseUrl || "https://ilinkai.weixin.qq.com",
            accountId: res.botId,
          },
        })

        return
      }

      if (res.status === "expired") {
        stopPolling()
        setError(language.tr("微信二维码已过期，请点击刷新", "WeChat QR code expired, please refresh"))

        return
      }

      await sleep(1500)
    }
  }

  const saveRobot = async (override?: Partial<Parameters<SdkApi["experimental"]["mobile"]["create"]>[0]>) => {
    if (busy()) return
    const p = override?.platform ?? platform()
    const payload: Parameters<SdkApi["experimental"]["mobile"]["create"]>[0] = {
      name: (override?.name ?? name().trim()) || platformMeta(p).zhName,
      platform: p,
      enabled: true,
      ownerID: (override?.ownerID ?? ownerId().trim()) || undefined,
      feishu:
        override?.feishu ??
        (p === "feishu" && feishuAppId().trim() && feishuAppSecret().trim()
          ? {
              appId: feishuAppId().trim(),
              appSecret: feishuAppSecret().trim(),
              domain: feishuDomain().trim() || "feishu",
            }
          : undefined),
      weixin:
        override?.weixin ??
        (p === "weixin" && weixinToken().trim()
          ? {
              token: weixinToken().trim(),
              baseUrl: weixinBaseUrl().trim() || "https://ilinkai.weixin.qq.com",
              accountId: weixinAccountId().trim() || undefined,
            }
          : undefined),
      dingtalk:
        p === "dingtalk" && dingtalkClientId().trim() && dingtalkClientSecret().trim()
          ? {
              clientId: dingtalkClientId().trim(),
              clientSecret: dingtalkClientSecret().trim(),
            }
          : undefined,
      wecom:
        p === "wecom" && wecomBotId().trim() && wecomSecret().trim()
          ? {
              botId: wecomBotId().trim(),
              secret: wecomSecret().trim(),
            }
          : undefined,
      qqbot:
        p === "qqbot" && qqbotAppId().trim() && qqbotAppSecret().trim()
          ? {
              appId: qqbotAppId().trim(),
              appSecret: qqbotAppSecret().trim(),
              sandbox: qqbotSandbox(),
            }
          : undefined,
    }

    if (p === "feishu" && !payload.feishu) {
      setError(language.tr("请填写飞书 App ID 和 App Secret，或使用扫码一键创建", "Please enter Feishu App ID & Secret"))

      return
    }

    if (p === "weixin" && !payload.weixin) {
      setError(language.tr("请先扫码获取微信 Bot Token 或手动填写", "Please scan QR or enter WeChat Bot Token"))

      return
    }

    if (p === "dingtalk" && !payload.dingtalk) {
      setError(language.tr("请填写钉钉 Client ID 和 Client Secret", "Please enter DingTalk Client ID & Secret"))

      return
    }

    if (p === "wecom" && !payload.wecom) {
      setError(language.tr("请填写企业微信 Bot ID 和 Secret", "Please enter WeCom Bot ID & Secret"))

      return
    }

    if (p === "qqbot" && !payload.qqbot) {
      setError(language.tr("请填写 QQ 机器人 App ID 和 App Secret", "Please enter QQ Bot App ID & Secret"))

      return
    }

    setBusy(true)
    setError("")
    const saved = await props.api.experimental.mobile.create(payload).catch((err) => {
      setError(err instanceof Error ? err.message : String(err))

      return undefined
    })
    setBusy(false)

    if (!saved) return
    showToast({
      variant: "success",
      title: language.tr("机器人已添加并启动", "Robot added and started"),
      description: `${saved.name} (${saved.shortCode})`,
    })
    dialog.close()
    props.onSaved()
  }

  const qrImageSrc = () => {
    const raw = qrUrl()

    if (!raw) return ""

    if (raw.startsWith("data:image/")) return raw

    return `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=10&data=${encodeURIComponent(raw)}`
  }

  return (
    <Dialog fit containerClass="!w-[min(94vw,540px)] !rounded-[12px]">
      <DialogHeader>
        <DialogTitle>
          {step() === 1
            ? language.tr("选择接入平台", "Select Mobile Platform")
            : `${language.tr("配置", "Configure")} · ${language.tr(platformMeta(platform()).zhName, platformMeta(platform()).enName)}`}
        </DialogTitle>
      </DialogHeader>
      <DialogBody class="flex max-h-[72vh] flex-col gap-3.5 overflow-y-auto px-4 pb-2 pt-0">
        <Show when={step() === 1}>
          <div class="flex flex-col divide-y divide-v2-border-border-muted/40 rounded-lg border border-v2-border-border-muted/80 bg-v2-background-bg-layer-01">
            <For each={PLATFORMS}>
              {(p) => (
                <button
                  type="button"
                  onClick={() => choosePlatform(p.id)}
                  class="flex w-full cursor-pointer items-center justify-between gap-3 px-3.5 py-3 text-left transition-colors first:rounded-t-lg last:rounded-b-lg hover:bg-v2-background-bg-layer-02"
                >
                  <div class="flex min-w-0 flex-1 items-center gap-2.5">
                    <span class="text-[13px] font-[530] text-v2-text-text-base">
                      {language.tr(p.zhName, p.enName)}
                    </span>
                    <span class="rounded-[3px] border border-v2-border-border-base bg-v2-background-bg-layer-02 px-1.5 py-0.5 text-[11px] leading-none text-v2-text-text-muted">
                      {language.tr(p.badgeZh, p.badgeEn)}
                    </span>
                  </div>
                  <Icon name="chevron-right" size="small" class="shrink-0 text-v2-icon-icon-muted" />
                </button>
              )}
            </For>
          </div>
        </Show>

        <Show when={step() === 2}>
          <Show when={platform() === "feishu" || platform() === "weixin"}>
            <div class="flex items-center gap-1 rounded-lg bg-v2-background-bg-layer-02 p-1">
              <button
                type="button"
                onClick={() => {
                  setMode("qr")

                  if (platform() === "feishu") void startFeishuQr()

                  if (platform() === "weixin") void startWeixinQr()
                }}
                class={`flex-1 cursor-pointer rounded-md py-1.5 text-12-medium transition-colors ${
                  mode() === "qr"
                    ? "bg-v2-background-bg-base text-v2-text-text-base"
                    : "text-v2-text-text-muted hover:text-v2-text-text-base"
                }`}
              >
                {language.tr("扫码快速接入", "QR Quick Setup")}
              </button>
              <button
                type="button"
                onClick={() => {
                  stopPolling()
                  setMode("manual")
                }}
                class={`flex-1 cursor-pointer rounded-md py-1.5 text-12-medium transition-colors ${
                  mode() === "manual"
                    ? "bg-v2-background-bg-base text-v2-text-text-base"
                    : "text-v2-text-text-muted hover:text-v2-text-text-base"
                }`}
              >
                {language.tr("手动填写凭证", "Manual Credentials")}
              </button>
            </div>
          </Show>

          <Show when={(platform() === "feishu" || platform() === "weixin") && mode() === "qr"}>
            <div class="flex flex-col items-center gap-3 rounded-lg border border-v2-border-border-muted/70 bg-v2-background-bg-layer-01 p-5 text-center">
              <Show
                when={qrImageSrc()}
                fallback={
                  <div class="flex h-[204px] w-[204px] items-center justify-center rounded-lg border border-dashed border-v2-border-border-muted text-12-regular text-v2-text-text-muted">
                    {qrBusy()
                      ? language.tr("正在生成二维码...", "Generating QR code...")
                      : language.tr("点击下方按钮获取二维码", "Click below to generate QR code")}
                  </div>
                }
              >
                <div class="rounded-lg bg-white p-2">
                  <img src={qrImageSrc()} alt="QR Code" class="h-[196px] w-[196px] object-contain" />
                </div>
              </Show>

              <p class="max-w-md text-12-regular leading-relaxed text-v2-text-text-muted">{qrStatus()}</p>

              <div class="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="small"
                  icon="refresh"
                  disabled={qrBusy()}
                  onClick={() => {
                    if (platform() === "feishu") void startFeishuQr()

                    if (platform() === "weixin") void startWeixinQr()
                  }}
                >
                  {language.tr("刷新二维码", "Refresh QR")}
                </Button>
                <Show when={platform() === "feishu" && qrUrl()}>
                  <a
                    href={qrUrl()}
                    target="_blank"
                    rel="noreferrer"
                    class="px-2 py-1 text-12-regular text-v2-text-text-accent hover:underline"
                  >
                    {language.tr("在浏览器中打开 ↗", "Open in Browser ↗")}
                  </a>
                </Show>
              </div>
            </div>
          </Show>

          <Show when={mode() === "manual" || (platform() !== "feishu" && platform() !== "weixin")}>
            <div class="flex flex-col gap-3">
              <LabeledInput
                label={language.tr("机器人名称", "Robot Name")}
                placeholder={platformMeta(platform()).zhName}
                value={name()}
                onInput={(e) => setName(e.currentTarget.value)}
              />

              <Show when={platform() === "feishu"}>
                <LabeledInput
                  label="Feishu App ID"
                  placeholder="cli_a9..."
                  value={feishuAppId()}
                  onInput={(e) => setFeishuAppId(e.currentTarget.value)}
                />
                <LabeledInput
                  label="Feishu App Secret"
                  type="password"
                  placeholder="App Secret"
                  value={feishuAppSecret()}
                  onInput={(e) => setFeishuAppSecret(e.currentTarget.value)}
                />
                <div class="rounded-lg border border-v2-border-border-muted/70 bg-v2-background-bg-layer-01 p-3 text-11-regular leading-relaxed text-v2-text-text-muted">
                  <div class="mb-1 text-12-medium text-v2-text-text-base">
                    {language.tr("飞书开放平台手动配置指引", "Feishu Open Platform Setup")}
                  </div>
                  <ol class="list-inside list-decimal space-y-0.5">
                    <li>访问 open.feishu.cn/app 创建企业自建应用并添加「机器人」能力</li>
                    <li>「事件与回调」选择长连接接收事件（先在下方保存启动以建立握手）</li>
                    <li>订阅 `im.message.receive_v1` 与卡片回调 `card.action.trigger`</li>
                    <li>开通 `im:message`、`im:resource` 权限并发布应用版本</li>
                  </ol>
                </div>
              </Show>

              <Show when={platform() === "weixin"}>
                <LabeledInput
                  label="WeChat iLink Bot Token"
                  type="password"
                  placeholder="Bot Token"
                  value={weixinToken()}
                  onInput={(e) => setWeixinToken(e.currentTarget.value)}
                />
                <LabeledInput
                  label="iLink Base URL"
                  placeholder="https://ilinkai.weixin.qq.com"
                  value={weixinBaseUrl()}
                  onInput={(e) => setWeixinBaseUrl(e.currentTarget.value)}
                />
              </Show>

              <Show when={platform() === "dingtalk"}>
                <LabeledInput
                  label="DingTalk Client ID (AppKey)"
                  placeholder="ding..."
                  value={dingtalkClientId()}
                  onInput={(e) => setDingtalkClientId(e.currentTarget.value)}
                />
                <LabeledInput
                  label="DingTalk Client Secret (AppSecret)"
                  type="password"
                  placeholder="Client Secret"
                  value={dingtalkClientSecret()}
                  onInput={(e) => setDingtalkClientSecret(e.currentTarget.value)}
                />
                <div class="rounded-lg border border-v2-border-border-muted/70 bg-v2-background-bg-layer-01 p-3 text-11-regular leading-relaxed text-v2-text-text-muted">
                  前往 open-dev.dingtalk.com 创建企业内部应用，添加「机器人」能力，消息接收模式选择 Stream 模式并发布。
                </div>
              </Show>

              <Show when={platform() === "wecom"}>
                <LabeledInput
                  label="企业微信智能机器人 Bot ID"
                  placeholder="aib..."
                  value={wecomBotId()}
                  onInput={(e) => setWecomBotId(e.currentTarget.value)}
                />
                <LabeledInput
                  label="企业微信智能机器人 Secret"
                  type="password"
                  placeholder="Secret"
                  value={wecomSecret()}
                  onInput={(e) => setWecomSecret(e.currentTarget.value)}
                />
                <div class="rounded-lg border border-v2-border-border-muted/70 bg-v2-background-bg-layer-01 p-3 text-11-regular leading-relaxed text-v2-text-text-muted">
                  企业微信管理后台 → 安全与管理 → 管理工具 → 智能机器人 → 创建机器人 → API 模式选择 WebSocket 长连接。
                </div>
              </Show>

              <Show when={platform() === "qqbot"}>
                <LabeledInput
                  label="QQ 机器人 App ID"
                  placeholder="102..."
                  value={qqbotAppId()}
                  onInput={(e) => setQqbotAppId(e.currentTarget.value)}
                />
                <LabeledInput
                  label="QQ 机器人 App Secret"
                  type="password"
                  placeholder="App Secret"
                  value={qqbotAppSecret()}
                  onInput={(e) => setQqbotAppSecret(e.currentTarget.value)}
                />
                <label class="flex cursor-pointer select-none items-center gap-2 text-12-regular text-v2-text-text-muted">
                  <input
                    type="checkbox"
                    checked={qqbotSandbox()}
                    onChange={(e) => setQqbotSandbox(e.currentTarget.checked)}
                  />
                  <span>
                    {language.tr(
                      "启用沙箱网关 (sandbox.api.sgroup.qq.com)",
                      "Use sandbox gateway (sandbox.api.sgroup.qq.com)",
                    )}
                  </span>
                </label>
                <div class="rounded-lg border border-v2-border-border-muted/70 bg-v2-background-bg-layer-01 p-3 text-11-regular leading-relaxed text-v2-text-text-muted">
                  前往 q.qq.com 创建机器人获取 AppID 与 AppSecret，在「开发设置 → IP 白名单」配置当前出口 IPv4，并在「沙箱配置」添加测试成员或群。
                </div>
              </Show>

              <LabeledInput
                label={language.tr("管理员 Owner ID（可选）", "Owner User ID (Optional)")}
                placeholder={language.tr("留空则在手机端发送首条消息自动认领", "Leave empty to auto-claim on first message")}
                value={ownerId()}
                onInput={(e) => setOwnerId(e.currentTarget.value)}
              />
            </div>
          </Show>
        </Show>

        <Show when={error()}>
          <div class="text-xs text-[var(--v2-state-fg-danger)]">{error()}</div>
        </Show>
      </DialogBody>
      <DialogFooter>
        <Show when={step() === 2}>
          <Button
            variant="ghost-muted"
            size="small"
            icon="arrow-left"
            onClick={() => {
              stopPolling()
              setStep(1)
            }}
          >
            {language.tr("返回", "Back")}
          </Button>
        </Show>
        <Button
          variant="ghost-muted"
          onClick={() => {
            stopPolling()
            dialog.close()
          }}
        >
          {language.tr("关闭", "Close")}
        </Button>
        <Show when={step() === 2 && (mode() === "manual" || (platform() !== "feishu" && platform() !== "weixin"))}>
          <Button variant="contrast" disabled={busy()} onClick={() => void saveRobot()}>
            {busy() ? language.tr("保存中...", "Saving...") : language.tr("保存并连接", "Save & Connect")}
          </Button>
        </Show>
      </DialogFooter>
    </Dialog>
  )
}

/* ============================================================================
 * Dialog: Edit Existing Mobile Robot & Allowlist
 * ========================================================================== */

const DialogEditMobileRobot: Component<{
  api: SdkApi
  robot: MobileRobotView
  onSaved: () => void
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()

  const [name, setName] = createSignal(props.robot.name)
  const [ownerId, setOwnerId] = createSignal(props.robot.ownerID ?? "")
  const [allowListText, setAllowListText] = createSignal(props.robot.allowFrom ?? "")
  const [feishuAppId, setFeishuAppId] = createSignal(props.robot.feishu?.appId ?? "")
  const [feishuAppSecret, setFeishuAppSecret] = createSignal(props.robot.feishu?.appSecret ?? "")
  const [weixinToken, setWeixinToken] = createSignal(props.robot.weixin?.token ?? "")
  const [dingtalkClientId, setDingtalkClientId] = createSignal(props.robot.dingtalk?.clientId ?? "")
  const [dingtalkClientSecret, setDingtalkClientSecret] = createSignal(props.robot.dingtalk?.clientSecret ?? "")
  const [wecomBotId, setWecomBotId] = createSignal(props.robot.wecom?.botId ?? "")
  const [wecomSecret, setWecomSecret] = createSignal(props.robot.wecom?.secret ?? "")
  const [qqbotAppId, setQqbotAppId] = createSignal(props.robot.qqbot?.appId ?? "")
  const [qqbotAppSecret, setQqbotAppSecret] = createSignal(props.robot.qqbot?.appSecret ?? "")
  const [qqbotSandbox, setQqbotSandbox] = createSignal(Boolean(props.robot.qqbot?.sandbox))
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")

  const submit = async () => {
    setBusy(true)
    setError("")
    const allowFrom = allowListText()
      .split(/[\s,，;；]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .join(",")

    const saved = await props.api.experimental.mobile
      .update({
        robotID: props.robot.id,
        name: name().trim() || props.robot.name,
        enabled: props.robot.enabled,
        ownerID: ownerId().trim(),
        allowFrom,
        adminFrom: props.robot.adminFrom,
        feishu:
          (props.robot.platform === "feishu" || props.robot.platform === "lark") &&
          feishuAppId().trim() &&
          feishuAppSecret().trim()
            ? {
                appId: feishuAppId().trim(),
                appSecret: feishuAppSecret().trim(),
                domain: props.robot.feishu?.domain,
              }
            : undefined,
        weixin:
          props.robot.platform === "weixin" && weixinToken().trim()
            ? {
                token: weixinToken().trim(),
                baseUrl: props.robot.weixin?.baseUrl,
                accountId: props.robot.weixin?.accountId,
              }
            : undefined,
        dingtalk:
          props.robot.platform === "dingtalk" && dingtalkClientId().trim() && dingtalkClientSecret().trim()
            ? {
                clientId: dingtalkClientId().trim(),
                clientSecret: dingtalkClientSecret().trim(),
              }
            : undefined,
        wecom:
          props.robot.platform === "wecom" && wecomBotId().trim() && wecomSecret().trim()
            ? {
                botId: wecomBotId().trim(),
                secret: wecomSecret().trim(),
              }
            : undefined,
        qqbot:
          props.robot.platform === "qqbot" && qqbotAppId().trim() && qqbotAppSecret().trim()
            ? {
                appId: qqbotAppId().trim(),
                appSecret: qqbotAppSecret().trim(),
                sandbox: qqbotSandbox(),
              }
            : undefined,
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err))

        return undefined
      })
    setBusy(false)

    if (!saved) return
    showToast({
      variant: "success",
      title: language.tr("机器人配置已更新", "Robot updated"),
      description: saved.name,
    })
    dialog.close()
    props.onSaved()
  }

  return (
    <Dialog fit containerClass="!w-[min(94vw,480px)] !rounded-[12px]">
      <DialogHeader>
        <DialogTitle>{`${language.tr("编辑机器人", "Edit Robot")} · ${props.robot.name}`}</DialogTitle>
      </DialogHeader>
      <DialogBody class="flex max-h-[72vh] flex-col gap-3 overflow-y-auto px-4 pb-2 pt-0">
        <LabeledInput
          label={language.tr("机器人名称", "Robot Name")}
          value={name()}
          onInput={(e) => setName(e.currentTarget.value)}
        />

        <Show when={props.robot.platform === "feishu" || props.robot.platform === "lark"}>
          <LabeledInput
            label="Feishu App ID"
            value={feishuAppId()}
            onInput={(e) => setFeishuAppId(e.currentTarget.value)}
          />
          <LabeledInput
            label="Feishu App Secret"
            type="password"
            value={feishuAppSecret()}
            onInput={(e) => setFeishuAppSecret(e.currentTarget.value)}
          />
        </Show>

        <Show when={props.robot.platform === "weixin"}>
          <LabeledInput
            label="WeChat iLink Bot Token"
            type="password"
            value={weixinToken()}
            onInput={(e) => setWeixinToken(e.currentTarget.value)}
          />
        </Show>

        <Show when={props.robot.platform === "dingtalk"}>
          <LabeledInput
            label="DingTalk Client ID"
            value={dingtalkClientId()}
            onInput={(e) => setDingtalkClientId(e.currentTarget.value)}
          />
          <LabeledInput
            label="DingTalk Client Secret"
            type="password"
            value={dingtalkClientSecret()}
            onInput={(e) => setDingtalkClientSecret(e.currentTarget.value)}
          />
        </Show>

        <Show when={props.robot.platform === "wecom"}>
          <LabeledInput
            label="WeCom Bot ID"
            value={wecomBotId()}
            onInput={(e) => setWecomBotId(e.currentTarget.value)}
          />
          <LabeledInput
            label="WeCom Secret"
            type="password"
            value={wecomSecret()}
            onInput={(e) => setWecomSecret(e.currentTarget.value)}
          />
        </Show>

        <Show when={props.robot.platform === "qqbot"}>
          <LabeledInput
            label="QQ Bot App ID"
            value={qqbotAppId()}
            onInput={(e) => setQqbotAppId(e.currentTarget.value)}
          />
          <LabeledInput
            label="QQ Bot App Secret"
            type="password"
            value={qqbotAppSecret()}
            onInput={(e) => setQqbotAppSecret(e.currentTarget.value)}
          />
          <label class="flex cursor-pointer select-none items-center gap-2 text-12-regular text-v2-text-text-muted">
            <input
              type="checkbox"
              checked={qqbotSandbox()}
              onChange={(e) => setQqbotSandbox(e.currentTarget.checked)}
            />
            <span>
              {language.tr("启用沙箱网关 (sandbox.api.sgroup.qq.com)", "Use sandbox gateway (sandbox.api.sgroup.qq.com)")}
            </span>
          </label>
        </Show>

        <LabeledInput
          label={language.tr("管理员 Owner ID（清空可重新认领）", "Owner ID (Clear to re-claim)")}
          value={ownerId()}
          onInput={(e) => setOwnerId(e.currentTarget.value)}
        />

        <LabeledInput
          label={language.tr("访问白名单（多个 ID 用逗号分隔）", "Allowed User IDs (comma-separated)")}
          value={allowListText()}
          onInput={(e) => setAllowListText(e.currentTarget.value)}
        />

        <Show when={error()}>
          <div class="text-xs text-[var(--v2-state-fg-danger)]">{error()}</div>
        </Show>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost-muted" onClick={() => dialog.close()}>
          {language.tr("取消", "Cancel")}
        </Button>
        <Button variant="contrast" disabled={busy()} onClick={() => void submit()}>
          {busy() ? language.tr("保存中...", "Saving...") : language.tr("保存更改", "Save Changes")}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
