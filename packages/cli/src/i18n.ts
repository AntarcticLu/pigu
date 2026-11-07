import { existsSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export type CliLocale = "zh" | "en"

function detectCliLocale(): CliLocale {
  const explicit = process.env.PIGU_LANG?.trim().toLowerCase()
  if (explicit) return explicit.startsWith("zh") ? "zh" : "en"

  const configDir = process.env.OPENCODE_CONFIG_DIR ?? path.join(os.homedir(), ".config", "opencode")
  const localeFile = path.join(configDir, "pigu-locale.json")
  if (existsSync(localeFile)) {
    const raw = readFileSync(localeFile, "utf8")
    if (raw.includes('"zh"')) return "zh"
    if (raw.includes('"en"')) return "en"
  }

  // Keep automated CLI tests deterministic when running in isolated XDG_STATE_HOME directories.
  const stateHome = process.env.XDG_STATE_HOME
  if (stateHome && !stateHome.includes("ai.opencode.desktop")) return "en"

  const sys = (process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "").toLowerCase()
  return sys.startsWith("zh") ? "zh" : "en"
}

export const cliLocale: CliLocale = detectCliLocale()

export function tr(zh: string, en: string): string {
  return cliLocale === "zh" ? zh : en
}
