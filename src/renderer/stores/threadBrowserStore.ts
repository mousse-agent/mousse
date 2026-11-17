import type { BrowserViewApi, BrowserViewMethod, ThreadBrowserFrameEvent, ThreadBrowserView } from '../../shared/browser/threadView'
import { createWatchedBrowserStore, type WatchedBrowserCall } from './watchedBrowserStore'

/**
 * A thread agent's browser without a window, as that thread's Browser panel shows it: the general view
 * store (`watchedBrowserStore.ts`) over the `browser.view.*` methods, keyed by thread. Its state is read
 * while the panel shows the thread; pictures come only once the person opens the view.
 */

const threads = createWatchedBrowserStore<ThreadBrowserView, ThreadBrowserFrameEvent>({
  owner: (threadId) => ({ threadId }),
  keyOf: (event) => event.threadId,
  methods: {
    get: 'browser.view.get',
    watch: 'browser.view.watch',
    unwatch: 'browser.view.unwatch',
    hold: 'browser.view.hold',
    send: 'browser.view.send'
  },
  frames: (listener) => window.mousse.browser?.onViewFrame?.(listener) ?? (() => undefined),
  chooseFiles: () => {
    const choose = window.mousse?.browser?.chooseViewFiles
    return choose ? ({ key, ...request }) => choose({ threadId: key, ...request }) : undefined
  }
})

export const useThreadBrowserStore = threads.useStore
/** The store's hooks, for the general view (`WatchedBrowserPane`). */
export const threadBrowserKit = { useStore: threads.useStore, useWatch: threads.useWatch, useStream: threads.useStream }
/** While the element is on screen in a shown window, the thread's browser is watched at that size and rate. */
export const useThreadBrowserWatch = threads.useWatch
/** Keeps a thread's browser state fresh while `threadId` is shown: a light read every few seconds. */
export const useThreadBrowser = threads.useBrowserState
/** Whether a thread's browser pictures can arrive now (undefined while nothing of it is watched). */
export const useThreadBrowserStream = threads.useStream

type Call = <M extends BrowserViewMethod>(method: M, params: BrowserViewApi[M]['params']) => Promise<BrowserViewApi[M]['result']>

/** The transport the store calls through, and where pushed pictures come from; tests pass fakes. */
export function setThreadBrowserTransport(next: Call | null, frames?: ((listener: (event: ThreadBrowserFrameEvent) => void) => () => void) | null): void {
  threads.setTransport(next as unknown as WatchedBrowserCall | null, frames)
}
