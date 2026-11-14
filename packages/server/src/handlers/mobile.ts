import { Mobile } from "@opencode/core/mobile"
import { InvalidRequestError } from "@opencode/protocol/errors"
import type {
  CreateRobotPayload,
  FeishuQrPollPayload,
  ImportRobotPayload,
  RemoteServerPayload,
  SimulateInboundPayload,
  TranscribeAudioPayload,
  UpdateMobileSettingsPayload,
  UpdateRobotPayload,
  WeixinQrPollPayload,
} from "@opencode/protocol/groups/mobile"
import { Effect } from "effect"
import { HttpApiSchema } from "effect/http-api"

const mapError = <A>(effect: Effect.Effect<A, unknown>) =>
  effect.pipe(
    Effect.catchDefect((defect) =>
      Effect.fail(
        new InvalidRequestError({
          message: defect instanceof Error ? defect.message : String(defect),
          kind: "mobile",
        }),
      ),
    ),
    Effect.mapError((err) =>
      err instanceof InvalidRequestError
        ? err
        : new InvalidRequestError({
            message: err instanceof Error ? err.message : String(err),
            kind: "mobile",
          }),
    ),
  )

/** `mobile.*` in the `server.experimental` group. */
export const makeMobile = Effect.gen(function* () {
  const mobile = yield* Mobile.Service

  return {
    settings: () => mobile.settings().pipe(Effect.map((data) => ({ data }))),

    updateSettings: (payload: UpdateMobileSettingsPayload) =>
      mobile
        .updateSettings(payload)
        .pipe(Effect.map((data) => ({ data })), mapError),

    list: () => mobile.list().pipe(Effect.map((data) => ({ data }))),

    create: (payload: CreateRobotPayload) =>
      mobile
        .create(payload)
        .pipe(Effect.map((data) => ({ data })), mapError),

    update: (robotID: string, payload: UpdateRobotPayload) =>
      mobile
        .update({ id: robotID, ...payload })
        .pipe(Effect.map((data) => ({ data })), mapError),

    remove: (robotID: string) =>
      mobile
        .remove(robotID)
        .pipe(Effect.as(HttpApiSchema.NoContent.make()), mapError),

    importCode: (payload: ImportRobotPayload) =>
      mobile
        .importCode(payload.code)
        .pipe(Effect.map((data) => ({ data })), mapError),

    feishuQrBegin: () =>
      Effect.tryPromise(() => Mobile.feishuQrBegin()).pipe(
        Effect.map((data) => ({ data })),
        mapError,
      ),

    feishuQrPoll: (payload: FeishuQrPollPayload) =>
      Effect.tryPromise(() => Mobile.feishuQrPoll(payload.deviceCode, payload.baseUrl)).pipe(
        Effect.map((data) => ({ data })),
        mapError,
      ),

    weixinQrBegin: () =>
      Effect.tryPromise(() => Mobile.weixinQrBegin()).pipe(
        Effect.map((data) => ({ data })),
        mapError,
      ),

    weixinQrPoll: (payload: WeixinQrPollPayload) =>
      Effect.tryPromise(() => Mobile.weixinQrPoll(payload.qrcodeKey)).pipe(
        Effect.map((data) => ({ data })),
        mapError,
      ),

    syncRemotes: (payload: RemoteServerPayload) =>
      mobile
        .syncRemotes(payload.remotes)
        .pipe(Effect.as(HttpApiSchema.NoContent.make())),

    transcribe: (payload: TranscribeAudioPayload) =>
      mobile
        .transcribeAudio(payload)
        .pipe(Effect.map((data) => ({ data })), mapError),

    simulate: (payload: SimulateInboundPayload) =>
      mobile
        .simulateInbound({
          robotId: payload.robotId,
          userId: payload.userId,
          userName: payload.userName,
          chatId: payload.chatId,
          text: payload.text,
          progressDelayMs: payload.progressDelayMs,
          pushLive: payload.pushLive,
          audioAttachments: payload.audioBase64
            ? [
                {
                  data: new Uint8Array(Buffer.from(payload.audioBase64, "base64")),
                  mimeType: payload.audioMimeType || "audio/wav",
                  fileName: payload.audioFileName || "voice.wav",
                },
              ]
            : undefined,
          fileAttachments: payload.fileBase64
            ? [
                {
                  data: new Uint8Array(Buffer.from(payload.fileBase64, "base64")),
                  mimeType: payload.fileMimeType || "application/octet-stream",
                  fileName: payload.fileName || "attachment.bin",
                },
              ]
            : undefined,
        })
        .pipe(
          Effect.map((res) => ({
            data: {
              cardTitles: res.cards.map((c) => c.header?.title ?? ""),
              cardMarkdowns: res.cards.map((c) => Mobile.renderCardMarkdownFallback(c)),
              texts: [...res.texts],
              files: [...res.files],
              progressUpdates: [...res.progressUpdates],
            },
          })),
          mapError,
        ),
  }
})
