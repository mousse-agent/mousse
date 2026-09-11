export interface GuestSessionHandle {
  matchesPartition(expected: string): boolean
}

export interface GuestDebuggerHandle {
  attach(protocolVersion?: string): void
  detach(): void
  isAttached(): boolean
  sendCommand(method: string, commandParams?: Record<string, unknown>, sessionId?: string): Promise<unknown>
  on(event: 'message', listener: (event: unknown, method: string, params: unknown, sessionId: string) => void): void
  on(event: 'detach', listener: (event: unknown, reason: string) => void): void
  off(event: 'message', listener: (event: unknown, method: string, params: unknown, sessionId: string) => void): void
  off(event: 'detach', listener: (event: unknown, reason: string) => void): void
}

export type GuestDestroyedListener = () => void
export type GuestNavigatedListener = (url: string) => void

/**
 * Main-process-only handle. Never serialized into shared DTOs.
 * Tests inject fakes; production wraps Electron WebContents.
 */
export interface GuestWebContentsHandle {
  readonly nativeId: number
  isDestroyed(): boolean
  getURL(): string
  getTitle(): string
  hostWebContents(): GuestWebContentsHandle | null
  readonly session: GuestSessionHandle
  readonly debugger: GuestDebuggerHandle
  onDestroyed(listener: GuestDestroyedListener): () => void
  onNavigated(listener: GuestNavigatedListener): () => void
  /** Test/fixture inspection only. Production automation never uses this as a model API. */
  executeJavaScript?<T = unknown>(code: string): Promise<T>
}
