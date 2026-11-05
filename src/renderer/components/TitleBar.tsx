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

export function TitleBar() {
  const threadsSidebarOpen = useAppStore((s) => s.threadsSidebarOpen)
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
          {/* The logo only marks the drag area above the rail; the actions follow it. */}
          <img
            className="titlebar-logo-icon"
            src={logoIcon}
            alt=""
            aria-hidden="true"
            draggable={false}
          />
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
