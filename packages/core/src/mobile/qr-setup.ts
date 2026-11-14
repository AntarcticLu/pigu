import { gzipSync } from "node:zlib"

export const FEISHU_ACCOUNTS_BASE_URL = "https://accounts.feishu.cn"
export const LARK_ACCOUNTS_BASE_URL = "https://accounts.larksuite.com"
export const FEISHU_OPEN_BASE_URL = "https://open.feishu.cn"
export const LARK_OPEN_BASE_URL = "https://open.larksuite.com"
export const WEIXIN_DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com"

export interface FeishuQrBeginResult {
  readonly deviceCode: string
  readonly qrUrl: string
  readonly verificationUrl: string
  readonly interval: number
  readonly expireIn: number
  readonly baseUrl: string
}

export interface FeishuQrPollResult {
  readonly status: "pending" | "completed" | "expired" | "denied"
  readonly baseUrl: string
  readonly appId?: string
  readonly appSecret?: string
  readonly ownerOpenId?: string
  readonly botName?: string
  readonly domain?: string
  readonly message?: string
}

export interface WeixinQrBeginResult {
  readonly qrcodeKey: string
  readonly qrUrl: string
}

export interface WeixinQrPollResult {
  readonly status: "waiting" | "scanned" | "completed" | "expired"
  readonly token?: string
  readonly botId?: string
  readonly baseUrl?: string
  readonly userId?: string
}

export function prepareFeishuRegistrationUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim()
  if (!trimmed) return trimmed

  const addonConfig = JSON.stringify({
    scopes: ["im:message:send_as_bot"],
    events: ["im.message.receive_v1"],
    callbacks: ["card.action.trigger"],
  })
  const compressed = gzipSync(Buffer.from(addonConfig, "utf8"))
  const encodedAddon = compressed.toString("base64url")

  const parsed = new URL(trimmed)
  parsed.searchParams.set("from", "sdk")
  parsed.searchParams.set("tp", "sdk")
  parsed.searchParams.set("source", "go-sdk/al-ez-server")
  parsed.searchParams.set("addons", encodedAddon)
  return parsed.toString()
}

async function feishuPostForm(baseUrl: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/oauth/v1/app/registration`
  const body = new URLSearchParams(params).toString()
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  })
  const text = await resp.text()
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error(`Feishu registration endpoint returned HTTP ${resp.status}: ${text.slice(0, 200)}`)
  }
}

export async function feishuQrBegin(baseUrl = FEISHU_ACCOUNTS_BASE_URL): Promise<FeishuQrBeginResult> {
  const initResp = await feishuPostForm(baseUrl, { action: "init" })
  if (typeof initResp.error === "string" && initResp.error) {
    throw new Error(`Feishu init failed: ${initResp.error} (${String(initResp.error_description ?? "")})`)
  }

  const beginResp = await feishuPostForm(baseUrl, {
    action: "begin",
    archetype: "PersonalAgent",
    auth_method: "client_secret",
    request_user_info: "open_id",
  })
  if (typeof beginResp.error === "string" && beginResp.error) {
    throw new Error(`Feishu begin failed: ${beginResp.error} (${String(beginResp.error_description ?? "")})`)
  }

  const deviceCode = typeof beginResp.device_code === "string" ? beginResp.device_code : ""
  const verificationUrl =
    typeof beginResp.verification_uri_complete === "string" ? beginResp.verification_uri_complete : ""
  if (!deviceCode || !verificationUrl) {
    throw new Error("Feishu registration response missing device_code or verification_uri_complete")
  }

  const qrUrl = prepareFeishuRegistrationUrl(verificationUrl)
  const interval = typeof beginResp.interval === "number" && beginResp.interval > 0 ? beginResp.interval : 3
  const expireIn = typeof beginResp.expire_in === "number" && beginResp.expire_in > 0 ? beginResp.expire_in : 300

  return {
    deviceCode,
    qrUrl,
    verificationUrl,
    interval,
    expireIn,
    baseUrl,
  }
}

export async function fetchFeishuBotInfo(
  appId: string,
  appSecret: string,
  openBaseUrl = FEISHU_OPEN_BASE_URL,
): Promise<{ botName: string; botOpenId: string }> {
  const base = openBaseUrl.replace(/\/+$/, "")
  const tokenResp = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(10_000),
  })
  const tokenData = (await tokenResp.json()) as { code?: number; tenant_access_token?: string }
  if (tokenData.code !== 0 || !tokenData.tenant_access_token) {
    return { botName: "", botOpenId: "" }
  }

  const infoResp = await fetch(`${base}/open-apis/bot/v3/info/`, {
    method: "GET",
    headers: { Authorization: `Bearer ${tokenData.tenant_access_token}` },
    signal: AbortSignal.timeout(10_000),
  })
  const infoData = (await infoResp.json()) as {
    code?: number
    bot?: { app_name?: string; open_id?: string }
  }
  return {
    botName: infoData.bot?.app_name?.trim() ?? "",
    botOpenId: infoData.bot?.open_id?.trim() ?? "",
  }
}

export async function feishuQrPoll(
  deviceCode: string,
  currentBaseUrl = FEISHU_ACCOUNTS_BASE_URL,
): Promise<FeishuQrPollResult> {
  const resp = await feishuPostForm(currentBaseUrl, {
    action: "poll",
    device_code: deviceCode,
  })

  const userInfo = resp.user_info as { open_id?: string; tenant_brand?: string } | undefined
  const nextBaseUrl =
    userInfo?.tenant_brand === "lark" && currentBaseUrl !== LARK_ACCOUNTS_BASE_URL
      ? LARK_ACCOUNTS_BASE_URL
      : currentBaseUrl

  const clientId = typeof resp.client_id === "string" ? resp.client_id.trim() : ""
  const clientSecret = typeof resp.client_secret === "string" ? resp.client_secret.trim() : ""
  if (clientId && clientSecret) {
    const isLark = nextBaseUrl === LARK_ACCOUNTS_BASE_URL || userInfo?.tenant_brand === "lark"
    const domain = isLark ? LARK_OPEN_BASE_URL : FEISHU_OPEN_BASE_URL
    const botInfo = await fetchFeishuBotInfo(clientId, clientSecret, domain).catch(() => ({
      botName: "",
      botOpenId: "",
    }))
    return {
      status: "completed",
      baseUrl: nextBaseUrl,
      appId: clientId,
      appSecret: clientSecret,
      ownerOpenId: userInfo?.open_id?.trim() ?? "",
      botName: botInfo.botName || undefined,
      domain: isLark ? LARK_OPEN_BASE_URL : undefined,
    }
  }

  const errCode = typeof resp.error === "string" ? resp.error : ""
  if (errCode === "authorization_pending" || errCode === "slow_down" || !errCode) {
    return { status: "pending", baseUrl: nextBaseUrl }
  }
  if (errCode === "access_denied") {
    return {
      status: "denied",
      baseUrl: nextBaseUrl,
      message: typeof resp.error_description === "string" ? resp.error_description : "User denied authorization",
    }
  }
  return {
    status: "expired",
    baseUrl: nextBaseUrl,
    message: typeof resp.error_description === "string" ? resp.error_description : errCode,
  }
}

export async function weixinQrBegin(baseUrl = WEIXIN_DEFAULT_BASE_URL): Promise<WeixinQrBeginResult> {
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/ilink/bot/get_bot_qrcode?bot_type=3`
  const resp = await fetch(endpoint, {
    method: "GET",
    signal: AbortSignal.timeout(15_000),
  })
  const data = (await resp.json()) as {
    ret?: number
    errmsg?: string
    qrcode?: string
    qrcode_img_content?: string
  }
  if (data.ret && data.ret !== 0) {
    throw new Error(`Weixin get_bot_qrcode failed (ret=${data.ret}): ${data.errmsg ?? ""}`)
  }
  const qrcodeKey = data.qrcode?.trim() ?? ""
  const qrUrl = data.qrcode_img_content?.trim() || qrcodeKey
  if (!qrcodeKey) {
    throw new Error("Weixin get_bot_qrcode returned empty qrcode")
  }
  return { qrcodeKey, qrUrl }
}

export async function weixinQrPoll(
  qrcodeKey: string,
  baseUrl = WEIXIN_DEFAULT_BASE_URL,
): Promise<WeixinQrPollResult> {
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcodeKey)}`
  const resp = await fetch(endpoint, {
    method: "GET",
    headers: { "iLink-App-ClientVersion": "1" },
    signal: AbortSignal.timeout(15_000),
  })
  const data = (await resp.json()) as {
    ret?: number
    status?: string
    bot_token?: string
    ilink_bot_id?: string
    baseurl?: string
    ilink_user_id?: string
  }
  const status = (data.status ?? "wait").toLowerCase()
  if (status === "confirmed" && data.bot_token) {
    return {
      status: "completed",
      token: data.bot_token.trim(),
      botId: data.ilink_bot_id?.trim() ?? "",
      baseUrl: data.baseurl?.trim() || WEIXIN_DEFAULT_BASE_URL,
      userId: data.ilink_user_id?.trim() ?? "",
    }
  }
  if (status === "scaned" || status === "scanned") {
    return { status: "scanned" }
  }
  if (status === "expired") {
    return { status: "expired" }
  }
  return { status: "waiting" }
}
