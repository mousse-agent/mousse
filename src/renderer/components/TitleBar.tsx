import { useEffect, useState } from 'react'
import { PanelLeft, PanelRightClose, PanelRightOpen } from '../lib/icons'
import { WindowCloseButton } from './WindowCloseButton'
import { IconButton } from './IconButton'
import { QuickActionsButton } from './QuickActionsButton'
import { useAppStore } from '../stores/appStore'
import logoIcon from '../assets/mousse_logo_icon.svg'

function CaptionIcon({ children }: { children: React.ReactNode }) {
  return (
    <svg className="titlebar-caption-icon" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      {children}
    </svg>
  )
}

export function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false)
  const appInfo = useAppStore((s) => s.appInfo)
  const threadsSidebarOpen = useAppStore((s) => s.threadsSidebarOpen)
  const setThreadsSidebarOpen = useAppStore((s) => s.setThreadsSidebarOpen)
  const mainAreaOpen = useAppStore((s) => s.mainAreaOpen)
  const setMainAreaOpen = useAppStore((s) => s.setMainAreaOpen)
  const isMac = appInfo?.platform === 'darwin' || window.mousse.platform === 'darwin'

  useEffect(() => {
    window.mousse.window.isMaximized().then(setIsMaximized)
    return window.mousse.window.onMaximizedChange(setIsMaximized)
  }, [])

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
          <QuickActionsButton variant="titlebar" />
          <IconButton
            icon={mainAreaOpen ? PanelRightClose : PanelRightOpen}
            label={mainAreaOpen ? 'Hide app panel' : 'Show app panel'}
            variant="titlebar"
            className={mainAreaOpen ? 'titlebar-panel-open' : undefined}
            onClick={() => setMainAreaOpen(!mainAreaOpen)}
          />
        </div>
        {!isMac && (
          <>
            <button type="button" className="icon-btn icon-btn-titlebar" title="Minimize" aria-label="Minimize" onClick={() => window.mousse.window.minimize()}>
              <CaptionIcon><path d="M2 6h8" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" /></CaptionIcon>
            </button>
            <button type="button" className="icon-btn icon-btn-titlebar" title={isMaximized ? 'Restore' : 'Maximize'} aria-label={isMaximized ? 'Restore' : 'Maximize'} onClick={() => window.mousse.window.maximize()}>
              <CaptionIcon>
                {isMaximized
                  ? <path d="M4 2.25h5.75V8M2.25 4.25h5.75V10" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
                  : <rect x="2.15" y="2.15" width="7.7" height="7.7" stroke="currentColor" strokeWidth="1.25" />}
              </CaptionIcon>
            </button>
            <WindowCloseButton onClose={() => { void window.mousse.window.close() }}>
              <CaptionIcon><path d="M3.1 3.1l5.8 5.8M8.9 3.1L3.1 8.9" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" /></CaptionIcon>
            </WindowCloseButton>
          </>
        )}
      </div>
    </header>
    </>
  )
}
