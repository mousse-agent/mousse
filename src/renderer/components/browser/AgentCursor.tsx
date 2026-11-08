import { useEffect, useRef, useState } from 'react'
import { AGENT_CURSOR_GLIDE_MS, AGENT_CURSOR_IDLE_MS, agentCursorClicks, type BrowserAgentCursor } from '../../../shared/browser/agentCursor'
import './agentCursor.css'

/**
 * The agent cursor (`src/shared/browser/agentCursor.ts`): a pointer drawn over a browser page, where
 * an agent is about to click, type or scroll. It glides there, ripples where a click lands and
 * fades out after a few idle seconds. It sits in its own layer above the page and takes no events,
 * so the page never sees it and an agent's observation never contains it. Place it inside an
 * element exactly covering the page: the point is placed by its share of the page's viewport.
 */
export function AgentCursor({ cursor, label }: { cursor?: BrowserAgentCursor; label?: string }) {
  const [shown, setShown] = useState(false)
  // It appears where it is, and glides from there to each next point.
  const wasShown = useRef(false)
  const glides = wasShown.current
  useEffect(() => { wasShown.current = shown }, [shown])
  const at = cursor?.at
  useEffect(() => {
    if (at === undefined) {
      setShown(false)
      return
    }
    const left = AGENT_CURSOR_IDLE_MS - (Date.now() - at)
    if (left <= 0) {
      setShown(false)
      return
    }
    setShown(true)
    const timer = setTimeout(() => setShown(false), left)
    return () => clearTimeout(timer)
  }, [at])
  if (!cursor || !(cursor.viewport.width > 0) || !(cursor.viewport.height > 0)) return null
  const left = `${Math.max(0, Math.min(100, (cursor.x / cursor.viewport.width) * 100))}%`
  const top = `${Math.max(0, Math.min(100, (cursor.y / cursor.viewport.height) * 100))}%`
  return <div className="agent-cursor-layer" aria-hidden data-agent-cursor>
    <div className={`agent-cursor${shown ? ' is-shown' : ''}${glides ? ' glides' : ''}`} style={{ left, top, ['--agent-cursor-glide' as string]: `${AGENT_CURSOR_GLIDE_MS}ms` }}>
      {shown && agentCursorClicks(cursor.action) && <span key={cursor.at} className="agent-cursor-ripple" />}
      <svg className="agent-cursor-pointer" width="22" height="22" viewBox="0 0 22 22">
        <path d="M3 2.2 18.4 9.3c.8.4.7 1.5-.1 1.8l-6.2 1.9-2.6 6.1c-.3.8-1.5.8-1.8-.1L2.2 3c-.2-.6.3-1.1.8-.8Z" />
      </svg>
      {label && <span className="agent-cursor-label">{label}</span>}
    </div>
  </div>
}
