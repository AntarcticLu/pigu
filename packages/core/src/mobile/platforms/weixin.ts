import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import { Mime } from "../../mime.js"
import { renderCardMarkdownFallback, type MobileCard } from "../card.js"
import { WEIXIN_DEFAULT_BASE_URL } from "../qr-setup.js"
import type {
  MobileAudioAttachment,
  MobileCardActionHandler,
  MobileFileAttachment,
  MobileMessageHandler,
  MobilePlatformConnector,
  MobilePlatformStatus,
} from "./types.js"

const WEIXIN_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c"

export interface WeixinReplyContext {
  readonly toUserId: string
  readonly contextToken?: string
}

function randomWechatUin(): string {
  const bytes = randomBytes(4)
  const val = bytes.readUInt32BE(0)
  return Buffer.from(String(val), "utf8").toString("base64")
}

function encryptAes128Ecb(plaintext: Uint8Array, key: Uint8Array): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null)
  cipher.setAutoPadding(true)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

export function parseWeixinAesKey(aesKey: string | undefined): Buffer | undefined {
  const trimmed = aesKey?.trim() ?? ""
  if (!trimmed) return undefined
  if (/^[0-9a-fA-F]{32}$/.test(trimmed)) return Buffer.from(trimmed, "hex")
  const b64 = Buffer.from(trimmed, "base64")
  if (b64.byteLength === 16) return b64
  const asUtf8 = b64.toString("utf8")
  if (/^[0-9a-fA-F]{32}$/.test(asUtf8)) return Buffer.from(asUtf8, "hex")
  return undefined
}

function tryDecryptAes128Ecb(raw: Buffer, key: Buffer): Uint8Array | undefined {
  if (raw.byteLength === 0 || raw.byteLength % 16 !== 0) return undefined
  try {
    const decipher = createDecipheriv("aes-128-ecb", key, null)
    decipher.setAutoPadding(true)
    return new Uint8Array(Buffer.concat([decipher.update(raw), decipher.final()]))
  } catch {
    return undefined
  }
}

export function decryptWeixinCdnPayload(
  raw: Uint8Array,
  candidateKeys: readonly (string | undefined)[],
): Uint8Array {
  const rawBuf = Buffer.from(raw)
  if (rawBuf.byteLength === 0) return new Uint8Array(0)
  if (Mime.detect(rawBuf) !== "application/octet-stream") return new Uint8Array(rawBuf)

  const uniqueKeys = [...new Set(candidateKeys.map((k) => k?.trim()).filter((k): k is string => Boolean(k)))]
  const parsedKeys = uniqueKeys.flatMap((rawKey) => {
    const key = parseWeixinAesKey(rawKey)
    return key ? [key] : []
  })
  if (parsedKeys.length === 0) return new Uint8Array(rawBuf)

  const candidates = parsedKeys.flatMap((key) => {
    const decrypted = tryDecryptAes128Ecb(rawBuf, key)
    return decrypted && decrypted.byteLength > 0 ? [decrypted] : []
  })
  const recognized = candidates.find((bytes) => Mime.detect(bytes) !== "application/octet-stream")
  return recognized ?? candidates[0] ?? new Uint8Array(rawBuf)
}

async function downloadWeixinCdnBytes(
  encryptQueryParam: string,
  candidateKeys: readonly (string | undefined)[],
  cdnBaseUrl = WEIXIN_CDN_BASE_URL,
): Promise<Uint8Array | undefined> {
  const url = `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`
  const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) }).catch(() => undefined)
  if (!resp || !resp.ok) return undefined
  const raw = new Uint8Array(await resp.arrayBuffer())
  if (raw.byteLength === 0) return undefined
  return decryptWeixinCdnPayload(raw, candidateKeys)
}

async function downloadWeixinVoiceFallback(
  encryptQueryParam: string,
  aesKey?: string,
  cdnBaseUrl = WEIXIN_CDN_BASE_URL,
): Promise<MobileAudioAttachment | undefined> {
  const bytes = await downloadWeixinCdnBytes(encryptQueryParam, [aesKey], cdnBaseUrl)
  if (!bytes) return undefined
  const head = Buffer.from(bytes.subarray(0, 12)).toString("latin1")
  if (head.startsWith("#!SILK_V3") || head.startsWith("\x02#!SILK_V3")) return undefined
  const detected = Mime.detect(bytes)
  const mimeType = detected.startsWith("audio/") ? detected : "audio/amr"
  return {
    data: bytes,
    mimeType,
    fileName: `weixin-voice.${mimeType.split("/")[1] || "amr"}`,
  }
}

async function downloadWeixinFileAttachment(
  encryptQueryParam: string,
  candidateKeys: readonly (string | undefined)[],
  kind: "image" | "file" | "video",
  rawFileName?: string,
  seqIndex = 1,
  cdnBaseUrl = WEIXIN_CDN_BASE_URL,
): Promise<MobileFileAttachment | undefined> {
  const bytes = await downloadWeixinCdnBytes(encryptQueryParam, candidateKeys, cdnBaseUrl)
  if (!bytes) return undefined
  const detected = Mime.detect(bytes)
  const mimeType =
    detected !== "application/octet-stream"
      ? detected
      : kind === "video"
        ? "video/mp4"
        : "application/octet-stream"
  const ext = (mimeType.split("/")[1] || (kind === "video" ? "mp4" : "bin")).split("+")[0]
  const fileName = rawFileName?.trim() || `weixin-${kind}-${seqIndex}.${ext === "octet-stream" ? "bin" : ext || "bin"}`
  return {
    data: bytes,
    mimeType,
    fileName,
  }
}

export function createWeixinConnector(options: {
  readonly robotId: string
  readonly token: string
  readonly baseUrl?: string
  readonly cdnBaseUrl?: string
  readonly burstDebounceMs?: number
}): MobilePlatformConnector {
  const baseUrl = (options.baseUrl?.trim() || WEIXIN_DEFAULT_BASE_URL).replace(/\/+$/, "")
  const defaultCdnBaseUrl = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(baseUrl)
    ? `${baseUrl}/c2c`
    : WEIXIN_CDN_BASE_URL
  const cdnBaseUrl = (options.cdnBaseUrl?.trim() || defaultCdnBaseUrl).replace(/\/+$/, "")
  const burstDebounceMs = options.burstDebounceMs ?? 900
  const maxBurstWindowMs = Math.max(burstDebounceMs, 3_000)
  let currentStatus: MobilePlatformStatus = { state: "stopped" }
  let stopped = true
  let cursor = ""
  let pollAbort: AbortController | undefined
  let messageHandler: MobileMessageHandler | undefined
  const seenMsgIds = new Set<string>()
  const contextTokenByUser = new Map<string, string>()
  const typingTicketByUser = new Map<string, { ticket: string; expiresAt: number }>()
  type PendingUserBurst = {
    startedAt: number
    timer: ReturnType<typeof setTimeout>
    messageId: string
    replyContext: WeixinReplyContext
    texts: string[]
    audioAttachments: MobileAudioAttachment[]
    fileAttachments: MobileFileAttachment[]
  }
  const pendingBursts = new Map<string, PendingUserBurst>()

  function flushPendingBurst(fromUser: string): void {
    const burst = pendingBursts.get(fromUser)
    if (!burst) return
    pendingBursts.delete(fromUser)
    clearTimeout(burst.timer)
    if (!messageHandler || stopped) return
    const sessionKey = `weixin:${options.robotId}:${fromUser}`
    void messageHandler({
      robotId: options.robotId,
      platform: "weixin",
      sessionKey,
      messageId: burst.messageId,
      userId: fromUser,
      userName: fromUser,
      chatId: fromUser,
      text: burst.texts.join("\n").trim(),
      ...(burst.audioAttachments.length > 0 ? { audioAttachments: burst.audioAttachments } : {}),
      ...(burst.fileAttachments.length > 0 ? { fileAttachments: burst.fileAttachments } : {}),
      replyContext: burst.replyContext,
    })
  }

  async function postJson<T>(path: string, body: Record<string, unknown>, timeoutMs = 45_000): Promise<T> {
    const resp = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        AuthorizationType: "ilink_bot_token",
        Authorization: `Bearer ${options.token}`,
        "X-WECHAT-UIN": randomWechatUin(),
      },
      body: JSON.stringify({
        ...body,
        base_info: { channel_version: "pigu-mobile/1.0" },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await resp.text()
    return JSON.parse(text) as T
  }

  async function sendTextChunk(rc: WeixinReplyContext, text: string): Promise<void> {
    const ctxToken = rc.contextToken || contextTokenByUser.get(rc.toUserId)
    const msg: Record<string, unknown> = {
      from_user_id: "",
      to_user_id: rc.toUserId,
      client_id: `pigu-wx-${randomBytes(8).toString("hex")}`,
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text } }],
    }
    if (ctxToken) msg.context_token = ctxToken
    const resp = await postJson<{ ret?: number; errmsg?: string }>(
      "/ilink/bot/sendmessage",
      { msg },
      20_000,
    )
    if (resp.ret && resp.ret !== 0) {
      throw new Error(`Weixin sendmessage failed (ret=${resp.ret}): ${resp.errmsg ?? ""}`)
    }
  }

  async function sendText(replyContext: unknown, text: string): Promise<void> {
    const rc = replyContext as WeixinReplyContext
    const trimmed = text.trim()
    if (!trimmed) return
    const maxLen = 3500
    for (let i = 0; i < trimmed.length; i += maxLen) {
      await sendTextChunk(rc, trimmed.slice(i, i + maxLen))
    }
  }

  async function sendCard(replyContext: unknown, card: MobileCard): Promise<void> {
    await sendText(replyContext, renderCardMarkdownFallback(card))
  }

  async function setTyping(replyContext: unknown, typing: boolean): Promise<void> {
    const rc = replyContext as WeixinReplyContext
    if (!rc?.toUserId) return
    const now = Date.now()
    let cached = typingTicketByUser.get(rc.toUserId)
    if (!cached || now >= cached.expiresAt) {
      const ctxToken = rc.contextToken || contextTokenByUser.get(rc.toUserId)
      const cfg = await postJson<{ ret?: number; typing_ticket?: string }>(
        "/ilink/bot/getconfig",
        {
          ilink_user_id: rc.toUserId,
          ...(ctxToken ? { context_token: ctxToken } : {}),
        },
        8_000,
      ).catch(() => undefined)
      const ticket = cfg?.typing_ticket?.trim() ?? ""
      if (!ticket) return
      cached = { ticket, expiresAt: now + 12 * 3600_000 }
      typingTicketByUser.set(rc.toUserId, cached)
    }
    await postJson(
      "/ilink/bot/sendtyping",
      {
        ilink_user_id: rc.toUserId,
        typing_ticket: cached.ticket,
        status: typing ? 1 : 2,
      },
      8_000,
    ).catch(() => undefined)
  }

  async function sendFile(
    replyContext: unknown,
    file: { readonly fileName: string; readonly mimeType: string; readonly data: Uint8Array },
  ): Promise<void> {
    const rc = replyContext as WeixinReplyContext
    const rawSize = file.data.byteLength
    const rawMd5 = createHash("md5").update(file.data).digest("hex")
    const aesKey = randomBytes(16)
    const fileKey = randomBytes(16).toString("hex")
    const encrypted = encryptAes128Ecb(file.data, aesKey)
    const isImage = /^image\/(png|jpeg|gif|webp|bmp)$/i.test(file.mimeType)
    const mediaType = isImage ? 1 : 3

    const urlResp = await postJson<{
      ret?: number
      errmsg?: string
      upload_param?: string
      upload_full_url?: string
    }>(
      "/ilink/bot/getuploadurl",
      {
        filekey: fileKey,
        media_type: mediaType,
        to_user_id: rc.toUserId,
        rawsize: rawSize,
        rawfilemd5: rawMd5,
        filesize: encrypted.byteLength,
        no_need_thumb: true,
        aeskey: aesKey.toString("hex"),
      },
      20_000,
    )
    if (urlResp.ret && urlResp.ret !== 0) {
      throw new Error(`Weixin getuploadurl failed (ret=${urlResp.ret}): ${urlResp.errmsg ?? ""}`)
    }

    const uploadUrl =
      urlResp.upload_full_url?.trim() ||
      `${WEIXIN_CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(urlResp.upload_param ?? "")}&filekey=${encodeURIComponent(fileKey)}`

    const cdnResp = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: encrypted,
      signal: AbortSignal.timeout(60_000),
    })
    const downloadParam = cdnResp.headers.get("x-encrypted-param")?.trim() ?? ""
    if (!downloadParam) {
      throw new Error(`Weixin CDN upload missing x-encrypted-param (HTTP ${cdnResp.status})`)
    }

    const mediaRef = {
      encrypt_query_param: downloadParam,
      aes_key: Buffer.from(aesKey.toString("hex"), "utf8").toString("base64"),
      encrypt_type: 1,
    }
    const item = isImage
      ? { type: 2, image_item: { media: mediaRef, mid_size: encrypted.byteLength } }
      : { type: 4, file_item: { media: mediaRef, file_name: file.fileName, len: String(rawSize) } }

    const ctxToken = rc.contextToken || contextTokenByUser.get(rc.toUserId)
    const msg: Record<string, unknown> = {
      from_user_id: "",
      to_user_id: rc.toUserId,
      client_id: `pigu-wx-${randomBytes(8).toString("hex")}`,
      message_type: 2,
      message_state: 2,
      item_list: [item],
    }
    if (ctxToken) msg.context_token = ctxToken
    await postJson("/ilink/bot/sendmessage", { msg }, 20_000)
  }

  async function pollLoop(): Promise<void> {
    currentStatus = { state: "connected" }
    while (!stopped) {
      try {
        pollAbort = new AbortController()
        const resp = await fetch(`${baseUrl}/ilink/bot/getupdates`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            AuthorizationType: "ilink_bot_token",
            Authorization: `Bearer ${options.token}`,
            "X-WECHAT-UIN": randomWechatUin(),
          },
          body: JSON.stringify({
            get_updates_buf: cursor,
            base_info: { channel_version: "pigu-mobile/1.0" },
          }),
          signal: pollAbort.signal,
        })
        const data = (await resp.json()) as {
          ret?: number
          errcode?: number
          errmsg?: string
          get_updates_buf?: string
          msgs?: Array<{
            message_id?: number
            from_user_id?: string
            message_type?: number
            context_token?: string
            item_list?: Array<{
              type?: number
              text_item?: { text?: string }
              image_item?: {
                aeskey?: string
                media?: { encrypt_query_param?: string; aes_key?: string }
                hd_media?: { encrypt_query_param?: string; aes_key?: string }
                thumb_media?: { encrypt_query_param?: string; aes_key?: string }
              }
              voice_item?: {
                text?: string
                media?: { encrypt_query_param?: string; aes_key?: string }
              }
              file_item?: {
                file_name?: string
                aeskey?: string
                media?: { encrypt_query_param?: string; aes_key?: string }
              }
              video_item?: {
                aeskey?: string
                media?: { encrypt_query_param?: string; aes_key?: string }
              }
            }>
          }>
        }

        if ((data.ret && data.ret !== 0) || (data.errcode && data.errcode !== 0)) {
          currentStatus = {
            state: "error",
            error: `Weixin poll error (${data.errcode || data.ret}): ${data.errmsg ?? ""}`,
          }
          await new Promise((r) => setTimeout(r, 4_000))
          continue
        }

        currentStatus = { state: "connected" }
        if (data.get_updates_buf) {
          cursor = data.get_updates_buf
        }

        for (const msg of data.msgs ?? []) {
          if (msg.message_type !== 1) continue
          const fromUser = msg.from_user_id?.trim() ?? ""
          if (!fromUser) continue
          const msgId = String(msg.message_id ?? `${fromUser}_${Date.now()}`)
          if (seenMsgIds.has(msgId)) continue
          seenMsgIds.add(msgId)
          if (seenMsgIds.size > 1000) {
            const first = seenMsgIds.values().next().value
            if (first) seenMsgIds.delete(first)
          }

          if (msg.context_token) {
            contextTokenByUser.set(fromUser, msg.context_token)
          }

          const existingBurst = pendingBursts.get(fromUser)
          let attachmentSeq = (existingBurst?.fileAttachments.length ?? 0) + 1
          const texts: string[] = []
          const audioAttachments: MobileAudioAttachment[] = []
          const fileAttachments: MobileFileAttachment[] = []
          for (const item of msg.item_list ?? []) {
            if (item.type === 1 && item.text_item?.text) {
              texts.push(item.text_item.text)
            }
            if (item.type === 2 && item.image_item) {
              const selectedMedia =
                (item.image_item.hd_media?.encrypt_query_param ? item.image_item.hd_media : undefined) ??
                (item.image_item.media?.encrypt_query_param ? item.image_item.media : undefined) ??
                (item.image_item.thumb_media?.encrypt_query_param ? item.image_item.thumb_media : undefined)
              if (selectedMedia?.encrypt_query_param) {
                const downloaded = await downloadWeixinFileAttachment(
                  selectedMedia.encrypt_query_param,
                  [
                    selectedMedia.aes_key,
                    item.image_item.media?.aes_key,
                    item.image_item.hd_media?.aes_key,
                    item.image_item.aeskey,
                  ],
                  "image",
                  undefined,
                  attachmentSeq,
                  cdnBaseUrl,
                )
                if (downloaded) {
                  fileAttachments.push(downloaded)
                  attachmentSeq += 1
                }
              }
            }
            if (item.type === 3 && item.voice_item?.text) {
              texts.push(item.voice_item.text)
            }
            if (item.type === 3 && !item.voice_item?.text && item.voice_item?.media?.encrypt_query_param) {
              const downloaded = await downloadWeixinVoiceFallback(
                item.voice_item.media.encrypt_query_param,
                item.voice_item.media.aes_key,
                cdnBaseUrl,
              )
              if (downloaded) {
                audioAttachments.push(downloaded)
              }
            }
            if (item.type === 4 && item.file_item?.media?.encrypt_query_param) {
              const downloaded = await downloadWeixinFileAttachment(
                item.file_item.media.encrypt_query_param,
                [item.file_item.media.aes_key, item.file_item.aeskey],
                "file",
                item.file_item.file_name,
                attachmentSeq,
                cdnBaseUrl,
              )
              if (downloaded) {
                fileAttachments.push(downloaded)
                attachmentSeq += 1
              }
            }
            if (item.type === 5 && item.video_item?.media?.encrypt_query_param) {
              const downloaded = await downloadWeixinFileAttachment(
                item.video_item.media.encrypt_query_param,
                [item.video_item.media.aes_key, item.video_item.aeskey],
                "video",
                undefined,
                attachmentSeq,
                cdnBaseUrl,
              )
              if (downloaded) {
                fileAttachments.push(downloaded)
                attachmentSeq += 1
              }
            }
          }
          const text = texts.join("\n").trim()
          if ((!text && audioAttachments.length === 0 && fileAttachments.length === 0) || !messageHandler) continue

          const sessionKey = `weixin:${options.robotId}:${fromUser}`
          const replyContext: WeixinReplyContext = {
            toUserId: fromUser,
            contextToken: msg.context_token,
          }
          const hasMedia = audioAttachments.length > 0 || fileAttachments.length > 0
          const isDotCommand = !hasMedia && /^[.。]\S/.test(text)
          const pending = pendingBursts.get(fromUser)

          if (isDotCommand && pending) {
            flushPendingBurst(fromUser)
          }

          if (burstDebounceMs > 0 && !isDotCommand && (hasMedia || pending !== undefined)) {
            const now = Date.now()
            if (pending) {
              clearTimeout(pending.timer)
              if (text) pending.texts.push(text)
              pending.audioAttachments.push(...audioAttachments)
              pending.fileAttachments.push(...fileAttachments)
              pending.replyContext = replyContext
              const remainingMax = maxBurstWindowMs - (now - pending.startedAt)
              if (remainingMax <= 0) {
                flushPendingBurst(fromUser)
                continue
              }
              pending.timer = setTimeout(() => flushPendingBurst(fromUser), Math.min(burstDebounceMs, remainingMax))
              continue
            }

            const timer = setTimeout(() => flushPendingBurst(fromUser), burstDebounceMs)
            pendingBursts.set(fromUser, {
              startedAt: now,
              timer,
              messageId: msgId,
              replyContext,
              texts: text ? [text] : [],
              audioAttachments: [...audioAttachments],
              fileAttachments: [...fileAttachments],
            })
            continue
          }

          void messageHandler({
            robotId: options.robotId,
            platform: "weixin",
            sessionKey,
            messageId: msgId,
            userId: fromUser,
            userName: fromUser,
            chatId: fromUser,
            text,
            ...(audioAttachments.length > 0 ? { audioAttachments } : {}),
            ...(fileAttachments.length > 0 ? { fileAttachments } : {}),
            replyContext,
          })
        }
      } catch (err) {
        if (stopped) return
        const msg = err instanceof Error ? err.message : String(err)
        if (!msg.includes("abort")) {
          currentStatus = { state: "connecting", error: msg }
          await new Promise((r) => setTimeout(r, 3_000))
        }
      }
    }
  }

  return {
    async start(onMessage: MobileMessageHandler, _onCardAction: MobileCardActionHandler) {
      messageHandler = onMessage
      stopped = false
      void pollLoop()
    },
    async stop() {
      stopped = true
      currentStatus = { state: "stopped" }
      for (const burst of pendingBursts.values()) {
        clearTimeout(burst.timer)
      }
      pendingBursts.clear()
      pollAbort?.abort()
    },
    status() {
      return currentStatus
    },
    sendText,
    sendCard,
    sendFile,
    setTyping,
  }
}
