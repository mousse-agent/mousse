import { useEffect, useSyncExternalStore } from 'react'
import type { Project } from '../../shared/types'
import type { ProjectIconImage } from '../../shared/projectIcon'

/** How long a window keeps a project's icon before asking the daemon again (the daemon answers from its own cache). */
export const PROJECT_ICON_REFRESH_MS = 15 * 60 * 1000

type IconProject = Pick<Project, 'id' | 'node' | 'iconPath' | 'iconOff' | 'detectedIconPath' | 'iconDetectedAt'>

interface Entry {
  key: string
  icon: ProjectIconImage | null
  fetchedAt: number
  pending?: Promise<void>
}

type IconReader = (projectId: string) => Promise<ProjectIconImage | null>

const entries = new Map<string, Entry>()
/** The projects shown lately, so coming back to the window refreshes their icons. */
const shown = new Map<string, IconProject>()
const listeners = new Set<() => void>()
/** Set when the daemon or the app does not serve icons (an older one): every project shows its folder. */
let unsupported = false

function notify(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function defaultReader(): IconReader | undefined {
  const reader = (globalThis as { mousse?: { projects?: { icon?: unknown } } }).mousse?.projects?.icon
  return typeof reader === 'function' ? (reader as IconReader) : undefined
}

let readIcon: () => IconReader | undefined = defaultReader

/** Tests: the reader icons come from, and a fresh cache. */
export function setProjectIconReaderForTests(reader: IconReader | undefined): void {
  readIcon = reader ? () => reader : defaultReader
  entries.clear()
  shown.clear()
  unsupported = false
}

/** Coming back to the window reads again the icons that are old, so a changed favicon shows up. */
function refreshShown(): void {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
  for (const project of shown.values()) ensureProjectIcon(project)
}

if (typeof window !== 'undefined') window.addEventListener('focus', refreshShown)

/** What a cached icon depends on: a change to the project's icon choice, or its being opened again, reads it again. */
export function projectIconKey(project: IconProject): string {
  return [project.iconOff ? 'off' : '', project.iconPath ?? '', project.detectedIconPath ?? '', project.iconDetectedAt ? '' : 'stale'].join('|')
}

/** Whether a project can have an image icon at all: only a project of this computer with icons on. */
export function canShowProjectIcon(project: IconProject | undefined): project is IconProject {
  return Boolean(project && !project.node && !project.iconOff)
}

/** Reads the project's icon when it is missing, its key changed, or it is old. */
export function ensureProjectIcon(project: IconProject, now = Date.now()): void {
  if (unsupported || !canShowProjectIcon(project)) return
  shown.set(project.id, project)
  const key = projectIconKey(project)
  const entry = entries.get(project.id)
  if (entry?.pending) return
  if (entry && entry.key === key && now - entry.fetchedAt < PROJECT_ICON_REFRESH_MS) return
  const reader = readIcon()
  if (!reader) {
    unsupported = true
    return
  }
  const next: Entry = { key, icon: entry?.icon ?? null, fetchedAt: entry?.fetchedAt ?? 0 }
  next.pending = reader(project.id)
    .then(
      (icon) => {
        next.icon = isIcon(icon) ? icon : null
      },
      (error: unknown) => {
        next.icon = null
        // A daemon from before icons does not know the method: stop asking.
        if (/unknown method|unhandled method|method not found|not supported/i.test(error instanceof Error ? error.message : String(error))) unsupported = true
      }
    )
    .finally(() => {
      next.fetchedAt = Date.now()
      delete next.pending
      if (entries.get(project.id) === next) notify()
    })
  entries.set(project.id, next)
}

function isIcon(value: unknown): value is ProjectIconImage {
  return Boolean(value && typeof (value as ProjectIconImage).dataUrl === 'string' && (value as ProjectIconImage).dataUrl.startsWith('data:image/'))
}

/** The project's icon as a data URL, or null for the folder glyph: another computer's project, icons off, or none found. */
export function projectIconUrl(project: IconProject | undefined): string | null {
  if (unsupported || !canShowProjectIcon(project)) return null
  return entries.get(project.id)?.icon?.dataUrl ?? null
}

/** The project's icon data URL, read on first use and when the project's icon choice changes; null shows the folder. */
export function useProjectIcon(project: IconProject | undefined): string | null {
  const url = useSyncExternalStore(subscribe, () => projectIconUrl(project), () => null)
  const key = project ? `${project.id}:${projectIconKey(project)}:${project.node ?? ''}` : ''
  useEffect(() => {
    if (project) ensureProjectIcon(project)
    // The key carries everything the icon depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return url
}
