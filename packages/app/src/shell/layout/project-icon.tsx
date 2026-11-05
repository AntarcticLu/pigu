import { Icon } from "@opencode/ui/icon"
import type { ProjectAvatarProps } from "@opencode/ui/project-avatar"
import type { LocalProject } from "@/shell/state/layout"

type ProjectIconProps = Omit<ProjectAvatarProps, "fallback" | "src" | "variant"> & {
  project: Pick<LocalProject, "id" | "name" | "worktree" | "icon">
  fallback?: string
  icon?: LocalProject["icon"]
}

export function ProjectIcon(props: ProjectIconProps) {
  return (
    <span
      class={`inline-flex shrink-0 items-center justify-center text-v2-icon-icon-muted ${props.class ?? ""}`}
    >
      <Icon name="folder" size="small" />
    </span>
  )
}
