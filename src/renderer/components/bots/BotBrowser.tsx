import { useRef } from 'react'
import { Globe, Maximize } from '../../lib/icons'
import type { BotSummary } from '../../../shared/bots/personal/chat'
import { BOT_BROWSER_PREVIEW_WATCH, type BotBrowserView } from '../../../shared/bots/personal/browser'
import { botBrowserKit, canOpenBotBrowserWindow, useBotBrowserStore, useBotBrowserStream, useBotBrowserWatch, type BotBrowserStream } from '../../stores/botBrowserStore'
import { WatchedBrowserFrame } from '../browser/WatchedBrowserFrame'
import { WatchedBrowserPane, sinceText, useNow, watchedBrowserStatus, type WatchedBrowserStatus } from '../browser/WatchedBrowserPane'
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
export function BotBrowserPreview({ bot, view }: { bot: BotSummary; view: BotBrowserView }) {
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
 * The split view: the bot's browser beside its chat (the general `WatchedBrowserPane`). The owner
 * watches; Take over hands the browser to this window (the bot's actions wait), and everything they do
 * then reaches the page in order, each input answered; Give back returns it. A closed browser can be
 * opened again here, under the owner's control. On the computer the browser runs on, Open in a window shows it as a
 * real window instead, held the same way, until Close window (or the window's own close) gives it back.
 */
export function BotBrowserPane({ bot, view }: { bot: BotSummary; view: BotBrowserView }) {
  const busy = useBotBrowserStore((state) => state.busy)
  const open = (url: string | undefined) => void useBotBrowserStore.getState().open(bot.id, url)
  const inWindow = {
    offered: Boolean(view.windowable) && canOpenBotBrowserWindow(),
    open: () => void useBotBrowserStore.getState().inWindow(bot.id, 'open'),
    close: () => void useBotBrowserStore.getState().inWindow(bot.id, 'close')
  }
  return <WatchedBrowserPane kit={botBrowserKit} browserKey={bot.id} label={`${bot.name}'s browser`} user={bot.name} view={view} open={open} inWindow={inWindow}
    closed={(typed) => <>
      <p>{view.stopped ? 'The browser stopped.' : `${bot.name}'s browser is closed.`}</p>
      <button type="button" disabled={busy} onClick={() => open(/^https?:\/\//i.test(typed) ? typed : undefined)}>Open it</button>
    </>}
    line={(holding) => holding === 'window' ? `${bot.name} waits until you close the window.`
      : holding === 'this-window' ? `You're using ${bot.name}'s browser. Sites you sign in to stay signed in for it. Give it back when you're done.`
      : holding === 'another-window' ? 'Held in another window. Take over to use it here.'
      : holding === 'agent' ? `${bot.name} is using its own browser, apart from your tabs. Take over to click or type in it.`
      : `Only ${bot.name} uses this browser. Open it to sign in to a site for it.`} />
}
