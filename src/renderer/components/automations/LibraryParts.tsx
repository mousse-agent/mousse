import { RefreshCw } from '../../lib/icons'
import './automations.css'

/**
 * Connects the configured MCP servers and reads installed skills and tools again, so the agent and
 * workflow editors list what is there now. Only the Agents and Workflows libraries show it.
 */
export function RefreshToolsButton({ refreshing, onRefresh }: { refreshing: boolean; onRefresh: () => void }) {
  return (
    <button
      type="button"
      className="settings-icon-btn"
      data-action="refresh-tools"
      title="Connect servers and refresh tools"
      aria-label={refreshing ? 'Refreshing tools' : 'Refresh tools'}
      aria-busy={refreshing || undefined}
      disabled={refreshing}
      onClick={onRefresh}
    >
      <RefreshCw size={14} className={refreshing ? 'spin' : undefined} />
    </button>
  )
}
