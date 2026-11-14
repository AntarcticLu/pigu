import { createHash } from "node:crypto"

export const UNIVERSAL_ROBOT_MIGRATION_PREFIX = "AL-ROBOT-1"
export const FEISHU_MIGRATION_PREFIX = "AL-FEISHU-1"

export type MobilePlatformType = "feishu" | "lark" | "weixin" | "dingtalk" | "wecom" | "qqbot"

export interface FeishuMigrationCredentials {
  readonly app_id: string
  readonly app_secret: string
  readonly domain?: string
}

export interface WeixinMigrationCredentials {
  readonly token: string
  readonly base_url?: string
  readonly account_id?: string
}

export interface DingTalkMigrationCredentials {
  readonly client_id: string
  readonly client_secret: string
}

export interface WeComMigrationCredentials {
  readonly mode: string
  readonly bot_id?: string
  readonly bot_secret?: string
  readonly corp_id?: string
  readonly agent_id?: string
  readonly secret?: string
  readonly token?: string
  readonly encoding_aes_key?: string
}

export interface QQBotMigrationCredentials {
  readonly app_id: string
  readonly app_secret: string
  readonly sandbox?: boolean
}

export interface UniversalRobotMigrationPayload {
  readonly v: number
  readonly kind: string
  readonly platform: MobilePlatformType
  readonly name?: string
  readonly work_dir?: string
  readonly owner_id?: string
  readonly allow_from?: string
  readonly admin_from?: string
  readonly feishu?: FeishuMigrationCredentials
  readonly weixin?: WeixinMigrationCredentials
  readonly dingtalk?: DingTalkMigrationCredentials
  readonly wecom?: WeComMigrationCredentials
  readonly qqbot?: QQBotMigrationCredentials
}

export interface MobileRobotConfig {
  readonly id: string
  readonly name: string
  readonly platform: MobilePlatformType
  readonly enabled: boolean
  readonly ownerID: string
  readonly allowFrom: string
  readonly adminFrom?: string
  readonly userNames?: Record<string, string>
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
  readonly createdAt: number
  readonly updatedAt: number
}

function normalizePlatform(raw: string): MobilePlatformType {
  const value = raw.trim().toLowerCase()
  if (value === "lark") return "lark"
  if (value === "feishu") return "feishu"
  if (value === "weixin" || value === "wechat" || value === "ilink") return "weixin"
  if (value === "dingtalk") return "dingtalk"
  if (value === "wecom" || value === "wework") return "wecom"
  if (value === "qqbot" || value === "qq") return "qqbot"
  throw new Error(`Unsupported robot platform: ${raw}`)
}

export function normalizeAllowFromWithOwner(ownerID: string, allowFrom: string): string {
  const owner = ownerID.trim()
  const raw = allowFrom.trim()
  if (raw === "*") return "*"

  const seen = new Set<string>()
  const out: string[] = []
  const add = (id: string) => {
    const clean = id.trim()
    if (!clean || clean === "*") return
    const key = clean.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push(clean)
  }

  if (owner) add(owner)
  for (const part of raw.split(",")) {
    add(part)
  }
  return out.join(",")
}

export function buildMigrationPayloadFromRobot(robot: MobileRobotConfig): UniversalRobotMigrationPayload {
  const platform = normalizePlatform(robot.platform)
  const owner = robot.ownerID.trim()
  const allowFrom = normalizeAllowFromWithOwner(owner, robot.allowFrom)
  const base = {
    v: 1,
    kind: "universal_robot",
    platform,
    ...(robot.name.trim() ? { name: robot.name.trim() } : {}),
    ...(owner ? { owner_id: owner } : {}),
    ...(allowFrom ? { allow_from: allowFrom } : {}),
    ...(robot.adminFrom?.trim() ? { admin_from: robot.adminFrom.trim() } : {}),
  }

  if (platform === "feishu" || platform === "lark") {
    const appId = robot.feishu?.appId.trim() ?? ""
    const appSecret = robot.feishu?.appSecret.trim() ?? ""
    if (!appId || !appSecret) throw new Error("Feishu migration requires appId and appSecret")
    return {
      ...base,
      feishu: {
        app_id: appId,
        app_secret: appSecret,
        ...(robot.feishu?.domain?.trim() ? { domain: robot.feishu.domain.trim() } : {}),
      },
    }
  }

  if (platform === "weixin") {
    const token = robot.weixin?.token.trim() ?? ""
    if (!token) throw new Error("Weixin migration requires token")
    return {
      ...base,
      weixin: {
        token,
        ...(robot.weixin?.baseUrl?.trim() ? { base_url: robot.weixin.baseUrl.trim() } : {}),
        ...(robot.weixin?.accountId?.trim() ? { account_id: robot.weixin.accountId.trim() } : {}),
      },
    }
  }

  if (platform === "dingtalk") {
    const clientId = robot.dingtalk?.clientId.trim() ?? ""
    const clientSecret = robot.dingtalk?.clientSecret.trim() ?? ""
    if (!clientId || !clientSecret) throw new Error("DingTalk migration requires clientId and clientSecret")
    return {
      ...base,
      dingtalk: {
        client_id: clientId,
        client_secret: clientSecret,
      },
    }
  }

  if (platform === "wecom") {
    const botId = robot.wecom?.botId.trim() ?? ""
    const secret = robot.wecom?.secret.trim() ?? ""
    if (!botId || !secret) throw new Error("WeCom migration requires botId and secret")
    return {
      ...base,
      wecom: {
        mode: "websocket",
        bot_id: botId,
        bot_secret: secret,
      },
    }
  }

  const appId = robot.qqbot?.appId.trim() ?? ""
  const appSecret = robot.qqbot?.appSecret.trim() ?? ""
  if (!appId || !appSecret) throw new Error("QQBot migration requires appId and appSecret")
  return {
    ...base,
    qqbot: {
      app_id: appId,
      app_secret: appSecret,
      ...(robot.qqbot?.sandbox ? { sandbox: true } : {}),
    },
  }
}

export function encodeUniversalRobotMigrationCode(payload: UniversalRobotMigrationPayload): string {
  const json = JSON.stringify(payload)
  const b64 = Buffer.from(json, "utf8").toString("base64url")
  const sum = createHash("sha256")
    .update(`${UNIVERSAL_ROBOT_MIGRATION_PREFIX}.${b64}`)
    .digest("hex")
    .slice(0, 8)
  return `${UNIVERSAL_ROBOT_MIGRATION_PREFIX}.${b64}.${sum}`
}

export function encodeRobotMigrationCode(robot: MobileRobotConfig): string {
  return encodeUniversalRobotMigrationCode(buildMigrationPayloadFromRobot(robot))
}

export function shortMigrationCode(code: string): string {
  const trimmed = code.trim()
  if (trimmed.length <= 28) return trimmed
  return `${trimmed.slice(0, 16)}...${trimmed.slice(-10)}`
}

export function decodeUniversalRobotMigrationCode(raw: string): UniversalRobotMigrationPayload {
  const cleaned = raw.trim().replaceAll(/\s+/g, "")
  if (!cleaned) throw new Error("Migration code is empty")

  if (cleaned.startsWith(`${FEISHU_MIGRATION_PREFIX}.`)) {
    return decodeLegacyFeishuMigrationCode(cleaned)
  }

  const parts = cleaned.split(".")
  if (parts.length !== 3 || parts[0] !== UNIVERSAL_ROBOT_MIGRATION_PREFIX) {
    throw new Error(`Invalid migration code format (expected ${UNIVERSAL_ROBOT_MIGRATION_PREFIX}.<payload>.<checksum>)`)
  }

  const b64 = parts[1] ?? ""
  const gotSum = (parts[2] ?? "").toLowerCase()
  const wantSum = createHash("sha256")
    .update(`${UNIVERSAL_ROBOT_MIGRATION_PREFIX}.${b64}`)
    .digest("hex")
    .slice(0, 8)

  if (gotSum !== wantSum) {
    throw new Error("Migration code checksum mismatch (string may be truncated or modified)")
  }

  const rawJson = Buffer.from(b64, "base64url").toString("utf8")
  const parsed = JSON.parse(rawJson) as Record<string, unknown>
  const platform = normalizePlatform(typeof parsed.platform === "string" ? parsed.platform : "")
  const ownerId = typeof parsed.owner_id === "string" ? parsed.owner_id.trim() : ""
  const rawAllowFrom = typeof parsed.allow_from === "string" ? parsed.allow_from.trim() : ""
  const allowFrom = normalizeAllowFromWithOwner(ownerId, rawAllowFrom)

  return {
    v: typeof parsed.v === "number" ? parsed.v : 1,
    kind: "universal_robot",
    platform,
    name: typeof parsed.name === "string" ? parsed.name.trim() : undefined,
    work_dir: typeof parsed.work_dir === "string" ? parsed.work_dir.trim() : undefined,
    owner_id: ownerId || undefined,
    allow_from: allowFrom || undefined,
    admin_from: typeof parsed.admin_from === "string" ? parsed.admin_from.trim() : undefined,
    feishu: parsed.feishu as FeishuMigrationCredentials | undefined,
    weixin: parsed.weixin as WeixinMigrationCredentials | undefined,
    dingtalk: parsed.dingtalk as DingTalkMigrationCredentials | undefined,
    wecom: parsed.wecom as WeComMigrationCredentials | undefined,
    qqbot: parsed.qqbot as QQBotMigrationCredentials | undefined,
  }
}

function decodeLegacyFeishuMigrationCode(cleaned: string): UniversalRobotMigrationPayload {
  const parts = cleaned.split(".")
  if (parts.length !== 3 || parts[0] !== FEISHU_MIGRATION_PREFIX) {
    throw new Error(`Invalid Feishu migration code format`)
  }
  const b64 = parts[1] ?? ""
  const gotSum = (parts[2] ?? "").toLowerCase()
  const wantSum = createHash("sha256")
    .update(`${FEISHU_MIGRATION_PREFIX}.${b64}`)
    .digest("hex")
    .slice(0, 8)
  if (gotSum !== wantSum) {
    throw new Error("Feishu migration code checksum mismatch")
  }
  const parsed = JSON.parse(Buffer.from(b64, "base64url").toString("utf8")) as Record<string, unknown>
  const appId = typeof parsed.app_id === "string" ? parsed.app_id.trim() : ""
  const appSecret = typeof parsed.app_secret === "string" ? parsed.app_secret.trim() : ""
  if (!appId || !appSecret) throw new Error("Legacy Feishu migration code missing app_id or app_secret")
  const ownerId = typeof parsed.owner_id === "string" ? parsed.owner_id.trim() : ""
  const allowFrom = normalizeAllowFromWithOwner(
    ownerId,
    typeof parsed.allow_from === "string" ? parsed.allow_from.trim() : "",
  )
  const platform = parsed.platform === "lark" ? "lark" : "feishu"
  return {
    v: 1,
    kind: "universal_robot",
    platform,
    name: typeof parsed.name === "string" ? parsed.name.trim() : undefined,
    owner_id: ownerId || undefined,
    allow_from: allowFrom || undefined,
    admin_from: typeof parsed.admin_from === "string" ? parsed.admin_from.trim() : undefined,
    feishu: {
      app_id: appId,
      app_secret: appSecret,
      domain: typeof parsed.domain === "string" ? parsed.domain.trim() : undefined,
    },
  }
}
