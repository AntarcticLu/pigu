import { createEffect } from "solid-js"
import { createHomeController } from "./model"
import { useTabs } from "@/shell/tabs/tabs"
import { SettingsScreen } from "@/settings/shell"

export function Home() {
  const home = createHomeController()
  const tabs = useTabs()

  createEffect(() => {
    if (!tabs.ready()) return
    const existing = tabs.store.at(-1)

    if (existing) {
      tabs.select(existing)

      return
    }

    const project = home.project.newSession()

    if (project) {
      home.project.openNewSession()
    }
  })

  return <SettingsScreen />
}
