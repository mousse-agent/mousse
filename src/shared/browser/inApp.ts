import type { BrowserAgentCursor } from './agentCursor'
import type { AttachedControlState } from './attached'

/**
 * Renderer-facing IDs are local tab IDs; native handles and private paths stay in main.
 * `threadId` is the thread whose agent the tab is bound to, when it is bound.
 */
export type InAppBrowserState = Partial<AttachedControlState> & { uiTabId: string; profileId: string; threadId?: string }
/** Where an agent acts in a window's tab (`uiTabId` is the window's local tab id), drawn over that tab. */
export interface InAppBrowserCursor { uiTabId: string; profileId: string; cursor: BrowserAgentCursor }
export interface InAppBrowserApi {
  registerTab(input: { localTabId: string; webContentsId: number; threadId?: string }): Promise<{ uiTabId: string }>
  selectTab(input: { localTabId: string; threadId: string }): Promise<void>
  takeControl(localTabId: string): Promise<void>
  resumeAgent(localTabId: string): Promise<void>
  onState(listener: (state: InAppBrowserState) => void): () => void
  onCursor(listener: (event: InAppBrowserCursor) => void): () => void
}
