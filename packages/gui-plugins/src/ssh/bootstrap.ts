import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { Effect, Option, Schema } from "effect"
import { parseTarget, quote, runSsh, sshArgs, SshFailure } from "./command"
import { RemoteCli } from "./remote-cli"

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

const decodeLocalConfig = Schema.decodeUnknownOption(LocalConfigFile)

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

function remoteConfigSyncScript() {
  const b64 = readLocalCloudProviderConfigBase64()
  const wrapperCheck = `if [ -f "$HOME/.pigu/bin/pigu" ] && ! grep -q 'OPENCODE_CONFIG_DIR=' "$HOME/.pigu/bin/pigu" 2>/dev/null; then
  printf '#!/usr/bin/env bash\\nexport OPENCODE_PTY_BIN="$HOME/.pigu/app/opencode-pty"\\nexport OPENCODE_DB="opencode-local.db"\\nexport OPENCODE_CONFIG_DIR="$HOME/.config/pigu"\\nexec "$HOME/.pigu/bun/bin/bun" "$HOME/.pigu/app/index.js" "$@"\\n' > "$HOME/.pigu/bin/pigu"
  chmod 755 "$HOME/.pigu/bin/pigu"
  cp "$HOME/.pigu/bin/pigu" "$HOME/.local/bin/pigu" 2>/dev/null || true
  cp "$HOME/.pigu/bin/pigu" "/usr/local/bin/pigu" 2>/dev/null || true
  pigu_config_changed=1
fi`
  if (!b64) {
    return `pigu_config_changed=0\n${wrapperCheck}`
  }
  return `pigu_config_changed=0
${wrapperCheck}
mkdir -p "$HOME/.config/pigu"
if [ -x "$HOME/.pigu/bun/bin/bun" ]; then
  if "$HOME/.pigu/bun/bin/bun" -e '
    import fs from "node:fs";
    const target = process.env.HOME + "/.config/pigu/opencode.json";
    const incoming = JSON.parse(Buffer.from("${b64}", "base64").toString("utf8"));
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
      process.exit(10);
    }
  '; then
    :
  elif [ $? -eq 10 ]; then
    pigu_config_changed=1
  fi
fi`
}

export const discoverScript = `set -eu
${RemoteCli.discoverScript({ fromPath: true, cache: { directory: ".opencode/desktop-ssh", prefix: "0.0.0-beta-" } })}
if [ -z "$cli" ]; then
  printf 'OPENCODE_SSH_CLI_MISSING=1\\n'
  exit 0
fi
status=$("$cli" service status 2>/dev/null || printf 'stopped\\n')
if [ "$status" = stopped ]; then
  "$cli" service start
fi
${registrationScript}`

export function startScript(version: string, replace = false) {
  void RemoteCli.requireVersion(version)

  return `set -eu
${RemoteCli.discoverScript({ fromPath: true, cache: { directory: ".opencode/desktop-ssh", prefix: "0.0.0-beta-" } })}
if [ -z "$cli" ]; then
  printf 'OPENCODE_SSH_CLI_MISSING=1\\n'
  exit 0
fi
${remoteConfigSyncScript()}
"$cli" service ${replace ? "restart" : "start"}
${registrationScript}`
}

function discoverWithSyncScript() {
  return `set -eu
${RemoteCli.discoverScript({ fromPath: true, cache: { directory: ".opencode/desktop-ssh", prefix: "0.0.0-beta-" } })}
if [ -z "$cli" ]; then
  printf 'OPENCODE_SSH_CLI_MISSING=1\\n'
  exit 0
fi
${remoteConfigSyncScript()}
status=$("$cli" service status 2>/dev/null || printf 'stopped\\n')
if [ "$status" = stopped ]; then
  "$cli" service start
elif [ "$pigu_config_changed" = 1 ]; then
  "$cli" service restart
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

const autoInstallBundleScript = `set -eu
mkdir -p "$HOME/.pigu/bun" "$HOME/.pigu/app" "$HOME/.pigu/bin" "$HOME/.local/bin"
cat > "$HOME/.pigu/bundle.tar.gz"
if [ ! -x "$HOME/.pigu/bun/bin/bun" ]; then
  curl -fsSL https://registry.npmmirror.com/@oven/bun-linux-x64/-/bun-linux-x64-1.4.4.tgz -o "$HOME/.pigu/bun.tgz" || curl -fsSL https://registry.npmjs.org/@oven/bun-linux-x64/-/bun-linux-x64-1.4.4.tgz -o "$HOME/.pigu/bun.tgz"
  tar -xzf "$HOME/.pigu/bun.tgz" -C "$HOME/.pigu/bun" --strip-components=1
  chmod +x "$HOME/.pigu/bun/bin/bun"
  rm -f "$HOME/.pigu/bun.tgz"
fi
tar -xzf "$HOME/.pigu/bundle.tar.gz" -C "$HOME/.pigu/app"
rm -f "$HOME/.pigu/bundle.tar.gz"
chmod +x "$HOME/.pigu/app/opencode-pty" 2>/dev/null || true
printf '#!/usr/bin/env bash\\nexport OPENCODE_PTY_BIN="$HOME/.pigu/app/opencode-pty"\\nexport OPENCODE_DB="opencode-local.db"\\nexport OPENCODE_CONFIG_DIR="$HOME/.config/pigu"\\nexec "$HOME/.pigu/bun/bin/bun" "$HOME/.pigu/app/index.js" "$@"\\n' > "$HOME/.pigu/bin/pigu"
chmod 755 "$HOME/.pigu/bin/pigu"
cp "$HOME/.pigu/bin/pigu" "$HOME/.local/bin/pigu"
`

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

  const firstOutput = yield* run(input.replace ? startScript(input.version, true) : discoverWithSyncScript())

  const resolveOutput = Effect.fnUntraced(function* () {
    if (!firstOutput.includes("OPENCODE_SSH_CLI_MISSING=1")) return firstOutput
    const cachedBundle = path.join(homedir(), ".pigu", "cache", "pigu-bundle-linux-x64.tar.gz")

    if (!existsSync(cachedBundle)) return yield* Effect.fail(new SshFailure("install"))
    const archive = new Uint8Array(readFileSync(cachedBundle))
    yield* runSsh({
      args: [...sshArgs(input.target), input.target.host, `sh -c ${quote(autoInstallBundleScript)}`],
      env: input.env,
      stdin: archive,
    }).pipe(Effect.mapError(() => new SshFailure("install")))

    return yield* run(startScript(input.version, false))
  })

  const output = yield* resolveOutput()

  if (output.includes("OPENCODE_SSH_CLI_MISSING=1")) {
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
