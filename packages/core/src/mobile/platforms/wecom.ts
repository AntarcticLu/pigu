import { createDecipheriv, randomBytes } from "node:crypto"
import { Mime } from "../../mime.js"
import { renderCardMarkdownFallback, type MobileCard } from "../card.js"
import type {
  MobileCardActionHandler,
  MobileFileAttachment,
  MobileMessageHandler,
  MobilePlatformConnector,
  MobilePlatformStatus,
  MobileProgressHandle,
} from "./types.js"

const WECOM_WS_ENDPOINT = "wss://openws.work.weixin.qq.com"

export interface WeComReplyContext {
  readonly reqId?: string
  readonly chatId: string
  readonly userId: string
  readonly usedReply?: { value: boolean }
}

function makeReqId(prefix: string): string {
  return `${prefix}_${Date.now()}_${randomBytes(4).toString("hex")}`
}

export function createWeComConnector(options: {
  readonly robotId: string
  readonly botId: string
  readonly secret: string
}): MobilePlatformConnector {
  let currentStatus: MobilePlatformStatus = { state: "stopped" }
  let stopped = true
  let ws: WebSocket | undefined
  let pingTimer: ReturnType<typeof setInterval> | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let messageHandler: MobileMessageHandler | undefined
  const seenMsgIds = new Set<string>()

  function sendJsonFrame(frame: Record<string, unknown>): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("WeCom WebSocket is not connected")
    }
    ws.send(JSON.stringify(frame))
  }

  async function sendText(replyContext: unknown, text: string): Promise<void> {
    const rc = replyContext as WeComReplyContext
    const trimmed = text.trim()
    if (!trimmed) return

    if (rc.reqId && rc.usedReply && !rc.usedReply.value) {
      rc.usedReply.value = true
      sendJsonFrame({
        cmd: "aibot_respond_msg",
        headers: { req_id: rc.reqId },
        body: {
          msgtype: "stream",
          stream: {
            id: makeReqId("stream"),
            finish: true,
            content: trimmed,
          },
        },
      })
      return
    }

    sendJsonFrame({
      cmd: "aibot_send_msg",
      headers: { req_id: makeReqId("aibot_send_msg") },
      body: {
        chatid: rc.chatId,
        msgtype: "markdown",
        markdown: { content: trimmed },
      },
    })
  }

  async function sendCard(replyContext: unknown, card: MobileCard): Promise<void> {
    await sendText(replyContext, renderCardMarkdownFallback(card))
  }

  async function startProgress(
    replyContext: unknown,
    initialCard: MobileCard,
  ): Promise<MobileProgressHandle | undefined> {
    const rc = replyContext as WeComReplyContext
    if (!rc.reqId || !rc.usedReply || rc.usedReply.value) return undefined
    if (!ws || ws.readyState !== WebSocket.OPEN) return undefined
    rc.usedReply.value = true
    const reqId = rc.reqId
    const streamId = makeReqId("stream")
    const sendStreamFrame = (content: string, finish: boolean) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      sendJsonFrame({
        cmd: "aibot_respond_msg",
        headers: { req_id: reqId },
        body: {
          msgtype: "stream",
          stream: {
            id: streamId,
            finish,
            content: content.trim() || "处理中…",
          },
        },
      })
    }
    sendStreamFrame(renderCardMarkdownFallback(initialCard), false)
    return {
      async update(card) {
        sendStreamFrame(renderCardMarkdownFallback(card), false)
      },
      async finish(finalCard) {
        const doneText = finalCard ? renderCardMarkdownFallback(finalCard) : "✅ 任务处理完成，结果见下方回复。"
        sendStreamFrame(doneText, true)
      },
    }
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

  function connectLoop(): void {
    if (stopped) return
    currentStatus = { state: "connecting" }
    try {
      const socket = new WebSocket(WECOM_WS_ENDPOINT)
      ws = socket

      socket.onopen = () => {
        if (stopped) {
          socket.close()
          return
        }
        const subReqId = makeReqId("aibot_subscribe")
        socket.send(
          JSON.stringify({
            cmd: "aibot_subscribe",
            headers: { req_id: subReqId },
            body: {
              bot_id: options.botId,
              secret: options.secret,
            },
          }),
        )
      }

      socket.onmessage = (ev) => {
        const raw = typeof ev.data === "string" ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString("utf8")
        try {
          const frame = JSON.parse(raw) as {
            cmd?: string
            headers?: { req_id?: string }
            errcode?: number
            errmsg?: string
            body?: {
              msgid?: string
              aibotid?: string
              chatid?: string
              chattype?: string
              from?: { userid?: string }
              msgtype?: string
              text?: { content?: string }
              voice?: { content?: string }
              image?: { url?: string; aeskey?: string }
              file?: { url?: string; aeskey?: string; filename?: string }
              mixed?: {
                msg_item?: Array<{
                  msgtype?: string
                  text?: { content?: string }
                  image?: { url?: string; aeskey?: string }
                }>
              }
            }
          }
          const reqId = frame.headers?.req_id ?? ""
          if (!frame.cmd && reqId.startsWith("aibot_subscribe")) {
            if (frame.errcode === 0) {
              currentStatus = { state: "connected" }
              if (pingTimer) clearInterval(pingTimer)
              pingTimer = setInterval(() => {
                if (socket.readyState === WebSocket.OPEN) {
                  socket.send(JSON.stringify({ cmd: "ping", headers: { req_id: makeReqId("ping") } }))
                }
              }, 30_000)
              return
            }
            currentStatus = {
              state: "error",
              error: `WeCom subscribe failed (${frame.errcode}): ${frame.errmsg ?? ""}`,
            }
            socket.close()
            return
          }

          if (frame.cmd === "aibot_msg_callback" && frame.body) {
            void handleMsgCallback(reqId, frame.body)
          }
        } catch {
          // Ignore invalid JSON
        }
      }

      socket.onclose = () => {
        if (pingTimer) {
          clearInterval(pingTimer)
          pingTimer = undefined
        }
        if (stopped) return
        if (currentStatus.state !== "error") {
          currentStatus = { state: "connecting", error: "Connection closed, reconnecting..." }
        }
        reconnectTimer = setTimeout(() => connectLoop(), 5_000)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      currentStatus = { state: "error", error: msg }
      if (!stopped) {
        reconnectTimer = setTimeout(() => connectLoop(), 6_000)
      }
    }
  }

  async function downloadWeComMedia(
    url: string | undefined,
    aeskey?: string,
    fallbackName?: string,
  ): Promise<MobileFileAttachment | undefined> {
    if (!url?.trim()) return undefined
    const resp = await fetch(url.trim(), { signal: AbortSignal.timeout(25_000) }).catch(() => undefined)
    if (!resp || !resp.ok) return undefined
    const raw = Buffer.from(await resp.arrayBuffer())
    if (raw.byteLength === 0) return undefined
    const bytes = (() => {
      if (!aeskey?.trim()) return new Uint8Array(raw)
      try {
        const key = Buffer.from(aeskey.trim(), "base64")
        if (key.byteLength !== 32) return new Uint8Array(raw)
        const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16))
        decipher.setAutoPadding(true)
        return new Uint8Array(Buffer.concat([decipher.update(raw), decipher.final()]))
      } catch {
        return new Uint8Array(raw)
      }
    })()
    const detected = Mime.detect(bytes)
    const mimeType = detected !== "application/octet-stream" ? detected : "application/octet-stream"
    const ext = (mimeType.split("/")[1] || "bin").split("+")[0] || "bin"
    return {
      data: bytes,
      mimeType,
      fileName: fallbackName?.trim() || `wecom-attachment.${ext}`,
    }
  }

  async function handleMsgCallback(
    reqId: string,
    body: {
      msgid?: string
      aibotid?: string
      chatid?: string
      chattype?: string
      from?: { userid?: string }
      msgtype?: string
      text?: { content?: string }
      voice?: { content?: string }
      image?: { url?: string; aeskey?: string }
      file?: { url?: string; aeskey?: string; filename?: string }
      mixed?: {
        msg_item?: Array<{
          msgtype?: string
          text?: { content?: string }
          image?: { url?: string; aeskey?: string }
        }>
      }
    },
  ): Promise<void> {
    if (!messageHandler) return
    const msgId = body.msgid ?? `${Date.now()}`
    if (seenMsgIds.has(msgId)) return
    seenMsgIds.add(msgId)
    if (seenMsgIds.size > 1000) {
      const first = seenMsgIds.values().next().value
      if (first) seenMsgIds.delete(first)
    }

    const userId = body.from?.userid?.trim() ?? ""
    const chatId = body.chatid?.trim() || userId
    if (!userId || !chatId) return

    let text = ""
    const fileAttachments: MobileFileAttachment[] = []
    if (body.msgtype === "text") text = body.text?.content ?? ""
    if (body.msgtype === "voice") text = body.voice?.content ?? ""
    if (body.msgtype === "image" && body.image?.url) {
      const att = await downloadWeComMedia(body.image.url, body.image.aeskey)
      if (att) fileAttachments.push(att)
    }
    if (body.msgtype === "file" && body.file?.url) {
      const att = await downloadWeComMedia(body.file.url, body.file.aeskey, body.file.filename)
      if (att) fileAttachments.push(att)
    }
    if (body.msgtype === "mixed" && body.mixed?.msg_item) {
      const parts: string[] = []
      for (const item of body.mixed.msg_item) {
        if (item.text?.content) parts.push(item.text.content)
        if (item.image?.url) {
          const att = await downloadWeComMedia(item.image.url, item.image.aeskey)
          if (att) fileAttachments.push(att)
        }
      }
      text = parts.join("\n")
    }
    text = text.replace(new RegExp(`@${options.botId}\\s*`, "gi"), "").trim()
    if (!text && fileAttachments.length === 0) return

    const sessionKey = `wecom:${options.robotId}:${chatId}`
    const replyContext: WeComReplyContext = {
      reqId,
      chatId,
      userId,
      usedReply: { value: false },
    }
    await messageHandler({
      robotId: options.robotId,
      platform: "wecom",
      sessionKey,
      messageId: msgId,
      userId,
      userName: userId,
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
      connectLoop()
    },
    async stop() {
      stopped = true
      currentStatus = { state: "stopped" }
      if (pingTimer) {
        clearInterval(pingTimer)
        pingTimer = undefined
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
    startProgress,
  }
}
