import { Mime } from "../../mime.js"
import { renderCardMarkdownFallback, type MobileCard } from "../card.js"
import type {
  MobileCardActionHandler,
  MobileFileAttachment,
  MobileMessageHandler,
  MobilePlatformConnector,
  MobilePlatformStatus,
} from "./types.js"

export interface DingTalkReplyContext {
  readonly sessionWebhook?: string
  readonly conversationId: string
  readonly senderStaffId: string
  readonly isGroup: boolean
}

export function createDingTalkConnector(options: {
  readonly robotId: string
  readonly clientId: string
  readonly clientSecret: string
}): MobilePlatformConnector {
  let currentStatus: MobilePlatformStatus = { state: "stopped" }
  let stopped = true
  let ws: WebSocket | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let messageHandler: MobileMessageHandler | undefined
  let cachedToken = ""
  let tokenExpiresAt = 0
  const seenMsgIds = new Set<string>()

  async function getAccessToken(): Promise<string> {
    if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken
    const resp = await fetch("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appKey: options.clientId,
        appSecret: options.clientSecret,
      }),
      signal: AbortSignal.timeout(10_000),
    })
    const data = (await resp.json()) as { accessToken?: string; expireIn?: number }
    if (!data.accessToken) throw new Error("DingTalk failed to obtain accessToken")
    cachedToken = data.accessToken
    tokenExpiresAt = Date.now() + Math.max(60, (data.expireIn ?? 7200) - 300) * 1000
    return cachedToken
  }

  async function sendText(replyContext: unknown, text: string): Promise<void> {
    const rc = replyContext as DingTalkReplyContext
    const trimmed = text.trim()
    if (!trimmed) return
    const firstLine = trimmed.split("\n")[0]?.replace(/^[#*>\-\s]+/, "").slice(0, 32) || "Pigu"

    if (rc.sessionWebhook) {
      const resp = await fetch(rc.sessionWebhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          msgtype: "markdown",
          markdown: {
            title: firstLine,
            text: trimmed,
          },
        }),
        signal: AbortSignal.timeout(15_000),
      })
      if (resp.ok) return
    }

    const token = await getAccessToken()
    const msgParam = JSON.stringify({ title: firstLine, text: trimmed })
    if (rc.isGroup) {
      await fetch("https://api.dingtalk.com/v1.0/robot/groupMessages/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-acs-dingtalk-access-token": token,
        },
        body: JSON.stringify({
          robotCode: options.clientId,
          openConversationId: rc.conversationId,
          msgKey: "sampleMarkdown",
          msgParam,
        }),
        signal: AbortSignal.timeout(15_000),
      })
      return
    }

    await fetch("https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": token,
      },
      body: JSON.stringify({
        robotCode: options.clientId,
        userIds: [rc.senderStaffId],
        msgKey: "sampleMarkdown",
        msgParam,
      }),
      signal: AbortSignal.timeout(15_000),
    })
  }

  async function sendCard(replyContext: unknown, card: MobileCard): Promise<void> {
    await sendText(replyContext, renderCardMarkdownFallback(card))
  }

  async function sendFile(
    replyContext: unknown,
    file: { readonly fileName: string; readonly mimeType: string; readonly data: Uint8Array },
  ): Promise<void> {
    const preview = Buffer.from(file.data.subarray(0, 3500)).toString("utf8")
    await sendText(
      replyContext,
      `📄 **${file.fileName}** (${file.data.byteLength} bytes)\n\`\`\`\n${preview}\n\`\`\``,
    )
  }

  async function connectLoop(): Promise<void> {
    if (stopped) return
    currentStatus = { state: "connecting" }
    try {
      const openResp = await fetch("https://api.dingtalk.com/v1.0/gateway/connections/open", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          clientId: options.clientId,
          clientSecret: options.clientSecret,
          subscriptions: [
            { type: "EVENT", topic: "*" },
            { type: "CALLBACK", topic: "/v1.0/im/bot/messages/get" },
            { type: "CALLBACK", topic: "/v1.0/card/instances/callback" },
          ],
          ua: "dingtalk-sdk-ts/pigu-1.0",
        }),
        signal: AbortSignal.timeout(15_000),
      })
      const openData = (await openResp.json()) as {
        endpoint?: string
        ticket?: string
        message?: string
      }
      if (!openData.endpoint || !openData.ticket) {
        throw new Error(`DingTalk stream open failed: ${openData.message ?? "missing endpoint/ticket"}`)
      }

      const wsUrl = `${openData.endpoint}?ticket=${encodeURIComponent(openData.ticket)}`
      const socket = new WebSocket(wsUrl)
      ws = socket

      socket.onopen = () => {
        if (stopped) {
          socket.close()
          return
        }
        currentStatus = { state: "connected" }
      }

      socket.onmessage = (ev) => {
        const raw = typeof ev.data === "string" ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString("utf8")
        try {
          const frame = JSON.parse(raw) as {
            specVersion?: string
            type?: string
            headers?: Record<string, string>
            data?: string
          }
          const messageId = frame.headers?.messageId ?? ""
          const topic = frame.headers?.topic ?? ""

          if (frame.type === "SYSTEM" && topic === "ping") {
            socket.send(
              JSON.stringify({
                code: 200,
                headers: frame.headers ?? {},
                message: "OK",
                data: frame.data ?? "",
              }),
            )
            return
          }

          if (frame.type === "CALLBACK") {
            socket.send(
              JSON.stringify({
                code: 200,
                headers: {
                  contentType: "application/json",
                  messageId,
                },
                message: "OK",
                data: JSON.stringify({ response: null }),
              }),
            )
            if (topic === "/v1.0/im/bot/messages/get" && frame.data) {
              void handleBotMessage(frame.data)
            }
          }
        } catch {
          // Ignore malformed frame
        }
      }

      socket.onclose = () => {
        if (stopped) return
        currentStatus = { state: "connecting", error: "Stream disconnected, reconnecting..." }
        reconnectTimer = setTimeout(() => void connectLoop(), 4_000)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      currentStatus = { state: "error", error: msg }
      if (!stopped) {
        reconnectTimer = setTimeout(() => void connectLoop(), 6_000)
      }
    }
  }

  async function downloadDingTalkFile(
    downloadCode: string,
    fallbackName?: string,
  ): Promise<MobileFileAttachment | undefined> {
    const token = await getAccessToken().catch(() => "")
    if (!token || !downloadCode.trim()) return undefined
    const metaResp = await fetch("https://api.dingtalk.com/v1.0/robot/messageFiles/download", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": token,
      },
      body: JSON.stringify({
        downloadCode: downloadCode.trim(),
        robotCode: options.clientId,
      }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => undefined)
    if (!metaResp || !metaResp.ok) return undefined
    const metaData = (await metaResp.json()) as { downloadUrl?: string }
    if (!metaData.downloadUrl) return undefined
    const fileResp = await fetch(metaData.downloadUrl, { signal: AbortSignal.timeout(25_000) }).catch(() => undefined)
    if (!fileResp || !fileResp.ok) return undefined
    const bytes = new Uint8Array(await fileResp.arrayBuffer())
    if (bytes.byteLength === 0) return undefined
    const detected = Mime.detect(bytes)
    const mimeType = detected !== "application/octet-stream" ? detected : "application/octet-stream"
    const ext = (mimeType.split("/")[1] || "bin").split("+")[0] || "bin"
    return {
      data: bytes,
      mimeType,
      fileName: fallbackName?.trim() || `dingtalk-attachment.${ext}`,
    }
  }

  async function handleBotMessage(rawJson: string): Promise<void> {
    if (!messageHandler) return
    const data = JSON.parse(rawJson) as {
      msgId?: string
      msgtype?: string
      conversationId?: string
      conversationType?: string
      senderStaffId?: string
      senderId?: string
      senderNick?: string
      sessionWebhook?: string
      text?: { content?: string }
      content?: {
        recognition?: string
        downloadCode?: string
        fileName?: string
        richText?: Array<{ text?: string; downloadCode?: string; type?: string }>
      }
    }
    const msgId = data.msgId ?? `${Date.now()}`
    if (seenMsgIds.has(msgId)) return
    seenMsgIds.add(msgId)
    if (seenMsgIds.size > 1000) {
      const first = seenMsgIds.values().next().value
      if (first) seenMsgIds.delete(first)
    }

    const userId = data.senderStaffId || data.senderId || ""
    const chatId = data.conversationId || userId
    if (!userId || !chatId) return

    const fileAttachments: MobileFileAttachment[] = []
    let text = (data.text?.content ?? data.content?.recognition ?? "").trim()
    if (data.msgtype === "richText" && Array.isArray(data.content?.richText)) {
      const textParts: string[] = []
      for (const item of data.content.richText) {
        if (item.text) textParts.push(item.text)
        if (item.downloadCode) {
          const att = await downloadDingTalkFile(item.downloadCode)
          if (att) fileAttachments.push(att)
        }
      }
      text = textParts.join("").trim() || text
    }
    if ((data.msgtype === "picture" || data.msgtype === "file") && data.content?.downloadCode) {
      const att = await downloadDingTalkFile(data.content.downloadCode, data.content.fileName)
      if (att) fileAttachments.push(att)
    }

    if (!text && fileAttachments.length === 0) return

    const sessionKey = `dingtalk:${options.robotId}:${chatId}`
    const replyContext: DingTalkReplyContext = {
      sessionWebhook: data.sessionWebhook,
      conversationId: chatId,
      senderStaffId: userId,
      isGroup: data.conversationType === "2",
    }

    await messageHandler({
      robotId: options.robotId,
      platform: "dingtalk",
      sessionKey,
      messageId: msgId,
      userId,
      userName: data.senderNick?.trim() || userId,
      chatId,
      text,
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
