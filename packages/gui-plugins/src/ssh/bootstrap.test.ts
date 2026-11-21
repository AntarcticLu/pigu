import { spawnSync } from "node:child_process"
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { expect, test } from "bun:test"
import {
  autoInstallReleaseArchiveScript,
  binaryPath,
  discoverWithSyncScript,
  parseRegistration,
  parseRemoteArch,
  parseRemotePlatform,
  remoteConfigSyncScript,
  remoteGitHubInstallScript,
  resolveLocalArchives,
} from "./bootstrap"
import { RemoteCli } from "./remote-cli"

test("ignores stopped services and registrations that do not match the healthy endpoint", () => {
  const registration = { url: "http://127.0.0.1:1234", password: "secret", version: "2.0.0", pid: 42 }
  const frame = `OPENCODE_SSH_REGISTRATION_BEGIN\n${JSON.stringify(registration)}\nOPENCODE_SSH_REGISTRATION_END\n`
  expect(parseRegistration(`OPENCODE_SSH_STATUS=stopped\n${frame}`)).toBeUndefined()
  expect(parseRegistration(`OPENCODE_SSH_STATUS=http://127.0.0.1:9999\n${frame}`)).toBeUndefined()
  expect(
    parseRegistration(
      `OPENCODE_SSH_STATUS=${registration.url}\nOPENCODE_SSH_REGISTRATION_BEGIN\ninvalid\nOPENCODE_SSH_REGISTRATION_END\n`,
    ),
  ).toBeUndefined()
})

test("rejects unsafe versions and platforms in remote installation paths", () => {
  expect(() => binaryPath('2.0.0"; whoami')).toThrow()
  expect(RemoteCli.archiveUrl("linux-x64-baseline-musl", "2.0.0-beta.1")).toBe(
    "https://registry.npmjs.org/@opencode/cli-linux-x64-baseline-musl/-/cli-linux-x64-baseline-musl-2.0.0-beta.1.tgz",
  )
  expect(() => RemoteCli.installScript({ version: '2.0.0"; whoami', source: { type: "installer" } })).toThrow()
  expect(() => RemoteCli.archiveUrl("linux-x64;whoami", "2.0.0")).toThrow()
})

test("parses remote OS and CPU architecture markers accurately", () => {
  expect(parseRemoteArch("OPENCODE_SSH_REMOTE_ARCH=x86_64\nOPENCODE_SSH_CLI_MISSING=1\n")).toBe("x64")
  expect(parseRemoteArch("OPENCODE_SSH_REMOTE_ARCH=aarch64\nOPENCODE_SSH_ARCHIVE_OUTDATED=1\n")).toBe("arm64")
  expect(parseRemotePlatform("OPENCODE_SSH_REMOTE_OS=Linux\nOPENCODE_SSH_REMOTE_ARCH=x86_64\n")).toBe("linux-x64")
  expect(parseRemotePlatform("OPENCODE_SSH_REMOTE_OS=Linux\nOPENCODE_SSH_REMOTE_ARCH=aarch64\n")).toBe("linux-arm64")
  expect(parseRemotePlatform("OPENCODE_SSH_REMOTE_OS=Darwin\nOPENCODE_SSH_REMOTE_ARCH=arm64\n")).toBe("darwin-arm64")
  expect(parseRemotePlatform("OPENCODE_SSH_REMOTE_OS=Darwin\nOPENCODE_SSH_REMOTE_ARCH=x86_64\n")).toBe("darwin-x64")
  expect(parseRemotePlatform("")).toBe("linux-x64")
})

test("detects outdated remote archive stamp and preserves standalone binary wrappers", () => {
  if (process.platform === "win32") return
  const tempHome = mkdtempSync(path.join(tmpdir(), "pigu-ssh-test-"))
  try {
    mkdirSync(path.join(tempHome, ".pigu", "bin"), { recursive: true })
    mkdirSync(path.join(tempHome, ".opencode", "bin"), { recursive: true })
    // Simulate a standalone binary at ~/.pigu/bin/pigu and a self-referencing symlink in ~/.opencode/bin/pigu -> opencode
    const fakeElf = "#!/bin/sh\nif [ \"$1\" = \"service\" ] && [ \"$2\" = \"status\" ]; then echo http://127.0.0.1:4321; exit 0; fi\nexit 0\n"
    writeFileSync(path.join(tempHome, ".pigu", "bin", "pigu"), fakeElf, { mode: 0o755 })
    writeFileSync(path.join(tempHome, ".opencode", "bin", "opencode"), fakeElf, { mode: 0o755 })
    symlinkSync(
      path.join(tempHome, ".opencode", "bin", "opencode"),
      path.join(tempHome, ".opencode", "bin", "pigu"),
    )

    // 1. remoteConfigSyncScript must NOT clobber standalone ~/.pigu/bin/pigu when ~/.pigu/app/index.js does not exist
    const syncRun = spawnSync("sh", ["-c", remoteConfigSyncScript()], {
      env: { ...process.env, HOME: tempHome, PATH: "/usr/bin:/bin" },
      encoding: "utf8",
    })
    expect(syncRun.status).toBe(0)
    expect(readFileSync(path.join(tempHome, ".pigu", "bin", "pigu"), "utf8")).toBe(fakeElf)

    // 2. discoverWithSyncScript emits OPENCODE_SSH_ARCHIVE_OUTDATED=1 when local sha256 differs from .installed-sha256
    const script = discoverWithSyncScript({
      "linux-x64": "expected-sha-123",
      "linux-arm64": "expected-sha-123",
      "darwin-x64": "expected-sha-123",
      "darwin-arm64": "expected-sha-123",
    })
    const outdatedRun = spawnSync("sh", ["-c", script], {
      env: { ...process.env, HOME: tempHome, PATH: "/usr/bin:/bin" },
      encoding: "utf8",
    })
    expect(outdatedRun.status).toBe(0)
    expect(outdatedRun.stdout).toContain("OPENCODE_SSH_ARCHIVE_OUTDATED=1")

    // 3. autoInstallReleaseArchiveScript safely replaces symlinks (including ~/.pigu/bin/pigu -> ~/.opencode/bin/opencode) and records .installed-sha256
    rmSync(path.join(tempHome, ".pigu", "bin", "pigu"), { force: true })
    symlinkSync(
      path.join(tempHome, ".opencode", "bin", "opencode"),
      path.join(tempHome, ".pigu", "bin", "pigu"),
    )

    const stageTarDir = mkdtempSync(path.join(tmpdir(), "pigu-ssh-tar-"))
    mkdirSync(path.join(stageTarDir, "bin"), { recursive: true })
    writeFileSync(path.join(stageTarDir, "bin", "opencode"), "#!/bin/sh\necho new-release-bin \"$@\"\n")
    chmodSync(path.join(stageTarDir, "bin", "opencode"), 0o755)
    const tarPath = path.join(stageTarDir, "release.tar.gz")
    spawnSync("tar", ["-czf", tarPath, "-C", stageTarDir, "bin/opencode"])

    const installRun = spawnSync("sh", ["-c", autoInstallReleaseArchiveScript("expected-sha-123")], {
      env: { ...process.env, HOME: tempHome, PATH: "/usr/bin:/bin" },
      input: readFileSync(tarPath),
    })
    rmSync(stageTarDir, { recursive: true, force: true })
    expect(installRun.status).toBe(0)
    expect(readFileSync(path.join(tempHome, ".pigu", ".installed-sha256"), "utf8").trim()).toBe("expected-sha-123")
    expect(lstatSync(path.join(tempHome, ".pigu", "bin", "pigu")).isSymbolicLink()).toBe(false)
    expect(lstatSync(path.join(tempHome, ".opencode", "bin", "pigu")).isSymbolicLink()).toBe(false)
    expect(lstatSync(path.join(tempHome, ".opencode", "bin", "opencode")).isSymbolicLink()).toBe(false)
    const execWrapper = spawnSync(path.join(tempHome, ".pigu", "bin", "pigu"), ["--version"], {
      env: { ...process.env, HOME: tempHome, PATH: "/usr/bin:/bin" },
      encoding: "utf8",
    })
    expect(execWrapper.stdout.trim()).toBe("new-release-bin --version")
    const execOpencodeShim = spawnSync(path.join(tempHome, ".opencode", "bin", "opencode"), ["--version"], {
      env: { ...process.env, HOME: tempHome, PATH: "/usr/bin:/bin" },
      encoding: "utf8",
    })
    expect(execOpencodeShim.stdout.trim()).toBe("new-release-bin --version")
  } finally {
    rmSync(tempHome, { recursive: true, force: true })
  }
})

test("compares remote CLI version against local release version (upgrades older, reuses equal, preserves newer)", () => {
  if (process.platform === "win32") return
  const tempHome = mkdtempSync(path.join(tmpdir(), "pigu-ssh-ver-"))
  try {
    mkdirSync(path.join(tempHome, ".pigu", "bin"), { recursive: true })
    mkdirSync(path.join(tempHome, ".local", "state", "opencode"), { recursive: true })
    const restartMarker = path.join(tempHome, "restarted.flag")

    const writeFakeCli = (cliVersion: string, runningVersion: string) => {
      rmSync(restartMarker, { force: true })
      writeFileSync(
        path.join(tempHome, ".local", "state", "opencode", "service.json"),
        JSON.stringify({ url: "http://127.0.0.1:4321", password: "pw", version: runningVersion, pid: 12345 }),
      )
      const script = `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "opencode v${cliVersion}"
  exit 0
fi
if [ "$1" = "service" ] && [ "$2" = "status" ]; then
  echo "http://127.0.0.1:4321"
  exit 0
fi
if [ "$1" = "service" ] && [ "$2" = "restart" ]; then
  echo "restarted" > "${restartMarker}"
  exit 0
fi
exit 0
`
      writeFileSync(path.join(tempHome, ".pigu", "bin", "pigu"), script, { mode: 0o755 })
    }

    const testEnv = {
      ...process.env,
      HOME: tempHome,
      XDG_STATE_HOME: path.join(tempHome, ".local", "state"),
      PATH: "/usr/bin:/bin",
    }

    // Case 1: remote (1.0.0) < local (1.0.1) -> marks outdated for upgrade
    writeFakeCli("1.0.0", "1.0.0")
    const olderRun = spawnSync("sh", ["-c", discoverWithSyncScript(undefined, "1.0.1")], {
      env: testEnv,
      encoding: "utf8",
    })
    expect(olderRun.status).toBe(0)
    expect(olderRun.stdout).toContain("OPENCODE_SSH_VERSION_OUTDATED=1")
    expect(olderRun.stdout).toContain("OPENCODE_SSH_REMOTE_VERSION=1.0.0")

    // Case 2: remote (1.0.1) === local (1.0.1) -> reuses without upgrade; steady-state run does not restart
    writeFakeCli("1.0.1", "1.0.1")
    spawnSync("sh", ["-c", discoverWithSyncScript(undefined, "1.0.1")], { env: testEnv, encoding: "utf8" })
    rmSync(restartMarker, { force: true })
    const equalRun = spawnSync("sh", ["-c", discoverWithSyncScript(undefined, "1.0.1")], {
      env: testEnv,
      encoding: "utf8",
    })
    expect(equalRun.status).toBe(0)
    expect(equalRun.stdout).not.toContain("OPENCODE_SSH_VERSION_OUTDATED=1")
    expect(parseRegistration(equalRun.stdout)?.version).toBe("1.0.1")
    expect(spawnSync("test", ["-f", restartMarker]).status).not.toBe(0)

    // Case 3: remote (1.0.2) > local (1.0.1) -> NEVER downgrades; restarts daemon only if daemon lagged binary
    writeFakeCli("1.0.2", "1.0.0")
    const newerRun = spawnSync("sh", ["-c", discoverWithSyncScript(undefined, "1.0.1")], {
      env: testEnv,
      encoding: "utf8",
    })
    expect(newerRun.status).toBe(0)
    expect(newerRun.stdout).not.toContain("OPENCODE_SSH_VERSION_OUTDATED=1")
    expect(spawnSync("test", ["-f", restartMarker]).status).toBe(0)
  } finally {
    rmSync(tempHome, { recursive: true, force: true })
  }
})

test("remoteGitHubInstallScript atomically replaces running pigu-bin inode and rejects wrapper loops", () => {
  if (process.platform === "win32") return
  const tempHome = mkdtempSync(path.join(tmpdir(), "pigu-ssh-gh-"))
  const mockBin = mkdtempSync(path.join(tmpdir(), "pigu-ssh-mockbin-"))
  try {
    mkdirSync(path.join(tempHome, ".pigu", "libexec"), { recursive: true })
    mkdirSync(path.join(tempHome, ".pigu", "bin"), { recursive: true })
    mkdirSync(path.join(tempHome, ".opencode", "bin"), { recursive: true })

    const piguBinPath = path.join(tempHome, ".pigu", "libexec", "pigu-bin")
    writeFileSync(piguBinPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x01, 0x01, 0x01, 0x00]), { mode: 0o755 })
    const oldInode = statSync(piguBinPath).ino

    // Pre-existing wrapper shim at ~/.opencode/bin/opencode from a prior install
    const oldShim = '#!/usr/bin/env bash\nexec "$HOME/.pigu/libexec/pigu-bin" "$@"\n'
    writeFileSync(path.join(tempHome, ".opencode", "bin", "opencode"), oldShim, { mode: 0o755 })

    // 1. If installer leaves a `#!` wrapper instead of a binary, script must fail rather than create a fork loop
    writeFileSync(path.join(mockBin, "curl"), "#!/bin/sh\necho 'exit 0'\n", { mode: 0o755 })
    const env = { ...process.env, HOME: tempHome, PATH: `${mockBin}:/usr/bin:/bin` }
    const loopGuardRun = spawnSync("sh", ["-c", remoteGitHubInstallScript("1.0.3")], { env, encoding: "utf8" })
    expect(loopGuardRun.status).not.toBe(0)
    expect(statSync(piguBinPath).ino).toBe(oldInode)

    // 2. When installer writes a fresh compiled binary, pigu-bin is replaced via atomic rename (new inode, no ETXTBSY)
    const installerPayload = [
      "mkdir -p \"$HOME/.opencode/bin\"",
      "rm -f \"$HOME/.opencode/bin/opencode\"",
      "printf '\\177ELFNEWBINARY' > \"$HOME/.opencode/bin/opencode\"",
      "chmod 755 \"$HOME/.opencode/bin/opencode\"",
    ].join("\n")
    writeFileSync(
      path.join(mockBin, "curl"),
      `#!/bin/sh\ncat <<'EOF'\n${installerPayload}\nEOF\n`,
      { mode: 0o755 },
    )
    const upgradeRun = spawnSync("sh", ["-c", remoteGitHubInstallScript("1.0.3")], { env, encoding: "utf8" })
    expect(upgradeRun.stderr).toBe("")
    expect(upgradeRun.status).toBe(0)
    expect(statSync(piguBinPath).ino).not.toBe(oldInode)
    expect(readFileSync(piguBinPath).subarray(4).toString("utf8")).toBe("NEWBINARY")
    expect(readFileSync(path.join(tempHome, ".opencode", "bin", "opencode"), "utf8")).toContain(
      'exec "$HOME/.pigu/libexec/pigu-bin" "$@"',
    )

    // 3. Stale unversioned `pigu-linux-x64.tar.gz` in ~/.pigu/cache must never be resolved on dev builds (prevents silent remote downgrade)
    const cacheDir = path.join(tempHome, ".pigu", "cache")
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(path.join(cacheDir, "pigu-linux-x64.tar.gz"), "stale-v1.0.0-archive")
    expect(resolveLocalArchives(cacheDir, { development: true }).has("linux-x64")).toBe(false)
    expect(resolveLocalArchives(cacheDir, {}).has("linux-x64")).toBe(false)

    writeFileSync(path.join(cacheDir, "pigu-v1.0.4-linux-x64.tar.gz"), "release-1.0.4-archive")
    expect(resolveLocalArchives(cacheDir, { releaseVersion: "1.0.4" }).get("linux-x64")?.kind).toBe("release")
  } finally {
    rmSync(tempHome, { recursive: true, force: true })
    rmSync(mockBin, { recursive: true, force: true })
  }
})
