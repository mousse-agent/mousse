import type { CSSProperties, MouseEvent, PointerEvent, ReactNode, Ref } from 'react'
import { Globe } from '../../lib/icons'
import type { WatchedBrowserView } from '../../../shared/browser/watched'
import { AgentCursor } from './AgentCursor'
import './watchedBrowser.css'

function frameSrc(view: Pick<WatchedBrowserView, 'frame'>): string | undefined {
  return view.frame ? `data:${view.frame.mimeType};base64,${view.frame.data}` : undefined
}

/**
 * The picture of a watched browser's tab at its page's shape, with the agent cursor over it. Its user
 * styles it (`watched-browser-frame`) and lays its own controls over it (`children`).
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
  // The page's shape: the large view fits the whole picture in its stage by it (`--watched-frame-aspect`).
  const shape = { aspectRatio: `${viewport.width} / ${viewport.height}`, '--watched-frame-aspect': viewport.width / viewport.height } as CSSProperties
  return <div ref={frameRef} className={`watched-browser-frame${className ? ` ${className}` : ''}`} style={shape} {...events}>
    {src
      ? <img src={src} alt={view.tab?.title || label} draggable={false} />
      : <div className="watched-browser-frame-empty">{!view.setup && <Globe size={22} aria-hidden />}</div>}
    {view.open && <AgentCursor cursor={view.cursor} />}
    {view.setup && <div className="watched-browser-closed" role="status"><p>Setting up the browser on this computer{view.setup.percent !== undefined ? ` · ${view.setup.percent}%` : '…'}</p></div>}
    {children}
  </div>
}
