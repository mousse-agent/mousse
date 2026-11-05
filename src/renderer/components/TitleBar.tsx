import { Edit, Info, PanelLeft, PanelRightClose, PanelRightOpen, Search } from '../lib/icons'
import { useShortcutTitle } from '../commands/commandRegistry'
import { createAndSelectThread } from '../lib/threadActions'
import { useChatsStore } from '../stores/chatsStore'
import { WindowCaptionButtons } from './WindowCaptionButtons'
import { IconButton } from './IconButton'
import {
  applySideCardToggle,
  nextSideCardToggleState,
  sideCardButtonTitle,
  useSideCardMode,
  useSideCardUnavailable,
  useSideCardVisible
} from './sideCard/sideCardLogic'
import { useAppStore } from '../stores/appStore'
import { channelForVersion } from '../../shared/updates'
import stableLogoIcon from '../assets/mousse_logo_icon.svg'
import nightlyLogoIcon from '../assets/mousse_logo_icon_nightly.webp'

/** Set at build time from package.json (electron.vite.config.ts). */
declare const __MOUSSE_VERSION__: string | undefined
const BUILD_VERSION = typeof __MOUSSE_VERSION__ === 'string' ? __MOUSSE_VERSION__ : ''
const logoIcon = channelForVersion(BUILD_VERSION) === 'nightly' ? nightlyLogoIcon : stableLogoIcon

/**
 * What the title bar names while the sidebar is closed: "<thread> · <project>" for the open thread,
 * or null when the sidebar is open, no thread is open, or another view (agent chats, Usage) replaces it.
 */
export function titlebarThreadLabel(
  state: Pick<
    ReturnType<typeof useAppStore.getState>,
    'threadsSidebarOpen' | 'sidebarMode' | 'usageOpen' | 'scheduledOpen' | 'activeThreadId' | 'threads' | 'projects'
  >
): string | null {
  // Usage and Automations replace the thread view, so there is no open thread to name.
  if (state.threadsSidebarOpen || state.sidebarMode === 'chats' || state.usageOpen || state.scheduledOpen || !state.activeThreadId) return null
  const thread = state.threads.find((candidate) => candidate.id === state.activeThreadId)
  if (!thread) return null
  const project = thread.projectId ? state.projects.find((candidate) => candidate.id === thread.projectId) : undefined
  return project ? `${thread.name} · ${project.name}` : thread.name
}

export function TitleBar() {
  const threadsSidebarOpen = useAppStore((s) => s.threadsSidebarOpen)
  const threadLabel = useAppStore(titlebarThreadLabel)
  const setThreadsSidebarOpen = useAppStore((s) => s.setThreadsSidebarOpen)
  const mainAreaOpen = useAppStore((s) => s.mainAreaOpen)
  const setMainAreaOpen = useAppStore((s) => s.setMainAreaOpen)
  const sideCardVisible = useSideCardVisible()
  const sideCardMode = useSideCardMode()
  const sideCardUnavailable = useSideCardUnavailable()
  // In the Chats tab, New and Search act on agent chats.
  const chatsMode = useAppStore((s) => s.sidebarMode === 'chats')
  const sidebarLabel = threadsSidebarOpen ? 'Hide sidebar' : 'Show sidebar'
  const sidebarTitle = useShortcutTitle(sidebarLabel, 'sidebar.toggle')
  const newThreadTitle = useShortcutTitle('New thread', 'thread.new')
  const searchTitle = useShortcutTitle('Search threads', 'threads.search')
  const detailsTitle = useShortcutTitle('Thread details', 'sideCard.toggle')
  // A disabled button explains why instead of offering its key.
  const sideCardTitle = sideCardUnavailable ? sideCardButtonTitle(sideCardUnavailable) : detailsTitle
  const panelLabel = mainAreaOpen ? 'Hide panel' : 'Show panel'
  const panelTitle = useShortcutTitle(panelLabel, 'mainArea.toggle')

  const toggleSideCard = () => {
    const { sideCardOn, mainAreaOpen, sideCardOverlayOpen } = useAppStore.getState()
    applySideCardToggle(nextSideCardToggleState(sideCardVisible, { sideCardOn, mainAreaOpen, sideCardOverlayOpen }, sideCardMode))
  }

  return (
    <>
    <header className="titlebar">
      {/* Double-click maximize is handled natively by -webkit-app-region: drag.
          Do not also call maximize() here — that toggles and undoes the OS maximize. */}
      <div className="titlebar-drag">
        <div className="titlebar-left">
          {/* The logo and the word are part of the drag area; the actions follow them. */}
          <div className="titlebar-brand">
            <img
              className="titlebar-logo-icon"
              src={logoIcon}
              alt=""
              aria-hidden="true"
              draggable={false}
            />
            <span
              className={`titlebar-title${threadsSidebarOpen ? ' titlebar-title-visible' : ''}`}
            >
              Mousse
            </span>
          </div>
          <div className="titlebar-start-actions">
            <IconButton
              icon={PanelLeft}
              label={sidebarLabel}
              title={sidebarTitle}
              variant="titlebar"
              className="titlebar-sidebar-toggle"
              aria-expanded={threadsSidebarOpen}
              onClick={() => setThreadsSidebarOpen(!threadsSidebarOpen)}
            />
            <IconButton
              icon={Edit}
              label={chatsMode ? 'New chat' : 'New thread'}
              title={chatsMode ? 'New chat' : newThreadTitle}
              variant="titlebar"
              onClick={() => {
                if (chatsMode) useChatsStore.setState({ newChatOpen: true, newChatKind: 'direct' })
                else void createAndSelectThread()
              }}
            />
            <IconButton
              icon={Search}
              label={chatsMode ? 'Search chats' : 'Search threads'}
              title={chatsMode ? 'Search chats' : searchTitle}
              variant="titlebar"
              onClick={() => {
                if (chatsMode) useChatsStore.setState({ searchOpen: true })
                else useAppStore.getState().setThreadSearchOpen(true)
              }}
            />
          </div>
        </div>
        {/* Part of the drag area: the label takes no pointer events, so dragging on it moves the window. */}
        {threadLabel && <div className="titlebar-thread-label">{threadLabel}</div>}
      </div>
      <div className="titlebar-controls">
        <div className="titlebar-app-actions">
          <IconButton
            icon={Info}
            label="Thread details"
            title={sideCardTitle}
            variant="titlebar"
            className={sideCardVisible ? 'titlebar-side-card-on' : undefined}
            aria-pressed={sideCardVisible}
            disabled={sideCardUnavailable !== null}
            onClick={toggleSideCard}
          />
          <IconButton
            icon={mainAreaOpen ? PanelRightClose : PanelRightOpen}
            label={panelLabel}
            title={panelTitle}
            variant="titlebar"
            className={mainAreaOpen ? 'titlebar-panel-open' : undefined}
            onClick={() => setMainAreaOpen(!mainAreaOpen)}
          />
        </div>
        <WindowCaptionButtons />
      </div>
    </header>
    </>
  )
}
