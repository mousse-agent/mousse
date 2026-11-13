import { Globe } from '../../lib/icons'
import type { ThreadBrowserView as View } from '../../../shared/browser/threadView'
import { threadBrowserKit, useThreadBrowser, useThreadBrowserStore } from '../../stores/threadBrowserStore'
import { WatchedBrowserPane, watchedBrowserStatus, type WatchedBrowserHolding } from './WatchedBrowserPane'
import './threadBrowser.css'

/**
 * A thread agent's browser without a window, in that thread's Browser panel. While the agent has one
 * open, the panel shows one line for it (its state and View); View opens it over the panel's tabs, where
 * the person watches it and can take it over, as in a bot's split view. Nothing streams until View.
 */

/** What the panel's line says of the browser, in a word or two. */
function rowStatus(view: View): string {
  if (view.asks !== undefined) return 'Asks for you'
  return watchedBrowserStatus(view, undefined, 'The agent', Date.now()).text
}

function hostOf(url: string | undefined): string {
  if (!url) return ''
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** The line in the panel while the thread's agent has a browser without a window open; nothing otherwise. */
export function ThreadBrowserRow({ threadId, active }: { threadId: string; active: boolean }) {
  const view = useThreadBrowser(threadId, !active)
  const paneOpen = useThreadBrowserStore((state) => state.pane === threadId)
  if (!view || paneOpen || !(view.open || view.stopped)) return null
  const status = view.open ? rowStatus(view) : 'Stopped'
  const site = view.tab?.title || hostOf(view.tab?.url)
  return <div className="thread-browser-row" role="region" aria-label="The agent's browser">
    <Globe size={13} aria-hidden />
    <span className="thread-browser-row-name" title={view.asks || site || undefined}>Agent's browser{status ? ` · ${status}` : ''}</span>
    <button type="button" title="Watch it here, and take it over" onClick={() => useThreadBrowserStore.getState().openPane(threadId)}>View</button>
  </div>
}

/** The open view of the thread's browser, over the panel's tabs, until the person closes it. */
export function ThreadBrowserLayer({ threadId }: { threadId: string }) {
  const paneOpen = useThreadBrowserStore((state) => state.pane === threadId)
  const view = useThreadBrowserStore((state) => state.views[threadId])
  if (!paneOpen || !view) return null
  const line = (holding: WatchedBrowserHolding): string => {
    if (holding === 'this-window') return 'You have the agent\'s browser. Give it back when you\'re done.'
    if (holding === 'another-window') return view.asks !== undefined ? 'The agent asks for you. Take over to help.' : 'Held in another window. Take over to use it here.'
    if (holding === 'agent') return 'The agent\'s browser, without a window. Take over to click or type.'
    return 'No browser is open for this thread.'
  }
  return <div className="thread-browser-layer">
    <WatchedBrowserPane kit={threadBrowserKit} browserKey={threadId} label="The agent's browser" user="The agent" view={view}
      closed={() => <p>No browser open</p>}
      line={line}
      lineDetail={(holding) => holding === 'another-window' && view.asks ? view.asks : undefined} />
  </div>
}
