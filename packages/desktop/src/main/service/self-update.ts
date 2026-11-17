import { execFile, spawn } from "node:child_process"
import { createWriteStream } from "node:fs"
import http from "node:http"
import { chmod, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { app, BrowserWindow, shell } from "electron"
import { VERSION } from "../constants"
import { emitIpcEvent } from "../ipc-events"
import type { SelfUpdateState } from "../../shared/ipc-contract"
import { SelfUpdateChanged } from "../../shared/ipc-rpc/events"
import {
  parseMacScutilProxy,
  parseTotalBytes,
  parseWindowsRegProxy,
  probeGitHubRelease,
  resolveMacAppBundlePath,
  resolveReleaseAssetName,
} from "./self-update-probe"

const execFileAsync = promisify(execFile)

const REPO_BASE = "https://github.com/AntarcticLu/pigu"

const MICROSOFT_STORE_URL = "ms-windows-store://pdp/?ProductId=9P8R26Z8HTK4"

const MIN_ARCHIVE_BYTES = 5 * 1024 * 1024

const setGlobalProxy = (http as { setGlobalProxyFromEnv?: (env?: Record<string, string>) => void })
  .setGlobalProxyFromEnv

function currentCleanVersion() {
  return VERSION.replace(/^v/i, "")
}

function isMicrosoftStoreBuild() {
  return Boolean(process.windowsStore)
}

let currentState: SelfUpdateState = {
  status: isMicrosoftStoreBuild() ? "microsoft-store" : "idle",
  currentVersion: currentCleanVersion(),
}

let activeRawTag: string | undefined

function updateState(next: SelfUpdateState): SelfUpdateState {
  currentState = next
  const event = new SelfUpdateChanged({ state: next })
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      emitIpcEvent(win.webContents, event)
    }
  })

  return next
}

async function detectSystemHttpProxy(): Promise<string | undefined> {
  const fromEnv =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    undefined

  if (fromEnv && /^https?:\/\//i.test(fromEnv.trim())) {
    return fromEnv.trim()
  }

  if (process.platform === "darwin") {
    const out = await execFileAsync("/usr/sbin/scutil", ["--proxy"], { timeout: 2_000 })
      .then((res) => res.stdout)
      .catch(() => "")

    return parseMacScutilProxy(out)
  }

  if (process.platform === "win32") {
    const out = await execFileAsync(
      "reg.exe",
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"],
      { windowsHide: true, timeout: 2_000 },
    )
      .then((res) => res.stdout)
      .catch(() => "")

    return parseWindowsRegProxy(out)
  }

  return undefined
}

function applyNodeFetchProxy(proxyUrl: string | undefined) {
  if (!setGlobalProxy) return

  if (!proxyUrl) {
    setGlobalProxy({})

    return
  }

  setGlobalProxy({
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    NO_PROXY: "127.0.0.1,localhost,::1",
  })
}

export function getSelfUpdateState(): SelfUpdateState {
  if (isMicrosoftStoreBuild()) {
    return { status: "microsoft-store", currentVersion: currentCleanVersion() }
  }

  return currentState
}

export async function checkSelfUpdate(): Promise<SelfUpdateState> {
  if (isMicrosoftStoreBuild()) {
    return updateState({ status: "microsoft-store", currentVersion: currentCleanVersion() })
  }

  if (currentState.status === "downloading" || currentState.status === "installing") {
    return currentState
  }

  const version = currentCleanVersion()
  const assetName = resolveReleaseAssetName(process.platform, process.arch)
  updateState({
    status: "checking",
    currentVersion: version,
    assetName,
  })

  const proxyUrl = await detectSystemHttpProxy()
  applyNodeFetchProxy(proxyUrl)

  const first = await probeGitHubRelease({
    repoBase: REPO_BASE,
    currentVersion: version,
    assetName,
    fetchImpl: (url, init) => fetch(url, init),
  })

  // If a stale system proxy failed, retry once directly (e.g. TUN mode or direct network) before reporting offline.
  const probed = await (async () => {
    if (first.state.status !== "offline" || !proxyUrl) return first
    applyNodeFetchProxy(undefined)

    return probeGitHubRelease({
      repoBase: REPO_BASE,
      currentVersion: version,
      assetName,
      fetchImpl: (url, init) => fetch(url, init),
    })
  })()

  activeRawTag = probed.rawTag

  return updateState(probed.state)
}

export async function installSelfUpdate(onLinuxRelaunch?: () => void): Promise<SelfUpdateState> {
  if (isMicrosoftStoreBuild()) {
    await shell.openExternal(MICROSOFT_STORE_URL).catch(() => undefined)

    return updateState({ status: "microsoft-store", currentVersion: currentCleanVersion() })
  }

  if (currentState.status === "downloading" || currentState.status === "installing") {
    return currentState
  }

  if (currentState.status !== "available" || !currentState.latestVersion || !currentState.assetName) {
    const checked = await checkSelfUpdate()

    if (checked.status !== "available" || !checked.latestVersion || !checked.assetName) {
      return checked
    }
  }

  if (!app.isPackaged) {
    return updateState({
      ...currentState,
      status: "error",
      message: "开发模式不支持原地替换安装包，请在正式打包版中使用",
    })
  }

  const latestVersion = currentState.latestVersion!
  const assetName = currentState.assetName!
  const rawTag = activeRawTag || `v${latestVersion}`
  const downloadUrl = `${REPO_BASE}/releases/download/${rawTag}/${assetName}`

  return downloadAndStageUpdate({
    downloadUrl,
    latestVersion,
    assetName,
    expectedBytes: currentState.totalBytes,
    onLinuxRelaunch,
  }).catch((cause: unknown) =>
    updateState({
      status: "error",
      currentVersion: currentCleanVersion(),
      latestVersion,
      assetName,
      message: cause instanceof Error && cause.message ? cause.message : "下载或安装更新失败",
    }),
  )
}

async function downloadAndStageUpdate(input: {
  downloadUrl: string
  latestVersion: string
  assetName: string
  expectedBytes?: number
  onLinuxRelaunch?: () => void
}): Promise<SelfUpdateState> {
  const stageDir = await mkdtemp(path.join(tmpdir(), "pigu-self-update-"))
  const archivePath = path.join(stageDir, input.assetName)
  const extractDir = path.join(stageDir, "extracted")

  const cleanupOnFailure = async (err: unknown) => {
    await rm(stageDir, { recursive: true, force: true }).catch(() => undefined)
    throw err
  }

  return downloadArchiveWithProgress({
    downloadUrl: input.downloadUrl,
    archivePath,
    latestVersion: input.latestVersion,
    assetName: input.assetName,
    expectedBytes: input.expectedBytes,
  })
    .then(async (downloadedBytes) => {
      updateState({
        status: "installing",
        currentVersion: currentCleanVersion(),
        latestVersion: input.latestVersion,
        assetName: input.assetName,
        totalBytes: downloadedBytes,
        downloadedBytes,
        percent: 100,
      })

      if (process.platform === "darwin") {
        await stageMacUpdate({ archivePath, extractDir, stageDir })

        return currentState
      }

      if (process.platform === "win32") {
        await stageWindowsUpdate({ archivePath, extractDir, stageDir })

        return currentState
      }

      await stageLinuxUpdate({ archivePath, extractDir, stageDir, onLinuxRelaunch: input.onLinuxRelaunch })

      return currentState
    })
    .catch(cleanupOnFailure)
}

async function downloadArchiveWithProgress(input: {
  downloadUrl: string
  archivePath: string
  latestVersion: string
  assetName: string
  expectedBytes?: number
}): Promise<number> {
  updateState({
    status: "downloading",
    currentVersion: currentCleanVersion(),
    latestVersion: input.latestVersion,
    assetName: input.assetName,
    totalBytes: input.expectedBytes,
    downloadedBytes: 0,
    percent: 0,
  })

  const proxyUrl = await detectSystemHttpProxy()
  applyNodeFetchProxy(proxyUrl)
  const res = await fetch(input.downloadUrl, { redirect: "follow" })

  if (!res.ok || !res.body) {
    throw new Error(`下载更新包失败 (HTTP ${res.status})`)
  }

  const totalBytes = parseTotalBytes(res) ?? input.expectedBytes
  const fileStream = createWriteStream(input.archivePath)
  const reader = res.body.getReader()
  let downloadedBytes = 0
  let lastEmitAt = 0

  const writeChunk = (chunk: Uint8Array) =>
    new Promise<void>((resolve, reject) => {
      fileStream.write(chunk, (err) => (err ? reject(err) : resolve()))
    })

  const closeStream = () =>
    new Promise<void>((resolve, reject) => {
      fileStream.end((err?: Error | null) => (err ? reject(err) : resolve()))
    })

  while (true) {
    const step = await reader.read()

    if (step.done) break

    if (step.value && step.value.byteLength > 0) {
      await writeChunk(step.value)
      downloadedBytes += step.value.byteLength
      const now = Date.now()

      if (now - lastEmitAt >= 120) {
        lastEmitAt = now
        const percent = totalBytes ? Math.min(99, Math.round((downloadedBytes * 100) / totalBytes)) : undefined
        updateState({
          status: "downloading",
          currentVersion: currentCleanVersion(),
          latestVersion: input.latestVersion,
          assetName: input.assetName,
          totalBytes,
          downloadedBytes,
          percent,
        })
      }
    }
  }

  await closeStream()

  if (downloadedBytes < MIN_ARCHIVE_BYTES) {
    throw new Error("下载的更新包体积异常，已取消安装")
  }

  if (totalBytes && downloadedBytes !== totalBytes) {
    throw new Error("更新包下载不完整，请重试")
  }

  return downloadedBytes
}

async function stageMacUpdate(input: { archivePath: string; extractDir: string; stageDir: string }) {
  await writeFile(path.join(input.stageDir, ".keep"), "")
  await execFileAsync("mkdir", ["-p", input.extractDir])
  await execFileAsync("tar", ["-xzf", input.archivePath, "-C", input.extractDir], { timeout: 120_000 })

  const entries = await readdir(input.extractDir)
  const appFolder = entries.find((item) => item.endsWith(".app"))

  if (!appFolder) {
    throw new Error("更新包内未找到 macOS 应用包 (.app)")
  }

  const extractedApp = path.join(input.extractDir, appFolder)
  const mainBin = path.join(extractedApp, "Contents", "MacOS", "Pigu")
  const binInfo = await stat(mainBin).catch(() => undefined)

  if (!binInfo?.isFile()) {
    throw new Error("更新包结构校验失败")
  }

  const targetApp = resolveMacAppBundlePath(app.getPath("exe")) ?? "/Applications/Pigu.app"
  const scriptPath = path.join(input.stageDir, "apply-update.sh")
  const script = [
    "#!/bin/sh",
    'APP_PID="$1"',
    'SRC_APP="$2"',
    'DEST_APP="$3"',
    'STAGE_DIR="$4"',
    "i=0",
    'while kill -0 "$APP_PID" 2>/dev/null && [ "$i" -lt 75 ]; do',
    "  sleep 0.2",
    "  i=$((i + 1))",
    "done",
    'CLI_SRC="$SRC_APP/Contents/Resources/opencode-cli"',
    'if [ -f "$CLI_SRC" ]; then',
    '  mkdir -p "$HOME/.opencode/bin" "$HOME/.local/bin" 2>/dev/null || true',
    '  cp -f "$CLI_SRC" "$HOME/.opencode/bin/.opencode.tmp.$$" && chmod 755 "$HOME/.opencode/bin/.opencode.tmp.$$" && mv -f "$HOME/.opencode/bin/.opencode.tmp.$$" "$HOME/.opencode/bin/opencode"',
    '  ln -sf "$HOME/.opencode/bin/opencode" "$HOME/.opencode/bin/pigu" 2>/dev/null || true',
    '  ln -sf "$HOME/.opencode/bin/opencode" "$HOME/.local/bin/pigu" 2>/dev/null || true',
    '  "$HOME/.opencode/bin/opencode" service stop >/dev/null 2>&1 || pkill -f "opencode.*serve --service" >/dev/null 2>&1 || true',
    "fi",
    'BACKUP_APP="${DEST_APP}.bak.$$"',
    'if [ -d "$DEST_APP" ]; then',
    '  mv "$DEST_APP" "$BACKUP_APP" 2>/dev/null || rm -rf "$DEST_APP"',
    "fi",
    'if mv "$SRC_APP" "$DEST_APP" 2>/dev/null || cp -R "$SRC_APP" "$DEST_APP"; then',
    '  xattr -cr "$DEST_APP" 2>/dev/null || true',
    '  rm -rf "$BACKUP_APP" "$STAGE_DIR" 2>/dev/null || true',
    '  open "$DEST_APP"',
    "else",
    '  if [ -d "$BACKUP_APP" ] && [ ! -d "$DEST_APP" ]; then',
    '    mv "$BACKUP_APP" "$DEST_APP" 2>/dev/null || true',
    "  fi",
    "fi",
    "",
  ].join("\n")

  await writeFile(scriptPath, script, { mode: 0o755 })
  await chmod(scriptPath, 0o755)

  const child = spawn("/bin/sh", [scriptPath, String(process.pid), extractedApp, targetApp, input.stageDir], {
    detached: true,
    stdio: "ignore",
  })
  child.unref()
  setTimeout(() => app.quit(), 150)
}

async function stageWindowsUpdate(input: { archivePath: string; extractDir: string; stageDir: string }) {
  await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Expand-Archive -LiteralPath $env:PIGU_ZIP -DestinationPath $env:PIGU_DEST -Force",
    ],
    {
      env: { ...process.env, PIGU_ZIP: input.archivePath, PIGU_DEST: input.extractDir },
      windowsHide: true,
      timeout: 180_000,
    },
  )

  const rootExe = path.join(input.extractDir, "Pigu.exe")
  const hasRootExe = await stat(rootExe)
    .then((s) => s.isFile())
    .catch(() => false)
  const sourceDir = await (async () => {
    if (hasRootExe) return input.extractDir
    const entries = await readdir(input.extractDir, { withFileTypes: true })
    const sub = entries.find((entry) => entry.isDirectory())

    if (!sub) throw new Error("更新包内未找到 Pigu.exe")
    const nestedDir = path.join(input.extractDir, sub.name)
    const nestedExe = await stat(path.join(nestedDir, "Pigu.exe"))
      .then((s) => s.isFile())
      .catch(() => false)

    if (!nestedExe) throw new Error("更新包内未找到 Pigu.exe")

    return nestedDir
  })()

  const targetDir = path.dirname(app.getPath("exe"))
  const scriptPath = path.join(input.stageDir, "apply-update.ps1")
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "Wait-Process -Id ([int]$env:PIGU_APP_PID) -Timeout 20",
    "Start-Sleep -Milliseconds 400",
    "$cliBin = Join-Path $env:USERPROFILE '.opencode\\bin\\opencode.exe'",
    "if (Test-Path $cliBin) { & $cliBin service stop | Out-Null }",
    "Copy-Item -Path (Join-Path $env:PIGU_SRC_DIR '*') -Destination $env:PIGU_TARGET_DIR -Recurse -Force",
    "$bundledCli = Join-Path $env:PIGU_TARGET_DIR 'resources\\opencode-cli.exe'",
    "if (Test-Path $bundledCli) {",
    "  $binDir = Join-Path $env:USERPROFILE '.opencode\\bin'",
    "  New-Item -ItemType Directory -Force -Path $binDir | Out-Null",
    "  Copy-Item -Path $bundledCli -Destination (Join-Path $binDir 'opencode.exe') -Force",
    "  Copy-Item -Path $bundledCli -Destination (Join-Path $binDir 'pigu.exe') -Force",
    "}",
    "Start-Process -FilePath (Join-Path $env:PIGU_TARGET_DIR 'Pigu.exe')",
    "Remove-Item -LiteralPath $env:PIGU_STAGE_DIR -Recurse -Force",
    "",
  ].join("\r\n")

  await writeFile(scriptPath, script, "utf8")
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        PIGU_APP_PID: String(process.pid),
        PIGU_SRC_DIR: sourceDir,
        PIGU_TARGET_DIR: targetDir,
        PIGU_STAGE_DIR: input.stageDir,
      },
    },
  )
  child.unref()
  setTimeout(() => app.quit(), 150)
}

async function stageLinuxUpdate(input: {
  archivePath: string
  extractDir: string
  stageDir: string
  onLinuxRelaunch?: () => void
}) {
  await execFileAsync("mkdir", ["-p", input.extractDir])
  await execFileAsync("tar", ["-xzf", input.archivePath, "-C", input.extractDir], { timeout: 120_000 })
  const candidates = [
    path.join(input.extractDir, "opencode"),
    path.join(input.extractDir, "pigu"),
    path.join(input.extractDir, "bin", "opencode"),
  ]
  const found = await findFirstFile(candidates)

  if (!found) throw new Error("更新包内未找到可执行文件")
  const installDir = path.join(app.getPath("home"), ".opencode", "bin")
  await execFileAsync("mkdir", ["-p", installDir])
  await execFileAsync("cp", ["-f", found, path.join(installDir, "opencode")])
  await chmod(path.join(installDir, "opencode"), 0o755)
  await execFileAsync("ln", ["-sf", path.join(installDir, "opencode"), path.join(installDir, "pigu")])
  await rm(input.stageDir, { recursive: true, force: true }).catch(() => undefined)
  input.onLinuxRelaunch?.()
}

async function findFirstFile(paths: string[]): Promise<string | undefined> {
  for (const item of paths) {
    const ok = await stat(item)
      .then((s) => s.isFile())
      .catch(() => false)

    if (ok) return item
  }

  return undefined
}
