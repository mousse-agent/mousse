import type { ReactNode } from 'react'
import { formatBinding } from '../../shared/commands'
import type { MainView } from '../../shared/types'
import { useCommandBindings, useCommands } from '../commands/commandRegistry'
import { Bot, FileText, FolderOpen, GitCompare, GitPullRequest, Globe, MessagesSquare, Terminal } from '../lib/icons'
import { SURFACE_CHOICES, openSurface, type SurfaceChoice } from '../lib/surfaces'
import { useAppStore } from '../stores/appStore'

const ICONS = {
  browser: Globe,
  terminal: Terminal,
  files: FolderOpen,
  git: GitCompare,
  pullRequest: GitPullRequest,
  sideChats: MessagesSquare,
  agents: Bot,
  documents: FileText
} as const

/** Browsers and terminals can have several tabs; the menu always adds one. */
export function surfaceMenuLabel(choice: SurfaceChoice): string {
  if (choice.id === 'browser') return 'New browser tab'
  return choice.id === 'terminal' ? 'New terminal' : choice.label
}

/**
 * The panels a user can add. As the "+" menu (`menu`) the rows are menu items, panels that are
 * already open say "Open" and focus their tab, except Browser and Terminal which add tabs.
 * No shortcut hints show, since shortcuts only work while the empty picker is on screen.
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
              open={choice.id !== 'terminal' && choice.id !== 'browser' && !!openViews?.has(choice.id)}
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
        else openSurface(choice.id, choice.id === 'terminal' || choice.id === 'browser')
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
  const binding = useCommandBindings()[choice.commandId]
  const platform = useAppStore((state) => state.appInfo?.platform) ?? ''
  return <PanelPickerRow icon={ICONS[choice.id]} label={choice.label} shortcut={binding ? formatBinding(binding, platform) : undefined} onPick={() => openSurface(choice.id)} />
}

/** One row of an empty panel's picker: its icon and name, and the shortcut that opens it when it has one. */
export function PanelPickerRow({ icon: Icon, label, shortcut, onPick }: {
  icon: typeof Globe
  label: string
  shortcut?: string
  onPick: () => void
}) {
  return (
    <button type="button" className="surface-menu-row" onClick={onPick}>
      <span className="surface-menu-row-label">
        <Icon size={16} strokeWidth={1.8} />
        {label}
      </span>
      {shortcut && <kbd className="surface-menu-key">{shortcut}</kbd>}
    </button>
  )
}

/** An empty panel: one muted line and its rows, centred in the pane. The app panel's picker and a bot's side panel show it. */
export function PanelPicker({ children }: { children: ReactNode }) {
  return (
    <div className="surface-picker">
      <p className="surface-picker-title">Add a panel</p>
      <ul className="surface-menu-list">{children}</ul>
    </div>
  )
}

/**
 * The empty main area. While it is on screen the surface commands are registered, so B/T/F/D/R (or
 * whatever the profile bound) open a panel; the registry applies the text-field and overlay rules. The
 * palette lists the same commands everywhere through palette-only handlers (`useAppCommands`).
 */
export function OpenSurfacePicker() {
  useCommands(SURFACE_CHOICES.map((choice) => ({ id: choice.commandId, run: () => openSurface(choice.id) })))

  return (
    <PanelPicker>
      {SURFACE_CHOICES.map((choice) => <li key={choice.id}><SurfacePickerRow choice={choice} /></li>)}
    </PanelPicker>
  )
}
