import type { AttachedControlState } from './attached'

/**
 * Renderer-facing IDs are local tab IDs; native handles and private paths stay in main.
 * `threadId` is the thread whose agent the tab is bound to, when it is bound.
 */
export type InAppBrowserState = Partial<AttachedControlState> & { uiTabId: string; profileId: string; threadId?: string }
export interface InAppBrowserApi {
  registerTab(input: { localTabId: string; webContentsId: number; threadId?: string }): Promise<{ uiTabId: string }>
  selectTab(input: { localTabId: string; threadId: string }): Promise<void>
  takeControl(localTabId: string): Promise<void>
  resumeAgent(localTabId: string): Promise<void>
  onState(listener: (state: InAppBrowserState) => void): () => void
}
