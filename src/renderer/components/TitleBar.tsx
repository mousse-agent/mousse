import { useEffect, useState } from 'react'
import { Minus, Square, X, Copy, Settings, PanelLeft } from 'lucide-react'
import { IconButton } from './IconButton'
import { useAppStore } from '../stores/appStore'
import logoIcon from '../assets/mousse_logo_icon.svg'

export function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false)
  const appInfo = useAppStore((s) => s.appInfo)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const threadsSidebarOpen = useAppStore((s) => s.threadsSidebarOpen)
  const setThreadsSidebarOpen = useAppStore((s) => s.setThreadsSidebarOpen)
  const isMac = appInfo?.platform === 'darwin' || window.mousse.platform === 'darwin'

  useEffect(() => {
    window.mousse.window.isMaximized().then(setIsMaximized)
    return window.mousse.window.onMaximizedChange(setIsMaximized)
  }, [])

  return (
    <header className="titlebar">
      <div
        className="titlebar-drag"
        onDoubleClick={() => window.mousse.window.maximize()}
      >
        <div className="titlebar-left">
          <div className="titlebar-brand">
            <button
              type="button"
              className="titlebar-sidebar-toggle"
              aria-label={threadsSidebarOpen ? 'Close threads sidebar' : 'Open threads sidebar'}
              title={threadsSidebarOpen ? 'Close threads sidebar' : 'Open threads sidebar'}
              onClick={() => setThreadsSidebarOpen(!threadsSidebarOpen)}
            >
              <PanelLeft size={22} strokeWidth={2} />
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
        <IconButton
          icon={Settings}
          label="Settings"
          variant="titlebar"
          className="titlebar-settings-btn"
          onClick={() => setSettingsOpen(true)}
        />
        {!isMac && (
          <>
            <IconButton
              icon={Minus}
              label="Minimize"
              variant="titlebar"
              onClick={() => window.mousse.window.minimize()}
            />
            <IconButton
              icon={isMaximized ? Copy : Square}
              label={isMaximized ? 'Restore' : 'Maximize'}
              variant="titlebar"
              onClick={() => window.mousse.window.maximize()}
            />
            <IconButton
              icon={X}
              label="Close"
              variant="titlebar"
              className="titlebar-close"
              onClick={() => window.mousse.window.close()}
            />
          </>
        )}
      </div>
    </header>
  )
}
