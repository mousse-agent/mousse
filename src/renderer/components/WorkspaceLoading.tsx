import { useEffect, useState } from 'react'
import { RefreshCw } from '../lib/icons'
import './workspace-loading.css'

/** A load that finishes sooner than this shows nothing, so a fast start does not flash a skeleton. */
export const WORKSPACE_SKELETON_DELAY_MS = 160

interface WorkspaceLoadingProps {
  error?: string | null
  onRetry?: () => void
  sidebarWidth?: number
  conversationOnly?: boolean
}

/**
 * Content placeholders; the real titlebar and navigation remain available. No text while loading:
 * the skeleton appears only once the load takes longer than `WORKSPACE_SKELETON_DELAY_MS`.
 * A failure shows one error block with Retry in the same place.
 */
export function WorkspaceLoading({ error, onRetry, sidebarWidth, conversationOnly = false }: WorkspaceLoadingProps) {
  const [skeleton, setSkeleton] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setSkeleton(true), WORKSPACE_SKELETON_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [])

  return (
    <div className={`workspace-loading${conversationOnly ? ' workspace-loading-conversation-only' : ''}`}
      aria-busy={!error} data-workspace-loading={conversationOnly ? 'content' : 'connection'}>
      {skeleton && !conversationOnly && sidebarWidth !== undefined && <aside className="workspace-loading-sidebar"
        style={{ width: sidebarWidth }} aria-hidden="true">
        <div className="workspace-loading-line workspace-loading-heading" />
        {[0, 1, 2, 3, 4].map((row) => <div key={row} className="workspace-loading-row">
          <span className="workspace-loading-icon" /><span className="workspace-loading-line" />
        </div>)}
      </aside>}
      <section className="workspace-loading-content">
        {error ? <div className="workspace-loading-error" role="alert">
          <p className="workspace-loading-error-title">
            {conversationOnly ? 'Could not load workspace' : 'Could not connect to workspace'}
          </p>
          <p className="workspace-loading-detail">{error}</p>
          <button type="button" className="workspace-loading-retry" onClick={onRetry}>
            <RefreshCw size={14} aria-hidden="true" />Retry
          </button>
        </div> : skeleton && <div className="workspace-loading-composer" aria-hidden="true">
          <span className="workspace-loading-line" /><span className="workspace-loading-icon" />
        </div>}
      </section>
    </div>
  )
}
