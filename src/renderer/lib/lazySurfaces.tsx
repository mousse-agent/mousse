import { useEffect } from 'react'
import { create } from 'zustand'
import { LoadFailed, lazyNamed, preloadWhenIdle, type LoadFailedProps } from './lazyComponent'
import { Modal } from '../components/ui/Modal'
import { useAppStore } from '../stores/appStore'
import { useBotsStore } from '../stores/botsStore'

/*
 * Pages and panels the main window does not draw on its first paint (rail pages, settings, the panel area's
 * surfaces, Chats). Each loads as its own chunk when first shown; `preloadSplitSurfaces` fetches them all once
 * the workspace has painted, so opening one later does not wait. A chunk that fails to load shows a
 * "Couldn't load. Retry" state where the page or panel would be.
 */

/** Settings is an overlay: a failed load shows in a dialog that also closes it, and nothing while closed. */
function SettingsLoadFailed({ retry, reload }: LoadFailedProps) {
  const open = useAppStore((state) => state.settingsOpen)
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen)
  return <Modal open={open} title="Settings" onClose={() => setSettingsOpen(false)}><LoadFailed retry={retry} reload={reload} /></Modal>
}

/** The Automations page is mounted while hidden; a failed load keeps its hidden shell. */
function AutomationsLoadFailed({ retry, reload }: LoadFailedProps) {
  const open = useAppStore((state) => state.scheduledOpen)
  return <div className="automations-page" hidden={!open}><LoadFailed retry={retry} reload={reload} /></div>
}

function NewBotLoadFailed({ retry, reload }: LoadFailedProps) {
  const close = useBotsStore((state) => state.closeNewBot)
  return <Modal open title="New bot" onClose={close}><LoadFailed retry={retry} reload={reload} /></Modal>
}

export const SettingsPage = lazyNamed(() => import('../components/SettingsPage'), 'SettingsPage', SettingsLoadFailed)
export const AutomationsPage = lazyNamed(() => import('../components/AutomationsPage'), 'AutomationsPage', AutomationsLoadFailed)
export const SubscriptionUsagePage = lazyNamed(() => import('../components/SubscriptionUsagePage'), 'SubscriptionUsagePage')
export const ChatWorkspace = lazyNamed(() => import('../components/chats/ChatWorkspace'), 'ChatWorkspace')
export const NewBotDialogHost = lazyNamed(() => import('../components/bots/NewBotDialog'), 'NewBotDialogHost', NewBotLoadFailed)

export const FilesPanel = lazyNamed(() => import('../components/FilesPanel'), 'FilesPanel')
export const ProjectTerminalPanel = lazyNamed(() => import('../components/ProjectTerminalPanel'), 'ProjectTerminalPanel')
export const BrowserPanel = lazyNamed(() => import('../components/BrowserPanel'), 'BrowserPanel')
export const ChangesPanel = lazyNamed(() => import('../components/changes/ChangesPanel'), 'ChangesPanel')
export const PullRequestPanel = lazyNamed(() => import('../components/PullRequestPanel'), 'PullRequestPanel')
export const DocumentPanel = lazyNamed(() => import('../components/DocumentPanel'), 'DocumentPanel')

/** The panel area's tabs that stay mounted once mounted (their editors, PTYs and browser guests live there). */
export type KeptPanel = 'files' | 'terminal' | 'browser'

/** Which kept panels have mounted. A panel mounts the first time it is needed or the idle warm-up reaches it. */
export const useKeptPanels = create<Record<KeptPanel, boolean>>(() => ({ files: false, terminal: false, browser: false }))

export function mountKeptPanel(panel: KeptPanel): void {
  if (!useKeptPanels.getState()[panel]) useKeptPanels.setState({ [panel]: true })
}

/** True once `panel` should be mounted: while `needed`, and from then on. */
export function useKeptPanel(panel: KeptPanel, needed: boolean): boolean {
  const mounted = useKeptPanels((state) => state[panel])
  useEffect(() => {
    if (needed) mountKeptPanel(panel)
  }, [panel, needed])
  return mounted || needed
}

/** Loads a kept panel's chunk, then mounts it hidden, so the tab opens at once later. */
const warmKeptPanel = (panel: KeptPanel, preload: () => Promise<unknown>) => () =>
  preload().then(() => mountKeptPanel(panel))

let preloaded = false

/** Once per window, after the workspace's first paint: most likely to open first, first. */
export function preloadSplitSurfaces(): void {
  if (preloaded) return
  preloaded = true
  void preloadWhenIdle([
    warmKeptPanel('terminal', ProjectTerminalPanel.preload),
    warmKeptPanel('files', FilesPanel.preload),
    warmKeptPanel('browser', BrowserPanel.preload),
    ChangesPanel.preload,
    // The edit row's diff and the Markdown preview's highlighter (each module loads its own part on demand).
    () => import('../chat/components/agent-elements/tools/edit-tool').then((module) => module.preloadEditDiff()),
    () => import('../components/editors/MarkdownPreview').then((module) => module.preloadMarkdownHighlight()),
    PullRequestPanel.preload,
    DocumentPanel.preload,
    SettingsPage.preload,
    AutomationsPage.preload,
    SubscriptionUsagePage.preload,
    ChatWorkspace.preload,
    NewBotDialogHost.preload
  ])
}
