export * as Mobile from "./index.js"

import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readdir, stat } from "node:fs/promises"
import os from "node:os"
import path from "path"
import { Context, DateTime, Effect, Layer, Stream } from "effect"
import { Node, makeGlobalNode } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Bus } from "../bus.js"
import { Form } from "../form.js"
import { Location } from "../location.js"
import { LocationServiceMap } from "../location-service-map.js"
import { Mime } from "../mime.js"
import { Model } from "../model.js"
import { Permission } from "../permission.js"
import { Project } from "../project.js"
import { Provider } from "../provider.js"
import { describeMediaWithMultimodal, transcribeAudioWithMultimodal } from "../plugin/provider/multimodal.js"
import { AbsolutePath } from "../schema.js"
import { Session } from "../session.js"
import { SessionEvent } from "../session/event.js"
import {
  buildMobileButlerSystemPrompt,
  clearMobileTurnContext,
  extractMobileButlerActions,
  setMobileTurnContext,
  type MobileButlerAction,
} from "./butler.js"
import { renderCardMarkdownFallback, type CardButton, type MobileCard } from "./card.js"
import { isUserAllowed, parseMobileInput } from "./commands.js"
import {
  decodeUniversalRobotMigrationCode,
  encodeRobotMigrationCode,
  normalizeAllowFromWithOwner,
  shortMigrationCode,
  type MobilePlatformType,
  type MobileRobotConfig,
} from "./migration.js"
import { createDingTalkConnector } from "./platforms/dingtalk.js"
import { createFeishuConnector } from "./platforms/feishu.js"
import { createQQBotConnector } from "./platforms/qqbot.js"
import type {
  InboundMobileMessage,
  MobileAudioAttachment,
  MobileFileAttachment,
  MobilePlatformConnector,
  MobilePlatformStatus,
  MobileProgressHandle,
} from "./platforms/types.js"
import { createWeComConnector } from "./platforms/wecom.js"
import { createWeixinConnector } from "./platforms/weixin.js"
import {
  feishuQrBegin,
  feishuQrPoll,
  weixinQrBegin,
  weixinQrPoll,
  type FeishuQrBeginResult,
  type FeishuQrPollResult,
  type WeixinQrBeginResult,
  type WeixinQrPollResult,
} from "./qr-setup.js"

export {
  decodeUniversalRobotMigrationCode,
  encodeRobotMigrationCode,
  feishuQrBegin,
  feishuQrPoll,
  renderCardMarkdownFallback,
  shortMigrationCode,
  weixinQrBegin,
  weixinQrPoll,
  type FeishuQrBeginResult,
  type FeishuQrPollResult,
  type MobilePlatformType,
  type MobileRobotConfig,
  type WeixinQrBeginResult,
  type WeixinQrPollResult,
}

export interface RemoteServerTarget {
  readonly key: string
  readonly name: string
  readonly url: string
  readonly password?: string
}

export interface MobileRobotView extends MobileRobotConfig {
  readonly status: MobilePlatformStatus
  readonly migrationCode: string
  readonly shortCode: string
}

export interface CreateRobotInput {
  readonly name: string
  readonly platform: MobilePlatformType
  readonly enabled?: boolean
  readonly ownerID?: string
  readonly allowFrom?: string
  readonly adminFrom?: string
  readonly feishu?: {
    readonly appId: string
    readonly appSecret: string
    readonly domain?: string
  }
  readonly weixin?: {
    readonly token: string
    readonly baseUrl?: string
    readonly accountId?: string
  }
  readonly dingtalk?: {
    readonly clientId: string
    readonly clientSecret: string
  }
  readonly wecom?: {
    readonly botId: string
    readonly secret: string
  }
  readonly qqbot?: {
    readonly appId: string
    readonly appSecret: string
    readonly sandbox?: boolean
  }
}

export interface UpdateRobotInput {
  readonly id: string
  readonly name?: string
  readonly enabled?: boolean
  readonly ownerID?: string
  readonly allowFrom?: string
  readonly adminFrom?: string
  readonly feishu?: CreateRobotInput["feishu"]
  readonly weixin?: CreateRobotInput["weixin"]
  readonly dingtalk?: CreateRobotInput["dingtalk"]
  readonly wecom?: CreateRobotInput["wecom"]
  readonly qqbot?: CreateRobotInput["qqbot"]
}

interface ChatSessionBinding {
  serverKey: string // "local" or remoteServer.key
  projectId: string
  projectDirectory: string
  projectName: string
  sessionId: string
  effort?: string
}

interface UnifiedProjectItem {
  readonly serverKey: string
  readonly serverLabel: string
  readonly isRemote: boolean
  readonly id: string
  readonly name: string
  readonly directory: string
  readonly updatedAt?: number
}

interface UnifiedSessionItem {
  readonly id: string
  readonly title: string
  readonly updatedAt: number
  readonly modelLabel: string
}

interface UnifiedModelItem {
  readonly providerID: string
  readonly id: string
  readonly name: string
  readonly variants?: readonly string[]
  readonly supportsAudio?: boolean
  readonly supportsImage?: boolean
  readonly supportsPdf?: boolean
  readonly supportsVideo?: boolean
}

export interface MobileSettingsView {
  readonly preventSleep: boolean
  readonly active: boolean
}

export interface UpdateMobileSettingsInput {
  readonly preventSleep?: boolean
}

export interface SimulatedCommandResult {
  readonly cards: readonly MobileCard[]
  readonly texts: readonly string[]
  readonly files: readonly { fileName: string; mimeType: string; size: number }[]
  readonly progressUpdates: readonly string[]
}

export interface Interface {
  readonly settings: () => Effect.Effect<MobileSettingsView>
  readonly updateSettings: (input: UpdateMobileSettingsInput) => Effect.Effect<MobileSettingsView>
  readonly list: () => Effect.Effect<readonly MobileRobotView[]>
  readonly create: (input: CreateRobotInput) => Effect.Effect<MobileRobotView>
  readonly update: (input: UpdateRobotInput) => Effect.Effect<MobileRobotView>
  readonly remove: (id: string) => Effect.Effect<void>
  readonly importCode: (code: string) => Effect.Effect<MobileRobotView>
  readonly syncRemotes: (remotes: readonly RemoteServerTarget[]) => Effect.Effect<void>
  readonly transcribeAudio: (input: {
    readonly audioBase64: string
    readonly mimeType: string
    readonly fileName?: string
  }) => Effect.Effect<{ readonly text: string }>
  readonly simulateInbound: (input: {
    readonly robotId: string
    readonly sessionKey?: string
    readonly userId: string
    readonly userName?: string
    readonly chatId?: string
    readonly text: string
    readonly mentionedUsers?: readonly { id: string; name: string }[]
    readonly audioAttachments?: readonly MobileAudioAttachment[]
    readonly fileAttachments?: readonly MobileFileAttachment[]
    readonly cardAction?: string
    readonly progressDelayMs?: number
    readonly stallTimeoutMs?: number
    readonly pushLive?: boolean
  }) => Effect.Effect<SimulatedCommandResult>
  readonly drainBackgroundOutbox: (sessionKey: string) => Effect.Effect<{
    readonly cards: readonly MobileCard[]
    readonly texts: readonly string[]
  }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Mobile") {}

function robotAccountKey(
  robot: Pick<MobileRobotConfig, "platform" | "feishu" | "weixin" | "dingtalk" | "wecom" | "qqbot">,
): string | undefined {
  if (robot.platform === "feishu" || robot.platform === "lark") {
    const appId = robot.feishu?.appId?.trim()
    return appId ? `feishu:${appId}` : undefined
  }
  if (robot.platform === "weixin") {
    const id = robot.weixin?.accountId?.trim() || robot.weixin?.token?.trim()
    return id ? `weixin:${id}` : undefined
  }
  if (robot.platform === "dingtalk") {
    const clientId = robot.dingtalk?.clientId?.trim()
    return clientId ? `dingtalk:${clientId}` : undefined
  }
  if (robot.platform === "wecom") {
    const botId = robot.wecom?.botId?.trim()
    return botId ? `wecom:${botId}` : undefined
  }
  if (robot.platform === "qqbot") {
    const appId = robot.qqbot?.appId?.trim()
    return appId ? `qqbot:${appId}` : undefined
  }
  return undefined
}

function createConnectorForRobot(robot: MobileRobotConfig): MobilePlatformConnector | undefined {
  if (robot.platform === "feishu" || robot.platform === "lark") {
    if (!robot.feishu?.appId || !robot.feishu.appSecret) return undefined
    return createFeishuConnector({
      robotId: robot.id,
      platform: robot.platform,
      appId: robot.feishu.appId,
      appSecret: robot.feishu.appSecret,
      domain: robot.feishu.domain,
    })
  }
  if (robot.platform === "weixin") {
    if (!robot.weixin?.token) return undefined
    return createWeixinConnector({
      robotId: robot.id,
      token: robot.weixin.token,
      baseUrl: robot.weixin.baseUrl,
    })
  }
  if (robot.platform === "dingtalk") {
    if (!robot.dingtalk?.clientId || !robot.dingtalk.clientSecret) return undefined
    return createDingTalkConnector({
      robotId: robot.id,
      clientId: robot.dingtalk.clientId,
      clientSecret: robot.dingtalk.clientSecret,
    })
  }
  if (robot.platform === "wecom") {
    if (!robot.wecom?.botId || !robot.wecom.secret) return undefined
    return createWeComConnector({
      robotId: robot.id,
      botId: robot.wecom.botId,
      secret: robot.wecom.secret,
    })
  }
  if (robot.platform === "qqbot") {
    if (!robot.qqbot?.appId || !robot.qqbot.appSecret) return undefined
    return createQQBotConnector({
      robotId: robot.id,
      appId: robot.qqbot.appId,
      appSecret: robot.qqbot.appSecret,
      sandbox: robot.qqbot.sandbox,
    })
  }
  return undefined
}

function toView(robot: MobileRobotConfig, connector: MobilePlatformConnector | undefined): MobileRobotView {
  const status: MobilePlatformStatus = !robot.enabled
    ? { state: "stopped" }
    : (connector?.status() ?? { state: "stopped", error: "Missing credentials" })
  let migrationCode = ""
  try {
    migrationCode = encodeRobotMigrationCode(robot)
  } catch {
    migrationCode = ""
  }
  return {
    ...robot,
    status,
    migrationCode,
    shortCode: shortMigrationCode(migrationCode),
  }
}

const MOBILE_SESSION_PERMISSIONS = [{ action: "*", resource: "*", effect: "allow" as const }]

function remoteHeaders(remote: RemoteServerTarget, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = hasBody ? { "Content-Type": "application/json" } : {}
  if (remote.password) {
    const basic = Buffer.from(`opencode:${remote.password}`, "utf8").toString("base64")
    headers.Authorization = `Basic ${basic}`
  }
  return headers
}

async function remoteFetchJson<T>(
  remote: RemoteServerTarget,
  urlPath: string,
  init?: RequestInit,
  timeoutMs = 30_000,
): Promise<T> {
  const base = remote.url.replace(/\/+$/, "")
  const resp = await fetch(`${base}${urlPath}`, {
    ...init,
    headers: {
      ...remoteHeaders(remote, init?.body !== undefined),
      ...(init?.headers as Record<string, string> | undefined),
    },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!resp.ok) {
    const errText = await resp.text()
    throw new Error(`Remote server (${remote.name}) HTTP ${resp.status}: ${errText.slice(0, 200)}`)
  }
  if (resp.status === 204) return undefined as T
  return (await resp.json()) as T
}

function expandHomePath(rawPath: string): string {
  const trimmed = rawPath.trim()
  if (trimmed === "~") return os.homedir()
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(os.homedir(), trimmed.slice(2))
  }
  return trimmed
}

function inferRemoteHomeDir(projectDir?: string): string {
  const clean = (projectDir ?? "").trim()
  if (clean === "/root" || clean.startsWith("/root/")) return "/root"
  const homeMatch = /^\/(home|Users)\/([^/]+)/.exec(clean)
  if (homeMatch) return `/${homeMatch[1]}/${homeMatch[2]}`
  return "/root"
}

function expandPathForServer(rawPath: string, serverKey: string, remoteProjectDir?: string): string {
  if (serverKey === "local") return expandHomePath(rawPath)
  const trimmed = rawPath.trim().replaceAll("\\", "/")
  const remoteHome = inferRemoteHomeDir(remoteProjectDir)
  if (trimmed === "~") return remoteHome
  if (trimmed.startsWith("~/")) return path.posix.join(remoteHome, trimmed.slice(2))
  return trimmed
}

function isEphemeralTempDirectory(dir: string): boolean {
  const norm = dir.replaceAll("\\", "/").replace(/\/+$/, "")
  const sysTmp = os.tmpdir().replaceAll("\\", "/").replace(/\/+$/, "")
  return (
    norm === "/tmp" ||
    norm.startsWith("/tmp/") ||
    norm === "/private/tmp" ||
    norm.startsWith("/private/tmp/") ||
    norm.startsWith("/var/folders/") ||
    norm.startsWith("/private/var/folders/") ||
    (Boolean(sysTmp) && (norm === sysTmp || norm.startsWith(`${sysTmp}/`)))
  )
}

const IS_TEST_RUNTIME =
  process.env.NODE_ENV === "test" ||
  process.env.BUN_ENV === "test" ||
  process.argv.some((arg) => arg.endsWith(".test.ts") || arg.includes("/script/test.ts"))

function formatRelativeTime(timestampMs: number): string {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return "刚刚"
  const diffSec = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000))
  if (diffSec < 60) return "刚刚"
  const mins = Math.floor(diffSec / 60)
  if (mins < 60) return `${mins}分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  return `${days}天前`
}

function runLocalShellCommand(command: string, cwd: string, timeoutMs = 60_000): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const shell = process.platform === "win32" ? "powershell.exe" : "/bin/sh"
    const args = process.platform === "win32" ? ["-NoProfile", "-Command", command] : ["-c", command]
    const child = spawn(shell, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const chunks: Buffer[] = []
    let totalBytes = 0
    const maxBytes = 64 * 1024
    const onData = (chunk: Buffer) => {
      if (totalBytes >= maxBytes) return
      chunks.push(chunk)
      totalBytes += chunk.byteLength
    }
    child.stdout.on("data", onData)
    child.stderr.on("data", onData)
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
    }, timeoutMs)
    child.on("close", (code) => {
      clearTimeout(timer)
      const output = Buffer.concat(chunks).toString("utf8").trim()
      resolve({ exitCode: code ?? 1, output })
    })
    child.on("error", (err) => {
      clearTimeout(timer)
      resolve({ exitCode: 1, output: err.message })
    })
  })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    const fs = yield* FSUtil.Service
    const bus = yield* Bus.Service
    const projects = yield* Project.Service
    const sessions = yield* Session.Service
    const locations = yield* LocationServiceMap.Service
    const context = yield* Effect.context<never>()

    const runEffect = <A, E>(eff: Effect.Effect<A, E, never>): Promise<A> =>
      Effect.runPromiseWith(context)(eff)

    interface ActiveTurnState {
      interrupted: boolean
      anchorMsgId?: string
      sessionKey: string
      connector: MobilePlatformConnector
      replyContext: unknown
      binding: ChatSessionBinding
      steeredNotes: string[]
      lastActivityMs: number
    }

    interface LiveSessionRuntimeStatus {
      retry?: {
        readonly attempt: number
        readonly at: number
        readonly message: string
      }
      compacting: boolean
      lastActivityMs: number
      terminalError?: string
    }

    const storePath = path.join(global.config, "mobile-robots.json")
    const robots = new Map<string, MobileRobotConfig>()
    const connectors = new Map<string, MobilePlatformConnector>()
    const bindings = new Map<string, ChatSessionBinding>()
    const remoteServers = new Map<string, RemoteServerTarget>()
    const activeTurns = new Map<string, ActiveTurnState>()
    const lastReplyContexts = new Map<string, unknown>()
    const notifiedInteractiveIds = new Set<string>()
    const pendingFormDrafts = new Map<string, Record<string, Form.Answer[string]>>()
    const detachedDrainSessions = new Set<string>()
    const liveRuntimeStatus = new Map<string, LiveSessionRuntimeStatus>()
    const phoneOwnedBusyRuns = new Set<string>()
    const deliveredTurnTails = new Set<string>()
    const backgroundOutbox = new Map<string, { cards: MobileCard[]; texts: string[] }>()
    const remoteBusyTracker = new Map<string, { wasBusy: boolean }>()
    const remoteSupportsPiguButler = new Map<string, boolean>()
    const remoteFallbackButlerDigest = new Map<string, string>()
    let preventSleepEnabled = true
    let sleepGuardChild: ReturnType<typeof spawn> | undefined

    function isSleepPreventionActive(): boolean {
      if (!preventSleepEnabled) return false
      for (const r of robots.values()) {
        if (r.enabled && connectors.has(r.id)) return true
      }
      return false
    }

    function stopSleepGuardProcess(): void {
      if (!sleepGuardChild) return
      const proc = sleepGuardChild
      sleepGuardChild = undefined
      proc.kill()
    }

    function syncSleepPrevention(): void {
      const wantActive = isSleepPreventionActive()
      if (!wantActive || IS_TEST_RUNTIME || process.platform !== "darwin") {
        stopSleepGuardProcess()
        return
      }
      if (sleepGuardChild && sleepGuardChild.exitCode === null && !sleepGuardChild.killed) {
        return
      }
      const proc = spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], {
        stdio: "ignore",
      })
      proc.unref()
      proc.on("error", () => {
        if (sleepGuardChild === proc) sleepGuardChild = undefined
      })
      proc.on("exit", () => {
        if (sleepGuardChild === proc) sleepGuardChild = undefined
      })
      sleepGuardChild = proc
    }

    async function checkRemoteSupportsPiguButler(remote: RemoteServerTarget): Promise<boolean> {
      const cached = remoteSupportsPiguButler.get(remote.key)
      if (cached !== undefined) return cached
      const base = remote.url.replace(/\/+$/, "")
      const resp = await fetch(`${base}/api/experimental/mobile/robots`, {
        method: "GET",
        headers: remoteHeaders(remote, false),
        signal: AbortSignal.timeout(4_500),
      }).catch(() => undefined)
      if (!resp) return false
      const supported = resp.ok
      remoteSupportsPiguButler.set(remote.key, supported)
      return supported
    }

    function ensureRuntimeStatus(sessionId: string): LiveSessionRuntimeStatus {
      const existing = liveRuntimeStatus.get(sessionId)
      if (existing) return existing
      const created: LiveSessionRuntimeStatus = {
        compacting: false,
        lastActivityMs: Date.now(),
      }
      liveRuntimeStatus.set(sessionId, created)
      return created
    }

    function markTailDelivered(sessionKey: string, tailMsgId: string | undefined): boolean {
      if (!tailMsgId) return true
      const key = `${sessionKey}:${tailMsgId}`
      if (deliveredTurnTails.has(key)) return false
      deliveredTurnTails.add(key)
      if (deliveredTurnTails.size > 1200) {
        const oldest = deliveredTurnTails.values().next().value
        if (oldest) deliveredTurnTails.delete(oldest)
      }
      return true
    }

    function recordBackgroundOutbox(
      sessionKey: string,
      item: { readonly card?: MobileCard; readonly text?: string },
    ): void {
      const entry = backgroundOutbox.get(sessionKey) ?? { cards: [], texts: [] }
      if (item.card) {
        entry.cards.push(item.card)
        if (entry.cards.length > 20) entry.cards.shift()
      }
      if (item.text) {
        entry.texts.push(item.text)
        if (entry.texts.length > 20) entry.texts.shift()
      }
      backgroundOutbox.set(sessionKey, entry)
    }

    function synthesizeFallbackReplyContext(sessionKey: string, robot: MobileRobotConfig): unknown {
      const cached = lastReplyContexts.get(sessionKey)
      if (cached) return cached
      const chatId = sessionKey.split(":").slice(2).join(":")
      if (!chatId) return undefined
      if (robot.platform === "feishu" || robot.platform === "lark") {
        return { chatId, sessionKey }
      }
      if (robot.platform === "weixin") {
        return { toUserId: chatId }
      }
      if (robot.platform === "wecom") {
        return { chatId }
      }
      if (robot.platform === "qqbot") {
        if (chatId.startsWith("group:")) {
          return {
            messageType: "group" as const,
            userOpenId: robot.ownerID,
            groupOpenId: chatId.slice(6),
          }
        }
        return {
          messageType: "c2c" as const,
          userOpenId: chatId,
        }
      }
      if (robot.platform === "dingtalk") {
        if (chatId.startsWith("cid")) {
          return {
            isGroup: true,
            conversationId: chatId,
            senderStaffId: robot.ownerID,
          }
        }
        return {
          isGroup: false,
          conversationId: chatId,
          senderStaffId: chatId,
        }
      }
      return { chatId, sessionKey }
    }

    function markInteractiveNotified(dedupeKey: string): boolean {
      if (notifiedInteractiveIds.has(dedupeKey)) return false
      notifiedInteractiveIds.add(dedupeKey)
      if (notifiedInteractiveIds.size > 1200) {
        const oldest = notifiedInteractiveIds.values().next().value
        if (oldest) notifiedInteractiveIds.delete(oldest)
      }
      return true
    }

    async function localDirExists(dir: string): Promise<boolean> {
      if (!dir) return false
      const st = await stat(dir).catch(() => undefined)
      return Boolean(st?.isDirectory())
    }

    async function saveDiskState(): Promise<void> {
      const data = {
        version: 1,
        settings: {
          preventSleep: preventSleepEnabled,
        },
        robots: Array.from(robots.values()),
        bindings: Object.fromEntries(bindings.entries()),
      }
      await Bun.write(storePath, JSON.stringify(data, null, 2))
    }

    async function loadDiskState(): Promise<void> {
      try {
        const file = Bun.file(storePath)
        if (!(await file.exists())) return
        const parsed = (await file.json()) as {
          settings?: { preventSleep?: boolean }
          robots?: MobileRobotConfig[]
          bindings?: Record<string, ChatSessionBinding>
        }
        if (typeof parsed.settings?.preventSleep === "boolean") {
          preventSleepEnabled = parsed.settings.preventSleep
        }
        const seenKeys = new Map<string, string>()
        let dirty = false
        for (const r of parsed.robots ?? []) {
          if (!r?.id) continue
          const key = robotAccountKey(r)
          const existingId = key ? seenKeys.get(key) : undefined
          if (existingId) {
            dirty = true
            continue
          }
          if (key) seenKeys.set(key, r.id)
          robots.set(r.id, r)
        }
        for (const [k, v] of Object.entries(parsed.bindings ?? {})) {
          if (!v?.projectDirectory) continue
          const parts = k.split(":")
          if (parts.length >= 2 && parts[1] && !robots.has(parts[1])) {
            dirty = true
            continue
          }
          if (v.serverKey === "local" && !(await localDirExists(v.projectDirectory))) {
            dirty = true
            continue
          }
          bindings.set(k, v)
        }
        if (dirty) await saveDiskState()
      } catch {
        // Ignore corrupted or missing file on first start
      }
    }

    async function resolveDefaultProjectDir(): Promise<string> {
      const zhDir = path.join(global.home, "Documents", "默认项目")
      if (await localDirExists(zhDir)) return zhDir
      const enDir = path.join(global.home, "Documents", "Default Project")
      if (await localDirExists(enDir)) return enDir
      const createdZh = await runEffect(fs.ensureDir(zhDir))
        .then(() => zhDir)
        .catch(() => undefined)
      if (createdZh) return createdZh
      const fallbackDir = path.join(global.data, "默认项目")
      await runEffect(fs.ensureDir(fallbackDir)).catch(() => undefined)
      return fallbackDir
    }

    async function ensureDefaultProject(): Promise<UnifiedProjectItem> {
      const dir = await resolveDefaultProjectDir()
      const resolved = await runEffect(projects.resolve(AbsolutePath.make(dir)))
      return {
        serverKey: "local",
        serverLabel: "本机",
        isRemote: false,
        id: resolved.id,
        name: path.basename(resolved.directory) || "默认项目",
        directory: resolved.directory,
        updatedAt: 0,
      }
    }

    async function listAllProjects(): Promise<UnifiedProjectItem[]> {
      const defaultProj = await ensureDefaultProject().catch(() => undefined)
      const localList = await runEffect(projects.list())
      const items: UnifiedProjectItem[] = []
      for (const p of localList) {
        if (!(await localDirExists(p.canonical))) continue
        items.push({
          serverKey: "local",
          serverLabel: "本机",
          isRemote: false,
          id: p.id,
          name: p.name?.trim() || path.basename(p.canonical) || p.canonical,
          directory: p.canonical,
          updatedAt: p.time.active || p.time.updated || p.time.created,
        })
      }
      if (
        defaultProj &&
        !items.some(
          (p) =>
            p.serverKey === "local" &&
            ((defaultProj.id !== "global" && p.id === defaultProj.id) || p.directory === defaultProj.directory),
        )
      ) {
        items.push(defaultProj)
      }

      const globalSessions = await runEffect(
        sessions.list({
          project: Project.ID.make("global"),
          limit: 50,
        }),
      ).catch(() => ({ data: [] }))
      for (const s of globalSessions.data) {
        if (s.parentID) continue
        const dir = s.location.directory
        if (s.id.startsWith("ses_ext_") && dir && isEphemeralTempDirectory(dir)) continue
        if (
          dir &&
          !items.some((p) => p.serverKey === "local" && p.directory === dir) &&
          (await localDirExists(dir))
        ) {
          items.push({
            serverKey: "local",
            serverLabel: "本机",
            isRemote: false,
            id: "global",
            name: path.basename(dir) || dir,
            directory: dir,
            updatedAt: DateTime.toEpochMillis(s.time.updated),
          })
        }
      }

      for (const b of bindings.values()) {
        if (
          b.serverKey === "local" &&
          b.projectDirectory &&
          !items.some(
            (p) =>
              p.serverKey === "local" &&
              ((b.projectId !== "global" && p.id === b.projectId) || p.directory === b.projectDirectory),
          ) &&
          (await localDirExists(b.projectDirectory))
        ) {
          items.push({
            serverKey: "local",
            serverLabel: "本机",
            isRemote: false,
            id: b.projectId,
            name: b.projectName || path.basename(b.projectDirectory) || b.projectDirectory,
            directory: b.projectDirectory,
            updatedAt: 0,
          })
        }
      }

      for (const remote of remoteServers.values()) {
        // Query global sessions first so remote SessionExternal.sync() runs before /api/project on fresh servers.
        const remoteGlobal = await remoteFetchJson<{
          data?: Array<{
            id: string
            parentID?: string
            location?: { directory?: string }
            time?: { updated?: number; created?: number }
          }>
        }>(remote, "/api/session?project=global&parent=null&archived=false&limit=50", undefined, 8_000).catch(
          () => undefined,
        )

        const remoteProjects = await remoteFetchJson<
          Array<{
            id: string
            name?: string
            canonical: string
            time?: { active?: number; updated?: number; created?: number }
          }>
        >(remote, "/api/project", undefined, 8_000).catch(() => undefined)

        for (const rp of remoteProjects ?? []) {
          items.push({
            serverKey: remote.key,
            serverLabel: `SSH:${remote.name}`,
            isRemote: true,
            id: rp.id,
            name: rp.name?.trim() || path.posix.basename(rp.canonical) || rp.canonical,
            directory: rp.canonical,
            updatedAt: rp.time?.active ?? rp.time?.updated ?? rp.time?.created ?? 0,
          })
        }

        for (const rs of remoteGlobal?.data ?? []) {
          if (rs.parentID) continue
          const dir = rs.location?.directory?.trim() ?? ""
          if (!dir) continue
          if (rs.id.startsWith("ses_ext_") && isEphemeralTempDirectory(dir)) continue
          if (items.some((p) => p.serverKey === remote.key && p.directory === dir)) continue
          items.push({
            serverKey: remote.key,
            serverLabel: `SSH:${remote.name}`,
            isRemote: true,
            id: "global",
            name: path.posix.basename(dir) || dir,
            directory: dir,
            updatedAt: rs.time?.updated ?? rs.time?.created ?? 0,
          })
        }
      }

      for (const b of bindings.values()) {
        if (
          b.serverKey !== "local" &&
          remoteServers.has(b.serverKey) &&
          b.projectDirectory &&
          !items.some(
            (p) => p.serverKey === b.serverKey && (p.id === b.projectId || p.directory === b.projectDirectory),
          )
        ) {
          const remote = remoteServers.get(b.serverKey)!
          items.push({
            serverKey: b.serverKey,
            serverLabel: `SSH:${remote.name}`,
            isRemote: true,
            id: b.projectId,
            name: b.projectName || path.posix.basename(b.projectDirectory) || b.projectDirectory,
            directory: b.projectDirectory,
            updatedAt: Date.now(),
          })
        }
      }
      return items.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    }

    async function resolveDefaultModelRef(
      serverKey: string,
      directory: string,
    ): Promise<{ providerID: string; id: string } | undefined> {
      if (serverKey !== "local") {
        const remote = remoteServers.get(serverKey)
        if (!remote) return undefined
        try {
          const res = await remoteFetchJson<{ data?: { providerID?: string; id?: string } }>(
            remote,
            `/api/model/default?location%5Bdirectory%5D=${encodeURIComponent(directory)}`,
            undefined,
            5_000,
          )
          if (res.data?.providerID && res.data?.id) {
            return { providerID: res.data.providerID, id: res.data.id }
          }
        } catch {
          // Ignore
        }
        return undefined
      }

      try {
        const loc = Location.Ref.make({ directory: AbsolutePath.make(directory) })
        const def = await runEffect(
          Effect.scoped(
            Effect.gen(function* () {
              const locCtx = yield* locations.contextEffect(loc)
              const modelSvc = Context.get(locCtx, Model.Service)
              return yield* modelSvc.default()
            }),
          ),
        )
        if (def) {
          return { providerID: def.providerID, id: def.id }
        }
      } catch {
        // Ignore
      }
      return undefined
    }

    async function ensureBinding(sessionKey: string): Promise<ChatSessionBinding | undefined> {
      const existing = bindings.get(sessionKey)
      if (existing) {
        if (existing.serverKey === "local" && (await localDirExists(existing.projectDirectory))) {
          return existing
        }
        if (existing.serverKey !== "local") {
          return existing
        }
        bindings.delete(sessionKey)
      }
      const targetProj =
        (await ensureDefaultProject().catch(() => undefined)) ?? (await listAllProjects())[0]
      if (!targetProj) return undefined
      const sessionsList = await listSessionsForProject(targetProj)
      const sessionId = sessionsList[0]?.id ?? (await createSessionInProject(targetProj, "默认会话"))
      const next: ChatSessionBinding = {
        serverKey: targetProj.serverKey,
        projectId: targetProj.id,
        projectDirectory: targetProj.directory,
        projectName: targetProj.name,
        sessionId,
      }
      bindings.set(sessionKey, next)
      await saveDiskState()
      return next
    }

    function parseServerPrefixedArg(rawArg: string): {
      readonly serverKey?: string
      readonly rest: string
    } {
      const trimmed = rawArg.trim()
      if (!trimmed || /^[a-zA-Z]:[\\/]/.test(trimmed)) {
        return { rest: trimmed }
      }
      const lower = trimmed.toLowerCase()
      if (lower.startsWith("local:")) {
        return { serverKey: "local", rest: trimmed.slice(6).trim() }
      }
      const remotesByKeyLength = Array.from(remoteServers.values()).sort((a, b) => b.key.length - a.key.length)
      const exactKeyMatch = remotesByKeyLength.find((r) => trimmed.startsWith(`${r.key}:`))
      if (exactKeyMatch) {
        return {
          serverKey: exactKeyMatch.key,
          rest: trimmed.slice(exactKeyMatch.key.length + 1).trim(),
        }
      }
      const remotesByNameLength = Array.from(remoteServers.values()).sort((a, b) => b.name.length - a.name.length)
      const sshNameMatch = remotesByNameLength.find(
        (r) => r.name && lower.startsWith(`ssh:${r.name.toLowerCase()}:`),
      )
      if (sshNameMatch) {
        return {
          serverKey: sshNameMatch.key,
          rest: trimmed.slice(`ssh:${sshNameMatch.name}:`.length).trim(),
        }
      }
      const nameMatch = remotesByNameLength.find((r) => r.name && lower.startsWith(`${r.name.toLowerCase()}:`))
      if (nameMatch) {
        return {
          serverKey: nameMatch.key,
          rest: trimmed.slice(nameMatch.name.length + 1).trim(),
        }
      }
      if (lower.startsWith("ssh:") && remoteServers.size > 0) {
        const firstRemote = remoteServers.values().next().value
        if (firstRemote) {
          return {
            serverKey: firstRemote.key,
            rest: trimmed.slice(4).trim(),
          }
        }
      }
      return { rest: trimmed }
    }

    async function listSessionsForProject(proj: UnifiedProjectItem): Promise<UnifiedSessionItem[]> {
      const fallbackModel = await resolveDefaultModelRef(proj.serverKey, proj.directory)
      const fallbackModelLabel = fallbackModel ? `${fallbackModel.providerID}/${fallbackModel.id} (默认)` : "默认模型"

      if (proj.isRemote) {
        const remote = remoteServers.get(proj.serverKey)
        if (!remote) return []
        const res = await remoteFetchJson<{
          data: Array<{
            id: string
            parentID?: string
            title?: string
            location?: { directory?: string }
            model?: { providerID: string; id: string }
            time?: { updated?: number; created?: number }
          }>
        }>(remote, `/api/session?project=${encodeURIComponent(proj.id)}&parent=null&archived=false&limit=30`)
        return (res.data ?? [])
          .filter(
            (s) =>
              !s.parentID &&
              (proj.id !== "global" || !s.location?.directory || s.location.directory === proj.directory),
          )
          .map((s) => ({
            id: s.id,
            title: s.title?.trim() || "未命名会话",
            updatedAt: s.time?.updated ?? s.time?.created ?? Date.now(),
            modelLabel: s.model ? `${s.model.providerID}/${s.model.id}` : fallbackModelLabel,
          }))
      }

      const res = await runEffect(
        sessions.list({
          project: Project.ID.make(proj.id),
          limit: 30,
        }),
      )
      return res.data
        .filter((s) => !s.parentID && (proj.id !== "global" || s.location.directory === proj.directory))
        .map((s) => ({
          id: s.id,
          title: s.title?.trim() || "未命名会话",
          updatedAt: DateTime.toEpochMillis(s.time.updated),
          modelLabel: s.model ? `${s.model.providerID}/${s.model.id}` : fallbackModelLabel,
        }))
    }

    async function createSessionInProject(proj: UnifiedProjectItem, title?: string): Promise<string> {
      if (proj.isRemote) {
        const remote = remoteServers.get(proj.serverKey)
        if (!remote) throw new Error("SSH 远程服务器未连接")
        const res = await remoteFetchJson<{ data: { id: string } }>(remote, "/api/session", {
          method: "POST",
          body: JSON.stringify({
            location: { directory: proj.directory },
            title: title?.trim() || undefined,
            permissions: MOBILE_SESSION_PERMISSIONS,
          }),
        })
        return res.data.id
      }

      const created = await runEffect(
        sessions.create({
          location: Location.Ref.make({ directory: AbsolutePath.make(proj.directory) }),
          title: title?.trim() || undefined,
          permissions: MOBILE_SESSION_PERMISSIONS,
        }),
      )
      return created.id
    }

    async function listModelsForBinding(binding: ChatSessionBinding): Promise<UnifiedModelItem[]> {
      if (binding.serverKey !== "local") {
        const remote = remoteServers.get(binding.serverKey)
        if (!remote) return []
        const res = await remoteFetchJson<{
          data: Array<{
            providerID: string
            id: string
            name?: string
            variants?: ReadonlyArray<{ id: string }>
            capabilities?: { input?: readonly string[] }
          }>
        }>(remote, `/api/model?location%5Bdirectory%5D=${encodeURIComponent(binding.projectDirectory)}`)
        return (res.data ?? []).map((m) => ({
          providerID: m.providerID,
          id: m.id,
          name: m.name?.trim() || m.id,
          variants: (m.variants ?? []).map((v) => v.id),
          supportsAudio: Array.isArray(m.capabilities?.input) && m.capabilities.input.includes("audio"),
          supportsImage: Array.isArray(m.capabilities?.input) && m.capabilities.input.includes("image"),
          supportsPdf: Array.isArray(m.capabilities?.input) && m.capabilities.input.includes("pdf"),
          supportsVideo: Array.isArray(m.capabilities?.input) && m.capabilities.input.includes("video"),
        }))
      }

      try {
        const loc = Location.Ref.make({ directory: AbsolutePath.make(binding.projectDirectory) })
        const list = await runEffect(
          Effect.scoped(
            Effect.gen(function* () {
              const locCtx = yield* locations.contextEffect(loc)
              const modelSvc = Context.get(locCtx, Model.Service)
              return yield* modelSvc.available()
            }),
          ),
        )
        return list.map((m) => ({
          providerID: m.providerID,
          id: m.id,
          name: m.name?.trim() || m.id,
          variants: (m.variants ?? []).map((v) => v.id),
          supportsAudio: m.capabilities.input.includes("audio"),
          supportsImage: m.capabilities.input.includes("image"),
          supportsPdf: m.capabilities.input.includes("pdf"),
          supportsVideo: m.capabilities.input.includes("video"),
        }))
      } catch {
        return []
      }
    }

    async function getCurrentSessionSummary(binding: ChatSessionBinding | undefined): Promise<{
      projectLabel: string
      sessionLabel: string
      modelLabel: string
      activeModelRef?: { providerID: string; id: string }
      isBusy: boolean
    }> {
      if (!binding) {
        return {
          projectLabel: "未选择项目",
          sessionLabel: "无会话",
          modelLabel: "默认模型",
          isBusy: false,
        }
      }
      const serverTag =
        binding.serverKey === "local"
          ? "本机"
          : `SSH:${remoteServers.get(binding.serverKey)?.name ?? binding.serverKey}`
      const projectLabel = `${binding.projectName} (${serverTag})`
      const defaultModel = await resolveDefaultModelRef(binding.serverKey, binding.projectDirectory)
      const fallbackModelLabel = defaultModel ? `${defaultModel.providerID}/${defaultModel.id} (默认)` : "默认模型"

      if (binding.serverKey !== "local") {
        const remote = remoteServers.get(binding.serverKey)
        if (!remote) {
          return { projectLabel, sessionLabel: binding.sessionId.slice(0, 12), modelLabel: "未知", isBusy: false }
        }
        try {
          const info = await remoteFetchJson<{
            data: { id: string; title?: string; model?: { providerID: string; id: string } }
          }>(remote, `/api/session/${encodeURIComponent(binding.sessionId)}`, undefined, 6_000)
          const active = await remoteFetchJson<{ data: Record<string, unknown> }>(
            remote,
            "/api/session/active",
            undefined,
            6_000,
          )
          const activeRef = info.data.model ?? defaultModel
          return {
            projectLabel,
            sessionLabel: info.data.title?.trim() || info.data.id.slice(0, 12),
            modelLabel: info.data.model ? `${info.data.model.providerID}/${info.data.model.id}` : fallbackModelLabel,
            activeModelRef: activeRef,
            isBusy: Boolean(active.data?.[binding.sessionId]),
          }
        } catch {
          return {
            projectLabel,
            sessionLabel: binding.sessionId.slice(0, 12),
            modelLabel: fallbackModelLabel,
            activeModelRef: defaultModel,
            isBusy: false,
          }
        }
      }

      try {
        const info = await runEffect(sessions.get(Session.ID.make(binding.sessionId)))
        const activeSet = await runEffect(sessions.active)
        const activeRef = info.model ? { providerID: info.model.providerID, id: info.model.id } : defaultModel
        return {
          projectLabel,
          sessionLabel: info.title?.trim() || info.id.slice(0, 12),
          modelLabel: info.model ? `${info.model.providerID}/${info.model.id}` : fallbackModelLabel,
          activeModelRef: activeRef,
          isBusy: activeSet.has(info.id),
        }
      } catch {
        return {
          projectLabel,
          sessionLabel: binding.sessionId.slice(0, 12),
          modelLabel: fallbackModelLabel,
          activeModelRef: defaultModel,
          isBusy: false,
        }
      }
    }

    async function buildHelpCard(sessionKey: string, warningText?: string): Promise<MobileCard> {
      const binding = await ensureBinding(sessionKey)
      const summary = await getCurrentSessionSummary(binding)
      const statusBadge = summary.isBusy ? "运行中" : "空闲"

      const elements: MobileCard["elements"][number][] = []
      if (warningText) {
        elements.push({ kind: "markdown", content: warningText })
      }
      elements.push({
        kind: "markdown",
        content: [
          `项目：**${summary.projectLabel}**`,
          `会话：**${summary.sessionLabel}** · ${statusBadge}`,
          `模型：\`${summary.modelLabel}\``,
        ].join("\n"),
      })

      if (binding && summary.isBusy) {
        const runningTurn = activeTurns.get(binding.sessionId)
        const [live, pendingForms, pendingPerms] = await Promise.all([
          inspectLiveTurnProgress(binding, runningTurn?.anchorMsgId),
          listPendingFormsForBinding(binding),
          listPendingPermissionsForBinding(binding),
        ])
        const waitingHint =
          pendingForms.length > 0
            ? "⏸ 正在等待你回复上方的问答确认"
            : pendingPerms.length > 0
              ? "⏸ 正在等待你批准上方的执行权限"
              : live.activeStep
        const recentPreview = live.processEntries.slice(-4).join("\n")
        elements.push({
          kind: "markdown",
          content: [
            `**当前实时进度**：${waitingHint}${live.completedTools > 0 ? `（已完成 ${live.completedTools} 步）` : ""}`,
            ...(recentPreview ? [recentPreview] : []),
          ].join("\n"),
        })
      }

      elements.push({
        kind: "markdown",
        content: [
          "**自然语言、语音、文件与交互问答**",
          "直接发送**文字、语音、截图/图片或文件**即可对话；长任务中途静默更新进度（仅在完成时提醒一次），运行中直接发话即可自动插话纠偏；遇到 `question` 问答或权限确认会立即弹窗提醒；桌面端发起或 `/schedule` 定时任务完成后也会自动推送结果到手机。",
          "",
          "**快捷指令（`.` 前缀，支持编号选择）**",
          "`.project` (`.p`) — 项目列表 / `.p <编号>` 切换 / `.p new <路径>`",
          "`.chat` (`.c`) — 会话列表 / `.c <编号>` 切换 / `.new` 新建 / `.history` 历史 / `.undo` 撤回 / `.c name` 重命名 / `.c del` 删除",
          "`.model` (`.m`) — 模型列表 / `.m <编号>` 切换 / `.m effort <级别>`",
          "`.sh <命令>` (`.shell`) — 在项目目录执行终端命令",
          "`.log` (`.progress`) — 查看当前/上一轮任务的 AI 中间输出与执行步骤",
          "`.skip` — 跳过当前待确认问答（让 AI 按推荐方案继续）",
          "`.stop` — 停止当前生成",
          "`.ps <内容>` (`.btw`) — 运行途中补充指令（直接发文字同样支持自动合并）",
          "`.send` (`.file`) — 最近文件列表 / `.send <编号或路径>` 发送文件",
          "`.access` (`.acl`) — 权限管理 / `.whoami` 查看账号信息",
          "`.help` — 查看本面板",
        ].join("\n"),
      })

      return {
        header: {
          title: "Pigu 手机端控制中心",
          color: warningText ? "orange" : "blue",
        },
        elements,
      }
    }

    async function handleProjectCommand(
      sessionKey: string,
      sub: "list" | "switch" | "new",
      arg: string,
    ): Promise<MobileCard> {
      const current = await ensureBinding(sessionKey)
      if (sub === "new") {
        const trimmedArg = arg.trim()
        if (!trimmedArg) {
          return {
            header: { title: "新建/打开项目", color: "orange" },
            elements: [{ kind: "markdown", content: "用法：`.project new /项目目录路径`" }],
          }
        }
        const prefixed = parseServerPrefixedArg(trimmedArg)
        const targetServerKey =
          prefixed.serverKey === "local"
            ? "local"
            : prefixed.serverKey && remoteServers.has(prefixed.serverKey)
              ? prefixed.serverKey
              : current?.serverKey && current.serverKey !== "local" && remoteServers.has(current.serverKey)
                ? current.serverKey
                : "local"
        const pathPart = prefixed.rest
        const rawDir = expandPathForServer(
          pathPart,
          targetServerKey,
          current?.serverKey === targetServerKey ? current.projectDirectory : undefined,
        )

        if (targetServerKey !== "local") {
          const remote = remoteServers.get(targetServerKey)!
          const created = await remoteFetchJson<{
            data: { id: string; projectID: string; location: { directory: string } }
          }>(remote, "/api/session", {
            method: "POST",
            body: JSON.stringify({
              location: { directory: rawDir },
              title: "手机端会话",
              permissions: MOBILE_SESSION_PERMISSIONS,
            }),
          })
          const dir = created.data.location.directory
          const name = path.posix.basename(dir) || dir
          bindings.set(sessionKey, {
            serverKey: remote.key,
            projectId: created.data.projectID,
            projectDirectory: dir,
            projectName: name,
            sessionId: created.data.id,
          })
          await saveDiskState()
          return {
            header: { title: "已打开并切换项目", color: "green" },
            elements: [
              {
                kind: "markdown",
                content: `项目：**${name}** (SSH:${remote.name})\n路径：\`${dir}\`\n会话：\`${created.data.id.slice(0, 12)}\``,
              },
            ],
          }
        }

        const targetDir = path.resolve(rawDir)
        await runEffect(fs.ensureDir(targetDir)).catch(() => undefined)
        const resolved = await runEffect(projects.resolve(AbsolutePath.make(targetDir)))
        const projItem: UnifiedProjectItem = {
          serverKey: "local",
          serverLabel: "本机",
          isRemote: false,
          id: resolved.id,
          name: path.basename(resolved.directory) || resolved.directory,
          directory: resolved.directory,
        }
        const sessionId = await createSessionInProject(projItem, "手机端会话")
        bindings.set(sessionKey, {
          serverKey: "local",
          projectId: projItem.id,
          projectDirectory: projItem.directory,
          projectName: projItem.name,
          sessionId,
        })
        await saveDiskState()
        return {
          header: { title: "已打开并切换项目", color: "green" },
          elements: [
            {
              kind: "markdown",
              content: `项目：**${projItem.name}** (本机)\n路径：\`${projItem.directory}\`\n会话：\`${sessionId.slice(0, 12)}\``,
            },
          ],
        }
      }

      const allProjects = await listAllProjects()
      if (sub === "switch" && arg.trim()) {
        const rawQuery = arg.trim()
        const prefixed = parseServerPrefixedArg(rawQuery)
        const hasValidFilter =
          prefixed.serverKey === "local" || (prefixed.serverKey !== undefined && remoteServers.has(prefixed.serverKey))
        const query = hasValidFilter ? prefixed.rest : rawQuery
        const pool = hasValidFilter ? allProjects.filter((p) => p.serverKey === prefixed.serverKey) : allProjects
        const qLower = query.toLowerCase()
        const idx = Number(rawQuery)
        const matched =
          Number.isInteger(idx) && idx >= 1 && idx <= allProjects.length
            ? allProjects[idx - 1]
            : !query && pool.length > 0
              ? pool[0]
              : (pool.find(
                  (p) =>
                    p.id === query ||
                    p.name.toLowerCase() === qLower ||
                    p.directory.toLowerCase() === qLower,
                ) ??
                pool.find((p) => p.name.toLowerCase().includes(qLower)) ??
                pool.find((p) => p.serverLabel.toLowerCase().includes(qLower)))
        if (!matched) {
          return {
            header: { title: "未找到匹配项目", color: "red" },
            elements: [
              {
                kind: "markdown",
                content: `找不到项目 \`${query}\`。发送 \`.project\` 查看编号。`,
              },
            ],
          }
        }
        const projSessions = await listSessionsForProject(matched)
        const sessionId = projSessions[0]?.id ?? (await createSessionInProject(matched, "手机端会话"))
        bindings.set(sessionKey, {
          serverKey: matched.serverKey,
          projectId: matched.id,
          projectDirectory: matched.directory,
          projectName: matched.name,
          sessionId,
        })
        await saveDiskState()
        return {
          header: { title: "已切换项目", color: "green" },
          elements: [
            {
              kind: "markdown",
              content: [
                `项目：**${matched.name}** (${matched.serverLabel})`,
                `路径：\`${matched.directory}\``,
                `会话：${projSessions[0]?.title ?? "新会话"} (\`${sessionId.slice(0, 12)}\`)`,
              ].join("\n"),
            },
          ],
        }
      }

      if (allProjects.length === 0) {
        return {
          header: { title: "项目列表", color: "blue" },
          elements: [
            {
              kind: "markdown",
              content: "当前暂无项目。发送 `.project new /项目路径` 打开目录。",
            },
          ],
        }
      }

      const elements: MobileCard["elements"][number][] = []
      for (const [i, proj] of allProjects.slice(0, 20).entries()) {
        const isCurrent =
          current?.serverKey === proj.serverKey &&
          ((current.projectId !== "global" && current.projectId === proj.id) ||
            current.projectDirectory === proj.directory)
        const mark = isCurrent ? "* " : "- "
        const tag = isCurrent ? `${proj.serverLabel} · 当前` : proj.serverLabel
        elements.push({
          kind: "list_item",
          text: `${mark}**#${i + 1} ${proj.name}** (${tag}) · \`${proj.directory}\``,
        })
      }
      elements.push({
        kind: "note",
        text: "用法：.p <编号> 切换项目 ｜ .p new <路径> 打开目录",
      })

      return {
        header: { title: `项目列表 (共 ${allProjects.length} 个)`, color: "blue" },
        elements,
      }
    }

    async function handleChatCommand(
      sessionKey: string,
      sub: "list" | "new" | "switch" | "history" | "undo" | "name" | "delete",
      arg: string,
    ): Promise<MobileCard> {
      const binding = await ensureBinding(sessionKey)
      if (!binding) {
        return {
          header: { title: "会话管理", color: "orange" },
          elements: [{ kind: "markdown", content: "尚未绑定项目，请先使用 `.project new <路径>` 打开项目。" }],
        }
      }
      if (binding.serverKey !== "local" && !remoteServers.has(binding.serverKey)) {
        return {
          header: { title: "SSH 远程服务器未连接", color: "orange" },
          elements: [
            {
              kind: "markdown",
              content: "当前绑定的 SSH 服务器暂未连接，请恢复连接或发送 `.project` 切换其他项目。",
            },
          ],
        }
      }

      const allProjects = await listAllProjects()
      const currentProj: UnifiedProjectItem = allProjects.find(
        (p) =>
          p.serverKey === binding.serverKey &&
          ((binding.projectId !== "global" && p.id === binding.projectId) || p.directory === binding.projectDirectory),
      ) ?? {
        serverKey: binding.serverKey,
        serverLabel: binding.serverKey === "local" ? "本机" : "SSH",
        isRemote: binding.serverKey !== "local",
        id: binding.projectId,
        name: binding.projectName,
        directory: binding.projectDirectory,
      }

      if (sub === "new") {
        const title = arg.trim() || undefined
        const newSessionId = await createSessionInProject(currentProj, title)
        binding.sessionId = newSessionId
        bindings.set(sessionKey, binding)
        await saveDiskState()
        return {
          header: { title: "已新建并切换会话", color: "green" },
          elements: [
            {
              kind: "markdown",
              content: [
                `项目：**${currentProj.name}** (${currentProj.serverLabel})`,
                `会话：**${title ?? "未命名会话"}** (\`${newSessionId.slice(0, 12)}\`)`,
              ].join("\n"),
            },
          ],
        }
      }

      if (sub === "name") {
        const newTitle = arg.trim()
        if (!newTitle) {
          return {
            header: { title: "重命名会话", color: "orange" },
            elements: [{ kind: "markdown", content: "用法：`.chat name <新标题>`" }],
          }
        }
        if (currentProj.isRemote) {
          const remote = remoteServers.get(currentProj.serverKey)
          if (remote) {
            await remoteFetchJson(remote, `/api/session/${encodeURIComponent(binding.sessionId)}`, {
              method: "PATCH",
              body: JSON.stringify({ title: newTitle }),
            })
          }
        }
        if (!currentProj.isRemote) {
          await runEffect(
            sessions.rename({
              sessionID: Session.ID.make(binding.sessionId),
              title: newTitle,
            }),
          )
        }
        return {
          header: { title: "会话已重命名", color: "green" },
          elements: [{ kind: "markdown", content: `新标题：**${newTitle}**` }],
        }
      }

      if (sub === "undo") {
        try {
          if (currentProj.isRemote) {
            const remote = remoteServers.get(currentProj.serverKey)
            if (!remote) throw new Error("SSH 远程服务器未连接")
            const ctxRes = await remoteFetchJson<{ data: Array<{ id: string; type: string }> }>(
              remote,
              `/api/session/${encodeURIComponent(binding.sessionId)}/context`,
            )
            const lastUser = [...(ctxRes.data ?? [])]
              .reverse()
              .find((m) => m.type === "user" && !String(m.id ?? "").startsWith("msg_ext_"))
            if (!lastUser) {
              return {
                header: { title: "撤回上一轮", color: "orange" },
                elements: [{ kind: "markdown", content: "当前会话无可撤回记录。" }],
              }
            }
            await remoteFetchJson(remote, `/api/session/${encodeURIComponent(binding.sessionId)}/revert/stage`, {
              method: "POST",
              body: JSON.stringify({ messageID: lastUser.id, files: true }),
            })
            await remoteFetchJson(remote, `/api/session/${encodeURIComponent(binding.sessionId)}/revert/commit`, {
              method: "POST",
            })
          }
          if (!currentProj.isRemote) {
            const sessionID = Session.ID.make(binding.sessionId)
            const msgs = await runEffect(sessions.context(sessionID))
            const lastUser = [...msgs]
              .reverse()
              .find((m) => m.type === "user" && !String(m.id ?? "").startsWith("msg_ext_"))
            if (!lastUser) {
              return {
                header: { title: "撤回上一轮", color: "orange" },
                elements: [{ kind: "markdown", content: "当前会话无可撤回记录。" }],
              }
            }
            await runEffect(sessions.revert.stage({ sessionID, messageID: lastUser.id, files: true }))
            await runEffect(sessions.revert.commit(sessionID))
          }
          return {
            header: { title: "已撤回上一轮", color: "green" },
            elements: [{ kind: "markdown", content: "已回滚上一轮对话及关联的文件改动。" }],
          }
        } catch (err) {
          return {
            header: { title: "撤回失败", color: "red" },
            elements: [{ kind: "markdown", content: err instanceof Error ? err.message : String(err) }],
          }
        }
      }

      if (sub === "history") {
        const limit = Math.min(20, Math.max(1, Number(arg.trim()) || 6))
        const turns = await readRecentHistoryText(binding, limit)
        return {
          header: { title: `最近对话记录 · ${currentProj.name}`, color: "blue" },
          elements: [
            {
              kind: "markdown",
              content: turns || "当前会话暂无记录。",
            },
          ],
        }
      }

      const list = await listSessionsForProject(currentProj)

      if (sub === "delete") {
        const query = arg.trim()
        const idx = Number(query)
        const target =
          Number.isInteger(idx) && idx >= 1 && idx <= list.length
            ? list[idx - 1]
            : list.find((s) => s.id === query || s.title.toLowerCase() === query.toLowerCase())
        if (!target) {
          return {
            header: { title: "删除会话", color: "orange" },
            elements: [{ kind: "markdown", content: "用法：`.chat del <编号>`（先发 `.chat` 查看编号）" }],
          }
        }
        if (currentProj.isRemote) {
          const remote = remoteServers.get(currentProj.serverKey)
          if (remote) {
            await remoteFetchJson(remote, `/api/session/${encodeURIComponent(target.id)}`, { method: "DELETE" })
          }
        }
        if (!currentProj.isRemote) {
          await runEffect(sessions.remove(Session.ID.make(target.id)))
        }
        if (binding.sessionId === target.id) {
          const remaining = list.filter((s) => s.id !== target.id)
          binding.sessionId = remaining[0]?.id ?? (await createSessionInProject(currentProj, "手机端会话"))
          bindings.set(sessionKey, binding)
          await saveDiskState()
        }
        return {
          header: { title: "已删除会话", color: "green" },
          elements: [{ kind: "markdown", content: `已删除：**${target.title}** (\`${target.id.slice(0, 12)}\`)` }],
        }
      }

      if (sub === "switch" && arg.trim()) {
        const query = arg.trim()
        const qLower = query.toLowerCase()
        const idx = Number(query)
        const target =
          Number.isInteger(idx) && idx >= 1 && idx <= list.length
            ? list[idx - 1]
            : (list.find((s) => s.id === query || s.title.toLowerCase() === qLower) ??
              list.find((s) => s.title.toLowerCase().includes(qLower)))
        if (!target) {
          return {
            header: { title: "未找到会话", color: "red" },
            elements: [{ kind: "markdown", content: `未找到会话 \`${query}\`。发送 \`.chat\` 查看编号。` }],
          }
        }
        binding.sessionId = target.id
        bindings.set(sessionKey, binding)
        await saveDiskState()
        return {
          header: { title: "已切换会话", color: "green" },
          elements: [
            {
              kind: "markdown",
              content: [
                `项目：**${currentProj.name}** (${currentProj.serverLabel})`,
                `会话：**${target.title}** (\`${target.id.slice(0, 12)}\`)`,
                `模型：\`${target.modelLabel}\``,
              ].join("\n"),
            },
          ],
        }
      }

      const elements: MobileCard["elements"][number][] = []
      for (const [i, item] of list.slice(0, 15).entries()) {
        const isCurrent = item.id === binding.sessionId
        const mark = isCurrent ? "* " : "- "
        const status = isCurrent ? `当前 · ${formatRelativeTime(item.updatedAt)}` : formatRelativeTime(item.updatedAt)
        elements.push({
          kind: "list_item",
          text: `${mark}**#${i + 1} ${item.title}** (${status}) · \`${item.modelLabel}\``,
        })
      }
      elements.push({
        kind: "note",
        text: "用法：.c <编号> 切换 ｜ .new [标题] 新建 ｜ .c name <标题> 重命名 ｜ .c del <编号> 删除",
      })

      return {
        header: { title: `会话列表 · ${currentProj.name} (共 ${list.length} 个)`, color: "blue" },
        elements,
      }
    }

    async function handleModelCommand(
      sessionKey: string,
      sub: "list" | "switch" | "effort",
      arg: string,
    ): Promise<MobileCard> {
      const binding = await ensureBinding(sessionKey)
      if (!binding) {
        return {
          header: { title: "模型管理", color: "orange" },
          elements: [{ kind: "markdown", content: "请先通过 `.project` 选择项目。" }],
        }
      }
      if (binding.serverKey !== "local" && !remoteServers.has(binding.serverKey)) {
        return {
          header: { title: "SSH 远程服务器未连接", color: "orange" },
          elements: [
            {
              kind: "markdown",
              content: "当前绑定的 SSH 服务器暂未连接，请恢复连接或发送 `.project` 切换其他项目。",
            },
          ],
        }
      }

      if (sub === "effort") {
        const level = arg.trim().toLowerCase()
        if (!level) {
          return {
            header: { title: "推理强度", color: "blue" },
            elements: [
              {
                kind: "markdown",
                content: `当前：\`${binding.effort ?? "default"}\` ｜ 可选：\`low\` / \`medium\` / \`high\` / \`max\`\n用法：\`.m effort <级别>\``,
              },
            ],
          }
        }
        binding.effort = level === "default" ? undefined : level
        bindings.set(sessionKey, binding)
        await saveDiskState()
        const models = await listModelsForBinding(binding)
        const summary = await getCurrentSessionSummary(binding)
        const activeRef = summary.activeModelRef
        const activeMeta = activeRef
          ? models.find((m) => m.providerID === activeRef.providerID && m.id === activeRef.id)
          : undefined
        const supportsVariant =
          level === "default" || !activeMeta?.variants || activeMeta.variants.includes(level)
        if (activeRef?.providerID && activeRef.id) {
          await switchSessionModel(binding, {
            providerID: activeRef.providerID,
            id: activeRef.id,
            variant: level === "default" || !supportsVariant ? undefined : level,
          }).catch(() => undefined)
        }
        const extraNote = supportsVariant ? "" : "（当前模型无此推理档位，切换到支持的模型后自动生效）"
        return {
          header: { title: "已更新推理强度", color: "green" },
          elements: [{ kind: "markdown", content: `推理强度：\`${level}\`${extraNote}` }],
        }
      }

      const models = await listModelsForBinding(binding)
      const summary = await getCurrentSessionSummary(binding)

      if (sub === "switch" && arg.trim()) {
        const query = arg.trim()
        const qLower = query.toLowerCase()
        const idx = Number(query)
        const target =
          Number.isInteger(idx) && idx >= 1 && idx <= models.length
            ? models[idx - 1]
            : (models.find((m) => `${m.providerID}/${m.id}`.toLowerCase() === qLower) ??
              models.find((m) => m.id.toLowerCase() === qLower || m.name.toLowerCase() === qLower) ??
              models.find((m) => `${m.providerID}/${m.id}`.toLowerCase().includes(qLower)))

        const resolvedTarget: UnifiedModelItem | undefined =
          target ??
          (query.includes("/")
            ? {
                providerID: query.split("/")[0] ?? "",
                id: query.split("/").slice(1).join("/"),
                name: query,
              }
            : undefined)

        if (!resolvedTarget || !resolvedTarget.providerID || !resolvedTarget.id) {
          return {
            header: { title: "未找到匹配模型", color: "red" },
            elements: [
              {
                kind: "markdown",
                content: `未找到模型 \`${query}\`。发送 \`.model\` 查看编号或使用 \`<provider>/<model>\`。`,
              },
            ],
          }
        }

        const effectiveVariant =
          binding.effort &&
          binding.effort !== "default" &&
          (!resolvedTarget.variants || resolvedTarget.variants.includes(binding.effort))
            ? binding.effort
            : undefined

        await switchSessionModel(binding, {
          providerID: resolvedTarget.providerID,
          id: resolvedTarget.id,
          variant: effectiveVariant,
        })

        return {
          header: { title: "已切换会话模型", color: "green" },
          elements: [
            {
              kind: "markdown",
              content: `模型：\`${resolvedTarget.providerID}/${resolvedTarget.id}\`\n会话：${summary.sessionLabel}（上下文已保留）`,
            },
          ],
        }
      }

      const activeFull = summary.activeModelRef
        ? `${summary.activeModelRef.providerID}/${summary.activeModelRef.id}`
        : summary.modelLabel
      const elements: MobileCard["elements"][number][] = [
        {
          kind: "markdown",
          content: `当前：\`${summary.modelLabel}\` · 推理：\`${binding.effort ?? "default"}\``,
        },
      ]

      if (models.length > 0) {
        const lines = models
          .slice(0, 25)
          .map((m, i) => {
            const full = `${m.providerID}/${m.id}`
            const mark = full === activeFull || full === summary.modelLabel ? "* " : "- "
            return `${mark}**#${i + 1}** \`${full}\` (${m.name})`
          })
          .join("\n")
        elements.push({ kind: "markdown", content: lines })
      }
      if (models.length === 0) {
        elements.push({
          kind: "markdown",
          content: "未发现已启用模型，可使用 `.m <provider>/<model>` 指定。",
        })
      }

      elements.push({
        kind: "note",
        text: "用法：.m <编号或厂商/模型> 切换 ｜ .m effort <low|medium|high|max> 设推理强度",
      })

      return {
        header: { title: "模型与厂商切换 (.model)", color: "blue" },
        elements,
      }
    }

    async function switchSessionModel(
      binding: ChatSessionBinding,
      model: { providerID: string; id: string; variant?: string },
    ): Promise<void> {
      if (binding.serverKey !== "local") {
        const remote = remoteServers.get(binding.serverKey)
        if (!remote) throw new Error("SSH 远程服务器未连接")
        await remoteFetchJson(remote, `/api/session/${encodeURIComponent(binding.sessionId)}/model`, {
          method: "POST",
          body: JSON.stringify({ model }),
        })
        return
      }
      await runEffect(
        sessions.switchModel({
          sessionID: Session.ID.make(binding.sessionId),
          model: Model.Ref.make({
            providerID: Provider.ID.make(model.providerID),
            id: Model.ID.make(model.id),
            variant: model.variant ? Model.VariantID.make(model.variant) : undefined,
          }),
        }),
      )
    }

    async function readRecentHistoryText(binding: ChatSessionBinding, maxTurns: number): Promise<string> {
      interface RawMessage {
        readonly type: string
        readonly text?: string
        readonly command?: string
        readonly exit?: number
        readonly output?: string | { readonly output?: string }
        readonly model?: { providerID: string; id: string }
        readonly content?: Array<{ type: string; text?: string; name?: string }>
      }
      let rawMessages: RawMessage[] = []
      if (binding.serverKey !== "local") {
        const remote = remoteServers.get(binding.serverKey)
        if (!remote) return "远程服务器未连接。"
        const res = await remoteFetchJson<{ data: RawMessage[] }>(
          remote,
          `/api/session/${encodeURIComponent(binding.sessionId)}/context`,
        )
        rawMessages = res.data ?? []
      }
      if (binding.serverKey === "local") {
        const msgs = await runEffect(sessions.context(Session.ID.make(binding.sessionId)))
        rawMessages = msgs as unknown as RawMessage[]
      }

      const entries: string[] = []
      for (const m of rawMessages) {
        if (m.type === "user" && m.text) {
          entries.push(`**你**：${m.text.slice(0, 300)}`)
        }
        if (m.type === "shell" && m.command) {
          const rawOut = typeof m.output === "string" ? m.output : (m.output?.output ?? "")
          const out = rawOut.trim().slice(0, 400)
          entries.push(`**终端** (\`$ ${m.command}\`)：\n\`\`\`\n${out || "(无输出)"}\n\`\`\``)
        }
        if (m.type === "assistant" && m.content) {
          const textPart = m.content
            .filter((c) => c.type === "text" && c.text)
            .map((c) => c.text ?? "")
            .join("\n")
            .trim()
          if (textPart) {
            const tag = m.model ? ` \`[${m.model.id}]\`` : ""
            entries.push(`**AI**${tag}：${textPart.slice(0, 500)}`)
          }
        }
      }
      return entries.slice(-maxTurns * 2).join("\n\n")
    }

    async function handleShellCommand(sessionKey: string, cmd: string): Promise<MobileCard> {
      const binding = await ensureBinding(sessionKey)
      if (!binding) {
        return {
          header: { title: "终端命令 (.sh)", color: "orange" },
          elements: [{ kind: "markdown", content: "请先通过 `.project` 选择项目。" }],
        }
      }
      const trimmed = cmd.trim()
      if (!trimmed) {
        return {
          header: { title: "终端命令 (.sh)", color: "blue" },
          elements: [
            {
              kind: "markdown",
              content: `目录：\`${binding.projectDirectory}\`\n用法：\`.sh <命令>\`（例如 \`.sh git status -sb\`、\`.sh ls -la\`）`,
            },
          ],
        }
      }

      if (binding.serverKey !== "local") {
        const remote = remoteServers.get(binding.serverKey)
        if (!remote) {
          return {
            header: { title: "SSH 远程服务器未连接", color: "red" },
            elements: [{ kind: "markdown", content: "无法在远程服务器上执行命令。" }],
          }
        }
        await remoteFetchJson(
          remote,
          `/api/session/${encodeURIComponent(binding.sessionId)}/shell`,
          {
            method: "POST",
            body: JSON.stringify({ command: trimmed }),
          },
          65_000,
        )
        const ctxRes = await remoteFetchJson<{
          data: Array<{
            readonly type: string
            readonly command?: string
            readonly exit?: number
            readonly output?: string | { readonly output?: string }
          }>
        }>(remote, `/api/session/${encodeURIComponent(binding.sessionId)}/context`)
        const lastShell = [...(ctxRes.data ?? [])].reverse().find((m) => m.type === "shell")
        const rawOut =
          typeof lastShell?.output === "string" ? lastShell.output : (lastShell?.output?.output ?? "")
        const exitCode = lastShell?.exit ?? 0
        const snippet = rawOut.trim() ? rawOut.trim().slice(0, 3500) : "(无输出)"
        return {
          header: {
            title: exitCode === 0 ? `命令执行成功 (exit 0)` : `命令退出码 ${exitCode}`,
            color: exitCode === 0 ? "green" : "orange",
          },
          elements: [
            {
              kind: "markdown",
              content: `\`${binding.projectDirectory}\` · \`$ ${trimmed}\`\n\`\`\`\n${snippet}\n\`\`\``,
            },
          ],
        }
      }

      const res = await runLocalShellCommand(trimmed, binding.projectDirectory, 60_000)
      const snippet = res.output ? res.output.slice(0, 3500) : "(无输出)"
      return {
        header: {
          title: res.exitCode === 0 ? `命令执行成功 (exit 0)` : `命令退出码 ${res.exitCode}`,
          color: res.exitCode === 0 ? "green" : "orange",
        },
        elements: [
          {
            kind: "markdown",
            content: `\`${binding.projectDirectory}\` · \`$ ${trimmed}\`\n\`\`\`\n${snippet}\n\`\`\``,
          },
        ],
      }
    }

    async function handleStopCommand(sessionKey: string): Promise<MobileCard> {
      const binding = await ensureBinding(sessionKey)
      if (!binding) {
        return {
          header: { title: "停止生成", color: "orange" },
          elements: [{ kind: "markdown", content: "当前没有活动的会话。" }],
        }
      }
      const runningTurn = activeTurns.get(binding.sessionId)
      if (runningTurn) {
        runningTurn.interrupted = true
      }
      const [pendingForms, pendingPerms] = await Promise.all([
        listPendingFormsForBinding(binding),
        listPendingPermissionsForBinding(binding),
      ])
      for (const form of pendingForms) {
        pendingFormDrafts.delete(form.id)
        await cancelPendingFormForBinding(binding, form.id).catch(() => undefined)
      }
      for (const perm of pendingPerms) {
        await replyPendingPermissionForBinding(binding, perm.id, "reject").catch(() => undefined)
      }
      let interrupted = pendingForms.length > 0 || pendingPerms.length > 0
      if (binding.serverKey !== "local") {
        const remote = remoteServers.get(binding.serverKey)
        if (remote) {
          const res = await remoteFetchJson<{ interrupted: boolean }>(
            remote,
            `/api/session/${encodeURIComponent(binding.sessionId)}/interrupt`,
            { method: "POST" },
          ).catch(() => ({ interrupted: false }))
          interrupted = interrupted || Boolean(res?.interrupted)
        }
      }
      if (binding.serverKey === "local") {
        const didInterrupt = await runEffect(sessions.interrupt(Session.ID.make(binding.sessionId))).catch(() => false)
        interrupted = interrupted || didInterrupt
      }
      return {
        header: {
          title: interrupted ? "已中断当前会话生成" : "当前会话处于空闲状态",
          color: interrupted ? "orange" : "blue",
        },
        elements: [
          {
            kind: "markdown",
            content: interrupted ? "已停止正在运行的 AI 任务。" : "当前没有正在运行的生成任务。",
          },
        ],
      }
    }

    async function handlePsCommand(
      connector: MobilePlatformConnector,
      msg: InboundMobileMessage,
      text: string,
    ): Promise<void> {
      const binding = await ensureBinding(msg.sessionKey)
      if (!binding) {
        await connector.sendCard(msg.replyContext, {
          header: { title: "插话补充 (.ps)", color: "orange" },
          elements: [{ kind: "markdown", content: "请先选择项目与会话。" }],
        })
        return
      }
      const trimmed = text.trim()
      if (!trimmed) {
        await connector.sendCard(msg.replyContext, {
          header: { title: "插话补充 (.ps)", color: "blue" },
          elements: [{ kind: "markdown", content: "用法：`.ps <补充说明>` — 在运行途中追加引导指令。" }],
        })
        return
      }

      const existingTurn = activeTurns.get(binding.sessionId)
      const hadActiveTurn = Boolean(existingTurn && !existingTurn.interrupted)
      let admittedId: string | undefined

      if (binding.serverKey !== "local") {
        const remote = remoteServers.get(binding.serverKey)
        if (!remote) throw new Error("SSH 远程服务器未连接")
        const admitted = await remoteFetchJson<{ data?: { id?: string } }>(
          remote,
          `/api/session/${encodeURIComponent(binding.sessionId)}/prompt`,
          {
            method: "POST",
            body: JSON.stringify({
              text: trimmed,
              delivery: "steer",
              metadata: { mobileSteer: true },
            }),
          },
        )
        admittedId = admitted?.data?.id
      }
      if (binding.serverKey === "local") {
        if (!hadActiveTurn) {
          phoneOwnedBusyRuns.add(binding.sessionId)
        }
        const admitted = await runEffect(
          sessions.prompt({
            sessionID: Session.ID.make(binding.sessionId),
            text: trimmed,
            delivery: "steer",
            metadata: { mobileSteer: true },
          }),
        )
        admittedId = admitted.id
      }

      if (existingTurn && !existingTurn.interrupted) {
        existingTurn.steeredNotes.push(compactSingleLine(trimmed, 120))
        existingTurn.lastActivityMs = Date.now()
        if (existingTurn.sessionKey === msg.sessionKey) {
          existingTurn.replyContext = msg.replyContext
        }
      }

      await connector.sendCard(msg.replyContext, {
        header: { title: "已注入补充指令 (.ps)", color: "green" },
        elements: [
          {
            kind: "markdown",
            content: `> ${trimmed}`,
          },
        ],
      })

      if (hadActiveTurn) return

      const turnState: ActiveTurnState = {
        interrupted: false,
        anchorMsgId: admittedId,
        sessionKey: msg.sessionKey,
        connector,
        replyContext: msg.replyContext,
        binding,
        steeredNotes: [],
        lastActivityMs: Date.now(),
      }
      activeTurns.set(binding.sessionId, turnState)
      try {
        await waitSessionDrain(binding)
      } finally {
        if (activeTurns.get(binding.sessionId) === turnState) {
          activeTurns.delete(binding.sessionId)
        }
      }
      if (turnState.interrupted) return
      const ext = await extractTurnProcessAndReply(binding, admittedId, true)
      markTailDelivered(msg.sessionKey, ext.tailMsgId)
      if (!ext.finalReply) return
      const summary = await getCurrentSessionSummary(binding)
      const footer = `\n\n*[${summary.projectLabel} · ${summary.sessionLabel} · ${summary.modelLabel}]*`
      await connector.sendText(msg.replyContext, `${ext.finalReply}${footer}`)
    }

    async function listRecentProjectFiles(dir: string): Promise<Array<{ name: string; size: number; mtimeMs: number }>> {
      const ignored = new Set([".git", "node_modules", "dist", "build", ".DS_Store", ".next", "target", "coverage"])
      const files: Array<{ name: string; size: number; mtimeMs: number }> = []
      let scanned = 0
      const scanDir = async (currentDir: string, relPrefix: string, depth: number): Promise<void> => {
        if (depth > 2 || scanned >= 200) return
        let names: string[] = []
        try {
          names = await readdir(currentDir)
        } catch {
          return
        }
        for (const entry of names) {
          if (scanned >= 200) return
          if (ignored.has(entry) || entry.startsWith(".")) continue
          scanned += 1
          const full = path.join(currentDir, entry)
          const relName = relPrefix ? `${relPrefix}/${entry}` : entry
          try {
            const st = await stat(full)
            if (st.isFile() && st.size > 0 && st.size <= 50 * 1024 * 1024) {
              files.push({ name: relName, size: st.size, mtimeMs: st.mtimeMs })
              continue
            }
            if (st.isDirectory() && depth < 2) {
              await scanDir(full, relName, depth + 1)
            }
          } catch {
            // Skip unreadable entry
          }
        }
      }
      await scanDir(dir, "", 0)
      return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 8)
    }

    function inferMimeFromFileName(fileName: string, bytes: Uint8Array): string {
      const detected = Mime.detect(bytes)
      const lower = fileName.toLowerCase()
      if (lower.endsWith(".svg")) return "image/svg+xml"
      if (detected !== "text/plain" && detected !== "application/octet-stream") return detected
      if (lower.endsWith(".json")) return "application/json"
      if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown"
      if (lower.endsWith(".csv")) return "text/csv"
      if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html"
      if (lower.endsWith(".xml")) return "application/xml"
      if (lower.endsWith(".pdf")) return "application/pdf"
      if (lower.endsWith(".zip")) return "application/zip"
      return detected
    }

    async function deliverProjectFileToMobile(
      connector: MobilePlatformConnector,
      replyContext: unknown,
      binding: ChatSessionBinding,
      rawTarget: string,
    ): Promise<MobileCard | undefined> {
      const cleaned = expandPathForServer(rawTarget, binding.serverKey, binding.projectDirectory)
      if (!cleaned) {
        return {
          header: { title: "文件路径为空", color: "orange" },
          elements: [{ kind: "markdown", content: "未提供有效的文件路径。" }],
        }
      }

      if (binding.serverKey !== "local") {
        const remote = remoteServers.get(binding.serverKey)
        if (!remote) {
          return {
            header: { title: "SSH 远程服务器未连接", color: "red" },
            elements: [{ kind: "markdown", content: "无法从断开的远程服务器读取文件。" }],
          }
        }
        const relFromProj = path.posix.isAbsolute(cleaned)
          ? path.posix.relative(binding.projectDirectory, cleaned)
          : cleaned.replace(/^\.\/+/, "")
        const outsideProj =
          path.posix.isAbsolute(cleaned) && (relFromProj.startsWith("..") || path.posix.isAbsolute(relFromProj))
        const readBaseDir = outsideProj ? path.posix.dirname(cleaned) : binding.projectDirectory
        const relPath = outsideProj ? path.posix.basename(cleaned) : relFromProj
        const encodedSegments = relPath
          .split("/")
          .filter(Boolean)
          .map((seg) => encodeURIComponent(seg))
          .join("/")
        const readUrl = `${remote.url.replace(/\/+$/, "")}/api/fs/read/${encodedSegments}?location%5Bdirectory%5D=${encodeURIComponent(readBaseDir)}`
        const resp = await fetch(readUrl, {
          method: "GET",
          headers: remoteHeaders(remote, false),
          signal: AbortSignal.timeout(45_000),
        }).catch(() => undefined)
        if (!resp || !resp.ok) {
          return {
            header: { title: "远程文件不存在", color: "red" },
            elements: [{ kind: "markdown", content: `找不到远程文件：\`${cleaned}\`` }],
          }
        }
        const bytes = new Uint8Array(await resp.arrayBuffer())
        const fileName = path.posix.basename(cleaned) || "remote-file"
        const mimeType = inferMimeFromFileName(fileName, bytes)
        await connector.sendFile(replyContext, { fileName, mimeType, data: bytes })
        return undefined
      }

      const fullPath = path.isAbsolute(cleaned) ? cleaned : path.resolve(binding.projectDirectory, cleaned)
      const file = Bun.file(fullPath)
      if (!(await file.exists())) {
        return {
          header: { title: "文件不存在", color: "red" },
          elements: [{ kind: "markdown", content: `找不到文件：\`${fullPath}\`` }],
        }
      }

      const bytes = new Uint8Array(await file.arrayBuffer())
      const fileName = path.basename(fullPath)
      const mimeType = inferMimeFromFileName(fileName, bytes)
      await connector.sendFile(replyContext, {
        fileName,
        mimeType,
        data: bytes,
      })
      return undefined
    }

    async function listRemoteProjectFiles(
      remote: RemoteServerTarget,
      dir: string,
    ): Promise<Array<{ name: string; size: number; mtimeMs: number }>> {
      const res = await remoteFetchJson<{
        data?: Array<{ path: string; type: "file" | "directory" }>
      }>(remote, `/api/fs/list?location%5Bdirectory%5D=${encodeURIComponent(dir)}`, undefined, 8_000).catch(
        () => undefined,
      )
      return (res?.data ?? [])
        .filter((entry) => entry.type === "file" && entry.path && !path.posix.basename(entry.path).startsWith("."))
        .slice(0, 8)
        .map((entry) => ({ name: entry.path, size: -1, mtimeMs: 0 }))
    }

    async function handleSendFileCommand(
      connector: MobilePlatformConnector,
      replyContext: unknown,
      sessionKey: string,
      rawFilePath: string,
    ): Promise<void> {
      const binding = await ensureBinding(sessionKey)
      if (!binding) {
        await connector.sendCard(replyContext, {
          header: { title: "发送文件 (.send)", color: "orange" },
          elements: [{ kind: "markdown", content: "请先通过 `.project` 选择项目。" }],
        })
        return
      }
      if (binding.serverKey !== "local" && !remoteServers.has(binding.serverKey)) {
        await connector.sendCard(replyContext, {
          header: { title: "SSH 远程服务器未连接", color: "orange" },
          elements: [
            {
              kind: "markdown",
              content: "当前绑定的 SSH 服务器暂未连接，请恢复连接或发送 `.project` 切换其他项目。",
            },
          ],
        })
        return
      }
      const recentFiles =
        binding.serverKey === "local"
          ? await listRecentProjectFiles(binding.projectDirectory)
          : await listRemoteProjectFiles(remoteServers.get(binding.serverKey)!, binding.projectDirectory)
      const targetRel = expandPathForServer(rawFilePath, binding.serverKey, binding.projectDirectory)
      if (!targetRel) {
        const elements: MobileCard["elements"][number][] = [
          {
            kind: "markdown",
            content: `目录：\`${binding.projectDirectory}\``,
          },
        ]
        if (recentFiles.length > 0) {
          for (const [i, f] of recentFiles.entries()) {
            const sizeSuffix =
              f.size < 0 ? "" : ` (${f.size < 1024 ? `${f.size} B` : `${(f.size / 1024).toFixed(1)} KB`})`
            elements.push({
              kind: "list_item",
              text: `- **#${i + 1} ${f.name}**${sizeSuffix}`,
            })
          }
        }
        elements.push({
          kind: "note",
          text: "用法：.send <编号> 或 .send <相对/绝对路径>",
        })
        await connector.sendCard(replyContext, {
          header: { title: `发送文件 (.send) · ${binding.projectName}`, color: "blue" },
          elements,
        })
        return
      }

      const idx = Number(targetRel)
      const resolvedRel =
        Number.isInteger(idx) && idx >= 1 && idx <= recentFiles.length
          ? recentFiles[idx - 1]!.name
          : targetRel

      const errCard = await deliverProjectFileToMobile(connector, replyContext, binding, resolvedRel)
      if (errCard) {
        await connector.sendCard(replyContext, errCard)
      }
    }

    async function handleAccessCommand(
      robot: MobileRobotConfig,
      connector: MobilePlatformConnector,
      msg: InboundMobileMessage,
      sub: "list" | "add" | "remove" | "whoami",
      arg: string,
    ): Promise<MobileCard> {
      const senderId = msg.userId.trim()
      const ownerId = robot.ownerID.trim()

      if (sub === "whoami") {
        const role =
          ownerId && ownerId.toLowerCase() === senderId.toLowerCase()
            ? "管理员 (Owner)"
            : isUserAllowed(ownerId, robot.allowFrom, senderId)
              ? "授权用户"
              : "未授权用户"
        return {
          header: { title: "当前账号信息 (.whoami)", color: "blue" },
          elements: [
            {
              kind: "markdown",
              content: [
                `名称：${msg.userName || senderId}`,
                `ID：\`${senderId}\``,
                `角色：${role}`,
              ].join("\n"),
            },
          ],
        }
      }

      if (!ownerId) {
        const updated: MobileRobotConfig = {
          ...robot,
          ownerID: senderId,
          allowFrom: normalizeAllowFromWithOwner(senderId, robot.allowFrom),
          userNames: { ...(robot.userNames ?? {}), [senderId]: msg.userName || senderId },
          updatedAt: Date.now(),
        }
        robots.set(robot.id, updated)
        await saveDiskState()
        robot = updated
      }

      if (robot.ownerID.trim().toLowerCase() !== senderId.toLowerCase()) {
        return {
          header: { title: "权限不足", color: "red" },
          elements: [
            {
              kind: "markdown",
              content: `仅管理员（\`${robot.ownerID}\`）可执行 \`.access\`。`,
            },
          ],
        }
      }

      const userNames: Record<string, string> = { ...(robot.userNames ?? {}) }
      if (msg.userName && msg.userName !== senderId) {
        userNames[senderId] = msg.userName
      }
      for (const m of msg.mentionedUsers ?? []) {
        if (m.id && m.name) userNames[m.id] = m.name
      }

      if (sub === "add") {
        const targets: string[] = []
        for (const m of msg.mentionedUsers ?? []) {
          if (m.id) targets.push(m.id.trim())
        }
        if (targets.length === 0 && arg.trim()) {
          for (const part of arg.split(/[\s,]+/)) {
            const clean = part.replace(/^@/, "").trim()
            if (clean) targets.push(clean)
          }
        }
        if (targets.length === 0) {
          return {
            header: { title: "添加授权用户 (.access add)", color: "orange" },
            elements: [
              {
                kind: "markdown",
                content: "用法：`.access add @用户` 或 `.access add <ID>`（`*` 为允许所有人）",
              },
            ],
          }
        }

        const nextAllow = targets.includes("*")
          ? "*"
          : normalizeAllowFromWithOwner(robot.ownerID, [robot.allowFrom, ...targets].filter(Boolean).join(","))

        const updated: MobileRobotConfig = {
          ...robot,
          allowFrom: nextAllow,
          userNames,
          updatedAt: Date.now(),
        }
        robots.set(robot.id, updated)
        await saveDiskState()
        return handleAccessCommand(updated, connector, msg, "list", "")
      }

      const isPublic = robot.allowFrom.trim() === "*"
      const allowIds = isPublic
        ? []
        : robot.allowFrom
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s && s.toLowerCase() !== robot.ownerID.toLowerCase())

      if (sub === "remove") {
        const targets = new Set<string>()
        for (const m of msg.mentionedUsers ?? []) {
          if (m.id) targets.add(m.id.trim().toLowerCase())
        }
        for (const part of arg.split(/[\s,]+/)) {
          const clean = part.replace(/^@/, "").trim()
          if (!clean) continue
          const num = Number(clean)
          if (Number.isInteger(num) && num >= 1 && num <= allowIds.length) {
            targets.add(allowIds[num - 1]!.toLowerCase())
            continue
          }
          targets.add(clean.toLowerCase())
        }
        if (targets.size === 0) {
          return {
            header: { title: "移除授权用户 (.access remove)", color: "orange" },
            elements: [{ kind: "markdown", content: "用法：`.access rm <编号或ID>`" }],
          }
        }

        const remaining = robot.allowFrom
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s && s !== "*" && !targets.has(s.toLowerCase()))
        const nextAllow = normalizeAllowFromWithOwner(robot.ownerID, remaining.join(","))
        const updated: MobileRobotConfig = {
          ...robot,
          allowFrom: nextAllow,
          userNames,
          updatedAt: Date.now(),
        }
        robots.set(robot.id, updated)
        await saveDiskState()
        return handleAccessCommand(updated, connector, msg, "list", "")
      }

      const resolveLabel = async (id: string) => {
        if (userNames[id]) return `${userNames[id]} (\`${id}\`)`
        if (connector.resolveUserDisplayName) {
          const resolved = await connector.resolveUserDisplayName(id)
          if (resolved && resolved !== id) {
            userNames[id] = resolved
            return `${resolved} (\`${id}\`)`
          }
        }
        return `\`${id}\``
      }

      const ownerLabel = await resolveLabel(robot.ownerID)
      const elements: MobileCard["elements"][number][] = [
        {
          kind: "markdown",
          content: [
            `管理员：${ownerLabel}`,
            `策略：${isPublic ? "公开模式 (`*` 所有人可用)" : `白名单模式 (共 ${allowIds.length + 1} 人)`}`,
          ].join("\n"),
        },
      ]

      for (const [i, uid] of allowIds.entries()) {
        const label = await resolveLabel(uid)
        elements.push({
          kind: "list_item",
          text: `- **#${i + 1}** ${label}`,
        })
      }

      elements.push({
        kind: "note",
        text: "用法：.access add <@用户或ID> 添加（* 公开）｜ .access rm <编号或ID> 移除",
      })

      return {
        header: { title: "权限管理 (.access)", color: "blue" },
        elements,
      }
    }

    async function waitSessionDrain(binding: ChatSessionBinding): Promise<{
      readonly sshDisconnected?: boolean
      readonly errorMessage?: string
    }> {
      if (binding.serverKey !== "local") {
        const remote = remoteServers.get(binding.serverKey)
        if (!remote) {
          return { sshDisconnected: true, errorMessage: "SSH 远程服务器未连接或已断开" }
        }
        try {
          await remoteFetchJson(
            remote,
            `/api/experimental/session/${encodeURIComponent(binding.sessionId)}/wait`,
            { method: "POST" },
            600_000,
          )
          return {}
        } catch (err) {
          const alive = await remoteFetchJson(
            remote,
            `/api/session/${encodeURIComponent(binding.sessionId)}`,
            undefined,
            4_500,
          )
            .then(() => true)
            .catch(() => false)
          if (!alive) {
            return {
              sshDisconnected: true,
              errorMessage: err instanceof Error ? err.message : "SSH 远端服务器连接中断",
            }
          }
          return {}
        }
      }
      const sessionID = Session.ID.make(binding.sessionId)
      let resumeErr: string | undefined
      await runEffect(sessions.resume(sessionID)).catch((err) => {
        resumeErr = err instanceof Error ? err.message : String(err)
      })
      await runEffect(sessions.wait(sessionID)).catch(() => undefined)
      return resumeErr ? { errorMessage: resumeErr } : {}
    }

    function formatToolProgressLabel(name: string, input: unknown): string {
      const rec = input && typeof input === "object" ? (input as Record<string, unknown>) : undefined
      const pickStr = (key: string) => (typeof rec?.[key] === "string" ? String(rec[key]).trim() : "")
      const lower = name.toLowerCase()
      if (lower === "bash" || lower === "shell" || lower === "run_command") {
        const cmd = (pickStr("command") || pickStr("cmd")).replace(/\s+/g, " ").slice(0, 42)
        return cmd ? `执行终端命令 \`${cmd}\`` : "执行终端命令"
      }
      if (lower === "read" || lower === "read_file" || lower === "view") {
        const p = pickStr("filePath") || pickStr("file_path") || pickStr("path")
        return p ? `读取文件 \`${path.basename(p)}\`` : "读取文件"
      }
      if (lower === "edit" || lower === "edit_file" || lower === "write" || lower === "write_file" || lower === "patch") {
        const p = pickStr("filePath") || pickStr("file_path") || pickStr("path")
        return p ? `修改文件 \`${path.basename(p)}\`` : "修改代码文件"
      }
      if (lower === "grep" || lower === "glob" || lower === "search") {
        const q = (pickStr("pattern") || pickStr("query") || pickStr("path")).slice(0, 32)
        return q ? `检索代码 \`${q}\`` : "检索项目代码"
      }
      if (lower === "question") {
        return "向你发起需求问答确认"
      }
      return `调用工具 \`${name}\``
    }

    interface RawTurnPart {
      readonly type: string
      readonly name?: string
      readonly text?: string
      readonly state?: { readonly status?: string; readonly input?: unknown }
      readonly time?: { readonly completed?: unknown }
    }

    interface RawTurnMsg {
      readonly id?: string
      readonly type: string
      readonly text?: string
      readonly retry?: { readonly attempt?: number }
      readonly error?: { readonly message?: string }
      readonly content?: readonly RawTurnPart[]
    }

    async function loadTurnMessages(binding: ChatSessionBinding): Promise<RawTurnMsg[]> {
      if (binding.serverKey !== "local") {
        const remote = remoteServers.get(binding.serverKey)
        if (!remote) return []
        const res = await remoteFetchJson<{ data: RawTurnMsg[] }>(
          remote,
          `/api/session/${encodeURIComponent(binding.sessionId)}/context`,
          undefined,
          8_000,
        ).catch(() => ({ data: [] as RawTurnMsg[] }))
        return res.data ?? []
      }
      const list = await runEffect(sessions.context(Session.ID.make(binding.sessionId))).catch(() => [])
      return list as unknown as RawTurnMsg[]
    }

    function compactSingleLine(input: string, maxChars: number): string {
      const oneLine = input.replace(/\s+/g, " ").trim()
      if (oneLine.length <= maxChars) return oneLine
      return `${oneLine.slice(0, maxChars - 1)}…`
    }

    function formatProcessEntriesMarkdown(
      entries: readonly string[],
      maxChars: number,
      showTruncatedNote = false,
    ): { text: string; truncated: boolean } {
      if (entries.length === 0) return { text: "", truncated: false }
      const full = entries.join("\n")
      if (full.length <= maxChars) return { text: full, truncated: false }

      const speechEntries = entries.filter((e) => e.startsWith("- 💬"))
      const recentTail = entries.slice(-14)
      const head = entries.slice(0, 3)
      const merged: string[] = []
      const seen = new Set<string>()
      const pushUnique = (line: string) => {
        if (seen.has(line)) return
        seen.add(line)
        merged.push(line)
      }
      for (const line of head) pushUnique(line)
      for (const line of speechEntries) pushUnique(line)
      for (const line of recentTail) pushUnique(line)

      const lines: string[] = []
      let used = 0
      const budget = Math.max(120, maxChars - (showTruncatedNote ? 48 : 16))
      for (let i = merged.length - 1; i >= 0; i--) {
        const item = merged[i]!
        if (used + item.length + 1 > budget && lines.length > 0) break
        lines.unshift(item)
        used += item.length + 1
      }
      const omitted = Math.max(0, entries.length - lines.length)
      if (omitted > 0) {
        const hint = showTruncatedNote
          ? `- *(… 另省略 ${omitted} 条工具明细，发 \`.log\` 查看完整过程)*`
          : `- *(… 前序 ${omitted} 条步骤已折叠，发 \`.log\` 可看全量)*`
        lines.unshift(hint)
      }
      return { text: lines.join("\n").slice(0, maxChars), truncated: omitted > 0 }
    }

    async function inspectLiveTurnProgress(
      binding: ChatSessionBinding,
      anchorMsgId?: string,
    ): Promise<{
      completedTools: number
      stepCount: number
      activeStep: string
      processEntries: readonly string[]
      retryAttempt?: number
    }> {
      const messages = await loadTurnMessages(binding)
      const anchorIdx = anchorMsgId ? messages.findIndex((m) => m.id === anchorMsgId) : -1
      let startIdx = anchorIdx
      for (let i = messages.length - 1; i >= 0; i--) {
        if (startIdx >= 0) break
        if (messages[i]?.type === "user" || messages[i]?.type === "synthetic") {
          startIdx = i
        }
      }
      const relevant = startIdx >= 0 ? messages.slice(startIdx + 1) : messages.slice(-6)

      let completedTools = 0
      let stepCount = 0
      let activeStep = "正在思考与组织方案…"
      let retryAttempt: number | undefined
      const processEntries: string[] = []

      for (const m of relevant) {
        if (m.type === "user" && m.text?.trim()) {
          processEntries.push(`- 📌 补充指令：${compactSingleLine(m.text, 120)}`)
          continue
        }
        if (m.type === "compaction") {
          activeStep = "🗜️ 会话上下文较长，正在自动压缩整理历史记忆…"
          continue
        }
        if (m.type !== "assistant") continue
        stepCount += 1
        if (m.retry?.attempt) {
          retryAttempt = m.retry.attempt
          activeStep = `⏳ 模型接口限流/波动，正在自动第 ${m.retry.attempt} 次重试…`
        }
        const stepToolLabels: string[] = []
        let stepSpokeText = false
        for (const part of m.content ?? []) {
          if (part.type === "text" && part.text?.trim()) {
            const clean = extractMobileButlerActions(part.text).cleanText
            if (clean) {
              stepSpokeText = true
              processEntries.push(`- 💬 ${compactSingleLine(clean, 220)}`)
              activeStep = `AI：${compactSingleLine(clean, 56)}`
            }
          }
          if (part.type === "reasoning" && !part.time?.completed) {
            activeStep = "正在深度推理思考…"
            if (!stepSpokeText && part.text?.trim()) {
              activeStep = `思考中：${compactSingleLine(part.text, 48)}`
            }
          }
          if (part.type === "tool") {
            const st = part.state?.status
            const label = formatToolProgressLabel(part.name ?? "tool", part.state?.input)
            if (st === "completed") {
              completedTools += 1
              stepToolLabels.push(`✓ ${label}`)
              activeStep = `已完成 ${label}，继续推进中…`
            }
            if (st === "error") {
              completedTools += 1
              stepToolLabels.push(`✗ ${label} (出错)`)
              activeStep = `${label} 返回异常，正在调整方案…`
            }
            if (st === "running" || st === "streaming") {
              stepToolLabels.push(`▶ ${label}`)
              activeStep = `正在${label}…`
            }
          }
        }
        if (stepToolLabels.length > 0) {
          processEntries.push(`- 🔧 ${stepToolLabels.join(" · ")}`)
        }
      }

      const rt = liveRuntimeStatus.get(binding.sessionId)
      if (rt?.compacting) {
        activeStep = "🗜️ 会话上下文较长，正在自动压缩整理历史记忆…"
      }
      if (rt?.retry && rt.retry.at > Date.now()) {
        retryAttempt = rt.retry.attempt
        const waitSec = Math.max(1, Math.ceil((rt.retry.at - Date.now()) / 1000))
        activeStep = `⏳ 模型接口限流/波动，正在退避等待第 ${rt.retry.attempt} 次自动重试（约 ${waitSec}s 后）…`
      }

      return { completedTools, stepCount, activeStep, processEntries, retryAttempt }
    }

    async function extractTurnProcessAndReply(
      binding: ChatSessionBinding,
      anchorMsgId?: string,
      includeErrors = true,
    ): Promise<{
      readonly finalReply: string
      readonly processEntries: readonly string[]
      readonly completedTools: number
      readonly stepCount: number
      readonly actions: readonly MobileButlerAction[]
      readonly terminalError?: string
      readonly tailMsgId?: string
      readonly triggerKind: "user" | "synthetic"
    }> {
      const messages = await loadTurnMessages(binding)
      const tailMsgId = messages[messages.length - 1]?.id
      const anchorIdx = anchorMsgId ? messages.findIndex((m) => m.id === anchorMsgId) : -1
      let startIdx = anchorIdx
      if (startIdx < 0) {
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i]?.type === "user" || messages[i]?.type === "synthetic") {
            startIdx = i
            break
          }
        }
      }
      const triggerKind: "user" | "synthetic" =
        startIdx >= 0 && messages[startIdx]?.type === "synthetic" ? "synthetic" : "user"
      const relevant = startIdx >= 0 ? messages.slice(startIdx + 1) : messages.slice(-4)

      interface Segment {
        readonly steerText?: string
        readonly assistants: RawTurnMsg[]
      }
      const segments: Segment[] = [{ assistants: [] }]
      const errors: string[] = []
      let lastOutcomeError: string | undefined

      for (const m of relevant) {
        if (m.type === "user" || m.type === "synthetic") {
          segments.push({ steerText: m.text?.trim(), assistants: [] })
          continue
        }
        if (m.type === "idle" && m.error?.message) {
          if (includeErrors) {
            errors.push(`错误：${m.error.message}`)
            lastOutcomeError = m.error.message
          }
          continue
        }
        if (m.type === "compaction" && m.error?.message) {
          if (includeErrors) {
            errors.push(`上下文压缩错误：${m.error.message}`)
            lastOutcomeError = m.error.message
          }
          continue
        }
        if (m.type !== "assistant") continue
        if (m.error?.message) {
          if (includeErrors) {
            errors.push(`错误：${m.error.message}`)
            lastOutcomeError = m.error.message
          }
        }
        if (!m.error?.message) {
          lastOutcomeError = undefined
        }
        segments[segments.length - 1]!.assistants.push(m)
      }

      const rtErr = includeErrors ? liveRuntimeStatus.get(binding.sessionId)?.terminalError : undefined
      const terminalError = lastOutcomeError ?? rtErr

      const actions: MobileButlerAction[] = []
      const processEntries: string[] = []
      const finalReplyBlocks: string[] = []
      let completedTools = 0
      let stepCount = 0

      for (const seg of segments) {
        if (seg.steerText) {
          processEntries.push(`- 📌 补充指令：${compactSingleLine(seg.steerText, 140)}`)
        }
        if (seg.assistants.length === 0) continue

        const cleanedSteps = seg.assistants.map((m) => {
          stepCount += 1
          const textParts: string[] = []
          const toolLabels: string[] = []
          for (const part of m.content ?? []) {
            if (part.type === "text" && part.text?.trim()) {
              const ex = extractMobileButlerActions(part.text)
              for (const act of ex.actions) actions.push(act)
              if (ex.cleanText) textParts.push(ex.cleanText)
            }
            if (part.type === "tool") {
              completedTools += 1
              const label = formatToolProgressLabel(part.name ?? "tool", part.state?.input)
              const prefix = part.state?.status === "error" ? "✗" : "✓"
              toolLabels.push(`${prefix} ${label}`)
            }
          }
          return {
            cleanText: textParts.join("\n\n").trim(),
            toolLabels,
          }
        })

        let finalIdx = -1
        for (let i = cleanedSteps.length - 1; i >= 0; i--) {
          if (cleanedSteps[i]?.cleanText) {
            finalIdx = i
            break
          }
        }

        for (const [idx, step] of cleanedSteps.entries()) {
          if (idx === finalIdx && step.cleanText) {
            finalReplyBlocks.push(step.cleanText)
          }
          if (idx !== finalIdx && step.cleanText) {
            processEntries.push(`- 💬 ${compactSingleLine(step.cleanText, 260)}`)
          }
          if (step.toolLabels.length > 0) {
            processEntries.push(`- 🔧 ${step.toolLabels.join(" · ")}`)
          }
        }
      }

      const finalReply =
        finalReplyBlocks.length > 0
          ? finalReplyBlocks.join("\n\n")
          : errors.length > 0
            ? errors.join("\n")
            : ""

      return {
        finalReply,
        processEntries,
        completedTools,
        stepCount,
        actions,
        terminalError,
        tailMsgId,
        triggerKind,
      }
    }

    function buildTurnFailureAlertCard(input: {
      readonly projectLabel: string
      readonly sessionLabel: string
      readonly modelLabel: string
      readonly errorMessage: string
      readonly sshDisconnected?: boolean
      readonly stepCount?: number
      readonly completedTools?: number
      readonly partialReply?: string
      readonly isBackground?: boolean
    }): MobileCard {
      const title = input.sshDisconnected
        ? "🔴 任务异常中断 · SSH 远端连接断开"
        : input.isBackground
          ? "🔴 后台任务异常中断"
          : "🔴 任务异常中断 · 模型或执行报错"

      const lines = [
        `项目：**${input.projectLabel}** · 会话：**${input.sessionLabel}**`,
        `模型：\`${input.modelLabel}\``,
        ...(input.stepCount && input.stepCount > 0
          ? [`中断前进展：已执行 **${input.stepCount}** 步${input.completedTools ? ` · **${input.completedTools}** 次工具调用` : ""}`]
          : []),
        "",
        `**中断原因**：${compactSingleLine(input.errorMessage, 320)}`,
      ]

      if (input.partialReply?.trim() && !input.partialReply.startsWith("错误：")) {
        lines.push("", `**中断前最后输出**：\n> ${compactSingleLine(input.partialReply, 240)}`)
      }

      const recoveryHint = input.sshDisconnected
        ? "请检查远端服务器或 SSH 隧道网络状态；恢复连接后直接发送「继续」即可接着执行，或发 .project 切换其他项目"
        : "可直接发送 .model 查看并切换其他可用模型，切换后回复「继续」即可从断点接着执行 · 发 .log 可查看中断前明细"

      return {
        header: {
          title,
          color: "red",
        },
        elements: [
          { kind: "markdown", content: lines.join("\n") },
          { kind: "note", text: recoveryHint },
        ],
      }
    }

    function buildStallWarningCard(input: {
      readonly projectLabel: string
      readonly activeStep: string
      readonly stalledSeconds: number
    }): MobileCard {
      return {
        header: {
          title: `⚠️ 任务长时间无新进展提醒 (${input.stalledSeconds}s)`,
          color: "orange",
        },
        elements: [
          {
            kind: "markdown",
            content: [
              `项目：**${input.projectLabel}**`,
              `当前停留在：${input.activeStep}`,
              "",
              "该步骤已持续较长时间没有产生新输出，可能正在执行超耗时计算，也可能卡在终端交互等待（如 `[y/N]` 确认或网络阻塞）。",
            ].join("\n"),
          },
          {
            kind: "note",
            text: "发 .log 查看实时明细 · 直接发送文字可插话引导 AI 调整 · 发 .stop 立即终止任务",
          },
        ],
      }
    }

    function buildProgressCard(
      projectLabel: string,
      elapsedSec: number,
      progress: { completedTools: number; stepCount: number; activeStep: string; processEntries: readonly string[] },
    ): MobileCard {
      const summaryLines = [
        `项目：**${projectLabel}**`,
        `阶段：${progress.activeStep}`,
        ...(progress.completedTools > 0 ? [`进展：已完成 **${progress.completedTools}** 个工具调用`] : []),
      ]
      const formattedLog = formatProcessEntriesMarkdown(progress.processEntries, 3000, false)
      const elements: MobileCard["elements"][number][] = [
        {
          kind: "markdown",
          content: summaryLines.join("\n"),
        },
      ]
      if (formattedLog.text) {
        elements.push({
          kind: "collapsible",
          title: `实时中间内容与步骤 (${progress.processEntries.length} 条)`,
          expanded: true,
          content: formattedLog.text,
        })
      }
      elements.push({
        kind: "note",
        text: "静默执行中，全部干完才会提醒你 · 发 .stop 中断 · 发 .ps <说明> 补充",
      })
      return {
        header: {
          title: `⏳ AI 正在处理中 (${elapsedSec}s)`,
          color: "orange",
        },
        elements,
      }
    }

    function buildCompletedProcessCard(
      projectLabel: string,
      elapsedSec: number,
      processEntries: readonly string[],
      completedTools: number,
      stepCount: number,
    ): MobileCard {
      const formattedLog = formatProcessEntriesMarkdown(processEntries, 3400, false)
      const stepDesc =
        completedTools > 0 ? `共 ${stepCount} 轮思考 · ${completedTools} 次工具操作` : `共 ${stepCount} 步中间记录`
      return {
        header: {
          title: `📋 执行过程记录 · ${stepDesc} (${elapsedSec}s)`,
          color: "grey",
        },
        elements: [
          {
            kind: "collapsible",
            title: `点击展开查看 AI 中间输出与执行步骤 (${processEntries.length} 条记录 · ${projectLabel})`,
            expanded: false,
            content: formattedLog.text || "(无中间输出)",
          },
        ],
      }
    }

    async function handleLogCommand(sessionKey: string): Promise<MobileCard> {
      const binding = await ensureBinding(sessionKey)
      if (!binding) {
        return {
          header: { title: "中间过程记录 (.log)", color: "orange" },
          elements: [{ kind: "markdown", content: "尚未绑定项目与会话。" }],
        }
      }
      const summary = await getCurrentSessionSummary(binding)
      const runningTurn = activeTurns.get(binding.sessionId)
      if (summary.isBusy || runningTurn) {
        const live = await inspectLiveTurnProgress(binding, runningTurn?.anchorMsgId)
        const formatted = formatProcessEntriesMarkdown(live.processEntries, 3500, false)
        return {
          header: {
            title: `⏳ 实时中间执行过程 · ${summary.sessionLabel}`,
            color: "orange",
          },
          elements: [
            {
              kind: "markdown",
              content: [
                `项目：**${summary.projectLabel}**`,
                `当前阶段：${live.activeStep}`,
                `已完成工具调用：**${live.completedTools}** 次（共 ${live.stepCount} 步）`,
              ].join("\n"),
            },
            {
              kind: "markdown",
              content: formatted.text || "AI 刚开始思考，暂未产生中间输出。",
            },
            {
              kind: "note",
              text: "任务仍在后台静默运行，全部完成后会自动提醒你",
            },
          ],
        }
      }

      const completed = await extractTurnProcessAndReply(binding, undefined, true)
      const formatted = formatProcessEntriesMarkdown(completed.processEntries, 3500, false)
      return {
        header: {
          title: `📋 最近一轮中间执行明细 · ${summary.sessionLabel}`,
          color: "blue",
        },
        elements: [
          {
            kind: "markdown",
            content:
              formatted.text ||
              (completed.finalReply
                ? "上一轮为单步直接回复，未产生额外的多步中间工具或旁白记录。"
                : "当前会话暂无执行记录。"),
          },
        ],
      }
    }

    async function executeButlerAction(
      connector: MobilePlatformConnector,
      replyContext: unknown,
      sessionKey: string,
      action: MobileButlerAction,
      snapshot?: {
        readonly projects: readonly UnifiedProjectItem[]
        readonly sessions: readonly UnifiedSessionItem[]
      },
    ): Promise<MobileCard | undefined> {
      if (action.type === "send_file") {
        const binding = await ensureBinding(sessionKey)
        if (!binding) return undefined
        return deliverProjectFileToMobile(connector, replyContext, binding, action.target ?? "")
      }
      if (action.type === "switch_project") {
        const rawTarget = (action.target ?? "").replace(/^#/, "").trim()
        const idx = Number(rawTarget)
        const snapProj =
          snapshot && Number.isInteger(idx) && idx >= 1 && idx <= snapshot.projects.length
            ? snapshot.projects[idx - 1]
            : undefined
        const resolvedTarget = snapProj
          ? `${snapProj.serverKey}:${snapProj.directory}`
          : rawTarget
        return handleProjectCommand(sessionKey, "switch", resolvedTarget)
      }
      if (action.type === "open_project") {
        return handleProjectCommand(sessionKey, "new", action.target ?? "")
      }
      if (action.type === "switch_session") {
        const rawTarget = (action.target ?? "").replace(/^#/, "").trim()
        const idx = Number(rawTarget)
        const snapSess =
          snapshot && Number.isInteger(idx) && idx >= 1 && idx <= snapshot.sessions.length
            ? snapshot.sessions[idx - 1]
            : undefined
        return handleChatCommand(sessionKey, "switch", snapSess ? snapSess.id : rawTarget)
      }
      if (action.type === "new_session") {
        return handleChatCommand(sessionKey, "new", action.target ?? "")
      }
      if (action.type === "switch_model") {
        const target = action.target?.trim() ?? ""
        const effort = action.effort?.trim() ?? ""
        const modelCard = target ? await handleModelCommand(sessionKey, "switch", target) : undefined
        if (effort && (!modelCard || modelCard.header?.color !== "red")) {
          const effortCard = await handleModelCommand(sessionKey, "effort", effort)
          return modelCard ?? effortCard
        }
        return modelCard
      }
      return undefined
    }

    async function upgradeLegacyMobilePermissions(binding: ChatSessionBinding): Promise<void> {
      const isLegacyMobileRuleset = (
        rules: ReadonlyArray<{ action: string; resource: string; effect: string }> | undefined,
      ): boolean =>
        Boolean(
          rules &&
            rules.length === 2 &&
            rules[0]?.action === "*" &&
            rules[0]?.resource === "*" &&
            rules[0]?.effect === "allow" &&
            rules[1]?.action === "question" &&
            rules[1]?.resource === "*" &&
            rules[1]?.effect === "deny",
        )

      if (binding.serverKey !== "local") {
        const remote = remoteServers.get(binding.serverKey)
        if (!remote) return
        const info = await remoteFetchJson<{
          data?: { permissions?: Array<{ action: string; resource: string; effect: string }> }
        }>(remote, `/api/session/${encodeURIComponent(binding.sessionId)}`, undefined, 6_000).catch(() => undefined)
        if (!isLegacyMobileRuleset(info?.data?.permissions)) return
        await remoteFetchJson(remote, `/api/session/${encodeURIComponent(binding.sessionId)}`, {
          method: "PATCH",
          body: JSON.stringify({ permissions: MOBILE_SESSION_PERMISSIONS }),
        }).catch(() => undefined)
        return
      }

      const sessionID = Session.ID.make(binding.sessionId)
      const info = await runEffect(sessions.get(sessionID)).catch(() => undefined)
      if (!isLegacyMobileRuleset(info?.permissions)) return
      await runEffect(
        sessions.setPermissions({
          sessionID,
          permissions: MOBILE_SESSION_PERMISSIONS,
        }),
      ).catch(() => undefined)
    }

    async function listPendingFormsForBinding(binding: ChatSessionBinding): Promise<readonly Form.Info[]> {
      if (binding.serverKey !== "local") {
        const remote = remoteServers.get(binding.serverKey)
        if (!remote) return []
        const res = await remoteFetchJson<{ data?: Form.Info[] }>(
          remote,
          `/api/session/${encodeURIComponent(binding.sessionId)}/form`,
          undefined,
          6_000,
        ).catch(() => undefined)
        return res?.data ?? []
      }
      const loc = Location.Ref.make({ directory: AbsolutePath.make(binding.projectDirectory) })
      return runEffect(
        Effect.scoped(
          Effect.gen(function* () {
            const locCtx = yield* locations.contextEffect(loc)
            const formSvc = Context.get(locCtx, Form.Service)
            return yield* formSvc.list({ sessionID: binding.sessionId })
          }),
        ),
      ).catch(() => [])
    }

    async function replyPendingFormForBinding(
      binding: ChatSessionBinding,
      formId: string,
      answer: Form.Answer,
    ): Promise<void> {
      if (binding.serverKey !== "local") {
        const remote = remoteServers.get(binding.serverKey)
        if (!remote) throw new Error("SSH 远程服务器未连接")
        await remoteFetchJson(
          remote,
          `/api/session/${encodeURIComponent(binding.sessionId)}/form/${encodeURIComponent(formId)}/reply`,
          {
            method: "POST",
            body: JSON.stringify({ answer }),
          },
          10_000,
        )
        return
      }
      const loc = Location.Ref.make({ directory: AbsolutePath.make(binding.projectDirectory) })
      await runEffect(
        Effect.scoped(
          Effect.gen(function* () {
            const locCtx = yield* locations.contextEffect(loc)
            const formSvc = Context.get(locCtx, Form.Service)
            yield* formSvc.reply({ id: Form.ID.make(formId), answer })
          }),
        ),
      )
    }

    async function cancelPendingFormForBinding(
      binding: ChatSessionBinding,
      formId: string,
      message?: string,
    ): Promise<void> {
      if (binding.serverKey !== "local") {
        const remote = remoteServers.get(binding.serverKey)
        if (!remote) throw new Error("SSH 远程服务器未连接")
        const qs = message !== undefined ? `?message=${encodeURIComponent(message)}` : ""
        await remoteFetchJson(
          remote,
          `/api/session/${encodeURIComponent(binding.sessionId)}/form/${encodeURIComponent(formId)}${qs}`,
          { method: "DELETE" },
          10_000,
        )
        return
      }
      const loc = Location.Ref.make({ directory: AbsolutePath.make(binding.projectDirectory) })
      await runEffect(
        Effect.scoped(
          Effect.gen(function* () {
            const locCtx = yield* locations.contextEffect(loc)
            const formSvc = Context.get(locCtx, Form.Service)
            yield* formSvc.cancel(Form.ID.make(formId), message === undefined ? undefined : { message })
          }),
        ),
      )
    }

    async function listPendingPermissionsForBinding(binding: ChatSessionBinding): Promise<readonly Permission.Request[]> {
      if (binding.serverKey !== "local") {
        const remote = remoteServers.get(binding.serverKey)
        if (!remote) return []
        const res = await remoteFetchJson<{ data?: Permission.Request[] }>(
          remote,
          `/api/session/${encodeURIComponent(binding.sessionId)}/permission`,
          undefined,
          6_000,
        ).catch(() => undefined)
        return res?.data ?? []
      }
      const loc = Location.Ref.make({ directory: AbsolutePath.make(binding.projectDirectory) })
      return runEffect(
        Effect.scoped(
          Effect.gen(function* () {
            const locCtx = yield* locations.contextEffect(loc)
            const permSvc = Context.get(locCtx, Permission.Service)
            return yield* permSvc.forSession(Session.ID.make(binding.sessionId))
          }),
        ),
      ).catch(() => [])
    }

    async function replyPendingPermissionForBinding(
      binding: ChatSessionBinding,
      requestId: string,
      reply: Permission.Reply,
      message?: string,
    ): Promise<void> {
      if (binding.serverKey !== "local") {
        const remote = remoteServers.get(binding.serverKey)
        if (!remote) throw new Error("SSH 远程服务器未连接")
        await remoteFetchJson(
          remote,
          `/api/session/${encodeURIComponent(binding.sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
          {
            method: "POST",
            body: JSON.stringify({
              decision: reply,
              ...(message ? { message } : {}),
            }),
          },
          10_000,
        )
        return
      }
      const loc = Location.Ref.make({ directory: AbsolutePath.make(binding.projectDirectory) })
      await runEffect(
        Effect.scoped(
          Effect.gen(function* () {
            const locCtx = yield* locations.contextEffect(loc)
            const permSvc = Context.get(locCtx, Permission.Service)
            yield* permSvc.reply({
              requestID: Permission.ID.make(requestId),
              reply,
              ...(message ? { message } : {}),
            })
          }),
        ),
      )
    }

    function isFormFieldActive(field: Form.Field, draft: Record<string, Form.Answer[string]>): boolean {
      if (field.type === "external") return true
      if (!field.when || field.when.length === 0) return true
      return field.when.every((cond) => {
        const val = draft[cond.key]
        if (val === undefined) return false
        const hit = Array.isArray(val) ? val.some((item) => item === cond.value) : val === cond.value
        return cond.op === "eq" ? hit : !hit
      })
    }

    function resolveActiveFormFields(
      form: Form.Info,
      draft: Record<string, Form.Answer[string]>,
    ): {
      activeFields: Form.Field[]
      unansweredFields: Form.Field[]
    } {
      for (const field of form.fields) {
        if (
          field.type !== "external" &&
          field.hidden &&
          field.default !== undefined &&
          draft[field.key] === undefined &&
          isFormFieldActive(field, draft)
        ) {
          draft[field.key] = field.default
        }
      }
      const activeFields = form.fields.filter((f) => isFormFieldActive(f, draft))
      const unansweredFields = activeFields.filter(
        (f) => draft[f.key] === undefined && !(f.type !== "external" && f.hidden),
      )
      return { activeFields, unansweredFields }
    }

    function formatAnswerValueDisplay(val: Form.Answer[string] | undefined): string {
      if (val === undefined) return "未填写"
      if (typeof val === "boolean") return val ? "是" : "否"
      if (Array.isArray(val)) return val.join("、")
      return String(val)
    }

    function buildQuestionCard(
      form: Form.Info,
      draft: Record<string, Form.Answer[string]>,
      projectName?: string,
    ): MobileCard {
      const { activeFields, unansweredFields } = resolveActiveFormFields(form, draft)
      const visibleFields = activeFields.filter((f) => !(f.type !== "external" && f.hidden))
      const primaryField = unansweredFields[0] ?? visibleFields[0]
      const headerSuffix =
        visibleFields.length === 1 && primaryField?.title?.trim()
          ? ` · ${primaryField.title.trim()}`
          : visibleFields.length > 1
            ? ` (共 ${visibleFields.length} 项)`
            : form.title && form.title !== "Questions"
              ? ` · ${form.title}`
              : ""

      const elements: MobileCard["elements"][number][] = []
      if (projectName) {
        elements.push({
          kind: "markdown",
          content: `项目：**${projectName}** — AI 执行到这里需要你拍板确认后才能继续：`,
        })
      }

      for (const [idx, field] of visibleFields.entries()) {
        const answeredVal = draft[field.key]
        const qPrefix = visibleFields.length > 1 ? `**问题 ${idx + 1}/${visibleFields.length}**` : ""
        const titlePart = field.title?.trim() ? `**${field.title.trim()}**` : ""
        const headLine = [qPrefix, titlePart].filter(Boolean).join(" · ")
        if (answeredVal !== undefined) {
          elements.push({
            kind: "markdown",
            content: `✓ ${headLine || field.key}：已选 **${formatAnswerValueDisplay(answeredVal)}**`,
          })
          continue
        }

        const promptBody = field.description?.trim() || field.title?.trim() || "请确认以下选项："
        const lines: string[] = []
        if (headLine && field.description?.trim()) {
          lines.push(headLine)
        }
        lines.push(promptBody)

        if (field.type === "external") {
          lines.push(`请前往链接完成确认：${field.url}`)
          lines.push(`- **#1 已完成外部授权/确认**`)
        }
        if (field.type === "boolean") {
          lines.push(`- **#1 是** (确认开启/同意)`)
          lines.push(`- **#2 否** (不开启/跳过该项)`)
        }
        if ((field.type === "string" || field.type === "multiselect") && field.options && field.options.length > 0) {
          if (field.type === "multiselect") {
            lines.push(`*(支持多选：可发多个编号，如 \`1,2\`)*`)
          }
          for (const [optIdx, opt] of field.options.entries()) {
            const desc = opt.description?.trim() ? ` — ${opt.description.trim()}` : ""
            lines.push(`- **#${optIdx + 1} ${opt.label}**${desc}`)
          }
        }
        elements.push({ kind: "markdown", content: lines.join("\n") })
      }

      const buttons: CardButton[] = []
      if (primaryField && draft[primaryField.key] === undefined) {
        if (
          primaryField.type === "string" &&
          primaryField.options &&
          primaryField.options.length > 0 &&
          primaryField.options.length <= 6
        ) {
          for (const [optIdx, opt] of primaryField.options.entries()) {
            const cleanLabel = opt.label.replace(/\s*\(recommended\)\s*$/i, " (推荐)").trim()
            const shortLabel = cleanLabel.length > 18 ? `${cleanLabel.slice(0, 17)}…` : cleanLabel
            buttons.push({
              text: `#${optIdx + 1} ${shortLabel}`,
              value: `qa:${form.id}:${optIdx + 1}`,
              type: optIdx === 0 ? "primary" : "default",
            })
          }
        }
        if (primaryField.type === "boolean") {
          buttons.push({ text: "#1 是", value: `qa:${form.id}:1`, type: "primary" })
          buttons.push({ text: "#2 否", value: `qa:${form.id}:2`, type: "default" })
        }
        if (primaryField.type === "external") {
          buttons.push({ text: "#1 已完成确认", value: `qa:${form.id}:1`, type: "primary" })
        }
        if (primaryField.type === "multiselect" && primaryField.options.length > 0) {
          buttons.push({ text: "全选所有项", value: `qa:${form.id}:all`, type: "default" })
        }
        buttons.push({ text: "跳过 (按推荐)", value: `qa:${form.id}:.skip`, type: "default" })
      }
      if (buttons.length > 0) {
        elements.push({ kind: "actions", buttons })
      }

      const canCustom =
        primaryField &&
        (primaryField.type === "string" || primaryField.type === "multiselect") &&
        primaryField.custom !== false
      const hintParts: string[] = []
      if (unansweredFields.length > 1) {
        hintParts.push("可逐题回复编号（如先发 1），也可按 / 分隔一次回完（如 1 / 2）")
      }
      if (unansweredFields.length <= 1 && primaryField?.type === "multiselect") {
        hintParts.push("多选请发多个编号（如 1,2）")
      }
      if (unansweredFields.length <= 1 && primaryField?.type !== "multiselect") {
        hintParts.push("直接回复数字编号（如 1）")
      }
      if (canCustom) {
        hintParts.push("或直接发送文字/语音说出你的自定义方案")
      }
      hintParts.push("发 .skip 按推荐方案继续 · 发 .stop 取消任务")

      elements.push({
        kind: "note",
        text: hintParts.join(" · "),
      })

      return {
        header: {
          title: `❓ AI 需要确认需求${headerSuffix}`,
          color: "blue",
        },
        elements,
      }
    }

    function buildPermissionCard(req: Permission.Request, projectName?: string): MobileCard {
      const resourcePreview = req.resources.slice(0, 4).map((r) => `\`${r}\``).join("、")
      const lines = [
        ...(projectName ? [`项目：**${projectName}**`] : []),
        `请求权限：\`${req.action}\``,
        ...(resourcePreview ? [`目标对象：${resourcePreview}`] : []),
        ...(req.message?.trim() ? [`说明：${req.message.trim()}`] : []),
        "",
        "- **#1 允许本次** (`once`)",
        "- **#2 始终允许此类操作** (`always`)",
        "- **#3 拒绝执行** (`reject`)",
      ]
      return {
        header: {
          title: `🔐 AI 请求执行权限确认 · ${req.action}`,
          color: "orange",
        },
        elements: [
          { kind: "markdown", content: lines.join("\n") },
          {
            kind: "actions",
            buttons: [
              { text: "#1 允许本次", value: `perm:${req.id}:once`, type: "primary" },
              { text: "#2 始终允许", value: `perm:${req.id}:always`, type: "default" },
              { text: "#3 拒绝", value: `perm:${req.id}:reject`, type: "danger" },
            ],
          },
          {
            kind: "note",
            text: "直接回复 1（允许本次）/ 2（始终允许）/ 3（拒绝），或直接回复修改意见让 AI 调整方案",
          },
        ],
      }
    }

    function extractOptionIndexToken(raw: string): number | undefined {
      const m = raw.trim().match(/^(?:#|选项\s*|选\s*|第\s*)?(\d+)(?:\s*个|\.)?$/i)
      if (!m?.[1]) return undefined
      const num = Number(m[1])
      return Number.isInteger(num) && num >= 1 ? num : undefined
    }

    function parseSingleFieldAnswer(
      field: Form.Field,
      rawInput: string,
    ): { ok: true; value: Form.Answer[string]; display: string } | { ok: false; error: string } {
      const trimmed = rawInput.trim()
      if (!trimmed) {
        return { ok: false, error: "回复内容为空，请输入选项编号或自定义内容。" }
      }

      if (field.type === "external") {
        const lower = trimmed.toLowerCase()
        if (["2", "否", "no", "cancel", "取消"].includes(lower)) {
          return { ok: false, error: "外部确认未完成；如需跳过请发 `.skip`，如需终止请发 `.stop`。" }
        }
        return { ok: true, value: true, display: "已完成确认" }
      }

      if (field.type === "boolean") {
        const lower = trimmed.toLowerCase()
        const idx = extractOptionIndexToken(trimmed)
        if (idx === 1 || ["是", "yes", "y", "true", "好", "好的", "确认", "开启", "同意", "需要"].includes(lower)) {
          return { ok: true, value: true, display: "是" }
        }
        if (idx === 2 || ["否", "no", "n", "false", "不", "不用", "不需要", "关闭", "拒绝"].includes(lower)) {
          return { ok: true, value: false, display: "否" }
        }
        return { ok: false, error: "请回复 `1`（是）或 `2`（否）。" }
      }

      if (field.type === "number" || field.type === "integer") {
        const num = Number(trimmed)
        if (!Number.isFinite(num)) {
          return { ok: false, error: `请输入有效数字${field.type === "integer" ? "（整数）" : ""}。` }
        }
        if (field.type === "integer" && !Number.isInteger(num)) {
          return { ok: false, error: "该项要求输入整数。" }
        }
        if (field.minimum !== undefined && num < field.minimum) {
          return { ok: false, error: `数值不能小于 ${field.minimum}。` }
        }
        if (field.maximum !== undefined && num > field.maximum) {
          return { ok: false, error: `数值不能大于 ${field.maximum}。` }
        }
        return { ok: true, value: num, display: String(num) }
      }

      if (field.type === "multiselect") {
        const opts = field.options
        if (/^(全选|全部|all|\*)$/i.test(trimmed) && opts.length > 0) {
          return {
            ok: true,
            value: opts.map((o) => o.value),
            display: opts.map((o) => o.label).join("、"),
          }
        }
        const indexTokens = trimmed.split(/[,，、;\s/]+/).filter(Boolean)
        const parsedIndices = indexTokens.map((tok) => extractOptionIndexToken(tok))
        if (
          indexTokens.length > 0 &&
          parsedIndices.every((idx): idx is number => idx !== undefined && idx >= 1 && idx <= opts.length)
        ) {
          const uniqueIndices = Array.from(new Set(parsedIndices))
          const picked = uniqueIndices.map((idx) => opts[idx - 1]!)
          return {
            ok: true,
            value: picked.map((o) => o.value),
            display: picked.map((o) => o.label).join("、"),
          }
        }
        const rawItems = trimmed
          .split(/[,，、;\n]+/)
          .map((s) => s.trim())
          .filter(Boolean)
        const values: string[] = []
        const labels: string[] = []
        for (const item of rawItems) {
          const itemIdx = extractOptionIndexToken(item)
          if (itemIdx !== undefined && itemIdx >= 1 && itemIdx <= opts.length) {
            const opt = opts[itemIdx - 1]!
            values.push(opt.value)
            labels.push(opt.label)
            continue
          }
          const lower = item.toLowerCase()
          const matchedOpt = opts.find(
            (o) =>
              o.value.toLowerCase() === lower ||
              o.label.toLowerCase() === lower ||
              o.label.replace(/\s*\(recommended\)\s*$/i, "").trim().toLowerCase() === lower,
          )
          if (matchedOpt) {
            values.push(matchedOpt.value)
            labels.push(matchedOpt.label)
            continue
          }
          if (!field.custom) {
            return {
              ok: false,
              error: `未找到选项 \`${item}\`，请回复 1~${opts.length} 之间的选项编号（多选用逗号分隔，如 \`1,2\`）。`,
            }
          }
          values.push(item)
          labels.push(item)
        }
        if (values.length === 0) {
          return { ok: false, error: "请至少选择或输入一项。" }
        }
        return { ok: true, value: values, display: labels.join("、") }
      }

      // field.type === "string"
      const opts = field.options ?? []
      if (opts.length > 0) {
        const idx = extractOptionIndexToken(trimmed)
        if (idx !== undefined && idx >= 1 && idx <= opts.length) {
          const chosen = opts[idx - 1]!
          return { ok: true, value: chosen.value, display: chosen.label }
        }
        const lower = trimmed.toLowerCase()
        const exactOpt = opts.find(
          (o) =>
            o.value.toLowerCase() === lower ||
            o.label.toLowerCase() === lower ||
            o.label.replace(/\s*\(recommended\)\s*$/i, "").trim().toLowerCase() === lower,
        )
        if (exactOpt) {
          return { ok: true, value: exactOpt.value, display: exactOpt.label }
        }
        if (!field.custom) {
          const partialMatches = opts.filter((o) => o.label.toLowerCase().includes(lower))
          if (partialMatches.length === 1) {
            return { ok: true, value: partialMatches[0]!.value, display: partialMatches[0]!.label }
          }
          return {
            ok: false,
            error: `请回复 1~${opts.length} 之间的选项编号（例如 \`1\`）。`,
          }
        }
      }

      return { ok: true, value: trimmed, display: trimmed }
    }

    async function deliverDetachedSessionSettlement(
      serverKey: string,
      sessionId: string,
      outcome: "succeeded" | "failed",
      explicitError?: string,
    ): Promise<void> {
      if (activeTurns.has(sessionId) || detachedDrainSessions.has(sessionId)) return
      for (const [sessionKey, b] of bindings.entries()) {
        if (b.serverKey !== serverKey || b.sessionId !== sessionId) continue
        const res = await extractTurnProcessAndReply(b, undefined, true)
        if (!markTailDelivered(sessionKey, res.tailMsgId)) continue
        const robotId = sessionKey.split(":")[1] ?? ""
        const robot = robots.get(robotId)
        const conn = connectors.get(robotId)
        const rc = robot ? synthesizeFallbackReplyContext(sessionKey, robot) : lastReplyContexts.get(sessionKey)
        const summary = await getCurrentSessionSummary(b)

        const errText = outcome === "failed" ? (explicitError ?? res.terminalError ?? "执行异常终止") : res.terminalError
        if (errText) {
          const alertCard = buildTurnFailureAlertCard({
            projectLabel: summary.projectLabel,
            sessionLabel: summary.sessionLabel,
            modelLabel: summary.modelLabel,
            errorMessage: errText,
            stepCount: res.stepCount,
            completedTools: res.completedTools,
            partialReply: res.finalReply,
            isBackground: true,
          })
          recordBackgroundOutbox(sessionKey, { card: alertCard })
          if (conn && rc) {
            await conn.sendCard(rc, alertCard).catch(() => undefined)
          }
          continue
        }

        if (!res.finalReply) continue
        const badge =
          res.triggerKind === "synthetic"
            ? "⏰ **[定时 / 后台子智能体任务已完成]**"
            : "🖥️ **[桌面端任务已完成]**"
        const footer = `\n\n*[${summary.projectLabel} · ${summary.sessionLabel} · ${summary.modelLabel}]*`
        const fullText = `${badge}\n\n${res.finalReply}${footer}`
        recordBackgroundOutbox(sessionKey, { text: fullText })
        if (conn && rc) {
          await conn.sendText(rc, fullText).catch(() => undefined)
          const fileActions = res.actions.filter((a) => a.type === "send_file")
          for (const fa of fileActions) {
            const errCard = await executeButlerAction(conn, rc, sessionKey, fa)
            if (errCard) {
              await conn.sendCard(rc, errCard).catch(() => undefined)
            }
          }
        }
      }
    }

    function attachDetachedDrainNotification(
      connector: MobilePlatformConnector,
      replyContext: unknown,
      sessionKey: string,
      binding: ChatSessionBinding,
    ): void {
      if (activeTurns.has(binding.sessionId) || detachedDrainSessions.has(binding.sessionId)) return
      detachedDrainSessions.add(binding.sessionId)
      void (async () => {
        try {
          const drainRes = await waitSessionDrain(binding)
          const res = await extractTurnProcessAndReply(binding, undefined, true)
          if (!markTailDelivered(sessionKey, res.tailMsgId)) return
          const summary = await getCurrentSessionSummary(binding)
          const errText = drainRes.sshDisconnected
            ? (drainRes.errorMessage ?? "SSH 远端连接中断")
            : (res.terminalError ?? drainRes.errorMessage)
          if (errText) {
            const alertCard = buildTurnFailureAlertCard({
              projectLabel: summary.projectLabel,
              sessionLabel: summary.sessionLabel,
              modelLabel: summary.modelLabel,
              errorMessage: errText,
              sshDisconnected: drainRes.sshDisconnected,
              stepCount: res.stepCount,
              completedTools: res.completedTools,
              partialReply: res.finalReply,
              isBackground: true,
            })
            recordBackgroundOutbox(sessionKey, { card: alertCard })
            await connector.sendCard(replyContext, alertCard).catch(() => undefined)
            return
          }
          if (!res.finalReply) return
          const footer = `\n\n*[${summary.projectLabel} · ${summary.sessionLabel} · ${summary.modelLabel}]*`
          const fullText = `${res.finalReply}${footer}`
          recordBackgroundOutbox(sessionKey, { text: fullText })
          await connector.sendText(replyContext, fullText).catch(() => undefined)
        } finally {
          detachedDrainSessions.delete(binding.sessionId)
        }
      })()
    }

    async function applyInputToPendingForm(
      binding: ChatSessionBinding,
      form: Form.Info,
      rawReply: string,
    ): Promise<MobileCard> {
      const normalized = rawReply.trim()
      if (/^(\.skip|跳过|跳过问题)$/i.test(normalized)) {
        pendingFormDrafts.delete(form.id)
        await cancelPendingFormForBinding(
          binding,
          form.id,
          "用户在手机端选择了跳过该问题，请直接采用你最推荐的默认方案继续执行，无需再次追问。",
        )
        return {
          header: { title: "✅ 已跳过问答（按推荐方案继续）", color: "green" },
          elements: [
            {
              kind: "markdown",
              content: "已通知 AI 直接采用推荐默认方案继续干活，全部完成后提醒你。",
            },
          ],
        }
      }

      const draft: Record<string, Form.Answer[string]> = { ...(pendingFormDrafts.get(form.id) ?? {}) }
      const { unansweredFields } = resolveActiveFormFields(form, draft)
      if (unansweredFields.length === 0) {
        await replyPendingFormForBinding(binding, form.id, draft)
        pendingFormDrafts.delete(form.id)
        return {
          header: { title: "✅ 已提交确认，AI 继续执行中", color: "green" },
          elements: [{ kind: "markdown", content: "任务正在后台继续执行，全部干完后提醒你。" }],
        }
      }

      const batchSegments = (() => {
        if (unansweredFields.length <= 1) return [normalized]
        const slashOrLine = normalized
          .split(/\r?\n|\s*[\/｜|;；]\s*/)
          .map((s) => s.trim())
          .filter(Boolean)
        if (slashOrLine.length > 1 && slashOrLine.length <= unansweredFields.length) {
          return slashOrLine
        }
        if (unansweredFields[0]?.type !== "multiselect") {
          const commaParts = normalized.split(/[,，、\s]+/).filter(Boolean)
          const allValidIndices =
            commaParts.length > 1 &&
            commaParts.length <= unansweredFields.length &&
            commaParts.every((part, idx) => {
              const targetField = unansweredFields[idx]
              const optNum = extractOptionIndexToken(part)
              if (!targetField || optNum === undefined) return false
              if (targetField.type === "boolean") return optNum === 1 || optNum === 2
              if (targetField.type === "string" && targetField.options) {
                return optNum >= 1 && optNum <= targetField.options.length
              }
              return false
            })
          if (allValidIndices) return commaParts
        }
        return [normalized]
      })()

      for (const [segIdx, seg] of batchSegments.entries()) {
        const currentRemaining = resolveActiveFormFields(form, draft).unansweredFields
        const targetField = currentRemaining[0]
        if (!targetField) break
        const parsed = parseSingleFieldAnswer(targetField, seg)
        if (!parsed.ok) {
          if (segIdx > 0) pendingFormDrafts.set(form.id, draft)
          return {
            header: { title: "⚠️ 选项格式无法识别", color: "orange" },
            elements: [
              {
                kind: "markdown",
                content: `${parsed.error}\n*(发 \`.skip\` 可按推荐方案跳过，发 \`.stop\` 可中止任务)*`,
              },
            ],
          }
        }
        draft[targetField.key] = parsed.value
      }

      const afterStep = resolveActiveFormFields(form, draft)
      if (afterStep.unansweredFields.length > 0) {
        pendingFormDrafts.set(form.id, draft)
        return buildQuestionCard(form, draft, binding.projectName)
      }

      const validationErr = Form.validateAnswer(form.fields, draft)
      if (validationErr) {
        return {
          header: { title: "⚠️ 提交校验未通过", color: "orange" },
          elements: [{ kind: "markdown", content: validationErr }],
        }
      }

      await replyPendingFormForBinding(binding, form.id, draft)
      pendingFormDrafts.delete(form.id)

      const summaryLines = afterStep.activeFields
        .filter((f) => !(f.type !== "external" && f.hidden))
        .map((f) => {
          const label = f.title?.trim() || f.description?.trim() || f.key
          return `- **${compactSingleLine(label, 36)}**：${formatAnswerValueDisplay(draft[f.key])}`
        })

      return {
        header: { title: "✅ 已确认需求，AI 继续干活中", color: "green" },
        elements: [
          {
            kind: "markdown",
            content: [
              ...summaryLines,
              "",
              "AI 已收到你的回答并继续静默执行，全部完成后提醒你。",
            ].join("\n"),
          },
        ],
      }
    }

    async function applyInputToPendingPermission(
      binding: ChatSessionBinding,
      req: Permission.Request,
      rawReply: string,
    ): Promise<MobileCard> {
      const trimmed = rawReply.trim()
      const lower = trimmed.toLowerCase()
      const idx = extractOptionIndexToken(trimmed)
      if (idx === 1 || ["once", "允许", "允许本次", "同意", "确认", "yes", "y", "ok", "好", "好的"].includes(lower)) {
        await replyPendingPermissionForBinding(binding, req.id, "once")
        return {
          header: { title: "✅ 已允许本次执行", color: "green" },
          elements: [{ kind: "markdown", content: `已批准 \`${req.action}\`，AI 继续静默执行中，完成后提醒你。` }],
        }
      }
      if (idx === 2 || ["always", "始终允许", "总是允许"].includes(lower)) {
        await replyPendingPermissionForBinding(binding, req.id, "always")
        return {
          header: { title: "✅ 已设为始终允许", color: "green" },
          elements: [{ kind: "markdown", content: `已批准并记住 \`${req.action}\`，AI 继续静默执行中。` }],
        }
      }
      if (idx === 3 || ["reject", "拒绝", "不允许", "no", "n", ".skip", "跳过"].includes(lower)) {
        await replyPendingPermissionForBinding(binding, req.id, "reject")
        return {
          header: { title: "🚫 已拒绝该权限请求", color: "orange" },
          elements: [{ kind: "markdown", content: `已拒绝 \`${req.action}\`。` }],
        }
      }
      await replyPendingPermissionForBinding(binding, req.id, "reject", trimmed)
      return {
        header: { title: "💬 已将调整意见反馈给 AI", color: "blue" },
        elements: [
          {
            kind: "markdown",
            content: `已拒绝 \`${req.action}\` 并附带你的说明：> ${trimmed}\n\nAI 将根据你的反馈调整方案继续执行。`,
          },
        ],
      }
    }

    async function checkAndNotifyPendingInteractive(
      connector: MobilePlatformConnector,
      replyContext: unknown,
      sessionKey: string,
      binding: ChatSessionBinding,
    ): Promise<boolean> {
      const [pendingForms, pendingPerms] = await Promise.all([
        listPendingFormsForBinding(binding),
        listPendingPermissionsForBinding(binding),
      ])
      for (const form of pendingForms) {
        const dedupeKey = `form:${sessionKey}:${form.id}`
        if (!markInteractiveNotified(dedupeKey)) continue
        const draft = { ...(pendingFormDrafts.get(form.id) ?? {}) }
        const card = buildQuestionCard(form, draft, binding.projectName)
        await connector.sendCard(replyContext, card).catch(() => undefined)
      }
      for (const perm of pendingPerms) {
        const dedupeKey = `perm:${sessionKey}:${perm.id}`
        if (!markInteractiveNotified(dedupeKey)) continue
        const card = buildPermissionCard(perm, binding.projectName)
        await connector.sendCard(replyContext, card).catch(() => undefined)
      }
      return pendingForms.length > 0 || pendingPerms.length > 0
    }

    async function tryHandlePendingInteractiveReply(
      connector: MobilePlatformConnector,
      msg: InboundMobileMessage,
      rawPromptText: string,
    ): Promise<boolean> {
      const binding = bindings.get(msg.sessionKey)
      if (!binding) return false
      const [pendingForms, pendingPerms] = await Promise.all([
        listPendingFormsForBinding(binding),
        listPendingPermissionsForBinding(binding),
      ])
      if (pendingForms.length === 0 && pendingPerms.length === 0) return false

      let replyText = rawPromptText.trim()
      if (!replyText && msg.audioAttachments && msg.audioAttachments.length > 0) {
        const validAudio = msg.audioAttachments.filter((a) => a.mimeType !== "audio/silk")
        const parts: string[] = []
        for (const att of validAudio) {
          const text = await transcribeAudioWithMultimodal(global.config, {
            data: att.data,
            mimeType: att.mimeType,
            fileName: att.fileName,
          }).catch(() => "")
          if (text.trim()) parts.push(text.trim())
        }
        replyText = parts.join(" ").trim()
      }

      if (!replyText) return false

      if (pendingForms.length > 0) {
        const card = await applyInputToPendingForm(binding, pendingForms[0]!, replyText)
        await connector.sendCard(msg.replyContext, card)
        attachDetachedDrainNotification(connector, msg.replyContext, msg.sessionKey, binding)
        return true
      }

      if (pendingPerms.length > 0) {
        const card = await applyInputToPendingPermission(binding, pendingPerms[0]!, replyText)
        await connector.sendCard(msg.replyContext, card)
        attachDetachedDrainNotification(connector, msg.replyContext, msg.sessionKey, binding)
        return true
      }

      return false
    }

    async function handleSkipCommand(connector: MobilePlatformConnector, msg: InboundMobileMessage): Promise<void> {
      const binding = await ensureBinding(msg.sessionKey)
      if (!binding) {
        await connector.sendCard(msg.replyContext, {
          header: { title: "跳过问答 (.skip)", color: "orange" },
          elements: [{ kind: "markdown", content: "当前没有待确认的问题。" }],
        })
        return
      }
      const [pendingForms, pendingPerms] = await Promise.all([
        listPendingFormsForBinding(binding),
        listPendingPermissionsForBinding(binding),
      ])
      if (pendingForms.length > 0) {
        const card = await applyInputToPendingForm(binding, pendingForms[0]!, ".skip")
        await connector.sendCard(msg.replyContext, card)
        attachDetachedDrainNotification(connector, msg.replyContext, msg.sessionKey, binding)
        return
      }
      if (pendingPerms.length > 0) {
        const card = await applyInputToPendingPermission(binding, pendingPerms[0]!, "reject")
        await connector.sendCard(msg.replyContext, card)
        attachDetachedDrainNotification(connector, msg.replyContext, msg.sessionKey, binding)
        return
      }
      await connector.sendCard(msg.replyContext, {
        header: { title: "当前无待确认问题 (.skip)", color: "blue" },
        elements: [{ kind: "markdown", content: "当前会话没有挂起的问答或权限请求。" }],
      })
    }

    async function handleInboundCardAction(
      input: {
        readonly robotId: string
        readonly action: string
        readonly sessionKey: string
        readonly userId: string
        readonly chatId: string
        readonly replyContext: unknown
      },
      overrideConnector?: MobilePlatformConnector,
    ): Promise<MobileCard | undefined> {
      const robot = robots.get(input.robotId)
      const connector = overrideConnector ?? connectors.get(input.robotId)
      if (!robot || !connector) return undefined
      if (!isUserAllowed(robot.ownerID, robot.allowFrom, input.userId)) {
        return {
          header: { title: "未授权操作", color: "red" },
          elements: [{ kind: "markdown", content: `账号 \`${input.userId}\` 未获授权。` }],
        }
      }
      lastReplyContexts.set(input.sessionKey, input.replyContext)
      const binding = await ensureBinding(input.sessionKey)
      if (!binding) return undefined

      if (input.action.startsWith("qa:")) {
        const rest = input.action.slice(3)
        const sep = rest.indexOf(":")
        if (sep <= 0) return undefined
        const formId = rest.slice(0, sep)
        const choice = rest.slice(sep + 1)
        const pendingForms = await listPendingFormsForBinding(binding)
        const targetForm = pendingForms.find((f) => f.id === formId) ?? pendingForms[0]
        if (!targetForm) {
          return {
            header: { title: "该问题已处理完毕", color: "grey" },
            elements: [{ kind: "markdown", content: "该问答确认已完成或已过期。" }],
          }
        }
        const nextCard = await applyInputToPendingForm(binding, targetForm, choice)
        attachDetachedDrainNotification(connector, input.replyContext, input.sessionKey, binding)
        return nextCard
      }

      if (input.action.startsWith("perm:")) {
        const rest = input.action.slice(5)
        const sep = rest.indexOf(":")
        if (sep <= 0) return undefined
        const reqId = rest.slice(0, sep)
        const decision = rest.slice(sep + 1)
        const pendingPerms = await listPendingPermissionsForBinding(binding)
        const targetPerm = pendingPerms.find((p) => p.id === reqId) ?? pendingPerms[0]
        if (!targetPerm) {
          return {
            header: { title: "该权限请求已处理完毕", color: "grey" },
            elements: [{ kind: "markdown", content: "该权限确认已完成或已过期。" }],
          }
        }
        const nextCard = await applyInputToPendingPermission(binding, targetPerm, decision)
        attachDetachedDrainNotification(connector, input.replyContext, input.sessionKey, binding)
        return nextCard
      }

      return undefined
    }

    async function pushRealtimeLocalInteractiveEvent(
      event:
        | { readonly kind: "form"; readonly form: Form.Info }
        | { readonly kind: "perm"; readonly perm: Permission.Request },
    ): Promise<void> {
      const sessionID = event.kind === "form" ? event.form.sessionID : event.perm.sessionID
      const activeTurn = activeTurns.get(sessionID)
      if (activeTurn) {
        const dedupeKey =
          event.kind === "form"
            ? `form:${activeTurn.sessionKey}:${event.form.id}`
            : `perm:${activeTurn.sessionKey}:${event.perm.id}`
        if (!markInteractiveNotified(dedupeKey)) return
        const card =
          event.kind === "form"
            ? buildQuestionCard(
                event.form,
                { ...(pendingFormDrafts.get(event.form.id) ?? {}) },
                activeTurn.binding.projectName,
              )
            : buildPermissionCard(event.perm, activeTurn.binding.projectName)
        await activeTurn.connector.sendCard(activeTurn.replyContext, card).catch(() => undefined)
        return
      }

      for (const [sessionKey, b] of bindings.entries()) {
        if (b.serverKey !== "local" || b.sessionId !== sessionID) continue
        const parts = sessionKey.split(":")
        const robotId = parts[1] ?? ""
        const robot = robots.get(robotId)
        const conn = connectors.get(robotId)
        const rc = robot ? synthesizeFallbackReplyContext(sessionKey, robot) : lastReplyContexts.get(sessionKey)
        const dedupeKey =
          event.kind === "form" ? `form:${sessionKey}:${event.form.id}` : `perm:${sessionKey}:${event.perm.id}`
        if (!markInteractiveNotified(dedupeKey)) continue
        const card =
          event.kind === "form"
            ? buildQuestionCard(event.form, { ...(pendingFormDrafts.get(event.form.id) ?? {}) }, b.projectName)
            : buildPermissionCard(event.perm, b.projectName)
        recordBackgroundOutbox(sessionKey, { card })
        if (conn && rc) {
          await conn.sendCard(rc, card).catch(() => undefined)
        }
      }
    }

    async function handlePromptTurn(
      connector: MobilePlatformConnector,
      msg: InboundMobileMessage,
      promptText: string,
      butlerDepth = 0,
    ): Promise<void> {
      const binding = await ensureBinding(msg.sessionKey)
      if (!binding) {
        await connector.sendCard(msg.replyContext, {
          header: { title: "请先打开项目", color: "orange" },
          elements: [
            {
              kind: "markdown",
              content: "未发现项目，请发送 `.project new /项目路径` 打开目录。",
            },
          ],
        })
        return
      }

      if (binding.serverKey !== "local" && !remoteServers.has(binding.serverKey)) {
        await connector.sendText(msg.replyContext, "当前绑定的 SSH 服务器未连接，请发送 `.project` 切换项目。")
        return
      }

      const allProjects = await listAllProjects()
      const currentProj: UnifiedProjectItem = allProjects.find(
        (p) =>
          p.serverKey === binding.serverKey &&
          ((binding.projectId !== "global" && p.id === binding.projectId) || p.directory === binding.projectDirectory),
      ) ?? {
        serverKey: binding.serverKey,
        serverLabel: binding.serverKey === "local" ? "本机" : `SSH:${binding.serverKey}`,
        isRemote: binding.serverKey !== "local",
        id: binding.projectId,
        name: binding.projectName,
        directory: binding.projectDirectory,
      }
      const [projSessions, models, preSummary] = await Promise.all([
        listSessionsForProject(currentProj).catch(() => [] as UnifiedSessionItem[]),
        listModelsForBinding(binding).catch(() => [] as UnifiedModelItem[]),
        getCurrentSessionSummary(binding),
      ])

      const activeModelMeta = preSummary.activeModelRef
        ? models.find(
            (m) => m.providerID === preSummary.activeModelRef!.providerID && m.id === preSummary.activeModelRef!.id,
          )
        : undefined
      const activeModelIdLower = preSummary.activeModelRef?.id.toLowerCase() ?? ""
      const supportsNativeAudio = activeModelMeta ? activeModelMeta.supportsAudio : activeModelIdLower.includes("gemini")
      const supportsNativeImage = activeModelMeta
        ? (activeModelMeta.supportsImage ?? true)
        : !activeModelIdLower.includes("deepseek")
      const supportsNativePdf = activeModelMeta
        ? Boolean(activeModelMeta.supportsPdf)
        : activeModelIdLower.includes("gemini") || activeModelIdLower.includes("claude")
      const supportsNativeVideo = activeModelMeta
        ? Boolean(activeModelMeta.supportsVideo)
        : activeModelIdLower.includes("gemini")

      let effectivePromptText = promptText.trim()
      const inlinePromptFiles: Array<{ uri: string; name: string }> = []
      const rawAudio = msg.audioAttachments ?? []
      const rawFiles = msg.fileAttachments ?? []

      if (rawAudio.length > 0) {
        const validAudio = rawAudio.filter((item) => item.mimeType !== "audio/silk")
        if (validAudio.length === 0 && !effectivePromptText && rawFiles.length === 0) {
          await connector.sendText(
            msg.replyContext,
            "收到原始 SILK 编码语音，当前通道暂无法直接解码该音频帧；请开启客户端语音转文字或使用飞书/微信语音。",
          )
          return
        }
        if (validAudio.length > 0 && supportsNativeAudio) {
          validAudio.forEach((att, idx) => {
            const ext = (att.mimeType.split("/")[1] || "wav").split(";")[0] || "wav"
            inlinePromptFiles.push({
              uri: `data:${att.mimeType};base64,${Buffer.from(att.data).toString("base64")}`,
              name: att.fileName || `voice-${idx + 1}.${ext}`,
            })
          })
          if (!effectivePromptText && rawFiles.length === 0) {
            effectivePromptText = "请直接听取我发送的这段语音消息并自然回复。"
          }
        }
        if (validAudio.length > 0 && !supportsNativeAudio) {
          const transcripts: string[] = []
          for (const att of validAudio) {
            const transcribed = await transcribeAudioWithMultimodal(global.config, {
              data: att.data,
              mimeType: att.mimeType,
              fileName: att.fileName,
            })
            if (transcribed.trim()) {
              transcripts.push(transcribed.trim())
            }
          }
          const combinedTranscript = transcripts.join("\n").trim()
          effectivePromptText = [effectivePromptText, combinedTranscript].filter(Boolean).join("\n").trim()
          if (!effectivePromptText && rawFiles.length === 0) {
            await connector.sendText(msg.replyContext, "未能听清这段语音内容，请重试或直接发送文字。")
            return
          }
        }
      }

      if (rawFiles.length > 0) {
        const supportedInlineImageMimes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])
        const savedNotes: string[] = []
        const mediaFallbacks: string[] = []
        let hasImages = false

        const inboxDir = path.join(
          global.data,
          "mobile-inbox",
          msg.sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64),
        )
        if (binding.serverKey === "local") {
          await runEffect(fs.ensureDir(inboxDir)).catch(() => undefined)
        }

        for (const [idx, att] of rawFiles.entries()) {
          const safeName = path.basename(att.fileName || `attachment-${idx + 1}`).replace(/[^\w.\-\u4e00-\u9fff]/g, "_")
          const normalizedMime = inferMimeFromFileName(safeName, att.data)
          const isInlineRasterImage = supportedInlineImageMimes.has(normalizedMime)
          if (normalizedMime.startsWith("image/")) hasImages = true

          if (binding.serverKey === "local") {
            const savedPath = path.join(inboxDir, `${Date.now()}-${idx + 1}-${safeName}`)
            await Bun.write(savedPath, att.data).catch(() => undefined)
            savedNotes.push(`[手机端发来附件 \`${safeName}\` (${normalizedMime}) 已保存至本机：\`${savedPath}\`]`)
          }

          if (binding.serverKey !== "local") {
            const remote = remoteServers.get(binding.serverKey)
            if (remote) {
              const relInboxPath = `.opencode/mobile-inbox/${Date.now()}-${idx + 1}-${safeName}`
              const writeUrl = `${remote.url.replace(/\/+$/, "")}/api/experimental/fs/write?location%5Bdirectory%5D=${encodeURIComponent(binding.projectDirectory)}&path=${encodeURIComponent(relInboxPath)}`
              const ok = await fetch(writeUrl, {
                method: "POST",
                headers: {
                  ...remoteHeaders(remote, false),
                  "Content-Type": "application/octet-stream",
                },
                body: att.data,
                signal: AbortSignal.timeout(30_000),
              })
                .then((r) => r.ok)
                .catch(() => false)
              if (ok) {
                savedNotes.push(`[手机端发来附件 \`${safeName}\` 已保存至远程项目目录：\`${relInboxPath}\`]`)
              }
            }
          }

          if (isInlineRasterImage && supportsNativeImage) {
            inlinePromptFiles.push({
              uri: `data:${normalizedMime};base64,${Buffer.from(att.data).toString("base64")}`,
              name: safeName,
            })
            continue
          }
          if (isInlineRasterImage && !supportsNativeImage) {
            const desc = await describeMediaWithMultimodal(global.config, {
              data: att.data,
              mimeType: normalizedMime,
              fileName: safeName,
            })
            if (desc) {
              mediaFallbacks.push(`[图片内容识别 (${safeName})]:\n${desc}`)
            }
            continue
          }
          if (normalizedMime === "application/pdf" && supportsNativePdf) {
            inlinePromptFiles.push({
              uri: `data:application/pdf;base64,${Buffer.from(att.data).toString("base64")}`,
              name: safeName,
            })
            continue
          }
          if (normalizedMime === "application/pdf" && !supportsNativePdf && att.data.byteLength <= 10 * 1024 * 1024) {
            const desc = await describeMediaWithMultimodal(global.config, {
              data: att.data,
              mimeType: "application/pdf",
              fileName: safeName,
            })
            if (desc) {
              mediaFallbacks.push(`[PDF 内容提取 (${safeName})]:\n${desc}`)
            }
            continue
          }
          if (normalizedMime.startsWith("video/") && supportsNativeVideo) {
            inlinePromptFiles.push({
              uri: `data:${normalizedMime};base64,${Buffer.from(att.data).toString("base64")}`,
              name: safeName,
            })
            continue
          }
          const isUtf8Text =
            (Mime.detect(att.data) === "text/plain" || Mime.isTextual(normalizedMime)) &&
            !att.data.includes(0) &&
            att.data.byteLength <= 256 * 1024
          if (isUtf8Text) {
            inlinePromptFiles.push({
              uri: `data:text/plain;base64,${Buffer.from(att.data).toString("base64")}`,
              name: safeName,
            })
          }
        }

        if (!effectivePromptText) {
          effectivePromptText = hasImages
            ? "我发送了图片附件，请结合上下文查看画面内容并直接分析或处理。"
            : "我发送了文件附件，请查看文件内容并结合上下文分析或处理。"
        }
        effectivePromptText = [effectivePromptText, ...mediaFallbacks, ...savedNotes].filter(Boolean).join("\n\n").trim()
      }

      if (!effectivePromptText && inlinePromptFiles.length === 0) return

      const butlerPrompt = buildMobileButlerSystemPrompt({
        platform: msg.platform,
        currentProject: {
          name: currentProj.name,
          serverLabel: currentProj.serverLabel,
          directory: currentProj.directory,
        },
        currentSession: {
          id: binding.sessionId,
          title: preSummary.sessionLabel,
        },
        currentModel: preSummary.modelLabel,
        projects: allProjects.slice(0, 20).map((proj, idx) => ({
          index: idx + 1,
          name: proj.name,
          serverLabel: proj.serverLabel,
          directory: proj.directory,
          isCurrent:
            proj.serverKey === binding.serverKey &&
            ((binding.projectId !== "global" && proj.id === binding.projectId) ||
              proj.directory === binding.projectDirectory),
        })),
        sessions: projSessions.slice(0, 15).map((item, idx) => ({
          index: idx + 1,
          id: item.id,
          title: item.title,
          modelLabel: item.modelLabel,
          isCurrent: item.id === binding.sessionId,
        })),
        sampleModels: models.slice(0, 12).map((m) => `${m.providerID}/${m.id}`),
      })

      const targetSessionId = binding.sessionId
      await upgradeLegacyMobilePermissions(binding)

      const existingTurn = activeTurns.get(targetSessionId)
      if (existingTurn && !existingTurn.interrupted && butlerDepth === 0) {
        if (binding.serverKey !== "local") {
          const remote = remoteServers.get(binding.serverKey)!
          await remoteFetchJson(
            remote,
            `/api/session/${encodeURIComponent(targetSessionId)}/prompt`,
            {
              method: "POST",
              body: JSON.stringify({
                text: effectivePromptText,
                delivery: "steer",
                metadata: { mobileSteer: true },
                ...(inlinePromptFiles.length > 0 ? { files: inlinePromptFiles } : {}),
              }),
            },
          )
        }
        if (binding.serverKey === "local") {
          await runEffect(
            sessions.prompt({
              sessionID: Session.ID.make(targetSessionId),
              text: effectivePromptText,
              delivery: "steer",
              metadata: { mobileSteer: true },
              ...(inlinePromptFiles.length > 0 ? { files: inlinePromptFiles } : {}),
            }),
          )
        }
        existingTurn.steeredNotes.push(compactSingleLine(effectivePromptText, 120))
        existingTurn.lastActivityMs = Date.now()
        ensureRuntimeStatus(targetSessionId).lastActivityMs = Date.now()
        if (existingTurn.sessionKey === msg.sessionKey) {
          existingTurn.replyContext = msg.replyContext
        }
        await connector.sendCard(msg.replyContext, {
          header: { title: "💬 已收到补充指令，当前步骤完成后立即穿插执行", color: "green" },
          elements: [
            {
              kind: "markdown",
              content: `> ${compactSingleLine(effectivePromptText, 240)}`,
            },
            {
              kind: "note",
              text: "已自动合并至当前运行中的轮次，无需重复等待，全部完成后统一提醒你",
            },
          ],
        })
        return
      }

      if (binding.serverKey === "local") {
        setMobileTurnContext(targetSessionId, butlerPrompt)
        phoneOwnedBusyRuns.add(targetSessionId)
        ensureRuntimeStatus(targetSessionId).terminalError = undefined
      }

      let admittedId: string | undefined
      let turnInterrupted = false
      const turnState: ActiveTurnState = {
        interrupted: false,
        sessionKey: msg.sessionKey,
        connector,
        replyContext: msg.replyContext,
        binding,
        steeredNotes: [],
        lastActivityMs: Date.now(),
      }
      activeTurns.set(targetSessionId, turnState)
      try {
        if (binding.serverKey !== "local") {
          const remote = remoteServers.get(binding.serverKey)!
          const hasRemoteButlerHook = await checkRemoteSupportsPiguButler(remote)
          if (!hasRemoteButlerHook) {
            const digestKey = `${binding.serverKey}:${targetSessionId}`
            if (remoteFallbackButlerDigest.get(digestKey) !== butlerPrompt) {
              const injected = await remoteFetchJson(
                remote,
                `/api/session/${encodeURIComponent(targetSessionId)}/synthetic`,
                {
                  method: "POST",
                  body: JSON.stringify({
                    text: butlerPrompt,
                    metadata: { source: "mobile-butler" },
                    delivery: "steer",
                    resume: false,
                  }),
                },
                8_000,
              )
                .then(() => true)
                .catch(() => false)
              if (injected) {
                remoteFallbackButlerDigest.set(digestKey, butlerPrompt)
                if (remoteFallbackButlerDigest.size > 500) {
                  const oldest = remoteFallbackButlerDigest.keys().next().value
                  if (oldest) remoteFallbackButlerDigest.delete(oldest)
                }
              }
            }
          }
          const admitted = await remoteFetchJson<{ data?: { id?: string } }>(
            remote,
            `/api/session/${encodeURIComponent(targetSessionId)}/prompt`,
            {
              method: "POST",
              body: JSON.stringify({
                text: effectivePromptText,
                metadata: { mobileButlerPrompt: butlerPrompt },
                ...(inlinePromptFiles.length > 0 ? { files: inlinePromptFiles } : {}),
              }),
            },
          )
          admittedId = admitted?.data?.id
        }
        if (binding.serverKey === "local") {
          const admitted = await runEffect(
            sessions.prompt({
              sessionID: Session.ID.make(targetSessionId),
              text: effectivePromptText,
              metadata: { mobileButlerPrompt: butlerPrompt },
              ...(inlinePromptFiles.length > 0 ? { files: inlinePromptFiles } : {}),
            }),
          )
          admittedId = admitted.id
        }

        turnState.anchorMsgId = admittedId

        let drainCompleted = false
        let hasPendingInteractive = false
        let progressHandle: MobileProgressHandle | undefined
        const turnStartMs = Date.now()
        const initialDelayMs = msg.progressDelayMs ?? 1_000
        const stallTimeoutMs = msg.stallTimeoutMs ?? 180_000

        if (connector.setTyping) {
          void connector.setTyping(turnState.replyContext, true).catch(() => undefined)
        }

        const sleepSlice = async (ms: number) => {
          const deadline = Date.now() + ms
          while (!drainCompleted && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, Math.min(50, Math.max(15, deadline - Date.now()))))
          }
        }

        const interactiveMonitor = (async () => {
          const interactivePollMs = binding.serverKey === "local" ? 280 : 900
          while (!drainCompleted && !turnState.interrupted) {
            hasPendingInteractive = await checkAndNotifyPendingInteractive(
              turnState.connector,
              turnState.replyContext,
              msg.sessionKey,
              binding,
            ).catch(() => false)
            if (drainCompleted || turnState.interrupted) break
            await sleepSlice(interactivePollMs)
          }
        })()

        const stallWatchdog = (async () => {
          if (stallTimeoutMs <= 0) return
          const checkIntervalMs = Math.min(5_000, Math.max(60, Math.floor(stallTimeoutMs / 3)))
          let lastObservedSig = ""
          let stallAlertedSig = ""
          while (!drainCompleted && !turnState.interrupted) {
            await sleepSlice(checkIntervalMs)
            if (drainCompleted || turnState.interrupted) break
            const prog = await inspectLiveTurnProgress(binding, admittedId)
            if (drainCompleted || turnState.interrupted) break
            const rt = liveRuntimeStatus.get(targetSessionId)
            const curSig = `${prog.completedTools}:${prog.stepCount}:${prog.activeStep}:${prog.processEntries.length}:${turnState.steeredNotes.length}`
            if (curSig !== lastObservedSig) {
              lastObservedSig = curSig
              turnState.lastActivityMs = Date.now()
              stallAlertedSig = ""
            }
            const isLegitWait =
              hasPendingInteractive || Boolean(rt?.compacting) || Boolean(rt?.retry && rt.retry.at > Date.now())
            if (isLegitWait) {
              turnState.lastActivityMs = Date.now()
              continue
            }
            const lastAct = Math.max(turnState.lastActivityMs, rt?.lastActivityMs ?? 0)
            const idleMs = Date.now() - lastAct
            if (idleMs >= stallTimeoutMs && stallAlertedSig !== curSig) {
              stallAlertedSig = curSig
              const stalledSeconds = Math.max(1, Math.round(idleMs / 1000))
              await turnState.connector
                .sendCard(
                  turnState.replyContext,
                  buildStallWarningCard({
                    projectLabel: preSummary.projectLabel,
                    activeStep: prog.activeStep,
                    stalledSeconds,
                  }),
                )
                .catch(() => undefined)
            }
          }
        })()

        const progressMonitor = (async () => {
          if (!connector.startProgress && !connector.setTyping) return
          await sleepSlice(initialDelayMs)
          if (drainCompleted || turnState.interrupted) return

          if (connector.startProgress) {
            const firstRawProg = await inspectLiveTurnProgress(binding, admittedId)
            if (drainCompleted || turnState.interrupted) return
            const firstProg = hasPendingInteractive
              ? { ...firstRawProg, activeStep: "⏸ 正在等待你确认上方的需求问题…" }
              : firstRawProg
            const firstElapsed = Math.max(1, Math.round((Date.now() - turnStartMs) / 1000))
            progressHandle = await connector
              .startProgress(turnState.replyContext, buildProgressCard(preSummary.projectLabel, firstElapsed, firstProg))
              .catch(() => undefined)
            let lastSig = `${firstProg.completedTools}:${firstProg.stepCount}:${firstProg.activeStep}:${firstProg.processEntries.length}`
            let lastPatchMs = Date.now()
            const pollIntervalMs = Math.min(2_200, Math.max(250, initialDelayMs))
            while (!drainCompleted && !turnState.interrupted && progressHandle) {
              await sleepSlice(pollIntervalMs)
              if (drainCompleted || turnState.interrupted) break
              const rawNextProg = await inspectLiveTurnProgress(binding, admittedId)
              if (drainCompleted || turnState.interrupted) break
              const nextProg = hasPendingInteractive
                ? { ...rawNextProg, activeStep: "⏸ 正在等待你确认上方的需求问题…" }
                : rawNextProg
              const nextSig = `${nextProg.completedTools}:${nextProg.stepCount}:${nextProg.activeStep}:${nextProg.processEntries.length}`
              const nowMs = Date.now()
              if (nextSig === lastSig && nowMs - lastPatchMs < 6_000) continue
              lastSig = nextSig
              lastPatchMs = nowMs
              const elapsedSec = Math.max(1, Math.round((nowMs - turnStartMs) / 1000))
              await progressHandle
                .update(buildProgressCard(preSummary.projectLabel, elapsedSec, nextProg))
                .catch(() => undefined)
            }
            return
          }

          while (!drainCompleted && !turnState.interrupted && connector.setTyping) {
            await sleepSlice(12_000)
            if (drainCompleted || turnState.interrupted) break
            await connector.setTyping(turnState.replyContext, true).catch(() => undefined)
          }
        })()

        let settledViaProgressCard = false
        let turnExtract: Awaited<ReturnType<typeof extractTurnProcessAndReply>> | undefined
        let drainRes: Awaited<ReturnType<typeof waitSessionDrain>> = {}
        let totalElapsedSec = 1

        try {
          drainRes = await waitSessionDrain(binding)
        } finally {
          drainCompleted = true
          turnInterrupted = turnState.interrupted
          totalElapsedSec = Math.max(1, Math.round((Date.now() - turnStartMs) / 1000))
          if (activeTurns.get(targetSessionId) === turnState) {
            activeTurns.delete(targetSessionId)
          }
          await Promise.all([
            interactiveMonitor.catch(() => undefined),
            stallWatchdog.catch(() => undefined),
            progressMonitor.catch(() => undefined),
          ])
          if (connector.setTyping) {
            await connector.setTyping(turnState.replyContext, false).catch(() => undefined)
          }
          turnExtract = await extractTurnProcessAndReply(binding, admittedId, !turnInterrupted)
          markTailDelivered(msg.sessionKey, turnExtract.tailMsgId)
          if (progressHandle) {
            const keepProcessCard = !turnInterrupted && turnExtract.processEntries.length > 0
            if (keepProcessCard) {
              settledViaProgressCard = true
              await progressHandle
                .finish(
                  buildCompletedProcessCard(
                    preSummary.projectLabel,
                    totalElapsedSec,
                    turnExtract.processEntries,
                    turnExtract.completedTools,
                    turnExtract.stepCount,
                  ),
                )
                .catch(() => undefined)
            }
            if (!keepProcessCard) {
              await progressHandle.finish().catch(() => undefined)
            }
          }
        }

        const resolvedTurn = turnExtract ?? (await extractTurnProcessAndReply(binding, admittedId, !turnInterrupted))
        const hardFailureError = !turnInterrupted
          ? drainRes.sshDisconnected
            ? (drainRes.errorMessage ?? "SSH 远端连接中断")
            : (resolvedTurn.terminalError ?? drainRes.errorMessage)
          : undefined

        if (hardFailureError) {
          const summary = await getCurrentSessionSummary(binding)
          await turnState.connector.sendCard(
            turnState.replyContext,
            buildTurnFailureAlertCard({
              projectLabel: summary.projectLabel,
              sessionLabel: summary.sessionLabel,
              modelLabel: summary.modelLabel,
              errorMessage: hardFailureError,
              sshDisconnected: drainRes.sshDisconnected,
              stepCount: resolvedTurn.stepCount,
              completedTools: resolvedTurn.completedTools,
              partialReply: resolvedTurn.finalReply,
            }),
          )
          return
        }

        if (turnInterrupted && !resolvedTurn.finalReply) return

        const hasSwitchActions = resolvedTurn.actions.some((a) => a.type !== "send_file")
        const fileActions = resolvedTurn.actions.filter((a) => a.type === "send_file")

        if (!turnInterrupted && hasSwitchActions && butlerDepth < 1) {
          if (resolvedTurn.finalReply) {
            await turnState.connector.sendText(turnState.replyContext, resolvedTurn.finalReply)
          }
          let lastCard: MobileCard | undefined
          let followUp = ""
          for (const action of resolvedTurn.actions) {
            const card = await executeButlerAction(turnState.connector, turnState.replyContext, msg.sessionKey, action, {
              projects: allProjects,
              sessions: projSessions,
            })
            if (card) {
              lastCard = card
              await turnState.connector.sendCard(turnState.replyContext, card)
            }
            if (action.followUpPrompt?.trim()) {
              followUp = action.followUpPrompt.trim()
            }
          }
          if (followUp && lastCard?.header?.color !== "red") {
            await handlePromptTurn(
              turnState.connector,
              { ...msg, replyContext: turnState.replyContext, audioAttachments: undefined, fileAttachments: undefined },
              followUp,
              butlerDepth + 1,
            )
          }
          return
        }

        const summary = await getCurrentSessionSummary(binding)
        const footer = `\n\n*[${summary.projectLabel} · ${summary.sessionLabel} · ${summary.modelLabel}]*`
        const replyBody = resolvedTurn.finalReply
        const baseBody = turnInterrupted ? `${replyBody}\n\n*(已中断)*` : replyBody || "(已完成)"

        const shouldInlineProcess =
          !turnInterrupted && !settledViaProgressCard && resolvedTurn.processEntries.length > 0
        const finalMessage = (() => {
          if (!shouldInlineProcess) return `${baseBody}${footer}`
          const maxBubbleChars = msg.platform === "qqbot" ? 1650 : 3300
          const remaining = maxBubbleChars - baseBody.length - footer.length
          const stepHeader = `📋 **中间执行过程（共 ${resolvedTurn.stepCount} 步${resolvedTurn.completedTools > 0 ? ` · ${resolvedTurn.completedTools} 次工具操作` : ""} · ${totalElapsedSec}s）**`
          if (remaining < 220) {
            return `${baseBody}\n\n---\n📋 *中间共执行 ${resolvedTurn.stepCount} 步（发 \`.log\` 查看完整中间内容）*${footer}`
          }
          const formatted = formatProcessEntriesMarkdown(
            resolvedTurn.processEntries,
            Math.min(950, remaining - stepHeader.length - 16),
            true,
          )
          return `${baseBody}\n\n---\n${stepHeader}\n${formatted.text}${footer}`
        })()

        await turnState.connector.sendText(turnState.replyContext, finalMessage)

        if (!turnInterrupted && fileActions.length > 0 && butlerDepth <= 1) {
          for (const fileAction of fileActions) {
            const errCard = await executeButlerAction(
              turnState.connector,
              turnState.replyContext,
              msg.sessionKey,
              fileAction,
            )
            if (errCard) {
              await turnState.connector.sendCard(turnState.replyContext, errCard)
            }
          }
        }
      } finally {
        if (activeTurns.get(targetSessionId) === turnState) {
          activeTurns.delete(targetSessionId)
        }
        if (binding.serverKey === "local") {
          phoneOwnedBusyRuns.delete(targetSessionId)
          clearMobileTurnContext(targetSessionId)
        }
      }
    }

    async function dispatchInboundMessage(
      msg: InboundMobileMessage,
      overrideConnector?: MobilePlatformConnector,
    ): Promise<void> {
      const robot = robots.get(msg.robotId)
      const connector = overrideConnector ?? connectors.get(msg.robotId)
      if (!robot || !connector) return
      lastReplyContexts.set(msg.sessionKey, msg.replyContext)

      if (!robot.ownerID.trim() && msg.userId.trim()) {
        const updated: MobileRobotConfig = {
          ...robot,
          ownerID: msg.userId.trim(),
          allowFrom: normalizeAllowFromWithOwner(msg.userId.trim(), robot.allowFrom),
          userNames: {
            ...(robot.userNames ?? {}),
            [msg.userId.trim()]: msg.userName || msg.userId.trim(),
          },
          updatedAt: Date.now(),
        }
        robots.set(robot.id, updated)
        await saveDiskState()
      }

      const currentRobot = robots.get(msg.robotId) ?? robot
      const parsed = parseMobileInput(msg.text)

      if (parsed.kind === "access" && parsed.sub === "whoami") {
        const card = await handleAccessCommand(currentRobot, connector, msg, "whoami", "")
        await connector.sendCard(msg.replyContext, card)
        return
      }

      if (!isUserAllowed(currentRobot.ownerID, currentRobot.allowFrom, msg.userId)) {
        await connector.sendCard(msg.replyContext, {
          header: { title: "未授权访问", color: "red" },
          elements: [
            {
              kind: "markdown",
              content: `账号 \`${msg.userId}\` 未获授权。请联系管理员发送：\`.access add ${msg.userId}\``,
            },
          ],
        })
        return
      }

      try {
        if (parsed.kind === "help") {
          const card = await buildHelpCard(msg.sessionKey)
          await connector.sendCard(msg.replyContext, card)
          return
        }
        if (parsed.kind === "unknown_command") {
          const card = await buildHelpCard(
            msg.sessionKey,
            `未识别的命令 \`${parsed.rawCommand}\`（已本地拦截，未消耗 Token）。`,
          )
          await connector.sendCard(msg.replyContext, card)
          return
        }
        if (parsed.kind === "project") {
          const card = await handleProjectCommand(msg.sessionKey, parsed.sub, parsed.arg)
          await connector.sendCard(msg.replyContext, card)
          return
        }
        if (parsed.kind === "chat") {
          const card = await handleChatCommand(msg.sessionKey, parsed.sub, parsed.arg)
          await connector.sendCard(msg.replyContext, card)
          return
        }
        if (parsed.kind === "model") {
          const card = await handleModelCommand(msg.sessionKey, parsed.sub, parsed.arg)
          await connector.sendCard(msg.replyContext, card)
          return
        }
        if (parsed.kind === "shell") {
          const card = await handleShellCommand(msg.sessionKey, parsed.command)
          await connector.sendCard(msg.replyContext, card)
          return
        }
        if (parsed.kind === "stop") {
          const card = await handleStopCommand(msg.sessionKey)
          await connector.sendCard(msg.replyContext, card)
          return
        }
        if (parsed.kind === "skip") {
          await handleSkipCommand(connector, msg)
          return
        }
        if (parsed.kind === "ps") {
          await handlePsCommand(connector, msg, parsed.text)
          return
        }
        if (parsed.kind === "log") {
          const card = await handleLogCommand(msg.sessionKey)
          await connector.sendCard(msg.replyContext, card)
          return
        }
        if (parsed.kind === "send") {
          await handleSendFileCommand(connector, msg.replyContext, msg.sessionKey, parsed.filePath)
          return
        }
        if (parsed.kind === "access") {
          const card = await handleAccessCommand(currentRobot, connector, msg, parsed.sub, parsed.arg)
          await connector.sendCard(msg.replyContext, card)
          return
        }
        if (parsed.kind === "prompt") {
          const consumedInteractive = await tryHandlePendingInteractiveReply(connector, msg, parsed.text)
          if (consumedInteractive) return
          await handlePromptTurn(connector, msg, parsed.text)
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        await connector.sendText(msg.replyContext, `执行出错：${errMsg}`)
      }
    }

    async function restartRobotConnector(robot: MobileRobotConfig): Promise<void> {
      const prev = connectors.get(robot.id)
      if (prev) {
        await prev.stop().catch(() => undefined)
        connectors.delete(robot.id)
      }
      if (!robot.enabled) {
        syncSleepPrevention()
        return
      }
      const next = createConnectorForRobot(robot)
      if (!next) {
        syncSleepPrevention()
        return
      }
      connectors.set(robot.id, next)
      syncSleepPrevention()
      void next.start(
        (msg) => dispatchInboundMessage(msg),
        (actionEv) => handleInboundCardAction(actionEv),
      )
    }

    yield* Effect.addFinalizer(() => Effect.sync(stopSleepGuardProcess))

    yield* Stream.runForEach(
      bus.subscribe([
        Form.Event.Created,
        Permission.Event.Asked,
        SessionEvent.Execution.Started,
        SessionEvent.Execution.Succeeded,
        SessionEvent.Execution.Failed,
        SessionEvent.Execution.Interrupted,
        SessionEvent.RetryScheduled,
        SessionEvent.Compaction.Started,
        SessionEvent.Compaction.Ended,
        SessionEvent.Compaction.Failed,
        SessionEvent.Step.Started,
        SessionEvent.Text.Delta,
        SessionEvent.Tool.Called,
        SessionEvent.Tool.Progress,
        SessionEvent.Tool.Success,
        SessionEvent.Tool.Failed,
      ]),
      (ev) =>
        Effect.promise(async () => {
          if (ev.type === "form.created") {
            await pushRealtimeLocalInteractiveEvent({ kind: "form", form: ev.data.form })
            return
          }
          if (ev.type === "permission.asked") {
            await pushRealtimeLocalInteractiveEvent({ kind: "perm", perm: ev.data })
            return
          }
          const sessionID = ev.data.sessionID
          const rt = ensureRuntimeStatus(sessionID)
          const running = activeTurns.get(sessionID)

          if (ev.type === "session.execution.started") {
            rt.compacting = false
            rt.retry = undefined
            rt.terminalError = undefined
            rt.lastActivityMs = Date.now()
            if (running) {
              phoneOwnedBusyRuns.add(sessionID)
              running.lastActivityMs = Date.now()
            }
            return
          }

          if (ev.type === "session.retry.scheduled") {
            rt.retry = {
              attempt: ev.data.attempt,
              at: ev.data.at,
              message: ev.data.error.message,
            }
            rt.lastActivityMs = Date.now()
            return
          }

          if (ev.type === "session.compaction.started") {
            rt.compacting = true
            rt.lastActivityMs = Date.now()
            return
          }

          if (ev.type === "session.compaction.ended" || ev.type === "session.compaction.failed") {
            rt.compacting = false
            rt.lastActivityMs = Date.now()
            return
          }

          if (
            ev.type === "session.step.started" ||
            ev.type === "session.text.delta" ||
            ev.type === "session.tool.called" ||
            ev.type === "session.tool.progress" ||
            ev.type === "session.tool.success" ||
            ev.type === "session.tool.failed"
          ) {
            rt.retry = undefined
            rt.lastActivityMs = Date.now()
            if (running) {
              running.lastActivityMs = Date.now()
            }
            return
          }

          if (ev.type === "session.execution.interrupted") {
            rt.retry = undefined
            rt.compacting = false
            phoneOwnedBusyRuns.delete(sessionID)
            return
          }

          if (ev.type === "session.execution.failed") {
            rt.retry = undefined
            rt.compacting = false
            rt.terminalError = ev.data.error.message
            const wasPhoneOwned = phoneOwnedBusyRuns.delete(sessionID) || activeTurns.has(sessionID)
            if (!wasPhoneOwned) {
              await deliverDetachedSessionSettlement("local", sessionID, "failed", ev.data.error.message)
            }
            return
          }

          if (ev.type === "session.execution.succeeded") {
            rt.retry = undefined
            rt.compacting = false
            const wasPhoneOwned = phoneOwnedBusyRuns.delete(sessionID) || activeTurns.has(sessionID)
            if (!wasPhoneOwned) {
              await deliverDetachedSessionSettlement("local", sessionID, "succeeded")
            }
          }
        }),
    ).pipe(Effect.forkScoped)

    // Watch bound SSH remote sessions for background/desktop/scheduled task completions & Interactive prompts
    yield* Effect.forever(
      Effect.promise(async () => {
        await new Promise((r) => setTimeout(r, 4_000))
        const remoteBoundByServer = new Map<string, Array<[string, ChatSessionBinding]>>()
        for (const [sessionKey, b] of bindings.entries()) {
          if (b.serverKey === "local" || !remoteServers.has(b.serverKey)) continue
          const list = remoteBoundByServer.get(b.serverKey) ?? []
          list.push([sessionKey, b])
          remoteBoundByServer.set(b.serverKey, list)
        }
        for (const [serverKey, list] of remoteBoundByServer.entries()) {
          const remote = remoteServers.get(serverKey)
          if (!remote) continue
          const activeResp = await remoteFetchJson<{ data?: Record<string, unknown> }>(
            remote,
            "/api/session/active",
            undefined,
            5_000,
          ).catch(() => undefined)
          if (!activeResp?.data) continue
          for (const [sessionKey, b] of list) {
            if (activeTurns.has(b.sessionId) || detachedDrainSessions.has(b.sessionId)) continue
            const isBusy = Boolean(activeResp.data[b.sessionId])
            const prev = remoteBusyTracker.get(b.sessionId)
            if (isBusy) {
              if (!prev?.wasBusy) {
                remoteBusyTracker.set(b.sessionId, { wasBusy: true })
              }
              const robotId = sessionKey.split(":")[1] ?? ""
              const robot = robots.get(robotId)
              const conn = connectors.get(robotId)
              const rc = robot ? synthesizeFallbackReplyContext(sessionKey, robot) : lastReplyContexts.get(sessionKey)
              if (conn && rc) {
                await checkAndNotifyPendingInteractive(conn, rc, sessionKey, b).catch(() => undefined)
              }
              continue
            }
            if (prev?.wasBusy) {
              remoteBusyTracker.set(b.sessionId, { wasBusy: false })
              await deliverDetachedSessionSettlement(serverKey, b.sessionId, "succeeded").catch(() => undefined)
            }
          }
        }
      }),
    ).pipe(Effect.forkScoped)

    // Boot existing robots on startup
    yield* Effect.promise(async () => {
      await fs.ensureDir(global.config).pipe(Effect.runPromise).catch(() => undefined)
      await loadDiskState()
      for (const robot of robots.values()) {
        if (robot.enabled) {
          void restartRobotConnector(robot)
        }
      }
      syncSleepPrevention()
    })

    return Service.of({
      settings: () =>
        Effect.sync(() => ({
          preventSleep: preventSleepEnabled,
          active: isSleepPreventionActive(),
        })),

      updateSettings: (input) =>
        Effect.promise(async () => {
          if (typeof input.preventSleep === "boolean") {
            preventSleepEnabled = input.preventSleep
          }
          await saveDiskState()
          syncSleepPrevention()
          return {
            preventSleep: preventSleepEnabled,
            active: isSleepPreventionActive(),
          }
        }),

      list: () =>
        Effect.sync(() =>
          Array.from(robots.values())
            .sort((a, b) => a.createdAt - b.createdAt)
            .map((r) => toView(r, connectors.get(r.id))),
        ),

      create: (input) =>
        Effect.promise(async () => {
          const now = Date.now()
          const key = robotAccountKey(input)
          const existing = key ? Array.from(robots.values()).find((r) => robotAccountKey(r) === key) : undefined
          const ownerID = input.ownerID?.trim() || existing?.ownerID || ""
          const allowFrom = normalizeAllowFromWithOwner(ownerID, input.allowFrom ?? existing?.allowFrom ?? "")
          const robot: MobileRobotConfig = {
            id: existing?.id ?? `robot_${randomUUID().slice(0, 8)}`,
            name: input.name.trim() || existing?.name || `${input.platform}-robot`,
            platform: input.platform,
            enabled: input.enabled ?? true,
            ownerID,
            allowFrom,
            adminFrom: input.adminFrom?.trim() || existing?.adminFrom,
            userNames: existing?.userNames,
            feishu: input.feishu ?? existing?.feishu,
            weixin: input.weixin ?? existing?.weixin,
            dingtalk: input.dingtalk ?? existing?.dingtalk,
            wecom: input.wecom ?? existing?.wecom,
            qqbot: input.qqbot ?? existing?.qqbot,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
          }
          robots.set(robot.id, robot)
          await saveDiskState()
          await restartRobotConnector(robot)
          return toView(robot, connectors.get(robot.id))
        }),

      update: (input) =>
        Effect.promise(async () => {
          const existing = robots.get(input.id)
          if (!existing) {
            throw new Error(`Robot not found: ${input.id}`)
          }
          const ownerID = input.ownerID !== undefined ? input.ownerID.trim() : existing.ownerID
          const rawAllow = input.allowFrom !== undefined ? input.allowFrom : existing.allowFrom
          const updated: MobileRobotConfig = {
            ...existing,
            name: input.name !== undefined ? input.name.trim() || existing.name : existing.name,
            enabled: input.enabled !== undefined ? input.enabled : existing.enabled,
            ownerID,
            allowFrom: normalizeAllowFromWithOwner(ownerID, rawAllow),
            adminFrom: input.adminFrom !== undefined ? input.adminFrom.trim() || undefined : existing.adminFrom,
            feishu: input.feishu !== undefined ? input.feishu : existing.feishu,
            weixin: input.weixin !== undefined ? input.weixin : existing.weixin,
            dingtalk: input.dingtalk !== undefined ? input.dingtalk : existing.dingtalk,
            wecom: input.wecom !== undefined ? input.wecom : existing.wecom,
            qqbot: input.qqbot !== undefined ? input.qqbot : existing.qqbot,
            updatedAt: Date.now(),
          }
          robots.set(updated.id, updated)
          await saveDiskState()
          await restartRobotConnector(updated)
          return toView(updated, connectors.get(updated.id))
        }),

      remove: (id) =>
        Effect.promise(async () => {
          const prev = connectors.get(id)
          if (prev) {
            await prev.stop().catch(() => undefined)
            connectors.delete(id)
          }
          robots.delete(id)
          for (const k of Array.from(bindings.keys())) {
            if (k.split(":")[1] === id) bindings.delete(k)
          }
          await saveDiskState()
          syncSleepPrevention()
        }),

      importCode: (code) =>
        Effect.promise(async () => {
          const payload = decodeUniversalRobotMigrationCode(code)
          const now = Date.now()
          const candidate = {
            platform: payload.platform,
            feishu: payload.feishu
              ? {
                  appId: payload.feishu.app_id,
                  appSecret: payload.feishu.app_secret,
                  domain: payload.feishu.domain,
                }
              : undefined,
            weixin: payload.weixin
              ? {
                  token: payload.weixin.token,
                  baseUrl: payload.weixin.base_url,
                  accountId: payload.weixin.account_id,
                }
              : undefined,
            dingtalk: payload.dingtalk
              ? {
                  clientId: payload.dingtalk.client_id,
                  clientSecret: payload.dingtalk.client_secret,
                }
              : undefined,
            wecom: payload.wecom
              ? {
                  botId: payload.wecom.bot_id ?? "",
                  secret: payload.wecom.bot_secret ?? payload.wecom.secret ?? "",
                }
              : undefined,
            qqbot: payload.qqbot
              ? {
                  appId: payload.qqbot.app_id,
                  appSecret: payload.qqbot.app_secret,
                  sandbox: payload.qqbot.sandbox,
                }
              : undefined,
          }
          const key = robotAccountKey(candidate)
          const existing = key ? Array.from(robots.values()).find((r) => robotAccountKey(r) === key) : undefined
          const ownerID = payload.owner_id?.trim() || existing?.ownerID || ""
          const allowFrom = normalizeAllowFromWithOwner(ownerID, payload.allow_from ?? existing?.allowFrom ?? "")
          const robot: MobileRobotConfig = {
            id: existing?.id ?? `robot_${randomUUID().slice(0, 8)}`,
            name: payload.name?.trim() || existing?.name || `${payload.platform}-robot`,
            enabled: true,
            ownerID,
            allowFrom,
            adminFrom: payload.admin_from?.trim() || existing?.adminFrom,
            userNames: existing?.userNames,
            ...candidate,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
          }
          robots.set(robot.id, robot)
          await saveDiskState()
          await restartRobotConnector(robot)
          return toView(robot, connectors.get(robot.id))
        }),

      syncRemotes: (remotes) =>
        Effect.sync(() => {
          const nextKeys = new Set<string>()
          remoteServers.clear()
          for (const r of remotes) {
            if (r.key && r.url) {
              remoteServers.set(r.key, r)
              nextKeys.add(r.key)
            }
          }
          for (const cachedKey of Array.from(remoteSupportsPiguButler.keys())) {
            if (!nextKeys.has(cachedKey)) remoteSupportsPiguButler.delete(cachedKey)
          }
        }),

      transcribeAudio: (input) =>
        Effect.promise(async () => {
          const cleanB64 = input.audioBase64.includes(",")
            ? (input.audioBase64.split(",")[1] ?? "")
            : input.audioBase64
          const bytes = new Uint8Array(Buffer.from(cleanB64, "base64"))
          if (bytes.byteLength === 0) {
            throw new Error("语音数据为空")
          }
          const text = await transcribeAudioWithMultimodal(global.config, {
            data: bytes,
            mimeType: input.mimeType || "audio/wav",
            fileName: input.fileName,
          })
          return { text }
        }),

      simulateInbound: (input) =>
        Effect.promise(async () => {
          const robot = robots.get(input.robotId)
          if (!robot) throw new Error(`Robot not found: ${input.robotId}`)
          const cards: MobileCard[] = []
          const texts: string[] = []
          const files: { fileName: string; mimeType: string; size: number }[] = []
          const progressUpdates: string[] = []
          const chatId = input.chatId ?? "sim_chat"
          const sessionKey = input.sessionKey ?? `${robot.platform}:${robot.id}:${chatId}`
          const liveConn = input.pushLive ? connectors.get(robot.id) : undefined
          if (liveConn) {
            if (input.fileAttachments && input.fileAttachments.length > 0) {
              for (const att of input.fileAttachments) {
                await liveConn
                  .sendFile(
                    { chatId, sessionKey },
                    { fileName: att.fileName, mimeType: att.mimeType, data: att.data },
                  )
                  .catch(() => undefined)
              }
            }
            const label =
              input.audioAttachments && input.audioAttachments.length > 0 && !input.text.trim()
                ? `[飞书实测 · 语音消息] 🎤 (${input.audioAttachments[0]?.fileName ?? "voice"})`
                : input.fileAttachments && input.fileAttachments.length > 0
                  ? `[飞书实测 · 用户发来附件] 📎 (${input.fileAttachments.map((f) => f.fileName).join(", ")})${input.text.trim() ? `：${input.text}` : ""}`
                  : input.cardAction
                    ? `[飞书实测 · 点击卡片按钮] 🔘 ${input.cardAction}`
                    : `[飞书实测 · 用户输入] ${input.text}`
            await liveConn.sendText({ chatId, sessionKey }, label).catch(() => undefined)
          }
          const supportsCardProgress =
            robot.platform === "feishu" || robot.platform === "lark" || robot.platform === "wecom"
          const captureConnector: MobilePlatformConnector = {
            status: () => ({ state: "connected" }),
            start: async () => undefined,
            stop: async () => undefined,
            sendText: async (rc, text) => {
              texts.push(text)
              if (liveConn) await liveConn.sendText(rc, text).catch(() => undefined)
            },
            sendCard: async (rc, card) => {
              cards.push(card)
              if (liveConn) await liveConn.sendCard(rc, card).catch(() => undefined)
            },
            sendFile: async (rc, file) => {
              files.push({ fileName: file.fileName, mimeType: file.mimeType, size: file.data.byteLength })
              if (liveConn) await liveConn.sendFile(rc, file).catch(() => undefined)
            },
            ...(supportsCardProgress
              ? {
                  startProgress: async (rc, initialCard) => {
                    progressUpdates.push(renderCardMarkdownFallback(initialCard))
                    const liveHandle = liveConn?.startProgress
                      ? await liveConn.startProgress(rc, initialCard).catch(() => undefined)
                      : undefined
                    return {
                      update: async (nextCard) => {
                        progressUpdates.push(renderCardMarkdownFallback(nextCard))
                        if (liveHandle) await liveHandle.update(nextCard).catch(() => undefined)
                      },
                      finish: async (finalCard) => {
                        if (finalCard) progressUpdates.push(renderCardMarkdownFallback(finalCard))
                        if (liveHandle) await liveHandle.finish(finalCard).catch(() => undefined)
                      },
                    }
                  },
                }
              : {}),
            resolveUserDisplayName: async (id) => (id === input.userId ? (input.userName ?? id) : id),
          }
          if (input.cardAction) {
            const actionCard = await handleInboundCardAction(
              {
                robotId: robot.id,
                action: input.cardAction,
                sessionKey,
                userId: input.userId,
                chatId,
                replyContext: { chatId, sessionKey },
              },
              captureConnector,
            )
            if (actionCard) {
              cards.push(actionCard)
              if (liveConn) await liveConn.sendCard({ chatId, sessionKey }, actionCard).catch(() => undefined)
            }
            return { cards, texts, files, progressUpdates }
          }
          await dispatchInboundMessage(
            {
              robotId: robot.id,
              platform: robot.platform,
              sessionKey,
              messageId: `sim_${Date.now()}`,
              userId: input.userId,
              userName: input.userName ?? input.userId,
              chatId,
              text: input.text,
              mentionedUsers: input.mentionedUsers,
              audioAttachments: input.audioAttachments,
              fileAttachments: input.fileAttachments,
              progressDelayMs: input.progressDelayMs,
              stallTimeoutMs: input.stallTimeoutMs,
              replyContext: { chatId, sessionKey },
            },
            captureConnector,
          )
          return { cards, texts, files, progressUpdates }
        }),

      drainBackgroundOutbox: (sessionKey) =>
        Effect.sync(() => {
          const entry = backgroundOutbox.get(sessionKey)
          if (!entry) return { cards: [], texts: [] }
          backgroundOutbox.delete(sessionKey)
          return {
            cards: [...entry.cards],
            texts: [...entry.texts],
          }
        }),
    })
  }),
)

export const node: LayerNode.Provider<Service, never, typeof Node.tags.values.global> = makeGlobalNode({
  service: Service,
  layer,
  deps: [Global.node, FSUtil.node, Bus.node, Project.node, Session.node, LocationServiceMap.node],
})
