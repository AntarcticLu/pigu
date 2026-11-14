import { Mime } from "../../mime.js"
import { renderCardMarkdownFallback, type MobileCard } from "../card.js"
import type {
  MobileAudioAttachment,
  MobileCardActionHandler,
  MobileFileAttachment,
  MobileMessageHandler,
  MobilePlatformConnector,
  MobilePlatformStatus,
} from "./types.js"

const QQ_TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken"
const QQ_API_PROD = "https://api.sgroup.qq.com"
const QQ_API_SANDBOX = "https://sandbox.api.sgroup.qq.com"
const DEFAULT_INTENTS = 1 << 25

export interface QQBotReplyContext {
  readonly messageType: "c2c" | "group"
  readonly userOpenId: string
  readonly groupOpenId?: string
  readonly eventMsgId?: string
}

export function createQQBotConnector(options: {
  readonly robotId: string
  readonly appId: string
  readonly appSecret: string
  readonly sandbox?: boolean
}): MobilePlatformConnector {
  const apiBase = options.sandbox ? QQ_API_SANDBOX : QQ_API_PROD
  let currentStatus: MobilePlatformStatus = { state: "stopped" }
  let stopped = true
  let ws: WebSocket | undefined
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let messageHandler: MobileMessageHandler | undefined
  let cachedToken = ""
  let tokenExpiresAt = 0
  let lastSeq: number | null = null
  let markdownAllowed = true
  const seenMsgIds = new Set<string>()
  const msgSeqMap = new Map<string, number>()

  function stripMarkdownSyntax(input: string): string {
    return input
      .replace(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/(^|\n)\*([^\n*]+)\*(?=\n|$)/g, "$1$2")
      .replace(/`([^`\n]+)`/g, "$1")
      .trim()
  }

  function defangUrls(input: string): string {
    return input.replace(/https?:\/\/[^\s)]+/gi, (url) => url.replace("://", "[:]//").replace(/\./g, "[.]"))
  }

  function nextMsgSeq(eventMsgId: string): number {
    const cur = (msgSeqMap.get(eventMsgId) ?? 0) + 1
    msgSeqMap.set(eventMsgId, cur)
    if (msgSeqMap.size > 500) {
      const first = msgSeqMap.keys().next().value
      if (first) msgSeqMap.delete(first)
    }
    return cur
  }

  async function getAccessToken(): Promise<string> {
    if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken
    const resp = await fetch(QQ_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appId: options.appId,
        clientSecret: options.appSecret,
      }),
      signal: AbortSignal.timeout(10_000),
    })
    const data = (await resp.json()) as { access_token?: string; expires_in?: string | number }
    if (!data.access_token) {
      throw new Error("QQBot failed to obtain access_token")
    }
    const expiresIn = Number(data.expires_in ?? 7200)
    cachedToken = data.access_token
    tokenExpiresAt = Date.now() + Math.max(60, expiresIn - 300) * 1000
    return cachedToken
  }

  async function sendText(replyContext: unknown, text: string): Promise<void> {
    const rc = replyContext as QQBotReplyContext
    const trimmed = text.trim()
    if (!trimmed) return
    const token = await getAccessToken()
    const url =
      rc.messageType === "group" && rc.groupOpenId
        ? `${apiBase}/v2/groups/${encodeURIComponent(rc.groupOpenId)}/messages`
        : `${apiBase}/v2/users/${encodeURIComponent(rc.userOpenId)}/messages`

    async function postPayload(
      body: Record<string, unknown>,
      usePassiveId = true,
    ): Promise<{ ok: boolean; status: number; errText: string }> {
      const payload = { ...body }
      const maxPassiveSeq = rc.messageType === "group" ? 5 : 4
      if (usePassiveId && rc.eventMsgId) {
        const seq = nextMsgSeq(rc.eventMsgId)
        if (seq <= maxPassiveSeq) {
          payload.msg_id = rc.eventMsgId
          payload.msg_seq = seq
        }
      }
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `QQBot ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      })
      if (resp.ok) return { ok: true, status: resp.status, errText: "" }
      if (payload.msg_id) {
        const proactiveResp = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `QQBot ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        })
        if (proactiveResp.ok) return { ok: true, status: proactiveResp.status, errText: "" }
      }
      return { ok: false, status: resp.status, errText: await resp.text() }
    }

    const maxLen = 1800
    for (let i = 0; i < trimmed.length; i += maxLen) {
      const chunk = trimmed.slice(i, i + maxLen)
      if (markdownAllowed) {
        const mdRes = await postPayload({ msg_type: 2, markdown: { content: chunk } })
        if (mdRes.ok) continue
        markdownAllowed = false
      }
      const plainChunk = stripMarkdownSyntax(chunk)
      const plainRes = await postPayload({ msg_type: 0, content: plainChunk })
      if (plainRes.ok) continue

      const defanged = defangUrls(plainChunk)
      if (defanged !== plainChunk) {
        const retryRes = await postPayload({ msg_type: 0, content: defanged })
        if (retryRes.ok) continue
      }
      throw new Error(`QQBot send failed (${plainRes.status}): ${plainRes.errText.slice(0, 200)}`)
    }
  }

  async function sendCard(replyContext: unknown, card: MobileCard): Promise<void> {
    await sendText(replyContext, renderCardMarkdownFallback(card))
  }

  async function sendFile(
    replyContext: unknown,
    file: { readonly fileName: string; readonly mimeType: string; readonly data: Uint8Array },
  ): Promise<void> {
    const rc = replyContext as QQBotReplyContext
    const token = await getAccessToken()
    const filesUrl =
      rc.messageType === "group" && rc.groupOpenId
        ? `${apiBase}/v2/groups/${encodeURIComponent(rc.groupOpenId)}/files`
        : `${apiBase}/v2/users/${encodeURIComponent(rc.userOpenId)}/files`
    const msgsUrl =
      rc.messageType === "group" && rc.groupOpenId
        ? `${apiBase}/v2/groups/${encodeURIComponent(rc.groupOpenId)}/messages`
        : `${apiBase}/v2/users/${encodeURIComponent(rc.userOpenId)}/messages`

    const isImage = /^image\/(png|jpeg|gif|webp|bmp)$/i.test(file.mimeType)
    const fileType = isImage ? 1 : 4
    const upResp = await fetch(filesUrl, {
      method: "POST",
      headers: {
        Authorization: `QQBot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        file_type: fileType,
        file_data: Buffer.from(file.data).toString("base64"),
        srv_send_msg: false,
        ...(fileType === 4 ? { file_name: file.fileName } : {}),
      }),
      signal: AbortSignal.timeout(30_000),
    })
    const upData = (await upResp.json()) as { file_info?: string }
    if (!upData.file_info) {
      const preview = Buffer.from(file.data.subarray(0, 1500)).toString("utf8")
      await sendText(replyContext, `[文件] ${file.fileName}\n\`\`\`\n${preview}\n\`\`\``)
      return
    }

    const baseBody: Record<string, unknown> = {
      msg_type: 7,
      media: { file_info: upData.file_info },
    }
    const maxPassiveSeq = rc.messageType === "group" ? 5 : 4
    const body: Record<string, unknown> = { ...baseBody }
    if (rc.eventMsgId) {
      const seq = nextMsgSeq(rc.eventMsgId)
      if (seq <= maxPassiveSeq) {
        body.msg_id = rc.eventMsgId
        body.msg_seq = seq
      }
    }
    const fileResp = await fetch(msgsUrl, {
      method: "POST",
      headers: {
        Authorization: `QQBot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    if (!fileResp.ok && body.msg_id && rc.messageType === "c2c") {
      await fetch(msgsUrl, {
        method: "POST",
        headers: {
          Authorization: `QQBot ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(baseBody),
        signal: AbortSignal.timeout(15_000),
      })
    }
  }

  async function connectLoop(): Promise<void> {
    if (stopped) return
    currentStatus = { state: "connecting" }
    try {
      const token = await getAccessToken()
      const gwResp = await fetch(`${apiBase}/gateway`, {
        method: "GET",
        headers: { Authorization: `QQBot ${token}` },
        signal: AbortSignal.timeout(10_000),
      })
      const gwData = (await gwResp.json()) as { url?: string }
      if (!gwData.url) {
        throw new Error("QQBot gateway returned empty url")
      }

      const socket = new WebSocket(gwData.url)
      ws = socket

      socket.onmessage = (ev) => {
        const raw = typeof ev.data === "string" ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString("utf8")
        try {
          const payload = JSON.parse(raw) as {
            op?: number
            s?: number
            t?: string
            d?: Record<string, unknown>
          }
          if (typeof payload.s === "number") lastSeq = payload.s

          if (payload.op === 10) {
            const interval = Number(payload.d?.heartbeat_interval ?? 40_000)
            socket.send(
              JSON.stringify({
                op: 2,
                d: {
                  token: `QQBot ${token}`,
                  intents: DEFAULT_INTENTS,
                  shard: [0, 1],
                },
              }),
            )
            if (heartbeatTimer) clearInterval(heartbeatTimer)
            heartbeatTimer = setInterval(() => {
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ op: 1, d: lastSeq }))
              }
            }, interval)
            return
          }

          if (payload.op === 0 && payload.t === "READY") {
            currentStatus = { state: "connected" }
            return
          }

          if (payload.op === 0 && (payload.t === "C2C_MESSAGE_CREATE" || payload.t === "GROUP_AT_MESSAGE_CREATE")) {
            void handleDispatch(payload.t, payload.d ?? {})
          }
        } catch {
          // Ignore malformed frame
        }
      }

      socket.onclose = (ev) => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer)
          heartbeatTimer = undefined
        }
        if (stopped) return
        const detail = ev.code ? ` (${ev.code}${ev.reason ? `: ${ev.reason}` : ""})` : ""
        currentStatus = { state: "connecting", error: `Gateway closed${detail}, reconnecting...` }
        reconnectTimer = setTimeout(() => void connectLoop(), 5_000)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      currentStatus = { state: "error", error: msg }
      if (!stopped) {
        reconnectTimer = setTimeout(() => void connectLoop(), 6_000)
      }
    }
  }

  async function handleDispatch(eventType: string, data: Record<string, unknown>): Promise<void> {
    if (!messageHandler) return
    const msgId = typeof data.id === "string" ? data.id : `${Date.now()}`
    if (seenMsgIds.has(msgId)) return
    seenMsgIds.add(msgId)
    if (seenMsgIds.size > 1000) {
      const first = seenMsgIds.values().next().value
      if (first) seenMsgIds.delete(first)
    }

    const author = data.author as { user_openid?: string; member_openid?: string; id?: string } | undefined
    const isGroup = eventType === "GROUP_AT_MESSAGE_CREATE"
    const userId = (isGroup ? author?.member_openid : author?.user_openid) || author?.id || ""
    const groupOpenId = typeof data.group_openid === "string" ? data.group_openid : ""
    const chatId = isGroup && groupOpenId ? groupOpenId : userId
    if (!userId || !chatId) return

    const content = (typeof data.content === "string" ? data.content : "")
      .replace(/^(?:\s*<@!?\w+>\s*)+/, "")
      .trim()
    const extractedAttachments = await extractQQAttachments(data.attachments)
    const audioAttachments = extractedAttachments.audioAttachments
    const fileAttachments = extractedAttachments.fileAttachments
    if (!content && audioAttachments.length === 0 && fileAttachments.length === 0) return

    const sessionKey = `qqbot:${options.robotId}:${chatId}`
    const replyContext: QQBotReplyContext = {
      messageType: isGroup ? "group" : "c2c",
      userOpenId: userId,
      groupOpenId: isGroup ? groupOpenId : undefined,
      eventMsgId: msgId,
    }
    await messageHandler({
      robotId: options.robotId,
      platform: "qqbot",
      sessionKey,
      messageId: msgId,
      userId,
      userName: userId.slice(0, 10),
      chatId,
      text: content,
      ...(audioAttachments.length > 0 ? { audioAttachments } : {}),
      ...(fileAttachments.length > 0 ? { fileAttachments } : {}),
      replyContext,
    })
  }

  return {
    async start(onMessage: MobileMessageHandler, _onCardAction: MobileCardActionHandler) {
      messageHandler = onMessage
      stopped = false
      await connectLoop()
    },
    async stop() {
      stopped = true
      currentStatus = { state: "stopped" }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer)
        heartbeatTimer = undefined
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = undefined
      }
      if (ws) {
        try {
          ws.close()
        } catch {
          // Ignore
        }
        ws = undefined
      }
    },
    status() {
      return currentStatus
    },
    sendText,
    sendCard,
    sendFile,
  }
}

function isSilkHeader(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 12)).toString("latin1")
  return head.startsWith("#!SILK_V3") || head.startsWith("\x02#!SILK_V3")
}

async function extractQQAttachments(rawAttachments: unknown): Promise<{
  audioAttachments: MobileAudioAttachment[]
  fileAttachments: MobileFileAttachment[]
}> {
  if (!Array.isArray(rawAttachments)) return { audioAttachments: [], fileAttachments: [] }
  const audioAttachments: MobileAudioAttachment[] = []
  const fileAttachments: MobileFileAttachment[] = []
  for (const raw of rawAttachments) {
    if (!raw || typeof raw !== "object") continue
    const rec = raw as { content_type?: string; url?: string; filename?: string }
    if (!rec.url) continue
    const ct = (rec.content_type ?? "").trim().toLowerCase()
    const filename = (rec.filename ?? "").trim()
    const fullUrl = rec.url.startsWith("//") ? `https:${rec.url}` : rec.url
    const resp = await fetch(fullUrl, { signal: AbortSignal.timeout(25_000) }).catch(() => undefined)
    if (!resp || !resp.ok) continue
    const bytes = new Uint8Array(await resp.arrayBuffer())
    if (bytes.byteLength === 0) continue

    const isAudio =
      ct === "voice" ||
      ct.startsWith("audio/") ||
      isSilkHeader(bytes) ||
      /\.(wav|mp3|ogg|amr|m4a|flac|webm|silk)$/i.test(filename)
    const detected = Mime.detect(bytes)

    if (isAudio) {
      const mimeType = isSilkHeader(bytes)
        ? "audio/silk"
        : detected.startsWith("audio/")
          ? detected
          : ct.startsWith("audio/")
            ? ct
            : "audio/amr"
      audioAttachments.push({
        data: bytes,
        mimeType,
        fileName: filename || `qq-voice.${mimeType.split("/")[1] || "amr"}`,
      })
      continue
    }

    const mimeType =
      detected !== "application/octet-stream"
        ? detected
        : ct && ct !== "file" && ct !== "application/octet-stream"
          ? ct
          : "application/octet-stream"
    const ext = (mimeType.split("/")[1] || "bin").split("+")[0] || "bin"
    fileAttachments.push({
      data: bytes,
      mimeType,
      fileName: filename || `qq-attachment.${ext}`,
    })
  }
  return { audioAttachments, fileAttachments }
}
