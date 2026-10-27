import { PanelLeft, PanelRightClose, PanelRightOpen, SidebarRight } from '../lib/icons'
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
          <div className="titlebar-brand">
            <button
              type="button"
              className="titlebar-sidebar-toggle"
              aria-label={threadsSidebarOpen ? 'Close threads sidebar' : 'Open threads sidebar'}
              title={threadsSidebarOpen ? 'Close threads sidebar' : 'Open threads sidebar'}
              onClick={() => setThreadsSidebarOpen(!threadsSidebarOpen)}
            >
              <PanelLeft size={16} strokeWidth={2} />
            </button>
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
        </div>
      </div>
      <div className="titlebar-controls">
        <div className="titlebar-app-actions">
          <IconButton
            icon={SidebarRight}
            label="Thread details"
            title={sideCardButtonTitle(sideCardUnavailable)}
            variant="titlebar"
            className={sideCardVisible ? 'titlebar-side-card-on' : undefined}
            aria-pressed={sideCardVisible}
            disabled={sideCardUnavailable !== null}
            onClick={toggleSideCard}
          />
          <IconButton
            icon={mainAreaOpen ? PanelRightClose : PanelRightOpen}
            label={mainAreaOpen ? 'Hide app panel' : 'Show app panel'}
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
