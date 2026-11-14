import { Mime } from "../../mime.js"
import {
  flattenCollapsibleCard,
  renderFeishuCardJson,
  renderFeishuCardObject,
  type MobileCard,
} from "../card.js"
import { FEISHU_OPEN_BASE_URL, LARK_OPEN_BASE_URL } from "../qr-setup.js"
import type {
  MobileAudioAttachment,
  MobileCardActionHandler,
  MobileFileAttachment,
  MobileMessageHandler,
  MobilePlatformConnector,
  MobilePlatformStatus,
  MobileProgressHandle,
  UserMention,
} from "./types.js"

interface Pbbp2Header {
  readonly key: string
  readonly value: string
}

interface Pbbp2Frame {
  readonly seqId: bigint
  readonly logId: bigint
  readonly service: number
  readonly method: number
  readonly headers: Pbbp2Header[]
  readonly payloadEncoding: string
  readonly payloadType: string
  readonly payload: Uint8Array
  readonly logIdNew: string
}

export interface FeishuReplyContext {
  readonly chatId: string
  readonly messageId?: string
  readonly sessionKey: string
}

function encodeVarint(value: bigint | number): number[] {
  let v = typeof value === "bigint" ? BigInt.asUintN(64, value) : BigInt(value >>> 0)
  const out: number[] = []
  while (v >= 0x80n) {
    out.push(Number(v & 0x7fn) | 0x80)
    v >>= 7n
  }
  out.push(Number(v))
  return out
}

function decodeVarint(buf: Uint8Array, offset: number): { value: bigint; next: number } {
  let result = 0n
  let shift = 0n
  let pos = offset
  while (pos < buf.length) {
    const byte = buf[pos] ?? 0
    pos++
    result |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return { value: result, next: pos }
    shift += 7n
  }
  return { value: result, next: pos }
}

function encodeLengthDelimited(tag: number, bytes: Uint8Array): number[] {
  return [...encodeVarint(tag), ...encodeVarint(bytes.length), ...bytes]
}

function encodeHeader(header: Pbbp2Header): Uint8Array {
  const keyBytes = Buffer.from(header.key, "utf8")
  const valBytes = Buffer.from(header.value, "utf8")
  return new Uint8Array([
    ...encodeLengthDelimited(0x0a, keyBytes),
    ...encodeLengthDelimited(0x12, valBytes),
  ])
}

export function encodePbbp2Frame(frame: Pbbp2Frame): Uint8Array {
  const out: number[] = []
  if (frame.seqId !== 0n) out.push(...encodeVarint(0x08), ...encodeVarint(frame.seqId))
  if (frame.logId !== 0n) out.push(...encodeVarint(0x10), ...encodeVarint(frame.logId))
  if (frame.service !== 0) out.push(...encodeVarint(0x18), ...encodeVarint(frame.service))
  if (frame.method !== 0) out.push(...encodeVarint(0x20), ...encodeVarint(frame.method))
  for (const h of frame.headers) {
    out.push(...encodeLengthDelimited(0x2a, encodeHeader(h)))
  }
  if (frame.payloadEncoding) {
    out.push(...encodeLengthDelimited(0x32, Buffer.from(frame.payloadEncoding, "utf8")))
  }
  if (frame.payloadType) {
    out.push(...encodeLengthDelimited(0x3a, Buffer.from(frame.payloadType, "utf8")))
  }
  if (frame.payload.length > 0) {
    out.push(...encodeLengthDelimited(0x42, frame.payload))
  }
  if (frame.logIdNew) {
    out.push(...encodeLengthDelimited(0x4a, Buffer.from(frame.logIdNew, "utf8")))
  }
  return new Uint8Array(out)
}

function decodeHeader(buf: Uint8Array): Pbbp2Header {
  let pos = 0
  let key = ""
  let value = ""
  while (pos < buf.length) {
    const tag = decodeVarint(buf, pos)
    pos = tag.next
    const fieldNum = Number(tag.value >> 3n)
    const wireType = Number(tag.value & 0x07n)
    if (wireType === 2) {
      const len = decodeVarint(buf, pos)
      pos = len.next
      const end = pos + Number(len.value)
      const slice = buf.subarray(pos, end)
      pos = end
      if (fieldNum === 1) key = Buffer.from(slice).toString("utf8")
      if (fieldNum === 2) value = Buffer.from(slice).toString("utf8")
    }
    if (wireType === 0) {
      pos = decodeVarint(buf, pos).next
    }
  }
  return { key, value }
}

export function decodePbbp2Frame(buf: Uint8Array): Pbbp2Frame {
  let pos = 0
  let seqId = 0n
  let logId = 0n
  let service = 0
  let method = 0
  const headers: Pbbp2Header[] = []
  let payloadEncoding = ""
  let payloadType = ""
  let payload: Uint8Array = new Uint8Array(0)
  let logIdNew = ""

  while (pos < buf.length) {
    const tag = decodeVarint(buf, pos)
    pos = tag.next
    const fieldNum = Number(tag.value >> 3n)
    const wireType = Number(tag.value & 0x07n)
    if (wireType === 0) {
      const val = decodeVarint(buf, pos)
      pos = val.next
      if (fieldNum === 1) seqId = val.value
      if (fieldNum === 2) logId = val.value
      if (fieldNum === 3) service = Number(val.value)
      if (fieldNum === 4) method = Number(val.value)
    }
    if (wireType === 2) {
      const len = decodeVarint(buf, pos)
      pos = len.next
      const end = pos + Number(len.value)
      const slice = buf.subarray(pos, end)
      pos = end
      if (fieldNum === 5) headers.push(decodeHeader(slice))
      if (fieldNum === 6) payloadEncoding = Buffer.from(slice).toString("utf8")
      if (fieldNum === 7) payloadType = Buffer.from(slice).toString("utf8")
      if (fieldNum === 8) payload = slice
      if (fieldNum === 9) logIdNew = Buffer.from(slice).toString("utf8")
    }
    if (wireType === 1) pos += 8
    if (wireType === 5) pos += 4
  }

  return {
    seqId,
    logId,
    service,
    method,
    headers,
    payloadEncoding,
    payloadType,
    payload,
    logIdNew,
  }
}

function getHeader(headers: readonly Pbbp2Header[], key: string): string {
  return headers.find((h) => h.key === key)?.value ?? ""
}

export function createFeishuConnector(options: {
  readonly robotId: string
  readonly platform: "feishu" | "lark"
  readonly appId: string
  readonly appSecret: string
  readonly domain?: string
}): MobilePlatformConnector {
  const domain = (
    options.domain?.trim() || (options.platform === "lark" ? LARK_OPEN_BASE_URL : FEISHU_OPEN_BASE_URL)
  ).replace(/\/+$/, "")

  let currentStatus: MobilePlatformStatus = { state: "stopped" }
  let stopped = true
  let ws: WebSocket | undefined
  let pingTimer: ReturnType<typeof setInterval> | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let cachedToken = ""
  let tokenExpiresAt = 0
  let botOpenId = ""
  const seenMessageIds = new Set<string>()
  const userNameCache = new Map<string, string>()
  const multipartCache = new Map<string, { parts: (Uint8Array | undefined)[]; timer: ReturnType<typeof setTimeout> }>()

  let messageHandler: MobileMessageHandler | undefined
  let cardActionHandler: MobileCardActionHandler | undefined

  async function getTenantToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && cachedToken && Date.now() < tokenExpiresAt) {
      return cachedToken
    }
    const resp = await fetch(`${domain}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: options.appId, app_secret: options.appSecret }),
      signal: AbortSignal.timeout(10_000),
    })
    const data = (await resp.json()) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number }
    if (data.code !== 0 || !data.tenant_access_token) {
      throw new Error(`Feishu auth failed (code=${data.code}): ${data.msg ?? ""}`)
    }
    cachedToken = data.tenant_access_token
    tokenExpiresAt = Date.now() + Math.max(60, (data.expire ?? 7200) - 300) * 1000
    return cachedToken
  }

  async function resolveUserDisplayName(userId: string): Promise<string> {
    const clean = userId.trim()
    if (!clean) return ""
    const cached = userNameCache.get(clean)
    if (cached) return cached
    try {
      const token = await getTenantToken()
      const resp = await fetch(`${domain}/open-apis/contact/v3/users/${encodeURIComponent(clean)}?user_id_type=open_id`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8_000),
      })
      const data = (await resp.json()) as { code?: number; data?: { user?: { name?: string } } }
      const name = data.data?.user?.name?.trim() ?? ""
      if (name) {
        userNameCache.set(clean, name)
        return name
      }
    } catch {
      // Ignore contact API lookup failures (permission may not be granted)
    }
    return clean
  }

  async function downloadMessageAudio(
    messageId: string,
    fileKey: string,
  ): Promise<MobileAudioAttachment | undefined> {
    const token = await getTenantToken().catch(() => "")
    if (!token) return undefined
    const url = `${domain}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=file`
    const resp = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    }).catch(() => undefined)
    if (!resp || !resp.ok) return undefined
    const bytes = new Uint8Array(await resp.arrayBuffer())
    if (bytes.byteLength === 0) return undefined
    const headerMime = resp.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? ""
    const mimeType = headerMime.startsWith("audio/") ? headerMime : "audio/ogg"
    const ext = mimeType.split("/")[1] || "ogg"
    return {
      data: bytes,
      mimeType,
      fileName: `feishu-voice.${ext}`,
    }
  }

  async function downloadMessageResource(
    messageId: string,
    resourceKey: string,
    resourceType: "image" | "file",
    fallbackFileName?: string,
  ): Promise<MobileFileAttachment | undefined> {
    const token = await getTenantToken().catch(() => "")
    if (!token) return undefined
    const url = `${domain}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(resourceKey)}?type=${resourceType}`
    const resp = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    }).catch(() => undefined)
    if (!resp || !resp.ok) return undefined
    const bytes = new Uint8Array(await resp.arrayBuffer())
    if (bytes.byteLength === 0) return undefined
    const detected = Mime.detect(bytes)
    const headerMime = resp.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? ""
    const mimeType =
      detected !== "application/octet-stream"
        ? detected
        : headerMime && headerMime !== "application/octet-stream"
          ? headerMime
          : resourceType === "image"
            ? "image/png"
            : "application/octet-stream"
    const ext = (mimeType.split("/")[1] || (resourceType === "image" ? "png" : "bin")).split("+")[0] || "bin"
    const fileName =
      fallbackFileName?.trim() || (resourceType === "image" ? `feishu-image.${ext}` : `feishu-file.${ext}`)
    return {
      data: bytes,
      mimeType,
      fileName,
    }
  }

  async function sendMessageApi(rc: FeishuReplyContext, msgType: string, content: string): Promise<string | undefined> {
    const token = await getTenantToken()
    if (rc.messageId) {
      const resp = await fetch(`${domain}/open-apis/im/v1/messages/${encodeURIComponent(rc.messageId)}/reply`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ msg_type: msgType, content }),
        signal: AbortSignal.timeout(15_000),
      })
      const data = (await resp.json()) as { code?: number; msg?: string; data?: { message_id?: string } }
      if (data.code === 0) return data.data?.message_id
    }
    if (!rc.chatId) return undefined
    const receiveIdType = rc.chatId.startsWith("ou_")
      ? "open_id"
      : rc.chatId.startsWith("on_")
        ? "union_id"
        : "chat_id"
    const resp = await fetch(`${domain}/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        receive_id: rc.chatId,
        msg_type: msgType,
        content,
      }),
      signal: AbortSignal.timeout(15_000),
    })
    const data = (await resp.json()) as { code?: number; msg?: string; data?: { message_id?: string } }
    if (data.code !== 0) {
      throw new Error(`Feishu send message failed (code=${data.code}): ${data.msg ?? ""}`)
    }
    return data.data?.message_id
  }

  async function sendInteractiveCard(rc: FeishuReplyContext, card: MobileCard): Promise<string | undefined> {
    const primary = await sendMessageApi(rc, "interactive", renderFeishuCardJson(card, rc.sessionKey)).catch(
      () => undefined,
    )
    if (primary) return primary
    const flat = flattenCollapsibleCard(card)
    if (flat === card) return undefined
    return sendMessageApi(rc, "interactive", renderFeishuCardJson(flat, rc.sessionKey)).catch(() => undefined)
  }

  async function patchCardMessage(messageId: string, card: MobileCard, sessionKey: string): Promise<boolean> {
    const token = await getTenantToken().catch(() => "")
    if (!token) return false
    const tryPatch = async (targetCard: MobileCard): Promise<boolean> => {
      const resp = await fetch(`${domain}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: renderFeishuCardJson(targetCard, sessionKey) }),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined)
      if (!resp) return false
      const data = (await resp.json().catch(() => ({ code: -1 }))) as { code?: number }
      return data.code === 0
    }
    if (await tryPatch(card)) return true
    const flat = flattenCollapsibleCard(card)
    if (flat === card) return false
    return tryPatch(flat)
  }

  async function deleteMessageApi(messageId: string): Promise<boolean> {
    const token = await getTenantToken().catch(() => "")
    if (!token) return false
    const resp = await fetch(`${domain}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined)
    if (!resp) return false
    const data = (await resp.json().catch(() => ({ code: -1 }))) as { code?: number }
    return data.code === 0
  }

  async function startProgress(
    replyContext: unknown,
    initialCard: MobileCard,
  ): Promise<MobileProgressHandle | undefined> {
    const rc = replyContext as FeishuReplyContext
    const sentId = await sendInteractiveCard(rc, initialCard)
    if (!sentId) return undefined
    return {
      async update(card) {
        await patchCardMessage(sentId, card, rc.sessionKey)
      },
      async finish(finalCard) {
        if (finalCard) {
          await patchCardMessage(sentId, finalCard, rc.sessionKey)
          return
        }
        const deleted = await deleteMessageApi(sentId)
        if (!deleted) {
          await patchCardMessage(
            sentId,
            {
              header: { title: "处理完成", color: "green" },
              elements: [{ kind: "markdown", content: "结果已在下方消息中返回。" }],
            },
            rc.sessionKey,
          )
        }
      },
    }
  }

  async function sendText(replyContext: unknown, text: string): Promise<void> {
    const rc = replyContext as FeishuReplyContext
    const trimmed = text.trim()
    if (!trimmed) return
    const hasMarkdown =
      trimmed.includes("```") ||
      trimmed.includes("**") ||
      trimmed.includes("\n- ") ||
      trimmed.includes("\n### ") ||
      trimmed.includes("\n## ")
    if (hasMarkdown) {
      const card: MobileCard = {
        elements: [{ kind: "markdown", content: trimmed }],
      }
      await sendMessageApi(rc, "interactive", renderFeishuCardJson(card, rc.sessionKey))
      return
    }
    await sendMessageApi(rc, "text", JSON.stringify({ text: trimmed }))
  }

  async function sendCard(replyContext: unknown, card: MobileCard): Promise<void> {
    const rc = replyContext as FeishuReplyContext
    const ok = await sendInteractiveCard(rc, card)
    if (!ok) {
      await sendMessageApi(rc, "interactive", renderFeishuCardJson(flattenCollapsibleCard(card), rc.sessionKey))
    }
  }

  async function sendFile(
    replyContext: unknown,
    file: { readonly fileName: string; readonly mimeType: string; readonly data: Uint8Array },
  ): Promise<void> {
    const rc = replyContext as FeishuReplyContext
    const token = await getTenantToken()
    const isImage = /^image\/(png|jpeg|gif|webp|bmp|tiff|x-icon)$/i.test(file.mimeType)
    if (isImage) {
      const form = new FormData()
      form.append("image_type", "message")
      form.append("image", new Blob([file.data], { type: file.mimeType }), file.fileName)
      const upResp = await fetch(`${domain}/open-apis/im/v1/images`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
        signal: AbortSignal.timeout(30_000),
      })
      const upData = (await upResp.json()) as { code?: number; msg?: string; data?: { image_key?: string } }
      if (upData.code !== 0 || !upData.data?.image_key) {
        throw new Error(`Feishu image upload failed: ${upData.msg ?? ""}`)
      }
      await sendMessageApi(rc, "image", JSON.stringify({ image_key: upData.data.image_key }))
      return
    }

    const lower = file.fileName.toLowerCase()
    const fileType = lower.endsWith(".pdf")
      ? "pdf"
      : lower.endsWith(".doc") || lower.endsWith(".docx")
        ? "doc"
        : lower.endsWith(".xls") || lower.endsWith(".xlsx")
          ? "xls"
          : lower.endsWith(".ppt") || lower.endsWith(".pptx")
            ? "ppt"
            : lower.endsWith(".mp4")
              ? "mp4"
              : "stream"

    const form = new FormData()
    form.append("file_type", fileType)
    form.append("file_name", file.fileName)
    form.append("file", new Blob([file.data], { type: file.mimeType }), file.fileName)
    const upResp = await fetch(`${domain}/open-apis/im/v1/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    })
    const upData = (await upResp.json()) as { code?: number; msg?: string; data?: { file_key?: string } }
    if (upData.code !== 0 || !upData.data?.file_key) {
      throw new Error(`Feishu file upload failed: ${upData.msg ?? ""}`)
    }
    await sendMessageApi(rc, "file", JSON.stringify({ file_key: upData.data.file_key }))
  }

  function mergeFramePayload(msgId: string, sum: number, seq: number, chunk: Uint8Array): Uint8Array | undefined {
    if (sum <= 1) return chunk
    let entry = multipartCache.get(msgId)
    if (!entry) {
      const timer = setTimeout(() => multipartCache.delete(msgId), 10_000)
      entry = { parts: Array.from({ length: sum }), timer }
      multipartCache.set(msgId, entry)
    }
    entry.parts[seq] = chunk
    if (entry.parts.some((p) => p === undefined)) return undefined
    clearTimeout(entry.timer)
    multipartCache.delete(msgId)
    const totalLen = entry.parts.reduce((acc, p) => acc + (p?.length ?? 0), 0)
    const combined = new Uint8Array(totalLen)
    let offset = 0
    for (const part of entry.parts) {
      if (!part) continue
      combined.set(part, offset)
      offset += part.length
    }
    return combined
  }

  async function handleDataFrame(socket: WebSocket, frame: Pbbp2Frame): Promise<void> {
    const sum = Number(getHeader(frame.headers, "sum") || "1")
    const seq = Number(getHeader(frame.headers, "seq") || "0")
    const msgId = getHeader(frame.headers, "message_id")
    const msgType = getHeader(frame.headers, "type")
    const fullPayload = mergeFramePayload(msgId, sum, seq, frame.payload)
    if (!fullPayload) return

    const startMs = Date.now()
    let respPayloadObj: Record<string, unknown> = { code: 200 }

    try {
      const jsonStr = Buffer.from(fullPayload).toString("utf8")
      const eventObj = JSON.parse(jsonStr) as Record<string, unknown>
      const header = eventObj.header as { event_type?: string } | undefined
      const eventType = header?.event_type ?? (eventObj.type as string | undefined) ?? ""

      if (msgType === "event" && eventType === "im.message.receive_v1") {
        void processMessageEvent(eventObj)
      }
      if (msgType === "card" || eventType === "card.action.trigger") {
        const cardData = await processCardActionEvent(eventObj)
        if (cardData) {
          respPayloadObj = {
            code: 200,
            data: Buffer.from(JSON.stringify(cardData), "utf8").toString("base64"),
          }
        }
      }
    } catch {
      // Always ack 200 so Feishu does not retry indefinitely
    }

    const bizRt = String(Date.now() - startMs)
    const replyHeaders = [...frame.headers, { key: "biz_rt", value: bizRt }]
    const replyFrame: Pbbp2Frame = {
      ...frame,
      headers: replyHeaders,
      payload: Buffer.from(JSON.stringify(respPayloadObj), "utf8"),
    }
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(encodePbbp2Frame(replyFrame))
    }
  }

  async function processMessageEvent(eventObj: Record<string, unknown>): Promise<void> {
    if (!messageHandler) return
    const event = eventObj.event as
      | {
          sender?: { sender_id?: { open_id?: string; user_id?: string } }
          message?: {
            message_id?: string
            create_time?: string
            chat_id?: string
            chat_type?: string
            message_type?: string
            content?: string
            mentions?: Array<{
              key?: string
              name?: string
              id?: { open_id?: string; user_id?: string }
            }>
          }
        }
      | undefined
    const msg = event?.message
    if (!msg?.message_id) return
    if (seenMessageIds.has(msg.message_id)) return
    seenMessageIds.add(msg.message_id)
    if (seenMessageIds.size > 2000) {
      const first = seenMessageIds.values().next().value
      if (first) seenMessageIds.delete(first)
    }

    if (msg.create_time) {
      const createdMs = Number(msg.create_time)
      if (Number.isFinite(createdMs) && Date.now() - createdMs > 5 * 60_000) return
    }

    const userId = event?.sender?.sender_id?.open_id || event?.sender?.sender_id?.user_id || ""
    const chatId = msg.chat_id || userId
    if (!userId || !chatId) return

    let text = ""
    const audioAttachments: MobileAudioAttachment[] = []
    const fileAttachments: MobileFileAttachment[] = []
    if (msg.message_type === "text" && msg.content) {
      const parsed = JSON.parse(msg.content) as { text?: string }
      text = parsed.text ?? ""
    }
    if (msg.message_type === "post" && msg.content) {
      const postExtracted = extractPostContent(msg.content)
      text = postExtracted.text
      for (const imgKey of postExtracted.imageKeys) {
        const downloaded = await downloadMessageResource(msg.message_id, imgKey, "image")
        if (downloaded) fileAttachments.push(downloaded)
      }
    }
    if (msg.message_type === "image" && msg.content) {
      const parsed = JSON.parse(msg.content) as { image_key?: string }
      const imageKey = parsed.image_key?.trim() ?? ""
      if (imageKey) {
        const downloaded = await downloadMessageResource(msg.message_id, imageKey, "image")
        if (downloaded) fileAttachments.push(downloaded)
      }
    }
    if ((msg.message_type === "file" || msg.message_type === "media") && msg.content) {
      const parsed = JSON.parse(msg.content) as { file_key?: string; file_name?: string }
      const fileKey = parsed.file_key?.trim() ?? ""
      if (fileKey) {
        const downloaded = await downloadMessageResource(msg.message_id, fileKey, "file", parsed.file_name)
        if (downloaded) fileAttachments.push(downloaded)
      }
    }
    if (msg.message_type === "audio" && msg.content) {
      const parsed = JSON.parse(msg.content) as { file_key?: string }
      const fileKey = parsed.file_key?.trim() ?? ""
      if (fileKey) {
        const downloaded = await downloadMessageAudio(msg.message_id, fileKey)
        if (downloaded) {
          audioAttachments.push(downloaded)
        }
      }
    }

    const mentions = msg.mentions ?? []
    const mentionedUsers: UserMention[] = []
    for (const m of mentions) {
      const mId = m.id?.open_id || m.id?.user_id || ""
      const mName = m.name?.trim() ?? ""
      if (mId && mName) userNameCache.set(mId, mName)
      if (m.key) {
        if (botOpenId && mId === botOpenId) {
          text = text.replaceAll(m.key, "")
        }
        if (!botOpenId || mId !== botOpenId) {
          text = text.replaceAll(m.key, mName ? `@${mName}` : "")
          if (mId) mentionedUsers.push({ id: mId, name: mName || mId })
        }
      }
    }

    text = text.trim()
    if (!text && audioAttachments.length === 0 && fileAttachments.length === 0) return

    const userName = await resolveUserDisplayName(userId)
    const sessionKey = `${options.platform}:${options.robotId}:${chatId}`
    const replyContext: FeishuReplyContext = {
      chatId,
      messageId: msg.message_id,
      sessionKey,
    }

    await messageHandler({
      robotId: options.robotId,
      platform: options.platform,
      sessionKey,
      messageId: msg.message_id,
      userId,
      userName,
      chatId,
      text,
      mentionedUsers,
      ...(audioAttachments.length > 0 ? { audioAttachments } : {}),
      ...(fileAttachments.length > 0 ? { fileAttachments } : {}),
      replyContext,
    })
  }

  async function processCardActionEvent(eventObj: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    const event = (eventObj.event ?? eventObj) as {
      open_id?: string
      user_id?: string
      open_chat_id?: string
      open_message_id?: string
      operator?: { open_id?: string; user_id?: string }
      context?: { open_chat_id?: string; open_message_id?: string }
      action?: {
        value?: Record<string, unknown> | string
        option?: string
      }
    }
    const actionObj = event.action
    if (!actionObj) return undefined
    const rawValue: Record<string, unknown> = (() => {
      if (typeof actionObj.value === "string") {
        const trimmed = actionObj.value.trim()
        if (!trimmed.startsWith("{")) return { action: trimmed }
        try {
          const parsed = JSON.parse(trimmed) as unknown
          return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : { action: trimmed }
        } catch {
          return { action: trimmed }
        }
      }
      if (actionObj.value && typeof actionObj.value === "object") {
        return actionObj.value
      }
      return {}
    })()
    const actionStr =
      (typeof rawValue.action === "string" ? rawValue.action : "") ||
      (typeof actionObj.option === "string" ? actionObj.option : "")
    if (!actionStr) return undefined

    const userId = event.operator?.open_id || event.operator?.user_id || event.open_id || event.user_id || ""
    const chatId = event.context?.open_chat_id || event.open_chat_id || userId
    const messageId = event.context?.open_message_id || event.open_message_id
    const sessionKey =
      (typeof rawValue.session_key === "string" && rawValue.session_key) ||
      `${options.platform}:${options.robotId}:${chatId}`
    const replyContext: FeishuReplyContext = { chatId, messageId, sessionKey }

    if (actionStr.startsWith("cmd:")) {
      const cmdText = actionStr.slice(4).trim()
      if (cmdText && messageHandler) {
        const userName = await resolveUserDisplayName(userId)
        void messageHandler({
          robotId: options.robotId,
          platform: options.platform,
          sessionKey,
          messageId: messageId ?? `card_${Date.now()}`,
          userId,
          userName,
          chatId,
          text: cmdText,
          replyContext,
        })
      }
      return undefined
    }

    if (cardActionHandler) {
      const nextCard = await cardActionHandler({
        robotId: options.robotId,
        action: actionStr,
        sessionKey,
        userId,
        chatId,
        replyContext,
      })
      if (nextCard) {
        return {
          card: {
            type: "raw",
            data: renderFeishuCardObject(nextCard, sessionKey),
          },
        }
      }
    }
    return undefined
  }

  async function connectLoop(): Promise<void> {
    if (stopped) return
    currentStatus = { state: "connecting" }
    try {
      // Discover bot open_id best-effort
      try {
        const token = await getTenantToken()
        const infoResp = await fetch(`${domain}/open-apis/bot/v3/info/`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(8_000),
        })
        const infoData = (await infoResp.json()) as { bot?: { open_id?: string } }
        if (infoData.bot?.open_id) botOpenId = infoData.bot.open_id
      } catch {
        // Non-fatal
      }

      const epResp = await fetch(`${domain}/callback/ws/endpoint`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          locale: "zh",
        },
        body: JSON.stringify({
          AppID: options.appId,
          AppSecret: options.appSecret,
        }),
        signal: AbortSignal.timeout(15_000),
      })
      const epData = (await epResp.json()) as {
        code?: number
        msg?: string
        data?: {
          URL?: string
          ClientConfig?: { PingInterval?: number; ReconnectInterval?: number }
        }
      }
      if (epData.code !== 0 || !epData.data?.URL) {
        throw new Error(`Feishu ws endpoint failed (code=${epData.code}): ${epData.msg ?? "empty URL"}`)
      }

      const wsUrl = epData.data.URL
      const parsedUrl = new URL(wsUrl)
      const serviceId = Number(parsedUrl.searchParams.get("service_id") ?? "0")
      const pingIntervalSec = epData.data.ClientConfig?.PingInterval ?? 120

      const socket = new WebSocket(wsUrl)
      socket.binaryType = "arraybuffer"
      ws = socket

      socket.onopen = () => {
        if (stopped) {
          socket.close()
          return
        }
        currentStatus = { state: "connected" }
        if (pingTimer) clearInterval(pingTimer)
        pingTimer = setInterval(() => {
          if (socket.readyState !== WebSocket.OPEN) return
          const pingFrame: Pbbp2Frame = {
            seqId: 0n,
            logId: 0n,
            service: serviceId,
            method: 0,
            headers: [{ key: "type", value: "ping" }],
            payloadEncoding: "",
            payloadType: "",
            payload: new Uint8Array(0),
            logIdNew: "",
          }
          socket.send(encodePbbp2Frame(pingFrame))
        }, pingIntervalSec * 1000)
      }

      socket.onmessage = (ev) => {
        if (!(ev.data instanceof ArrayBuffer)) return
        const frame = decodePbbp2Frame(new Uint8Array(ev.data))
        if (frame.method === 1) {
          void handleDataFrame(socket, frame)
        }
      }

      socket.onerror = () => {
        // Handled in onclose
      }

      socket.onclose = () => {
        if (pingTimer) {
          clearInterval(pingTimer)
          pingTimer = undefined
        }
        if (stopped) return
        currentStatus = { state: "connecting", error: "Connection closed, reconnecting..." }
        reconnectTimer = setTimeout(() => void connectLoop(), 5_000)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      currentStatus = { state: "error", error: msg }
      if (!stopped) {
        reconnectTimer = setTimeout(() => void connectLoop(), 8_000)
      }
    }
  }

  return {
    async start(onMessage, onCardAction) {
      messageHandler = onMessage
      cardActionHandler = onCardAction
      stopped = false
      await connectLoop()
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
          // Ignore close errors
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
    resolveUserDisplayName,
  }
}

function extractPostContent(rawContent: string): { text: string; imageKeys: string[] } {
  try {
    const parsed = JSON.parse(rawContent) as Record<string, unknown>
    const post = (parsed.content ? parsed : Object.values(parsed)[0]) as
      | { title?: string; content?: Array<Array<{ tag?: string; text?: string; image_key?: string }>> }
      | undefined
    if (!post?.content) return { text: "", imageKeys: [] }
    const lines: string[] = []
    const imageKeys: string[] = []
    if (post.title) lines.push(post.title)
    for (const para of post.content) {
      const lineParts: string[] = []
      for (const el of para) {
        if (el.text) lineParts.push(el.text)
        if (el.tag === "img" && el.image_key?.trim()) {
          imageKeys.push(el.image_key.trim())
        }
      }
      const line = lineParts.join("")
      if (line) lines.push(line)
    }
    return { text: lines.join("\n"), imageKeys }
  } catch {
    return { text: "", imageKeys: [] }
  }
}
