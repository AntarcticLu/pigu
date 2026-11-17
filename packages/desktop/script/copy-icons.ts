import { $ } from "bun"
import { exists } from "node:fs/promises"
import { resolveChannel } from "./utils"

const arg = process.argv[2]

const channel = arg === "dev" || arg === "beta" || arg === "prod" ? arg : resolveChannel()

const src = `./icons/${channel}`

const dest = "resources/icons"

const appxSrc = `./icons/${channel}/appx`

const appxDest = "resources/appx"

await $`rm -rf ${dest} ${appxDest}`

await $`cp -R ${src} ${dest}`

if (await exists(appxSrc)) {
  await $`cp -R ${appxSrc} ${appxDest}`
  await $`rm -rf ${dest}/appx`
}

console.log(`Copied ${channel} icons from ${src} to ${dest}`)
