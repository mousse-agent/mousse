import type { RefObject } from 'react'
import type { BotBrowserFrameEvent, BotBrowserView, BotsBrowserApi, BotsBrowserMethod } from '../../shared/bots/personal/browser'
import { createWatchedBrowserStore, type WatchedBrowserCall, type WatchedBrowserNeed, type WatchedBrowserStream } from './watchedBrowserStore'

/**
 * Each bot's own browser as its chat shows it: the live preview in its reply and the split view. The
 * general view store (`watchedBrowserStore.ts`) over the `bots.browser.*` methods, keyed by bot. A
 * service that predates watching or holds answers `bots.browser.get` with a picture and takes
 * `control` and `input` instead.
 */

export { STOP_GRACE_MS, WATCHED_BROWSER_FRAME_MS as BOT_BROWSER_FRAME_MS, viewId } from './watchedBrowserStore'

/** Whether pictures can arrive: live, or not updating since a time (ms since the epoch). */
export type BotBrowserStream = WatchedBrowserStream
/** What a preview or the split view needs while it is seen: its width in CSS pixels and pictures a second. */
export type BotBrowserNeed = WatchedBrowserNeed

const bots = createWatchedBrowserStore<BotBrowserView, BotBrowserFrameEvent>({
  owner: (botId) => ({ botId }),
  keyOf: (event) => event.botId,
  methods: {
    get: 'bots.browser.get',
    watch: 'bots.browser.watch',
    unwatch: 'bots.browser.unwatch',
    hold: 'bots.browser.hold',
    send: 'bots.browser.send',
    open: 'bots.browser.open',
    legacy: { control: 'bots.browser.control', input: 'bots.browser.input' }
  },
  frames: (listener) => window.mousse.personalBots?.onBrowserFrame?.(listener) ?? (() => undefined),
  chooseFiles: () => {
    const choose = window.mousse?.personalBots?.chooseBrowserFiles
    return choose ? ({ key, ...request }) => choose({ botId: key, ...request }) : undefined
  }
})

export const useBotBrowserStore = bots.useStore
/** The store's hooks, for the general view (`WatchedBrowserPane`). */
export const botBrowserKit = { useStore: bots.useStore, useWatch: bots.useWatch, useStream: bots.useStream }

type Call = <M extends BotsBrowserMethod>(method: M, params: BotsBrowserApi[M]['params']) => Promise<BotsBrowserApi[M]['result']>
type Subscribe = (listener: (event: BotBrowserFrameEvent) => void) => () => void

/** The transport the store calls through, and where pushed pictures come from; tests pass fakes. */
export function setBotBrowserTransport(next: Call | null, frames?: Subscribe | null): void {
  bots.setTransport(next as unknown as WatchedBrowserCall | null, frames)
}

/**
 * While `element` is on screen in a shown window, the bot's browser is watched at `need`; scrolled
 * out of sight, the window hidden, or unmounted, it no longer is. Pass `need` undefined to need nothing.
 */
export function useBotBrowserWatch(botId: string, element: RefObject<Element | null>, need: BotBrowserNeed | undefined): void {
  bots.useWatch(botId, element, need)
}

/**
 * Keeps a bot's browser state fresh while its chat is open: a light read every few seconds. Its
 * pictures come from what is seen of it (`useBotBrowserWatch`).
 */
export function useBotBrowser(botId: string): BotBrowserView | undefined {
  return bots.useBrowserState(botId)
}

/** Whether a bot's pictures can arrive now (undefined while nothing of it is watched). */
export function useBotBrowserStream(botId: string): BotBrowserStream | undefined {
  return bots.useStream(botId)
}
