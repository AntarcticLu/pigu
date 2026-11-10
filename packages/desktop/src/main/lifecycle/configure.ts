import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { enableCompileCache } from "node:module"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { app } from "electron"
import { debugBuild, memoryLogInterval } from "@opencode/gui-plugins/debug/options"
import { APP_ID, APP_NAME, CHANNEL } from "../constants"
import { remoteDebuggingPort } from "../diagnostics/options"

const testOnboarding = process.env.OPENCODE_TEST_ONBOARDING === "1"

const jsCallStackFeature = "DocumentPolicyIncludeJSCallStacksInCrashReports"

// Runs synchronously from the entry module, before Chromium is ready: command-line switches only
// take effect before ready, the single-instance lock is scoped to userData, and the early window
// needs userData to find the persisted window list and state.
export function configureApplication() {
  try {
    process.chdir(homedir())
  } catch {}

  process.env.OPENCODE_DISABLE_EMBEDDED_WEB_UI = "true"

  app.setName(APP_NAME)
  app.setAppUserModelId(APP_ID)
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")
  const features = app.commandLine.getSwitchValue("enable-features")
  app.commandLine.appendSwitch("enable-features", features ? `${jsCallStackFeature},${features}` : jsCallStackFeature)

  // Chromium animates each mouse-wheel notch on Linux; native Linux apps scroll by the full delta immediately.
  if (process.platform === "linux") app.commandLine.appendSwitch("disable-smooth-scrolling")

  const build = { packaged: app.isPackaged, channel: CHANNEL }
  const debugPort = remoteDebuggingPort(build, process.env.OPENCODE_DESKTOP_REMOTE_DEBUGGING_PORT)

  if (debugPort) app.commandLine.appendSwitch("remote-debugging-port", debugPort)

  if (app.commandLine.hasSwitch("remote-debugging-port"))
    app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1")

  // Precise heap sizes need a launch switch. The debug bar's toggle starts the log without one.
  if (debugBuild(build) && memoryLogInterval(process.env.OPENCODE_DESKTOP_MEMORY_LOG) !== undefined)
    app.commandLine.appendSwitch("enable-precise-memory-info")

  const testRoot = createTestRoot()
  app.setPath("userData", testRoot ? path.join(testRoot, "desktop") : path.join(app.getPath("appData"), APP_ID))

  if (testRoot) {
    app.setPath("sessionData", path.join(testRoot, "session"))

    if (testOnboarding) app.setPath("documents", path.join(testRoot, "documents"))
  }

  // V8 bytecode for the main bundle survives between launches, like the renderer's code cache.
  enableCompileCache(path.join(app.getPath("userData"), "compile-cache"))
  ensureWindowsSandboxAcl()
}

export function acquireApplicationLock() {
  if (app.requestSingleInstanceLock()) return true
  app.quit()

  return false
}

// Electron 44 aborts startup on Windows 11 (install_dir_access.cc) when the app is extracted to a
// drive or directory whose inherited ACL contains an AppContainer SID without ALL APPLICATION PACKAGES
// (*S-1-15-2-1). Granting read/execute on the install directory before ready lets the sandboxed child
// processes read the runtime files on any drive.
function ensureWindowsSandboxAcl() {
  if (process.platform !== "win32" || !app.isPackaged) return

  try {
    const installDir = path.dirname(process.execPath)
    const userData = app.getPath("userData")
    const markerPath = path.join(userData, "win-sandbox-acl.txt")
    const key = `${installDir}:${Math.floor(statSync(installDir).birthtimeMs)}`

    if (readMarker(markerPath) === key) return

    execFileSync(
      "icacls.exe",
      [installDir, "/grant", "*S-1-15-2-1:(OI)(CI)(RX)", "/grant", "*S-1-15-2-2:(OI)(CI)(RX)", "/Q"],
      { windowsHide: true, stdio: "ignore", timeout: 5000 },
    )
    mkdirSync(userData, { recursive: true })
    writeFileSync(markerPath, key, "utf8")
  } catch {}
}

function readMarker(filePath: string) {
  try {
    return readFileSync(filePath, "utf8")
  } catch {
    return ""
  }
}

function createTestRoot() {
  const root = testOnboarding
    ? path.join(tmpdir(), `opencode-onboarding-${randomUUID()}`)
    : process.env.OPENCODE_DESKTOP_TEST_ROOT

  if (!root) return undefined

  if (testOnboarding) rmSync(root, { recursive: true, force: true })

  for (const dir of ["data", "config", "cache", "state", "desktop", "session", "documents"])
    mkdirSync(path.join(root, dir), { recursive: true })

  if (testOnboarding) process.env.OPENCODE_DB = ":memory:"

  process.env.XDG_DATA_HOME = path.join(root, "data")
  process.env.XDG_CONFIG_HOME = path.join(root, "config")
  process.env.XDG_CACHE_HOME = path.join(root, "cache")
  process.env.XDG_STATE_HOME = path.join(root, "state")

  return root
}
