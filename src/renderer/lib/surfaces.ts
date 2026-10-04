import type { MainView } from '../../shared/types'
import type { BrowserTabState, ProjectTerminalTab } from '../../shared/types'
import { useAppStore } from '../stores/appStore'

export interface SurfaceChoice {
  id: MainView
  label: string
  shortcut: string
}

export const SURFACE_CHOICES: SurfaceChoice[] = [
  { id: 'browser', label: 'Browser', shortcut: 'B' },
  { id: 'terminal', label: 'Terminal', shortcut: 'T' },
  { id: 'files', label: 'Files', shortcut: 'F' },
  { id: 'git', label: 'Diff', shortcut: 'D' }
]

export interface SurfaceTabItem {
  key: string
  view: MainView
  label: string
  resourceId?: string
  closable: boolean
}

export function surfaceTabItems(input: {
  hasAgents: boolean
  opened: readonly MainView[]
  terminals: ProjectTerminalTab[]
  browsers: BrowserTabState[]
  documents: Array<{ id: string; title: string }>
}): SurfaceTabItem[] {
  const items: SurfaceTabItem[] = []
  if (input.hasAgents) {
    items.push({ key: 'agents', view: 'agents', label: 'Agents', closable: false })
  }
  for (const kind of input.opened) {
    if (kind === 'terminal') {
      input.terminals.forEach((tab) => {
        items.push({
          key: `terminal:${tab.id}`,
          view: 'terminal',
          label: tab.title || 'Terminal',
          resourceId: tab.id,
          closable: true
        })
      })
    } else if (kind === 'browser') {
      input.browsers.forEach((tab, index) => {
        const named = tab.title && tab.title !== 'New tab' && tab.title !== 'about:blank'
        items.push({
          key: `browser:${tab.id}`,
          view: 'browser',
          label: named ? tab.title : input.browsers.length > 1 ? `Browser ${index + 1}` : 'Browser',
          resourceId: tab.id,
          closable: true
        })
      })
    } else if (kind === 'files') {
      items.push({ key: 'files', view: 'files', label: 'Files', closable: true })
    } else if (kind === 'git') {
      items.push({ key: 'git', view: 'git', label: 'Diff', closable: true })
    }
  }
  input.documents.forEach((tab) => {
    items.push({
      key: `documents:${tab.id}`,
      view: 'documents',
      label: tab.title || 'Document',
      resourceId: tab.id,
      closable: true
    })
  })
  return items
}

export function openSurface(kind: MainView, another = false): void {
  const store = useAppStore.getState()
  const threadId = store.activeThreadId
  if (kind === 'terminal') {
    const visible = store.projectTerminalTabs.filter(
      (tab) => tab.ownerThreadId === threadId || tab.ownerThreadId === null
    )
    if (another || visible.length === 0) store.addProjectTerminalTab(threadId)
  }
  if (kind === 'browser') {
    const visible = store.browserTabs.filter(
      (tab) => tab.ownerThreadId === threadId || tab.ownerThreadId === null
    )
    if (another || visible.length === 0) store.addBrowserTab(threadId)
  }
  store.openSurfaceKind(kind)
}
