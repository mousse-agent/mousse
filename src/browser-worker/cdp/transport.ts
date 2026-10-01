export interface CdpCommandOptions {
  sessionId?: string
  timeoutMs?: number
  signal?: AbortSignal
}

export type CdpEventListener = (params: unknown, sessionId?: string) => void

/** Narrow CDP port shared by the managed pipe and the Electron debugger adapter. */
export interface CdpTransport {
  readonly connected: boolean
  send<T = unknown>(method: string, params?: Record<string, unknown>, options?: CdpCommandOptions): Promise<T>
  on(event: string, listener: CdpEventListener): unknown
  off(event: string, listener: CdpEventListener): unknown
}
