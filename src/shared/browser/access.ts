/** Profile-scoped permission for agents to operate the in-app browser. */
export interface BrowserAccessState {
  allowed: boolean
  pending: Array<{ requestId: string; threadId: string }>
}

export const BROWSER_ACCESS_METHODS = ['browser.access.status', 'browser.access.respond', 'browser.access.set'] as const
export type BrowserAccessMethod = (typeof BROWSER_ACCESS_METHODS)[number]
