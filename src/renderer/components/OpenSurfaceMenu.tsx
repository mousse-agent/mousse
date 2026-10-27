import { formatBinding } from '../../shared/commands'
import { useCommandBindings, useCommands } from '../commands/commandRegistry'
import { Bot, Eye, FileText, FolderOpen, GitBranch, Globe, Terminal } from '../lib/icons'
import { SURFACE_CHOICES, openSurface, type SurfaceChoice } from '../lib/surfaces'
import { useAppStore } from '../stores/appStore'

const ICONS = {
  browser: Globe,
  terminal: Terminal,
  files: FolderOpen,
  git: GitBranch,
  review: Eye,
  agents: Bot,
  documents: FileText
} as const

export function SurfaceChoiceList({
  onPick,
  another = false
}: {
  onPick?: () => void
  another?: boolean
}) {
  return (
    <ul className="surface-menu-list">
      {SURFACE_CHOICES.map((choice) => (
        <li key={choice.id}>
          <SurfaceChoiceButton choice={choice} another={another} onPick={onPick} />
        </li>
      ))}
    </ul>
  )
}

function SurfaceChoiceButton({
  choice,
  another,
  onPick
}: {
  choice: SurfaceChoice
  another: boolean
  onPick?: () => void
}) {
  const Icon = ICONS[choice.id]
  const binding = useCommandBindings()[choice.commandId]
  const platform = useAppStore((state) => state.appInfo?.platform) ?? ''
  return (
    <button
      type="button"
      className="surface-menu-row"
      onClick={() => {
        openSurface(choice.id, another)
        onPick?.()
      }}
    >
      <span className="surface-menu-row-label">
        <Icon size={16} strokeWidth={1.8} />
        {choice.label}
      </span>
      {binding && <kbd className="surface-menu-key">{formatBinding(binding, platform)}</kbd>}
    </button>
  )
}

/**
 * The empty main area. While it is on screen the surface commands are registered, so B/T/F/D/R (or
 * whatever the profile bound) open a surface; the registry applies the text-field and overlay rules.
 */
export function OpenSurfacePicker() {
  useCommands(SURFACE_CHOICES.map((choice) => ({ id: choice.commandId, run: () => openSurface(choice.id) })))

  return (
    <div className="surface-picker">
      <SurfaceChoiceList />
    </div>
  )
}
