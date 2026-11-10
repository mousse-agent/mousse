import { lazyNamed, preloadWhenIdle } from './lazyComponent'

/*
 * Pages and panels the main window does not draw on its first paint (rail pages, settings, the panel area's
 * surfaces, Chats). Each loads as its own chunk when first shown; `preloadSplitSurfaces` fetches them all once
 * the workspace has painted, so opening one later does not wait.
 */

export const SettingsPage = lazyNamed(() => import('../components/SettingsPage'), 'SettingsPage')
export const AutomationsPage = lazyNamed(() => import('../components/AutomationsPage'), 'AutomationsPage')
export const SubscriptionUsagePage = lazyNamed(() => import('../components/SubscriptionUsagePage'), 'SubscriptionUsagePage')
export const ChatWorkspace = lazyNamed(() => import('../components/chats/ChatWorkspace'), 'ChatWorkspace')
export const NewBotDialogHost = lazyNamed(() => import('../components/bots/NewBotDialog'), 'NewBotDialogHost')

export const FilesPanel = lazyNamed(() => import('../components/FilesPanel'), 'FilesPanel')
export const ProjectTerminalPanel = lazyNamed(() => import('../components/ProjectTerminalPanel'), 'ProjectTerminalPanel')
export const BrowserPanel = lazyNamed(() => import('../components/BrowserPanel'), 'BrowserPanel')
export const ChangesPanel = lazyNamed(() => import('../components/changes/ChangesPanel'), 'ChangesPanel')
export const PullRequestPanel = lazyNamed(() => import('../components/PullRequestPanel'), 'PullRequestPanel')
export const DocumentPanel = lazyNamed(() => import('../components/DocumentPanel'), 'DocumentPanel')

let preloaded = false

/** Once per window, after the workspace's first paint: most likely to open first, first. */
export function preloadSplitSurfaces(): void {
  if (preloaded) return
  preloaded = true
  preloadWhenIdle([
    ProjectTerminalPanel.preload,
    FilesPanel.preload,
    BrowserPanel.preload,
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
