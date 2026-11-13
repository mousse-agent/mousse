import type { MouseEvent, PointerEvent, ReactNode, Ref } from 'react'
import { Globe } from '../../lib/icons'
import type { WatchedBrowserView } from '../../../shared/browser/watched'
import { AgentCursor } from './AgentCursor'

function frameSrc(view: Pick<WatchedBrowserView, 'frame'>): string | undefined {
  return view.frame ? `data:${view.frame.mimeType};base64,${view.frame.data}` : undefined
}

/**
 * The picture of a watched browser's tab at its page's shape, with the agent cursor over it. Its user
 * styles it (`bot-browser-frame`) and lays its own controls over it (`children`).
 */
export function WatchedBrowserFrame({ label, view, children, className, ...handlers }: {
  /** The picture's name while its tab has none (the browser's own name). */
  label: string
  /** `setup`: the browser is being set up on this computer (its first use), and how far. */
  view: Pick<WatchedBrowserView, 'open' | 'frame' | 'cursor' | 'tab'> & { setup?: { percent?: number } }
  children?: ReactNode
  className?: string
  onPointerDown?(event: PointerEvent<HTMLDivElement>): void
  onPointerMove?(event: PointerEvent<HTMLDivElement>): void
  onPointerUp?(event: PointerEvent<HTMLDivElement>): void
  onPointerCancel?(event: PointerEvent<HTMLDivElement>): void
  onContextMenu?(event: MouseEvent<HTMLDivElement>): void
  frameRef?: Ref<HTMLDivElement>
}) {
  const src = frameSrc(view)
  const viewport = view.frame?.viewport ?? { width: 16, height: 10 }
  const { frameRef, ...events } = handlers
  return <div ref={frameRef} className={`bot-browser-frame${className ? ` ${className}` : ''}`} style={{ aspectRatio: `${viewport.width} / ${viewport.height}` }} {...events}>
    {src
      ? <img src={src} alt={view.tab?.title || label} draggable={false} />
      : <div className="bot-browser-frame-empty">{!view.setup && <Globe size={22} aria-hidden />}</div>}
    {view.open && <AgentCursor cursor={view.cursor} />}
    {view.setup && <div className="bot-browser-closed" role="status"><p>Setting up the browser on this computer{view.setup.percent !== undefined ? ` · ${view.setup.percent}%` : '…'}</p></div>}
    {children}
  </div>
}
