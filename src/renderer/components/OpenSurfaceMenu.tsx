import { useEffect } from 'react'
import { FileText, FolderOpen, GitBranch, Globe, Terminal } from '../lib/icons'
import { SURFACE_CHOICES, openSurface, type SurfaceChoice } from '../lib/surfaces'
import { useAppStore } from '../stores/appStore'

const ICONS = {
  browser: Globe,
  terminal: Terminal,
  files: FolderOpen,
  git: GitBranch,
  agents: GitBranch,
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
      <kbd className="surface-menu-key">{choice.shortcut}</kbd>
    </button>
  )
}

export function OpenSurfacePicker() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const store = useAppStore.getState()
      if (!store.mainAreaOpen || store.sidebarMode !== 'projects') return
      const target = event.target
      if (target instanceof HTMLElement && target.closest('input, textarea, [contenteditable="true"]')) return
      const choice = SURFACE_CHOICES.find((entry) => entry.shortcut.toLowerCase() === event.key.toLowerCase())
      if (!choice) return
      event.preventDefault()
      openSurface(choice.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="surface-picker">
      <SurfaceChoiceList />
    </div>
  )
}
