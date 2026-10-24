import { useEffect, useState } from 'react'
import { WindowCloseButton } from './WindowCloseButton'
import { useAppStore } from '../stores/appStore'

function CaptionIcon({ children }: { children: React.ReactNode }) {
  return (
    <svg className="titlebar-caption-icon" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      {children}
    </svg>
  )
}

/** Minimize, maximize and close for the frameless window. macOS draws native
 * traffic lights instead, so this renders nothing there. Full-window pages
 * that cover the title bar (Settings) render their own copy. */
export function WindowCaptionButtons() {
  const [isMaximized, setIsMaximized] = useState(false)
  const appInfo = useAppStore((s) => s.appInfo)
  const isMac = appInfo?.platform === 'darwin' || window.mousse.platform === 'darwin'

  useEffect(() => {
    if (isMac) return
    void window.mousse.window.isMaximized().then(setIsMaximized)
    return window.mousse.window.onMaximizedChange(setIsMaximized)
  }, [isMac])

  if (isMac) return null

  return (
    <>
      <button type="button" className="icon-btn icon-btn-titlebar" title="Minimize" aria-label="Minimize" onClick={() => { void window.mousse.window.minimize() }}>
        <CaptionIcon><path d="M2 6h8" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" /></CaptionIcon>
      </button>
      <button type="button" className="icon-btn icon-btn-titlebar" title={isMaximized ? 'Restore' : 'Maximize'} aria-label={isMaximized ? 'Restore' : 'Maximize'} onClick={() => { void window.mousse.window.maximize() }}>
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
  )
}
