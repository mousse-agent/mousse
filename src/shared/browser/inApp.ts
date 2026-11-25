import type { BrowserAgentCursor } from './agentCursor'
import type { AttachedControlState } from './attached'

/**
 * Renderer-facing IDs are local tab IDs; native handles and private paths stay in main.
 * `threadId` is the thread whose agent the tab is bound to, when it is bound.
 */
export type InAppBrowserState = Partial<AttachedControlState> & { uiTabId: string; profileId: string; threadId?: string }
/** Where an agent acts in a window's tab (`uiTabId` is the window's local tab id), drawn over that tab. */
export interface InAppBrowserCursor { uiTabId: string; profileId: string; cursor: BrowserAgentCursor }

/**
 * The person's use of a tab outside its page, reported by the window: a click or key in the toolbar or on the agent's
 * shield (`input`), and the address bar or element picker in use (`pin` until `unpin`). Each keeps the tab the person's.
 */
export type InAppBrowserActivity =
  | { localTabId: string; kind: 'input' }
  | { localTabId: string; kind: 'pin' | 'unpin'; pin: 'address' | 'picker' }

/** What main asks the window to do with its tabs for an agent (`browser_tabs`). */
export type InAppBrowserTabCommand =
  | { kind: 'open'; requestId: string; threadId: string; activate: boolean }
  | { kind: 'close'; localTabId: string }

export interface InAppBrowserApi {
  /** `agentOpened`: the window opened the tab because an agent asked for one (agents may close only such tabs). */
  registerTab(input: { localTabId: string; webContentsId: number; threadId?: string; openRequestId?: string; agentOpened?: boolean }): Promise<{ uiTabId: string }>
  selectTab(input: { localTabId: string; threadId: string }): Promise<void>
  resumeAgent(localTabId: string): Promise<void>
  /** The person used the tab (see `InAppBrowserActivity`). */
  reportActivity(activity: InAppBrowserActivity): Promise<void>
  /** The thread a tab belongs to changed (`null`: kept in every thread). */
  setTabOwner(input: { localTabId: string; threadId: string | null }): Promise<void>
  onState(listener: (state: InAppBrowserState) => void): () => void
  onCursor(listener: (event: InAppBrowserCursor) => void): () => void
  onTabCommand(listener: (command: InAppBrowserTabCommand) => void): () => void
}
