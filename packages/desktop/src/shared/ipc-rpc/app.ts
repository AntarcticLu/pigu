import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

const ServerReadyData = Schema.Struct({
  url: Schema.String,
})

export const AppAwaitInitialization = Rpc.make("AppAwaitInitialization", { success: ServerReadyData })

export const AppReconnectService = Rpc.make("AppReconnectService", { success: ServerReadyData })

// The renderer listens for DeepLinksOpened before it reports ready, and acknowledges each delivery once handled.
export const AppReadyDeepLinks = Rpc.make("AppReadyDeepLinks")

export const AppAcknowledgeDeepLinks = Rpc.make("AppAcknowledgeDeepLinks", {
  payload: { attempt: Schema.Number },
})

export const AppIsFirstLaunchOnboardingPending = Rpc.make("AppIsFirstLaunchOnboardingPending", {
  success: Schema.Boolean,
})

export const AppFinishFirstLaunchOnboarding = Rpc.make("AppFinishFirstLaunchOnboarding", {
  payload: { createDefaultProject: Schema.Boolean },
  success: Schema.NullOr(Schema.String),
})

export const AppCheckAppExists = Rpc.make("AppCheckAppExists", {
  payload: { appName: Schema.String },
  success: Schema.Boolean,
})

export const AppResolveAppPath = Rpc.make("AppResolveAppPath", {
  payload: { appName: Schema.String },
  success: Schema.NullOr(Schema.String),
})

export const AppSetBackgroundColor = Rpc.make("AppSetBackgroundColor", {
  payload: { color: Schema.String },
})

export const AppExportDebugLogs = Rpc.make("AppExportDebugLogs", { success: Schema.String })

export const AppSetForceFocus = Rpc.make("AppSetForceFocus", {
  payload: { enabled: Schema.Boolean },
})

export const AppRecordFatalRendererError = Rpc.make("AppRecordFatalRendererError", {
  payload: {
    error: Schema.Struct({
      error: Schema.String,
      url: Schema.String,
      version: Schema.optionalKey(Schema.String),
      platform: Schema.String,
      os: Schema.optionalKey(Schema.String),
    }),
  },
})

export const AppGetSpellcheckEnabled = Rpc.make("AppGetSpellcheckEnabled", { success: Schema.Boolean })

export const AppSetSpellcheckEnabled = Rpc.make("AppSetSpellcheckEnabled", {
  payload: { enabled: Schema.Boolean },
})

export const SelfUpdateStatusSchema = Schema.Literals([
  "idle",
  "checking",
  "offline",
  "up-to-date",
  "available",
  "downloading",
  "installing",
  "microsoft-store",
  "error",
])

export const SelfUpdateStateSchema = Schema.Struct({
  status: SelfUpdateStatusSchema,
  currentVersion: Schema.String,
  latestVersion: Schema.optionalKey(Schema.String),
  assetName: Schema.optionalKey(Schema.String),
  totalBytes: Schema.optionalKey(Schema.Number),
  downloadedBytes: Schema.optionalKey(Schema.Number),
  percent: Schema.optionalKey(Schema.Number),
  message: Schema.optionalKey(Schema.String),
})

export const AppGetSelfUpdateState = Rpc.make("AppGetSelfUpdateState", {
  success: SelfUpdateStateSchema,
})

export const AppCheckSelfUpdate = Rpc.make("AppCheckSelfUpdate", {
  success: SelfUpdateStateSchema,
})

export const AppInstallSelfUpdate = Rpc.make("AppInstallSelfUpdate", {
  success: SelfUpdateStateSchema,
})

export const AppSetPreventSleep = Rpc.make("AppSetPreventSleep", {
  payload: { enabled: Schema.Boolean },
  success: Schema.Boolean,
})

export const AppSetNativeTranslations = Rpc.make("AppSetNativeTranslations", {
  payload: { value: Schema.Unknown },
})

export const AppRelaunch = Rpc.make("AppRelaunch")

export const AppRpcs = RpcGroup.make(
  AppAwaitInitialization,
  AppReconnectService,
  AppReadyDeepLinks,
  AppAcknowledgeDeepLinks,
  AppIsFirstLaunchOnboardingPending,
  AppFinishFirstLaunchOnboarding,
  AppCheckAppExists,
  AppResolveAppPath,
  AppSetBackgroundColor,
  AppExportDebugLogs,
  AppSetForceFocus,
  AppGetSpellcheckEnabled,
  AppSetSpellcheckEnabled,
  AppSetPreventSleep,
  AppGetSelfUpdateState,
  AppCheckSelfUpdate,
  AppInstallSelfUpdate,
  AppRecordFatalRendererError,
  AppSetNativeTranslations,
  AppRelaunch,
)
