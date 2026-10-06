import './workspace-loading.css'

interface WorkspaceLoadingProps {
  error?: string | null
  onRetry?: () => void
  sidebarWidth?: number
  conversationOnly?: boolean
}

/** Content placeholders; the real titlebar and navigation remain available. */
export function WorkspaceLoading({ error, onRetry, sidebarWidth, conversationOnly = false }: WorkspaceLoadingProps) {
  return (
    <div className={`workspace-loading${conversationOnly ? ' workspace-loading-conversation-only' : ''}`}
      aria-busy={!error} data-workspace-loading={conversationOnly ? 'content' : 'connection'}>
      {!conversationOnly && sidebarWidth !== undefined && <aside className="workspace-loading-sidebar"
        style={{ width: sidebarWidth }} aria-hidden="true">
        <div className="workspace-loading-line workspace-loading-heading" />
        {[0, 1, 2, 3, 4].map((row) => <div key={row} className="workspace-loading-row">
          <span className="workspace-loading-icon" /><span className="workspace-loading-line" />
        </div>)}
      </aside>}
      <section className="workspace-loading-content">
        {error ? <div className="workspace-loading-status" role="alert">
          <p>Could not connect to workspace</p>
          <p className="workspace-loading-detail">{error}</p>
          <button type="button" onClick={onRetry}>Retry</button>
        </div> : <>
          <div className="workspace-loading-status" role="status">
            {conversationOnly ? 'Loading workspace…' : 'Connecting to workspace…'}
          </div>
          <div className="workspace-loading-composer" aria-hidden="true">
            <span className="workspace-loading-line" /><span className="workspace-loading-icon" />
          </div>
        </>}
      </section>
    </div>
  )
}
