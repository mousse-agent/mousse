import type { GitSetup } from '../../shared/gitSetup'
import { RefreshCw } from '../lib/icons'
import { LOADER_DELAY_MS, useShownAfter } from './ui/DelayedLoader'
import './workspace-loading.css'

/** A load that finishes sooner than this shows nothing, so a fast start does not flash a skeleton. */
export const WORKSPACE_SKELETON_DELAY_MS = LOADER_DELAY_MS

interface WorkspaceLoadingProps {
  error?: string | null
  onRetry?: () => void
  sidebarWidth?: number
  conversationOnly?: boolean
  gitSetup?: GitSetup
  onInstallGit?: () => void
}

/**
 * Content placeholders; the real titlebar and navigation remain available. No text while loading:
 * the skeleton appears only once the load takes longer than `WORKSPACE_SKELETON_DELAY_MS`.
 * A prerequisite download reports its own status immediately.
 * A failure shows one error block with Retry in the same place.
 */
export function WorkspaceLoading({ error, onRetry, sidebarWidth, conversationOnly = false, gitSetup, onInstallGit }: WorkspaceLoadingProps) {
  const required = gitSetup?.phase === 'required' ? gitSetup : undefined
  const gitError = gitSetup?.phase === 'failed' ? gitSetup.message : undefined
  const setup = gitSetup?.phase === 'downloading' || gitSetup?.phase === 'installing'
  const skeleton = useShownAfter(WORKSPACE_SKELETON_DELAY_MS)

  return (
    <div className={`workspace-loading${conversationOnly ? ' workspace-loading-conversation-only' : ''}`}
      aria-busy={!gitSetup && !error} data-workspace-loading={conversationOnly ? 'content' : 'connection'}>
      {skeleton && !conversationOnly && sidebarWidth !== undefined && <aside className="workspace-loading-sidebar"
        style={{ width: sidebarWidth }} aria-hidden="true">
        <div className="workspace-loading-line workspace-loading-heading" />
        {[0, 1, 2, 3, 4].map((row) => <div key={row} className="workspace-loading-row">
          <span className="workspace-loading-icon" /><span className="workspace-loading-line" />
        </div>)}
      </aside>}
      <section className="workspace-loading-content">
        {setup ? <div className="workspace-loading-error" role="status">
          <p className="workspace-loading-error-title">
            {gitSetup.phase === 'downloading' ? 'Downloading Git for Windows…'
              : gitSetup.native ? 'Installing Git…' : 'Setting up Git for Windows…'}
          </p>
          <p className="workspace-loading-detail">Mousse needs Git to start the workspace.</p>
        </div> : required ? <div className="workspace-loading-error" role="alert">
          <p className="workspace-loading-error-title">Git is required</p>
          <p className="workspace-loading-detail">{required.message}</p>
          <div className="workspace-loading-actions">
            {required.canInstall && <button type="button" className="workspace-loading-retry" onClick={onInstallGit}>
              Install Git
            </button>}
            <button type="button" className="workspace-loading-retry" onClick={onRetry}>
              <RefreshCw size={14} aria-hidden="true" />Retry
            </button>
          </div>
        </div> : (gitError || error) ? <div className="workspace-loading-error" role="alert">
          <p className="workspace-loading-error-title">
            {gitError ? 'Could not set up Git' : conversationOnly ? 'Could not load workspace' : 'Could not connect to workspace'}
          </p>
          <p className="workspace-loading-detail">{gitError || error}</p>
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
