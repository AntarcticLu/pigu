import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import http from "node:http"
import { homedir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { cleanReleaseSemver } from "@opencode/util/semver"
import { Effect, Option, Schema } from "effect"
import { parseTarget, quote, runSsh, sshArgs, SshFailure } from "./command"
import { RemoteCli } from "./remote-cli"

const execFileAsync = promisify(execFile)

const MIN_RELEASE_ARCHIVE_BYTES = 5 * 1024 * 1024

const setGlobalProxy = (http as { setGlobalProxyFromEnv?: (env?: Record<string, string>) => void })
  .setGlobalProxyFromEnv

// Use commands supported by released V2 CLIs. The registration is the service's
// complete private discovery contract; no remote Python/Node runtime is needed.
const registrationScript = `status=$("$cli" service status) || exit 0
if [ "$status" = stopped ]; then exit 0; fi
printf 'OPENCODE_SSH_STATUS=%s\\n' "$status"
for file in "\${XDG_STATE_HOME:-$HOME/.local/state}"/pigu/service*.json "\${XDG_STATE_HOME:-$HOME/.local/state}"/opencode/service*.json; do
  if [ ! -f "$file" ]; then continue; fi
  printf 'OPENCODE_SSH_REGISTRATION_BEGIN\\n'
  cat "$file"
  printf '\\nOPENCODE_SSH_REGISTRATION_END\\n'
done
`

const LocalConfigFile = Schema.fromJsonString(
  Schema.Struct({
    model: Schema.optional(Schema.String),
    provider: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
    providers: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  }),
)

const LocalJsonObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))

const decodeLocalConfig = Schema.decodeUnknownOption(LocalConfigFile)
const decodeLocalJsonObject = Schema.decodeUnknownOption(LocalJsonObject)

type LocalArchiveKind = "bundle" | "release"
export type RemoteOs = "linux" | "darwin"
export type RemoteArch = "x64" | "arm64"
export type RemotePlatform = `${RemoteOs}-${RemoteArch}`

type LocalArchive = {
  readonly kind: LocalArchiveKind
  readonly platform: RemotePlatform
  readonly filePath: string
  readonly sha256: string
  readonly mtimeMs: number
}

const remotePlatforms: ReadonlyArray<RemotePlatform> = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]

function computeFileSha256(filePath: string) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex")
}

function resolveLocalArchiveForPlatform(
  cacheDir: string,
  platform: RemotePlatform,
  options?: { releaseVersion?: string; development?: boolean },
): LocalArchive | undefined {
  const candidates: Array<{ readonly kind: LocalArchiveKind; readonly filePath: string }> = []

  if (options?.development || !options?.releaseVersion) {
    candidates.push({ kind: "bundle", filePath: path.join(cacheDir, `pigu-bundle-${platform}.tar.gz`) })
  }

  if (options?.releaseVersion) {
    candidates.push({
      kind: "release",
      filePath: path.join(cacheDir, `pigu-v${options.releaseVersion}-${platform}.tar.gz`),
    })
  } else {
    candidates.push({ kind: "release", filePath: path.join(cacheDir, `pigu-${platform}.tar.gz`) })
  }

  const found = candidates
    .flatMap((item) => {
      const st = statSync(item.filePath, { throwIfNoEntry: false })
      if (!st || !st.isFile() || st.size <= 0) return []
      return [
        {
          kind: item.kind,
          platform,
          filePath: item.filePath,
          mtimeMs: st.mtimeMs,
          sha256: computeFileSha256(item.filePath),
        },
      ]
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  return found[0]
}

function resolveLocalArchives(
  cacheDir = path.join(homedir(), ".pigu", "cache"),
  options?: { releaseVersion?: string; development?: boolean },
) {
  return new Map(
    remotePlatforms.flatMap((platform) => {
      const archive = resolveLocalArchiveForPlatform(cacheDir, platform, options)
      return archive ? [[platform, archive] as const] : []
    }),
  )
}

export function parseRemotePlatform(output: string): RemotePlatform {
  const rawOs = output
    .split(/\r?\n/)
    .findLast((line) => line.startsWith("OPENCODE_SSH_REMOTE_OS="))
    ?.slice("OPENCODE_SSH_REMOTE_OS=".length)
    .trim()
    .toLowerCase()
  const rawArch = output
    .split(/\r?\n/)
    .findLast((line) => line.startsWith("OPENCODE_SSH_REMOTE_ARCH="))
    ?.slice("OPENCODE_SSH_REMOTE_ARCH=".length)
    .trim()
    .toLowerCase()
  const os: RemoteOs = rawOs?.startsWith("darwin") ? "darwin" : "linux"
  const arch: RemoteArch = rawArch === "aarch64" || rawArch === "arm64" ? "arm64" : "x64"
  return `${os}-${arch}`
}

export function parseRemoteArch(output: string): RemoteArch {
  return parseRemotePlatform(output).endsWith("-arm64") ? "arm64" : "x64"
}

function readLocalCompanionConfigBase64(filename: string) {
  const home = homedir()
  const candidates = [
    path.join(home, ".config", "pigu", filename),
    path.join(home, ".config", "opencode", filename),
  ]
  const found = candidates.flatMap((file) => {
    if (!existsSync(file)) return []
    const decoded = Option.getOrUndefined(decodeLocalJsonObject(readFileSync(file, "utf8")))
    return decoded ? [decoded] : []
  })[0]
  if (!found) return ""
  return Buffer.from(`${JSON.stringify(found, null, 2)}\n`, "utf8").toString("base64")
}

function readLocalCloudProviderConfigBase64() {
  const home = homedir()
  const candidates = [
    path.join(home, ".config", "pigu", "opencode.json"),
    path.join(home, ".config", "opencode", "opencode.json"),
  ]
  const parsed = candidates.flatMap((file) => {
    if (!existsSync(file)) return []
    const decoded = Option.getOrUndefined(decodeLocalConfig(readFileSync(file, "utf8")))

    return decoded ? [decoded] : []
  })
  const providerEntries = parsed.flatMap((item) =>
    Object.entries(item.provider ?? item.providers ?? {}).filter(([key]) => key !== "local"),
  )

  if (providerEntries.length === 0) return ""
  const defaultModel = parsed
    .map((item) => item.model)
    .find((model): model is string => Boolean(model && !model.startsWith("local/")))
  const payload = JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      provider: Object.fromEntries(providerEntries),
      ...(defaultModel ? { model: defaultModel } : {}),
    },
    null,
    2,
  )

  return Buffer.from(`${payload}\n`, "utf8").toString("base64")
}

const bundleWrapperBody = [
  "#!/usr/bin/env bash",
  'export OPENCODE_PTY_BIN="$HOME/.pigu/app/opencode-pty"',
  'if [ "${1:-}" != "run" ]; then',
  '  export OPENCODE_DB="${OPENCODE_DB:-opencode-local.db}"',
  '  export OPENCODE_CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/pigu}"',
  "fi",
  'exec "$HOME/.pigu/bun/bin/bun" "$HOME/.pigu/app/index.js" "$@"',
].join("\\n")

const releaseWrapperBody = [
  "#!/usr/bin/env bash",
  'if [ "${1:-}" != "run" ]; then',
  '  export OPENCODE_DB="${OPENCODE_DB:-opencode-local.db}"',
  '  export OPENCODE_CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/pigu}"',
  "fi",
  'exec "$HOME/.pigu/libexec/pigu-bin" "$@"',
].join("\\n")

const syncShimsSnippet = `mkdir -p "$HOME/.local/bin" "$HOME/.opencode/bin"
for shim in "$HOME/.local/bin/pigu" "$HOME/.opencode/bin/pigu" "$HOME/.opencode/bin/opencode"; do
  rm -f "$shim"
  cp "$HOME/.pigu/bin/pigu" "$shim"
  chmod 755 "$shim"
done
if [ -w "/usr/local/bin" ]; then
  for sys_shim in "/usr/local/bin/pigu" "/usr/local/bin/opencode"; do
    rm -f "$sys_shim" 2>/dev/null || true
    cp "$HOME/.pigu/bin/pigu" "$sys_shim" 2>/dev/null || true
    chmod 755 "$sys_shim" 2>/dev/null || true
  done
fi`

export function remoteConfigSyncScript() {
  const b64 = readLocalCloudProviderConfigBase64()
  const multimodalB64 = readLocalCompanionConfigBase64("pigu-multimodal.json")
  const protocolsB64 = readLocalCompanionConfigBase64("pigu-model-protocols.json")
  // Only upgrade legacy JS-bundle wrapper scripts; never overwrite compiled ELF binaries.
  const wrapperCheck = `if [ -f "$HOME/.pigu/app/index.js" ] && [ -x "$HOME/.pigu/bun/bin/bun" ] && grep -q '\\.pigu/app/index\\.js' "$HOME/.pigu/bin/pigu" 2>/dev/null && ! grep -q 'OPENCODE_CONFIG_DIR=' "$HOME/.pigu/bin/pigu" 2>/dev/null; then
  rm -f "$HOME/.pigu/bin/pigu"
  printf '${bundleWrapperBody}\\n' > "$HOME/.pigu/bin/pigu"
  chmod 755 "$HOME/.pigu/bin/pigu"
  ${syncShimsSnippet}
  pigu_config_changed=1
fi`
  if (!b64 && !multimodalB64 && !protocolsB64) {
    return `pigu_config_changed=0\n${wrapperCheck}`
  }

  const mergeJs = `
    import fs from "node:fs";
    const dirs = [...new Set([process.env.HOME + "/.config/pigu", process.env.HOME + "/.config/opencode"])];
    let changed = false;
    const providerB64 = "${b64}";
    const multimodalB64 = "${multimodalB64}";
    const protocolsB64 = "${protocolsB64}";
    for (const dir of dirs) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
      if (providerB64) {
        const incoming = JSON.parse(Buffer.from(providerB64, "base64").toString("utf8"));
        const target = dir + "/opencode.json";
        const prevRaw = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
        let current = {};
        try { current = prevRaw ? JSON.parse(prevRaw) : {}; } catch {}
        const merged = {
          ...incoming,
          ...current,
          provider: { ...(current.provider ?? {}), ...(incoming.provider ?? {}) },
          model: current.model ?? incoming.model,
        };
        const nextRaw = JSON.stringify(merged, null, 2) + "\\n";
        if (nextRaw !== prevRaw) {
          fs.writeFileSync(target, nextRaw, { mode: 0o600 });
          changed = true;
        }
      }
      for (const [name, rawB64] of [["pigu-multimodal.json", multimodalB64], ["pigu-model-protocols.json", protocolsB64]]) {
        if (!rawB64) continue;
        const target = dir + "/" + name;
        if (fs.existsSync(target)) continue;
        const text = Buffer.from(rawB64, "base64").toString("utf8");
        fs.writeFileSync(target, text, { mode: 0o600 });
        changed = true;
      }
    }
    if (changed) process.exit(10);
  `

  return `pigu_config_changed=0
${wrapperCheck}
mkdir -p "$HOME/.config/pigu" "$HOME/.config/opencode"
js_runner=""
if [ -x "$HOME/.pigu/bun/bin/bun" ]; then
  js_runner="$HOME/.pigu/bun/bin/bun"
elif [ -x "$HOME/.bun/bin/bun" ]; then
  js_runner="$HOME/.bun/bin/bun"
elif command -v bun >/dev/null 2>&1; then
  js_runner="$(command -v bun)"
elif command -v node >/dev/null 2>&1; then
  js_runner="$(command -v node)"
fi
if [ -n "$js_runner" ]; then
  if "$js_runner" --input-type=module -e ${quote(mergeJs)} 2>/dev/null || "$js_runner" -e ${quote(mergeJs)} 2>/dev/null; then
    :
  elif [ $? -eq 10 ]; then
    pigu_config_changed=1
  fi
elif [ -x "$HOME/.pigu/libexec/pigu-bin" ]; then
  if BUN_BE_BUN=1 "$HOME/.pigu/libexec/pigu-bin" -e ${quote(mergeJs)} 2>/dev/null; then
    :
  elif [ $? -eq 10 ]; then
    pigu_config_changed=1
  fi
elif [ -n "${b64}" ] && [ ! -f "$HOME/.config/opencode/opencode.json" ]; then
  printf '%s' '${b64}' | base64 -d > "$HOME/.config/opencode/opencode.json" 2>/dev/null || true
  cp "$HOME/.config/opencode/opencode.json" "$HOME/.config/pigu/opencode.json" 2>/dev/null || true
  chmod 600 "$HOME/.config/opencode/opencode.json" "$HOME/.config/pigu/opencode.json" 2>/dev/null || true
  pigu_config_changed=1
fi`
}

type ExpectedPlatformHashes = Partial<Record<RemotePlatform, string>>

const emitRemotePlatformMarkers = `printf 'OPENCODE_SSH_REMOTE_OS=%s\\n' "$(uname -s 2>/dev/null || printf 'Linux')"
  printf 'OPENCODE_SSH_REMOTE_ARCH=%s\\n' "$(uname -m 2>/dev/null || printf 'x86_64')"`

function archiveFreshnessCheckSnippet(expected?: ExpectedPlatformHashes) {
  const lx64 = expected?.["linux-x64"] ?? ""
  const larm = expected?.["linux-arm64"] ?? ""
  const dx64 = expected?.["darwin-x64"] ?? ""
  const darm = expected?.["darwin-arm64"] ?? ""
  if (!lx64 && !larm && !dx64 && !darm) return ""
  return `remote_os_raw=$(uname -s 2>/dev/null || printf 'Linux')
remote_arch=$(uname -m 2>/dev/null || printf 'x86_64')
case "$remote_os_raw:$remote_arch" in
  Linux*:x86_64|Linux*:amd64|linux*:x86_64|linux*:amd64) expected_sha=${quote(lx64)} ;;
  Linux*:aarch64|Linux*:arm64|linux*:aarch64|linux*:arm64) expected_sha=${quote(larm)} ;;
  Darwin*:x86_64|Darwin*:amd64|darwin*:x86_64|darwin*:amd64) expected_sha=${quote(dx64)} ;;
  Darwin*:aarch64|Darwin*:arm64|darwin*:aarch64|darwin*:arm64) expected_sha=${quote(darm)} ;;
  *) expected_sha='' ;;
esac
if [ -n "$expected_sha" ] && [ "$(cat "$HOME/.pigu/.installed-sha256" 2>/dev/null || true)" != "$expected_sha" ]; then
  printf 'OPENCODE_SSH_REMOTE_OS=%s\\n' "$remote_os_raw"
  printf 'OPENCODE_SSH_REMOTE_ARCH=%s\\n' "$remote_arch"
  printf 'OPENCODE_SSH_ARCHIVE_OUTDATED=1\\n'
  exit 0
fi
`
}

function remoteVersionCheckSnippet(requiredReleaseVersion?: string) {
  const cleanVer = cleanReleaseSemver(requiredReleaseVersion)

  if (!cleanVer) return ""

  // Upgrade remote only when remote < local (`ver_cmp = -1`).
  // When remote === local (`0`) or remote > local (`1`), preserve the remote binary untouched.
  return `remote_ver=$("$cli" --version 2>/dev/null | awk 'NR==1 { sub(/^.*v/, "", $0); print $1 }' || true)
case "$remote_ver" in
  [0-9]*.[0-9]*.[0-9]*)
    ver_cmp=$(printf '%s %s\\n' "$remote_ver" ${quote(cleanVer)} | awk '{
      split($1, a, /[.-]/); split($2, b, /[.-]/);
      if (a[1]+0 != b[1]+0) { print (a[1]+0 < b[1]+0 ? -1 : 1); exit }
      if (a[2]+0 != b[2]+0) { print (a[2]+0 < b[2]+0 ? -1 : 1); exit }
      if (a[3]+0 != b[3]+0) { print (a[3]+0 < b[3]+0 ? -1 : 1); exit }
      print 0
    }')
    if [ "$ver_cmp" = "-1" ]; then
      ${emitRemotePlatformMarkers}
      printf 'OPENCODE_SSH_REMOTE_VERSION=%s\\n' "$remote_ver"
      printf 'OPENCODE_SSH_VERSION_OUTDATED=1\\n'
      exit 0
    fi
    ;;
esac
`
}

const restartIfRunningDaemonMismatchSnippet = `cli_ver_now=$("$cli" --version 2>/dev/null | awk 'NR==1 { sub(/^.*v/, "", $0); print $1 }' || true)
  if [ -n "$cli_ver_now" ]; then
    for reg_file in "\${XDG_STATE_HOME:-$HOME/.local/state}"/pigu/service*.json "\${XDG_STATE_HOME:-$HOME/.local/state}"/opencode/service*.json; do
      if [ ! -f "$reg_file" ] || ! grep -qF "$status" "$reg_file" 2>/dev/null; then continue; fi
      reg_ver=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$reg_file" | head -n 1)
      if [ -n "$reg_ver" ] && [ "$reg_ver" != "$cli_ver_now" ]; then
        "$cli" service restart
        break
      fi
    done
  fi`

export const discoverScript = `set -eu
${RemoteCli.discoverScript({ fromPath: true, cache: { directory: ".opencode/desktop-ssh", prefix: "0.0.0-beta-" } })}
if [ -z "$cli" ]; then
  ${emitRemotePlatformMarkers}
  printf 'OPENCODE_SSH_CLI_MISSING=1\\n'
  exit 0
fi
status=$("$cli" service status 2>/dev/null || printf 'stopped\\n')
if [ "$status" = stopped ]; then
  "$cli" service start
fi
${registrationScript}`

export function startScript(
  version: string,
  replace = false,
  expectedHashes?: ExpectedPlatformHashes,
  requiredReleaseVersion?: string,
) {
  void RemoteCli.requireVersion(version)

  return `set -eu
${RemoteCli.discoverScript({ fromPath: true, cache: { directory: ".opencode/desktop-ssh", prefix: "0.0.0-beta-" } })}
if [ -z "$cli" ]; then
  ${emitRemotePlatformMarkers}
  printf 'OPENCODE_SSH_CLI_MISSING=1\\n'
  exit 0
fi
${remoteVersionCheckSnippet(requiredReleaseVersion)}${archiveFreshnessCheckSnippet(expectedHashes)}${remoteConfigSyncScript()}
status=$("$cli" service status 2>/dev/null || printf 'stopped\\n')
if [ "$status" = stopped ]; then
  "$cli" service start
elif [ "${replace ? "1" : "0"}" = 1 ] || [ "$pigu_config_changed" = 1 ]; then
  "$cli" service restart
else
  ${restartIfRunningDaemonMismatchSnippet}
fi
${registrationScript}`
}

export function discoverWithSyncScript(expectedHashes?: ExpectedPlatformHashes, requiredReleaseVersion?: string) {
  return `set -eu
${RemoteCli.discoverScript({ fromPath: true, cache: { directory: ".opencode/desktop-ssh", prefix: "0.0.0-beta-" } })}
if [ -z "$cli" ]; then
  ${emitRemotePlatformMarkers}
  printf 'OPENCODE_SSH_CLI_MISSING=1\\n'
  exit 0
fi
${remoteVersionCheckSnippet(requiredReleaseVersion)}${archiveFreshnessCheckSnippet(expectedHashes)}${remoteConfigSyncScript()}
status=$("$cli" service status 2>/dev/null || printf 'stopped\\n')
if [ "$status" = stopped ]; then
  "$cli" service start
elif [ "$pigu_config_changed" = 1 ]; then
  "$cli" service restart
else
  ${restartIfRunningDaemonMismatchSnippet}
fi
${registrationScript}`
}

const Registration = Schema.fromJsonString(
  Schema.Struct({
    url: Schema.String,
    password: Schema.String,
    version: Schema.String,
    pid: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
)

export function parseRegistration(output: string) {
  const status = output
    .split(/\r?\n/)
    .findLast((line) => line.startsWith("OPENCODE_SSH_STATUS="))
    ?.slice("OPENCODE_SSH_STATUS=".length)

  if (!status) return undefined

  for (const match of output.matchAll(
    /OPENCODE_SSH_REGISTRATION_BEGIN\r?\n([\s\S]*?)\r?\nOPENCODE_SSH_REGISTRATION_END/g,
  )) {
    const result = Schema.decodeUnknownOption(Registration)(match[1])

    if (Option.isSome(result) && result.value.url === status) return result.value
  }

  return undefined
}

export function binaryPath(version: string) {
  return `$HOME/.pigu/desktop-ssh/${RemoteCli.requireVersion(version)}/pigu`
}

function connectionAddress(address: string, password: string) {
  const url = new URL(address)

  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "0.0.0.0", "[::]", "[::1]"].includes(url.hostname))
    throw new SshFailure("service")

  return {
    host: url.hostname === "[::1]" ? "[::1]" : "127.0.0.1",
    port: Number(url.port || 80),
    password,
  }
}

export function autoInstallBundleScript(sha256 = "") {
  return `set -eu
mkdir -p "$HOME/.pigu/bun" "$HOME/.pigu/bin"
stage_bundle="$HOME/.pigu/bundle.$$.tar.gz"
stage_app="$HOME/.pigu/app.next.$$"
rm -rf "$stage_app"
mkdir -p "$stage_app"
trap 'rm -rf "$stage_bundle" "$stage_app" "$HOME/.pigu/bun.$$.tgz"' EXIT
cat > "$stage_bundle"
if [ ! -x "$HOME/.pigu/bun/bin/bun" ]; then
  arch=$(uname -m 2>/dev/null || printf 'x86_64')
  os_raw=$(uname -s 2>/dev/null || printf 'Linux')
  case "$os_raw" in
    Darwin*|darwin*) bun_os="darwin" ;;
    *) bun_os="linux" ;;
  esac
  case "$arch" in
    aarch64|arm64) bun_pkg="bun-\${bun_os}-aarch64" ;;
    *) bun_pkg="bun-\${bun_os}-x64" ;;
  esac
  curl -fsSL "https://registry.npmmirror.com/@oven/\${bun_pkg}/-/\${bun_pkg}-1.4.4.tgz" -o "$HOME/.pigu/bun.$$.tgz" || curl -fsSL "https://registry.npmjs.org/@oven/\${bun_pkg}/-/\${bun_pkg}-1.4.4.tgz" -o "$HOME/.pigu/bun.$$.tgz"
  tar -xzf "$HOME/.pigu/bun.$$.tgz" -C "$HOME/.pigu/bun" --strip-components=1
  chmod +x "$HOME/.pigu/bun/bin/bun"
  rm -f "$HOME/.pigu/bun.$$.tgz"
fi
tar -xzf "$stage_bundle" -C "$stage_app"
rm -f "$stage_bundle"
chmod +x "$stage_app/opencode-pty" 2>/dev/null || true
rm -rf "$HOME/.pigu/app.prev"
if [ -d "$HOME/.pigu/app" ]; then
  mv "$HOME/.pigu/app" "$HOME/.pigu/app.prev"
fi
mv "$stage_app" "$HOME/.pigu/app"
rm -rf "$HOME/.pigu/app.prev"
rm -f "$HOME/.pigu/bin/pigu"
printf '${bundleWrapperBody}\\n' > "$HOME/.pigu/bin/pigu"
chmod 755 "$HOME/.pigu/bin/pigu"
${syncShimsSnippet}
${sha256 ? `printf '%s\\n' ${quote(sha256)} > "$HOME/.pigu/.installed-sha256"\n` : ""}`
}

export function autoInstallReleaseArchiveScript(sha256 = "") {
  return `set -eu
mkdir -p "$HOME/.pigu/libexec" "$HOME/.pigu/bin"
stage=$(mktemp -d "$HOME/.pigu/.install-XXXXXX")
trap 'rm -rf "$stage"' EXIT
cat > "$stage/pigu-linux.tar.gz"
tar -xzf "$stage/pigu-linux.tar.gz" -C "$stage"
bin_src=""
if [ -f "$stage/bin/opencode" ]; then
  bin_src="$stage/bin/opencode"
elif [ -f "$stage/opencode" ]; then
  bin_src="$stage/opencode"
elif [ -f "$stage/package/bin/opencode" ]; then
  bin_src="$stage/package/bin/opencode"
fi
if [ -z "$bin_src" ]; then
  exit 1
fi
chmod 755 "$bin_src"
mv -f "$bin_src" "$HOME/.pigu/libexec/pigu-bin"
rm -f "$HOME/.pigu/bin/pigu"
printf '${releaseWrapperBody}\\n' > "$HOME/.pigu/bin/pigu"
chmod 755 "$HOME/.pigu/bin/pigu"
${syncShimsSnippet}
${sha256 ? `printf '%s\\n' ${quote(sha256)} > "$HOME/.pigu/.installed-sha256"\n` : ""}`
}

function remoteGitHubInstallScript(releaseVersion?: string) {
  const versionArg = releaseVersion ? ` -s -- --version ${quote(releaseVersion)}` : ""

  return `set -eu
if [ -f /etc/network_turbo ] && [ -z "\${http_proxy:-}" ]; then
  . /etc/network_turbo >/dev/null 2>&1 || true
fi
curl -fsSL --connect-timeout 15 --max-time 180 https://raw.githubusercontent.com/AntarcticLu/pigu/dev/install | bash${versionArg}
mkdir -p "$HOME/.pigu/libexec" "$HOME/.pigu/bin"
if [ -x "$HOME/.opencode/bin/opencode" ]; then
  cp -f "$HOME/.opencode/bin/opencode" "$HOME/.pigu/libexec/pigu-bin"
  chmod 755 "$HOME/.pigu/libexec/pigu-bin"
  rm -f "$HOME/.pigu/bin/pigu"
  printf '${releaseWrapperBody}\\n' > "$HOME/.pigu/bin/pigu"
  chmod 755 "$HOME/.pigu/bin/pigu"
  ${syncShimsSnippet}
fi
`
}

async function detectLocalHttpProxy(): Promise<string | undefined> {
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
    const entries = new Map<string, string>()

    for (const rawLine of out.split(/\r?\n/)) {
      const match = /^\s*([A-Za-z0-9_]+)\s*:\s*(.+?)\s*$/.exec(rawLine)

      if (match?.[1] && match[2]) entries.set(match[1], match[2])
    }

    if (entries.get("HTTPSEnable") === "1" && entries.get("HTTPSProxy") && entries.get("HTTPSPort")) {
      return `http://${entries.get("HTTPSProxy")}:${entries.get("HTTPSPort")}`
    }

    if (entries.get("HTTPEnable") === "1" && entries.get("HTTPProxy") && entries.get("HTTPPort")) {
      return `http://${entries.get("HTTPProxy")}:${entries.get("HTTPPort")}`
    }
  }

  if (process.platform === "win32") {
    const out = await execFileAsync(
      "reg.exe",
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"],
      { windowsHide: true, timeout: 2_000 },
    )
      .then((res) => res.stdout)
      .catch(() => "")

    if (/ProxyEnable\s+REG_DWORD\s+0x0*1\b/i.test(out)) {
      const match = /ProxyServer\s+REG_SZ\s+([^\r\n]+)/i.exec(out)
      const raw = match?.[1]?.trim()

      if (raw) {
        const hostPort = raw.includes("=")
          ? /https=([^;]+)/i.exec(raw)?.[1]?.trim() || /http=([^;]+)/i.exec(raw)?.[1]?.trim()
          : raw

        if (hostPort) return /^https?:\/\//i.test(hostPort) ? hostPort : `http://${hostPort}`
      }
    }
  }

  return undefined
}

async function downloadReleaseArchiveBytes(url: string): Promise<Uint8Array> {
  const proxyUrl = await detectLocalHttpProxy()
  const attempts = proxyUrl ? [proxyUrl, undefined] : [undefined]

  for (const activeProxy of attempts) {
    if (setGlobalProxy) {
      setGlobalProxy(
        activeProxy
          ? { HTTP_PROXY: activeProxy, HTTPS_PROXY: activeProxy, NO_PROXY: "127.0.0.1,localhost,::1" }
          : {},
      )
    }

    const bytes = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(180_000),
      headers: { "User-Agent": "Pigu-SSH-Sync" },
    })
      .then(async (res) => {
        if (!res.ok) return undefined
        const buf = new Uint8Array(await res.arrayBuffer())

        return buf.byteLength >= MIN_RELEASE_ARCHIVE_BYTES ? buf : undefined
      })
      .catch(() => undefined)

    if (bytes) return bytes
  }

  throw new SshFailure("install")
}

function needsRemoteInstallOrUpdate(output: string) {
  return (
    output.includes("OPENCODE_SSH_CLI_MISSING=1") ||
    output.includes("OPENCODE_SSH_VERSION_OUTDATED=1") ||
    output.includes("OPENCODE_SSH_ARCHIVE_OUTDATED=1")
  )
}

export const bootstrap = Effect.fn("Ssh.bootstrap")(function* (input: {
  target: ReturnType<typeof parseTarget>
  version: string
  development?: boolean
  env: NodeJS.ProcessEnv
  replace?: boolean
}) {
  const run = (script: string) =>
    runSsh({
      args: [...sshArgs(input.target), input.target.host, "sh -l -s"],
      env: input.env,
      stdin: script,
    })

  const targetReleaseVersion = input.development ? undefined : cleanReleaseSemver(input.version)
  const localArchives = resolveLocalArchives(undefined, {
    releaseVersion: targetReleaseVersion,
    development: input.development,
  })
  // Hash-stamp checks only apply to unversioned local dev bundles; release builds use semver comparison
  // so a cached local release archive never downgrades a newer remote server.
  const expectedHashes: ExpectedPlatformHashes | undefined = targetReleaseVersion
    ? undefined
    : Object.fromEntries([...localArchives.entries()].map(([platform, archive]) => [platform, archive.sha256]))

  const firstOutput = yield* run(
    input.replace
      ? startScript(input.version, true, expectedHashes, targetReleaseVersion)
      : discoverWithSyncScript(expectedHashes, targetReleaseVersion),
  )

  const installRemoteFallback = Effect.fnUntraced(function* (platform: RemotePlatform) {
    const selected = localArchives.get(platform)
    if (selected) {
      const archive = new Uint8Array(readFileSync(selected.filePath))
      const script =
        selected.kind === "bundle"
          ? autoInstallBundleScript(selected.sha256)
          : autoInstallReleaseArchiveScript(selected.sha256)
      yield* runSsh({
        args: [...sshArgs(input.target), input.target.host, `sh -c ${quote(script)}`],
        env: input.env,
        stdin: archive,
      }).pipe(Effect.mapError(() => new SshFailure("install")))
      return
    }

    const directSuccess = yield* run(remoteGitHubInstallScript(targetReleaseVersion)).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    )
    if (directSuccess) return

    const cacheDir = path.join(homedir(), ".pigu", "cache")
    const cacheFileName = targetReleaseVersion
      ? `pigu-v${targetReleaseVersion}-${platform}.tar.gz`
      : `pigu-${platform}.tar.gz`
    const cachedRelease = path.join(cacheDir, cacheFileName)
    const releaseUrl = targetReleaseVersion
      ? `https://github.com/AntarcticLu/pigu/releases/download/v${targetReleaseVersion}/pigu-${platform}.tar.gz`
      : `https://github.com/AntarcticLu/pigu/releases/latest/download/pigu-${platform}.tar.gz`

    const bytes = yield* Effect.tryPromise({
      try: () => downloadReleaseArchiveBytes(releaseUrl),
      catch: () => new SshFailure("install"),
    })

    const downloadedSha = createHash("sha256").update(bytes).digest("hex")
    yield* Effect.sync(() => {
      mkdirSync(cacheDir, { recursive: true })
      const tempCache = `${cachedRelease}.${process.pid}.tmp`
      writeFileSync(tempCache, bytes)
      renameSync(tempCache, cachedRelease)
      rmSync(tempCache, { force: true })
    }).pipe(Effect.ignore)

    yield* runSsh({
      args: [...sshArgs(input.target), input.target.host, `sh -c ${quote(autoInstallReleaseArchiveScript(downloadedSha))}`],
      env: input.env,
      stdin: bytes,
    }).pipe(Effect.mapError(() => new SshFailure("install")))
  })

  const resolveOutput = Effect.fnUntraced(function* () {
    if (!needsRemoteInstallOrUpdate(firstOutput)) return firstOutput
    yield* installRemoteFallback(parseRemotePlatform(firstOutput))
    return yield* run(startScript(input.version, true))
  })

  const output = yield* resolveOutput()

  if (needsRemoteInstallOrUpdate(output)) {
    return yield* Effect.fail(new SshFailure("install"))
  }

  const registered = parseRegistration(output)

  if (!registered) {
    return yield* Effect.fail(new SshFailure("service"))
  }

  return yield* Effect.try({
    try: () => connectionAddress(registered.url, registered.password),
    catch: SshFailure.from,
  })
})
