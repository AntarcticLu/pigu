import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiSchema, OpenApi } from "effect/http-api"
import { InvalidRequestError } from "../errors.js"

const EXPERIMENTAL = "Experimental: may change without compatibility guarantees."

const annotations = (identifier: string, summary: string, description: string) =>
  OpenApi.annotations({
    identifier: `experimental.mobile.${identifier}`,
    summary,
    description: `${description} ${EXPERIMENTAL}`,
    transform: (operation) => ({ ...operation, tags: ["experimental"] }),
  })

export const MobilePlatformType = Schema.Literals(["feishu", "lark", "weixin", "dingtalk", "wecom", "qqbot"]).annotate({
  identifier: "Mobile.PlatformType",
})

export const FeishuCredentials = Schema.Struct({
  appId: Schema.String,
  appSecret: Schema.String,
  domain: Schema.optional(Schema.String),
}).annotate({ identifier: "Mobile.FeishuCredentials" })

export const WeixinCredentials = Schema.Struct({
  token: Schema.String,
  baseUrl: Schema.optional(Schema.String),
  accountId: Schema.optional(Schema.String),
}).annotate({ identifier: "Mobile.WeixinCredentials" })

export const DingTalkCredentials = Schema.Struct({
  clientId: Schema.String,
  clientSecret: Schema.String,
}).annotate({ identifier: "Mobile.DingTalkCredentials" })

export const WeComCredentials = Schema.Struct({
  botId: Schema.String,
  secret: Schema.String,
}).annotate({ identifier: "Mobile.WeComCredentials" })

export const QQBotCredentials = Schema.Struct({
  appId: Schema.String,
  appSecret: Schema.String,
  sandbox: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "Mobile.QQBotCredentials" })

export const MobileRobotStatus = Schema.Struct({
  state: Schema.Literals(["connected", "connecting", "error", "stopped"]),
  error: Schema.optional(Schema.String),
}).annotate({ identifier: "Mobile.RobotStatus" })

export const MobileRobotView = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  platform: MobilePlatformType,
  enabled: Schema.Boolean,
  ownerID: Schema.String,
  allowFrom: Schema.String,
  adminFrom: Schema.optional(Schema.String),
  userNames: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  feishu: Schema.optional(FeishuCredentials),
  weixin: Schema.optional(WeixinCredentials),
  dingtalk: Schema.optional(DingTalkCredentials),
  wecom: Schema.optional(WeComCredentials),
  qqbot: Schema.optional(QQBotCredentials),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  status: MobileRobotStatus,
  migrationCode: Schema.String,
  shortCode: Schema.String,
}).annotate({ identifier: "Mobile.RobotView" })

export const CreateRobotPayload = Schema.Struct({
  name: Schema.String,
  platform: MobilePlatformType,
  enabled: Schema.optional(Schema.Boolean),
  ownerID: Schema.optional(Schema.String),
  allowFrom: Schema.optional(Schema.String),
  adminFrom: Schema.optional(Schema.String),
  feishu: Schema.optional(FeishuCredentials),
  weixin: Schema.optional(WeixinCredentials),
  dingtalk: Schema.optional(DingTalkCredentials),
  wecom: Schema.optional(WeComCredentials),
  qqbot: Schema.optional(QQBotCredentials),
}).annotate({ identifier: "Mobile.CreateRobotPayload" })
export type CreateRobotPayload = typeof CreateRobotPayload.Type

export const UpdateRobotPayload = Schema.Struct({
  name: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
  ownerID: Schema.optional(Schema.String),
  allowFrom: Schema.optional(Schema.String),
  adminFrom: Schema.optional(Schema.String),
  feishu: Schema.optional(FeishuCredentials),
  weixin: Schema.optional(WeixinCredentials),
  dingtalk: Schema.optional(DingTalkCredentials),
  wecom: Schema.optional(WeComCredentials),
  qqbot: Schema.optional(QQBotCredentials),
}).annotate({ identifier: "Mobile.UpdateRobotPayload" })
export type UpdateRobotPayload = typeof UpdateRobotPayload.Type

export const ImportRobotPayload = Schema.Struct({
  code: Schema.String,
}).annotate({ identifier: "Mobile.ImportRobotPayload" })
export type ImportRobotPayload = typeof ImportRobotPayload.Type

export const FeishuQrBeginResponse = Schema.Struct({
  deviceCode: Schema.String,
  qrUrl: Schema.String,
  verificationUrl: Schema.String,
  interval: Schema.Number,
  expireIn: Schema.Number,
  baseUrl: Schema.String,
}).annotate({ identifier: "Mobile.FeishuQrBeginResponse" })

export const FeishuQrPollPayload = Schema.Struct({
  deviceCode: Schema.String,
  baseUrl: Schema.optional(Schema.String),
}).annotate({ identifier: "Mobile.FeishuQrPollPayload" })
export type FeishuQrPollPayload = typeof FeishuQrPollPayload.Type

export const FeishuQrPollResponse = Schema.Struct({
  status: Schema.Literals(["pending", "completed", "expired", "denied"]),
  baseUrl: Schema.String,
  appId: Schema.optional(Schema.String),
  appSecret: Schema.optional(Schema.String),
  ownerOpenId: Schema.optional(Schema.String),
  botName: Schema.optional(Schema.String),
  domain: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
}).annotate({ identifier: "Mobile.FeishuQrPollResponse" })

export const WeixinQrBeginResponse = Schema.Struct({
  qrcodeKey: Schema.String,
  qrUrl: Schema.String,
}).annotate({ identifier: "Mobile.WeixinQrBeginResponse" })

export const WeixinQrPollPayload = Schema.Struct({
  qrcodeKey: Schema.String,
}).annotate({ identifier: "Mobile.WeixinQrPollPayload" })
export type WeixinQrPollPayload = typeof WeixinQrPollPayload.Type

export const WeixinQrPollResponse = Schema.Struct({
  status: Schema.Literals(["waiting", "scanned", "completed", "expired"]),
  token: Schema.optional(Schema.String),
  botId: Schema.optional(Schema.String),
  baseUrl: Schema.optional(Schema.String),
  userId: Schema.optional(Schema.String),
}).annotate({ identifier: "Mobile.WeixinQrPollResponse" })

export const RemoteServerPayload = Schema.Struct({
  remotes: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      name: Schema.String,
      url: Schema.String,
      password: Schema.optional(Schema.String),
    }),
  ),
}).annotate({ identifier: "Mobile.RemoteServerPayload" })
export type RemoteServerPayload = typeof RemoteServerPayload.Type

export const TranscribeAudioPayload = Schema.Struct({
  audioBase64: Schema.String,
  mimeType: Schema.String,
  fileName: Schema.optional(Schema.String),
}).annotate({ identifier: "Mobile.TranscribeAudioPayload" })
export type TranscribeAudioPayload = typeof TranscribeAudioPayload.Type

export const TranscribeAudioResponse = Schema.Struct({
  text: Schema.String,
}).annotate({ identifier: "Mobile.TranscribeAudioResponse" })

export const SimulateInboundPayload = Schema.Struct({
  robotId: Schema.String,
  userId: Schema.String,
  userName: Schema.optional(Schema.String),
  chatId: Schema.optional(Schema.String),
  text: Schema.String,
  audioBase64: Schema.optional(Schema.String),
  audioMimeType: Schema.optional(Schema.String),
  audioFileName: Schema.optional(Schema.String),
  fileBase64: Schema.optional(Schema.String),
  fileMimeType: Schema.optional(Schema.String),
  fileName: Schema.optional(Schema.String),
  progressDelayMs: Schema.optional(Schema.Number),
  pushLive: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "Mobile.SimulateInboundPayload" })
export type SimulateInboundPayload = typeof SimulateInboundPayload.Type

export const SimulateInboundResponse = Schema.Struct({
  cardTitles: Schema.Array(Schema.String),
  cardMarkdowns: Schema.Array(Schema.String),
  texts: Schema.Array(Schema.String),
  files: Schema.Array(
    Schema.Struct({
      fileName: Schema.String,
      mimeType: Schema.String,
      size: Schema.Number,
    }),
  ),
  progressUpdates: Schema.Array(Schema.String),
}).annotate({ identifier: "Mobile.SimulateInboundResponse" })

export const MobileSettings = Schema.Struct({
  preventSleep: Schema.Boolean,
  active: Schema.Boolean,
}).annotate({ identifier: "Mobile.Settings" })

export const UpdateMobileSettingsPayload = Schema.Struct({
  preventSleep: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "Mobile.UpdateSettingsPayload" })
export type UpdateMobileSettingsPayload = typeof UpdateMobileSettingsPayload.Type

export const MobileEndpoints = [
  HttpApiEndpoint.get("mobile.settings", "/api/experimental/mobile/settings", {
    success: Schema.Struct({ data: MobileSettings }),
  }).annotateMerge(
    annotations(
      "settings",
      "Get mobile settings",
      "Get global mobile remote-work settings and active sleep-prevention state.",
    ),
  ),

  HttpApiEndpoint.patch("mobile.updateSettings", "/api/experimental/mobile/settings", {
    payload: UpdateMobileSettingsPayload,
    success: Schema.Struct({ data: MobileSettings }),
    error: [InvalidRequestError],
  }).annotateMerge(
    annotations(
      "updateSettings",
      "Update mobile settings",
      "Update global mobile remote-work settings such as sleep prevention.",
    ),
  ),

  HttpApiEndpoint.get("mobile.list", "/api/experimental/mobile/robots", {
    success: Schema.Struct({ data: Schema.Array(MobileRobotView) }),
  }).annotateMerge(annotations("list", "List mobile robots", "List configured mobile IM robots and their status.")),

  HttpApiEndpoint.post("mobile.create", "/api/experimental/mobile/robots", {
    payload: CreateRobotPayload,
    success: Schema.Struct({ data: MobileRobotView }),
    error: [InvalidRequestError],
  }).annotateMerge(annotations("create", "Create mobile robot", "Add and start a new mobile IM robot.")),

  HttpApiEndpoint.patch("mobile.update", "/api/experimental/mobile/robots/:robotID", {
    params: { robotID: Schema.String },
    payload: UpdateRobotPayload,
    success: Schema.Struct({ data: MobileRobotView }),
    error: [InvalidRequestError],
  }).annotateMerge(annotations("update", "Update mobile robot", "Update a mobile IM robot configuration.")),

  HttpApiEndpoint.delete("mobile.delete", "/api/experimental/mobile/robots/:robotID", {
    params: { robotID: Schema.String },
    success: HttpApiSchema.NoContent,
    error: [InvalidRequestError],
  }).annotateMerge(annotations("delete", "Delete mobile robot", "Stop and remove a mobile IM robot.")),

  HttpApiEndpoint.post("mobile.importCode", "/api/experimental/mobile/import", {
    payload: ImportRobotPayload,
    success: Schema.Struct({ data: MobileRobotView }),
    error: [InvalidRequestError],
  }).annotateMerge(
    annotations("importCode", "Import robot migration code", "Import a robot from an AL-ROBOT-1 migration string."),
  ),

  HttpApiEndpoint.post("mobile.feishuQrBegin", "/api/experimental/mobile/qr/feishu/begin", {
    success: Schema.Struct({ data: FeishuQrBeginResponse }),
    error: [InvalidRequestError],
  }).annotateMerge(
    annotations("feishuQrBegin", "Begin Feishu QR registration", "Start one-click Feishu bot QR code registration."),
  ),

  HttpApiEndpoint.post("mobile.feishuQrPoll", "/api/experimental/mobile/qr/feishu/poll", {
    payload: FeishuQrPollPayload,
    success: Schema.Struct({ data: FeishuQrPollResponse }),
    error: [InvalidRequestError],
  }).annotateMerge(
    annotations("feishuQrPoll", "Poll Feishu QR registration", "Poll one-click Feishu bot QR code registration status."),
  ),

  HttpApiEndpoint.post("mobile.weixinQrBegin", "/api/experimental/mobile/qr/weixin/begin", {
    success: Schema.Struct({ data: WeixinQrBeginResponse }),
    error: [InvalidRequestError],
  }).annotateMerge(annotations("weixinQrBegin", "Begin Weixin QR login", "Start Weixin iLink bot QR code login.")),

  HttpApiEndpoint.post("mobile.weixinQrPoll", "/api/experimental/mobile/qr/weixin/poll", {
    payload: WeixinQrPollPayload,
    success: Schema.Struct({ data: WeixinQrPollResponse }),
    error: [InvalidRequestError],
  }).annotateMerge(annotations("weixinQrPoll", "Poll Weixin QR login", "Poll Weixin iLink bot QR code login status.")),

  HttpApiEndpoint.post("mobile.syncRemotes", "/api/experimental/mobile/remotes", {
    payload: RemoteServerPayload,
    success: HttpApiSchema.NoContent,
  }).annotateMerge(
    annotations("syncRemotes", "Sync remote SSH servers", "Sync active SSH remote server endpoints for mobile control."),
  ),

  HttpApiEndpoint.post("mobile.transcribe", "/api/experimental/mobile/transcribe", {
    payload: TranscribeAudioPayload,
    success: Schema.Struct({ data: TranscribeAudioResponse }),
    error: [InvalidRequestError],
  }).annotateMerge(
    annotations("transcribe", "Transcribe audio input", "Transcribe voice audio using configured multimodal models."),
  ),

  HttpApiEndpoint.post("mobile.simulate", "/api/experimental/mobile/simulate", {
    payload: SimulateInboundPayload,
    success: Schema.Struct({ data: SimulateInboundResponse }),
    error: [InvalidRequestError],
  }).annotateMerge(
    annotations("simulate", "Simulate mobile inbound message", "Simulate an inbound mobile IM message."),
  ),
] as const
