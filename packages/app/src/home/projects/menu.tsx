import { Show } from "solid-js"
import { Menu } from "@opencode/ui/menu"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import type { ServerConnection } from "@/runtime/server/registry"
import type { LocalProject } from "@/shell/state/layout"
import { fileManagerApp } from "./file-manager"

export function ProjectMenuItems(props: {
  server: ServerConnection.Any
  project: LocalProject
  unread?: boolean
  archived?: boolean
  canImportSession?: boolean
  canRevealProject: (server: ServerConnection.Any) => boolean
  onOpenProjectNewSession: (server: ServerConnection.Any, directory: string) => void
  onImportSession?: (server: ServerConnection.Any, project: LocalProject) => void
  onEditProject: (server: ServerConnection.Any, project: LocalProject) => void
  onRevealProject: (server: ServerConnection.Any, project: LocalProject) => void
  onClearNotifications?: (server: ServerConnection.Any, project: LocalProject) => void
  onHideProject: (server: ServerConnection.Any, project: LocalProject) => void
}) {
  const language = useLanguage()

  const platform = usePlatform()

  return (
    <>
      <Menu.Item onSelect={() => props.onHideProject(props.server, props.project)}>
        {props.archived ? language.tr("恢复展示项目", "Unarchive project") : language.tr("收纳项目", "Archive project")}
      </Menu.Item>
      <Menu.Separator />
      <Menu.Item onSelect={() => props.onOpenProjectNewSession(props.server, props.project.worktree)}>
        {language.t("command.session.new")}
      </Menu.Item>
      <Menu.Item onSelect={() => props.onEditProject(props.server, props.project)}>
        {language.t("dialog.project.edit.title")}
      </Menu.Item>
      <Show when={props.canRevealProject(props.server)}>
        <Menu.Item onSelect={() => props.onRevealProject(props.server, props.project)}>
          {language.t(
            fileManagerApp(platform.platform === "desktop" ? (platform.os ?? "unknown") : "unknown").actionLabel,
          )}
        </Menu.Item>
      </Show>
    </>
  )
}
