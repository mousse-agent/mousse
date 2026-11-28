import { useRef } from 'react'
import { Globe, Maximize } from '../../lib/icons'
import type { BotSummary } from '../../../shared/bots/personal/chat'
import { BOT_BROWSER_PREVIEW_WATCH, type BotBrowserView } from '../../../shared/bots/personal/browser'
import { botBrowserKit, useBotBrowserStore, useBotBrowserStream, useBotBrowserWatch, type BotBrowserStream } from '../../stores/botBrowserStore'
import { WatchedBrowserFrame } from '../browser/WatchedBrowserFrame'
import { WatchedBrowserPane, sinceText, useNow, watchedBrowserStatus, type WatchedBrowserFullScreen, type WatchedBrowserStatus } from '../browser/WatchedBrowserPane'
import { botSetupBlock } from './botSetup'
import './botBrowser.css'

export { filesAskText } from '../browser/WatchedBrowserPane'
export { sinceText }

/**
 * A bot's own browser in its chat: a small live preview in the reply of the run that used it, and
 * the split view beside the chat, where the owner watches the bot use it and can take it over (to
 * sign in for it, say). Both show the tab the bot used last, as pictures the daemon pushes while
 * they are on screen, with the agent cursor drawn over them.
 */

/** What the view says of the bot's browser: "Live" only while pictures can arrive. */
export function browserStatus(view: BotBrowserView, stream: BotBrowserStream | undefined, botName: string, now: number): WatchedBrowserStatus {
  return watchedBrowserStatus(view, stream, botName, now)
}

function hostOf(url: string | undefined): string {
  if (!url) return ''
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/**
 * The small live preview in a reply; hovering shows Expand, which opens the split view. Watched only
 * while on screen. While the split view is open it shows the same tab larger: the preview is then one
 * line, with no picture, and asks for none.
 */
export function BotBrowserPreview({ bot, view: given }: { bot: BotSummary; view: BotBrowserView }) {
  // Its picture and cursor as they are now: the chat that passes `view` keeps it still between pictures.
  const view = useBotBrowserStore((state) => state.views[bot.id]) ?? given
  const host = hostOf(view.tab?.url)
  const figure = useRef<HTMLElement>(null)
  const paneOpen = useBotBrowserStore((state) => state.pane === bot.id)
  // A browser open in a window is seen there: nothing is pictured meanwhile.
  useBotBrowserWatch(bot.id, figure, view.open && !view.windowed && !paneOpen ? BOT_BROWSER_PREVIEW_WATCH : undefined)
  const stream = useBotBrowserStream(bot.id)
  const now = useNow(Boolean(view.open && stream && !stream.live))
  const status = browserStatus(view, stream, bot.name, now)
  if (paneOpen) return <p className="bot-browser-beside" role="status" title={view.tab?.title || host || undefined}>
    <Globe size={12} aria-hidden /><span>Browser open beside the chat</span>
  </p>
  return <figure ref={figure} className={`bot-browser-preview${status.live && !status.attention ? ' is-live' : ''}${view.open && status.attention ? ' is-stale' : ''}`} aria-label={`${bot.name}'s browser`}>
    <WatchedBrowserFrame label={`${bot.name}'s browser`} view={view}>
      <button type="button" className="bot-browser-expand" aria-label={`Expand ${bot.name}'s browser`} title="Expand"
        onClick={() => useBotBrowserStore.getState().openPane(bot.id)}><Maximize size={14} /></button>
    </WatchedBrowserFrame>
    <figcaption>
      <span className="bot-browser-dot" aria-hidden />
      <span className="bot-browser-title">{view.tab?.title || host || 'Browser'}</span>
      {host && <span className="bot-browser-host">{host}</span>}
      <span className="bot-browser-status" title={status.detail}>{status.text}</span>
    </figcaption>
  </figure>
}

/**
 * The bot's browser in its side panel (the general `WatchedBrowserPane`), or full screen over the centre pane. The
 * owner watches; the switch beside the address takes it over for this window (the bot's actions wait), and everything
 * they do then reaches the page in order, each input answered; pressed again, it gives it back. A closed browser can be
 * opened again here, under the owner's control.
 */
export function BotBrowserPane({ bot, view, fullScreen }: { bot: BotSummary; view: BotBrowserView; fullScreen?: WatchedBrowserFullScreen }) {
  const busy = useBotBrowserStore((state) => state.busy)
  const open = (url: string | undefined) => void useBotBrowserStore.getState().open(bot.id, url)
  // A bot of another computer is watched at Use; taking it over and opening it need Full there, while it is reached.
  const blocked = botSetupBlock(bot)
  // One view per browser: another bot's never inherits this one's pending input or menu.
  return <WatchedBrowserPane key={bot.id} kit={botBrowserKit} browserKey={bot.id} label={`${bot.name}'s browser`} user={bot.name} view={view} open={open}
    {...(fullScreen ? { fullScreen } : {})}
    {...(blocked ? { blocked } : {})}
    closed={(typed) => <>
      <p>{view.stopped ? 'The browser stopped.' : `${bot.name}'s browser is closed.`}</p>
      <button type="button" disabled={busy || Boolean(blocked)} title={blocked} onClick={() => open(/^https?:\/\//i.test(typed) ? typed : undefined)}>Open it</button>
    </>}
    line={(holding) => holding === 'window' ? `${bot.name} waits until you give it back.`
      : holding === 'this-window' ? ''
      : holding === 'another-window' ? 'Held in another window. Take over to use it here.'
      : holding === 'agent' ? ''
      : `Only ${bot.name} uses this browser. Open it to sign in to a site for it.`} />
}
