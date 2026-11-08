import { useEffect } from 'react'
import { create } from 'zustand'
import type { BotBrowserInput, BotBrowserView, BotsBrowserApi, BotsBrowserMethod } from '../../shared/bots/personal/browser'
import { errorText } from '../services/personalBotsClient'

/**
 * Each bot's own browser as its chat shows it: the live preview in its reply and the split view.
 * Read with `bots.browser.get` while the bot's chat is open: often, with a picture, while the
 * browser is open and on screen; seldom otherwise. A daemon without the methods shows none.
 */

/** How often an open browser on screen is pictured again. */
export const BOT_BROWSER_FRAME_MS = 700
/** How often a bot's browser is checked while nothing of it shows. */
const IDLE_POLL_MS = 3000

interface BotBrowserState {
  views: Record<string, BotBrowserView>
  /** The bot whose browser is open in the split view beside its chat. */
  paneBotId: string | null
  /** Set when the daemon has no bot-browser methods (an older one): nothing polls or shows. */
  unavailable: boolean
  busy: boolean
  error: string | null
  load(botId: string, frame: boolean): Promise<void>
  openPane(botId: string): void
  closePane(): void
  control(botId: string, control: 'owner' | 'bot'): Promise<void>
  input(botId: string, input: BotBrowserInput): Promise<void>
  open(botId: string, url?: string): Promise<void>
}

type Call = <M extends BotsBrowserMethod>(method: M, params: BotsBrowserApi[M]['params']) => Promise<BotsBrowserApi[M]['result']>
let transport: Call | null = null
/** The transport the store calls through; tests pass a fake. */
export function setBotBrowserTransport(next: Call | null): void { transport = next }
const call: Call = (method, params) => (transport ?? ((m, p) => window.mousse.platformRequest.request(m, p)) as Call)(method, params)

/** The daemon (or this app's bridge) does not know the bot-browser methods. */
const missingMethod = (cause: unknown) => /method not allowed|not allowlisted|unknown method/i.test(errorText(cause))

export const useBotBrowserStore = create<BotBrowserState>((set, get) => {
  const put = (botId: string, view: BotBrowserView) => set((state) => {
    const previous = state.views[botId]
    // A view without a picture keeps the last one: a seldom check never blanks the preview.
    const frame = view.frame ?? previous?.frame
    return { views: { ...state.views, [botId]: { ...view, ...(frame ? { frame } : {}) } } }
  })
  const act = async (botId: string, run: () => Promise<{ browser: BotBrowserView }>) => {
    set({ busy: true, error: null })
    try {
      put(botId, (await run()).browser)
      set({ busy: false })
    } catch (cause) {
      set({ busy: false, error: errorText(cause) })
    }
  }
  return {
    views: {},
    paneBotId: null,
    unavailable: false,
    busy: false,
    error: null,
    async load(botId, frame) {
      if (get().unavailable) return
      try {
        put(botId, (await call('bots.browser.get', { botId, ...(frame ? { frame: true } : {}) })).browser)
      } catch (cause) {
        if (missingMethod(cause)) set({ unavailable: true })
      }
    },
    openPane: (botId) => set({ paneBotId: botId, error: null }),
    closePane: () => set({ paneBotId: null, error: null }),
    control: (botId, control) => act(botId, () => call('bots.browser.control', { botId, control })),
    input: (botId, input) => act(botId, () => call('bots.browser.input', { botId, input })),
    open: (botId, url) => act(botId, () => call('bots.browser.open', { botId, ...(url ? { url } : {}) }))
  }
})

/**
 * Keeps a bot's browser view fresh while its chat is open: a picture every `BOT_BROWSER_FRAME_MS`
 * while the browser is open and its preview or split view shows, else a light check now and then.
 */
export function useBotBrowser(botId: string, showing: boolean): BotBrowserView | undefined {
  const view = useBotBrowserStore((state) => state.views[botId])
  const unavailable = useBotBrowserStore((state) => state.unavailable)
  const live = Boolean(view?.open) && showing
  useEffect(() => {
    if (unavailable) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      await useBotBrowserStore.getState().load(botId, live)
      if (!stopped) timer = setTimeout(() => { void tick() }, live ? BOT_BROWSER_FRAME_MS : IDLE_POLL_MS)
    }
    void tick()
    return () => { stopped = true; if (timer) clearTimeout(timer) }
  }, [botId, live, unavailable])
  return unavailable ? undefined : view
}
