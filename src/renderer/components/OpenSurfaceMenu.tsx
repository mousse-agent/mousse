import { formatBinding } from '../../shared/commands'
import type { MainView } from '../../shared/types'
import { useCommandBindings, useCommands } from '../commands/commandRegistry'
import { Bot, Eye, FileText, FolderOpen, GitBranch, GitPullRequest, Globe, Terminal } from '../lib/icons'
import { SURFACE_CHOICES, openSurface, type SurfaceChoice } from '../lib/surfaces'
import { useAppStore } from '../stores/appStore'

const ICONS = {
  browser: Globe,
  terminal: Terminal,
  files: FolderOpen,
  git: GitBranch,
  review: Eye,
  pullRequest: GitPullRequest,
  agents: Bot,
  documents: FileText
} as const

/** The menu row's label: several terminals are allowed, so the menu always adds one. */
export function surfaceMenuLabel(choice: SurfaceChoice): string {
  return choice.id === 'terminal' ? 'New terminal' : choice.label
}

/**
 * The panels a user can add. As the "+" menu (`menu`) the rows are menu items, panels that are
 * already open say "Open" and focus their tab, and no shortcut hints show, since the shortcuts
 * only work while the empty picker is on screen.
 */
export function SurfaceChoiceList({
  menu = false,
  openViews,
  onFocusOpen,
  onPick
}: {
  menu?: boolean
  openViews?: ReadonlySet<MainView>
  onFocusOpen?: (view: MainView) => void
  onPick?: () => void
}) {
  return (
    <ul className="surface-menu-list" role={menu ? 'none' : undefined}>
      {SURFACE_CHOICES.map((choice) => (
        <li key={choice.id} role={menu ? 'none' : undefined}>
          {menu
            ? <SurfaceMenuItem
              choice={choice}
              open={choice.id !== 'terminal' && !!openViews?.has(choice.id)}
              onFocusOpen={onFocusOpen}
              onPick={onPick}
            />
            : <SurfacePickerRow choice={choice} />}
        </li>
      ))}
    </ul>
  )
}

function SurfaceMenuItem({
  choice,
  open,
  onFocusOpen,
  onPick
}: {
  choice: SurfaceChoice
  open: boolean
  onFocusOpen?: (view: MainView) => void
  onPick?: () => void
}) {
  const Icon = ICONS[choice.id]
  return (
    <button
      type="button"
      role="menuitem"
      className="surface-menu-row"
      onClick={() => {
        if (open && onFocusOpen) onFocusOpen(choice.id)
        else openSurface(choice.id, choice.id === 'terminal')
        onPick?.()
      }}
    >
      <span className="surface-menu-row-label">
        <Icon size={16} strokeWidth={1.8} />
        {surfaceMenuLabel(choice)}
      </span>
      {open && <span className="surface-menu-state">Open</span>}
    </button>
  )
}

function SurfacePickerRow({ choice }: { choice: SurfaceChoice }) {
  const Icon = ICONS[choice.id]
  const binding = useCommandBindings()[choice.commandId]
  const platform = useAppStore((state) => state.appInfo?.platform) ?? ''
  return (
    <button type="button" className="surface-menu-row" onClick={() => openSurface(choice.id)}>
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
 * whatever the profile bound) open a panel; the registry applies the text-field and overlay rules.
 */
export function OpenSurfacePicker() {
  useCommands(SURFACE_CHOICES.map((choice) => ({ id: choice.commandId, run: () => openSurface(choice.id) })))

  return (
    <div className="surface-picker">
      <p className="surface-picker-title">Add a panel</p>
      <SurfaceChoiceList />
    </div>
  )
}
