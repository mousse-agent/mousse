import { useInboxShowsThread } from './automations/inbox/inboxStore'
import { Suspense, useEffect } from 'react'
// Each surface is its own chunk, loaded when the panel first draws it and preloaded once the window has painted.
import { BrowserPanel, ChangesPanel, DocumentPanel, FilesPanel, ProjectTerminalPanel, PullRequestPanel, mountKeptPanel, useKeptPanel } from '../lib/lazySurfaces'
// Shared markdown rules, once loaded here with the Documents panel: kept in place so the stylesheet's order holds.
import '../styles/chat-markdown.css'
import { KeepMounted, KeepMountedStack } from './KeepMounted'
import { useAppStore } from '../stores/appStore'
import { onFileLinkHeld } from '../services/fileLinks'
import { surfaceTabItems } from '../lib/surfaces'
import { OpenSurfacePicker } from './OpenSurfaceMenu'
import { ComputerSurfaceNote } from './ComputerSurfaceNote'

/** A file link that the Files tab cannot open yet (services/fileLinks holds it) mounts the tab. */
function useHeldFileLinks() {
  useEffect(() => onFileLinkHeld(() => mountKeptPanel('files')), [])
}

/**
 * The panel area's tabs. `open` is false while the panel is closed: it then stays mounted, faded out, for terminals
 * and browser guests, so every other tab draws nothing until it opens again.
 */
export function MainViewPanel({ open = true }: { open?: boolean }) {
  const selectedView = useAppStore((s) => s.mainView)
  const mainAreaOpen = useAppStore((s) => s.mainAreaOpen) && open
  // The Automations page covers the panel, except while it shows a run's thread (the panel then serves that thread).
  const inboxThread = useInboxShowsThread()
  const overlayOpen = useAppStore((s) => s.settingsOpen || s.usageOpen || (s.scheduledOpen && !inboxThread))
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const opened = useAppStore((s) => s.openedSurfaceKinds)
  const terminals = useAppStore((s) => s.projectTerminalTabs)
  const browsers = useAppStore((s) => s.browserTabs)
  const documentTabs = useAppStore((s) => s.documentTabs)
  const documentsTabVisible = useAppStore((s) => s.documentsTabVisible)
  const documents = documentsTabVisible ? documentTabs : []
  const items = surfaceTabItems({
    opened,
    terminals: terminals.filter((tab) => tab.ownerThreadId === activeThreadId || tab.ownerThreadId === null),
    browsers: browsers.filter((tab) => tab.ownerThreadId === activeThreadId || tab.ownerThreadId === null),
    documents
  })
  // A thread without surfaces shows the picker, but every thread's terminals and
  // browser guests stay mounted: an agent's tab must load and attach while hidden.
  const empty = items.length === 0
  const mainView = empty ? null : selectedView

  // Files, Terminal and Browser stay mounted once mounted. Each mounts the first time it shows, has tabs to keep
  // (restored or opened by an agent while hidden), or the idle warm-up after the first paint reaches it.
  const visible = mainAreaOpen && !overlayOpen
  const filesMounted = useKeptPanel('files', mainView === 'files' && visible)
  const terminalMounted = useKeptPanel('terminal', (mainView === 'terminal' && visible) || terminals.length > 0)
  const browserMounted = useKeptPanel('browser', (mainView === 'browser' && visible) || browsers.length > 0)
  useHeldFileLinks()

  const transientPanel = (() => {
    if (!mainAreaOpen || overlayOpen) return null
    if (empty) return <OpenSurfacePicker />
    switch (mainView) {
      case 'git': return <ChangesPanel />
      case 'pullRequest': return <PullRequestPanel />
      case 'documents': return <DocumentPanel />
      default: return null
    }
  })()

  return (
    <KeepMountedStack>
      {/* xterm keeps its scrollback while another tab shows. The Files tab keeps open files and their edits, but its
          tree and editor unmount until it shows again; they come back with their open folders, scroll and selection.
          While a surface's chunk loads its pane stays empty: the pane itself keeps its size. */}
      <KeepMounted active={mainView === 'files'} className="keep-mounted-pane">
        {filesMounted && <Suspense fallback={null}><FilesPanel showing={mainView === 'files' && visible} /></Suspense>}
      </KeepMounted>
      <KeepMounted active={mainView === 'terminal'} className="keep-mounted-pane">
        {terminalMounted && <Suspense fallback={null}><ProjectTerminalPanel /></Suspense>}
      </KeepMounted>
      <KeepMounted active={mainView === 'browser'} preserveLayout className="keep-mounted-pane">
        {browserMounted && <Suspense fallback={null}><BrowserPanel active={mainView === 'browser' && visible} /></Suspense>}
      </KeepMounted>
      {mainView !== 'files' && mainView !== 'terminal' && mainView !== 'browser' && (
        <div className="keep-mounted-pane"><Suspense fallback={null}>{transientPanel}</Suspense></div>
      )}
      {!empty && <ComputerSurfaceNote />}
    </KeepMountedStack>
  )
}
