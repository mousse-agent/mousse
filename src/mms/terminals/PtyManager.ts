import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import { resolve } from 'path'
import * as pty from 'node-pty'

/** Cap in-memory scrollback per PTY so long-running shells cannot grow without bound. */
export const MAX_PTY_SCROLLBACK_CHARS = 256_000
/** Bounded ring of sequenced output chunks for reconnect replay. */
export const MAX_PTY_OUTPUT_RING = 2_000

export interface PtySession {
  id: string
  agentId: string
  threadId: string
  pty: pty.IPty
  /** Monotonic per-PTY output sequence (starts at 0; first chunk is 1). */
  sequence: number
  /** Interrupted after daemon restart (process not reattachable). */
  interrupted: boolean
}

export interface PtyCreateOptions {
  env?: Record<string, string>
  shellArgs?: string[]
  threadId?: string
}

export type TerminalSendSink = (channel: string, data: unknown) => void

export type PtyLookupResult =
  | { alive: true; ptyId: string; agentId: string; threadId: string; sequence: number }
  | { alive: false; ptyId: string; interrupted?: boolean }

export interface PtyOutputChunk {
  sequence: number
  data: string
}

export function appendBoundedScrollback(
  existing: string,
  chunk: string,
  maxChars = MAX_PTY_SCROLLBACK_CHARS
): string {
  const next = existing + chunk
  if (next.length <= maxChars) return next
  return next.slice(next.length - maxChars)
}

export class PtyManager extends EventEmitter {
  private sessions = new Map<string, PtySession>()
  private scrollbacks = new Map<string, string>()
  /** Per-PTY sequenced output ring for reconnect. */
  private outputRings = new Map<string, PtyOutputChunk[]>()
  private sendSink: TerminalSendSink | null = null
  /** Capability: optional UI focus intent (daemon never holds BrowserWindow). */
  private focusIntentFn: (() => void) | null = null

  setSendSink(sink: TerminalSendSink): void {
    this.sendSink = sink
  }

  /** @deprecated Prefer setFocusIntent — daemon emits intent, UI decides. */
  setFocusWindow(fn: () => void): void {
    this.focusIntentFn = fn
  }

  setFocusIntent(fn: () => void): void {
    this.focusIntentFn = fn
  }

  focusWindow(): void {
    this.focusIntentFn?.()
    this.emit('focus-intent', {})
  }

  private emitToSink(channel: string, data: unknown): void {
    this.sendSink?.(channel, data)
  }

  create(
    agentId: string,
    cwd: string,
    command?: string,
    options: PtyCreateOptions = {}
  ): string {
    const ptyId = uuidv4()
    const threadId = options.threadId ?? '__unbound__'
    const resolvedCwd = resolve(cwd || process.env.HOME || process.cwd())
    const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || 'bash'
    const shellArgs =
      options.shellArgs ??
      (process.platform === 'win32'
        ? [
            '-NoLogo',
            '-NoExit',
            '-Command',
            command
              ? `Set-Location -LiteralPath '${resolvedCwd.replace(/'/g, "''")}'; ${command}`
              : `Set-Location -LiteralPath '${resolvedCwd.replace(/'/g, "''")}'`
          ]
        : command
          ? ['-c', `cd "${resolvedCwd}" && ${command}; exec $SHELL`]
          : [])

    const instance = pty.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: resolvedCwd,
      env: { ...process.env, ...(options.env ?? {}) } as Record<string, string>
    })

    const session: PtySession = {
      id: ptyId,
      agentId,
      threadId,
      pty: instance,
      sequence: 0,
      interrupted: false
    }
    this.sessions.set(ptyId, session)
    this.scrollbacks.set(ptyId, '')
    this.outputRings.set(ptyId, [])

    instance.onData((data) => {
      const existing = this.scrollbacks.get(ptyId) || ''
      this.scrollbacks.set(ptyId, appendBoundedScrollback(existing, data))
      session.sequence += 1
      const chunk: PtyOutputChunk = { sequence: session.sequence, data }
      const ring = this.outputRings.get(ptyId) ?? []
      ring.push(chunk)
      while (ring.length > MAX_PTY_OUTPUT_RING) ring.shift()
      this.outputRings.set(ptyId, ring)
      this.emit('data', { ptyId, data, sequence: session.sequence, threadId, agentId })
      this.emitToSink('pty:data', {
        ptyId,
        data,
        sequence: session.sequence,
        threadId,
        agentId
      })
    })

    instance.onExit(() => {
      this.sessions.delete(ptyId)
      this.scrollbacks.delete(ptyId)
      this.outputRings.delete(ptyId)
      this.emit('exit', { ptyId, agentId, threadId })
      this.emitToSink('pty:exit', { ptyId, agentId, threadId })
    })

    this.emit('created', { ptyId, agentId, threadId })
    return ptyId
  }

  write(ptyId: string, data: string): void {
    const session = this.sessions.get(ptyId)
    session?.pty.write(data)
  }

  has(ptyId: string): boolean {
    return this.sessions.has(ptyId)
  }

  isAlive(ptyId: string): boolean {
    return this.sessions.has(ptyId)
  }

  lookup(ptyId: string): PtyLookupResult {
    const session = this.sessions.get(ptyId)
    if (!session) {
      return { alive: false, ptyId }
    }
    return {
      alive: true,
      ptyId: session.id,
      agentId: session.agentId,
      threadId: session.threadId,
      sequence: session.sequence
    }
  }

  resize(ptyId: string, cols: number, rows: number): void {
    const session = this.sessions.get(ptyId)
    session?.pty.resize(cols, rows)
  }

  kill(ptyId: string): void {
    const session = this.sessions.get(ptyId)
    if (session) {
      session.pty.kill()
      this.sessions.delete(ptyId)
    }
    this.scrollbacks.delete(ptyId)
    this.outputRings.delete(ptyId)
  }

  killByAgentId(agentId: string): void {
    for (const [ptyId, session] of this.sessions) {
      if (session.agentId === agentId) {
        session.pty.kill()
        this.sessions.delete(ptyId)
        this.scrollbacks.delete(ptyId)
        this.outputRings.delete(ptyId)
      }
    }
  }

  /** Kill only PTYs for one thread — never global killAll on selection. */
  killByThreadId(threadId: string): void {
    for (const [ptyId, session] of [...this.sessions]) {
      if (session.threadId === threadId) {
        this.kill(ptyId)
      }
    }
  }

  /**
   * @deprecated Phase 4: do not use on thread switch. Prefer killByThreadId for deletion only.
   */
  killAll(): void {
    for (const session of this.sessions.values()) {
      session.pty.kill()
    }
    this.sessions.clear()
    this.scrollbacks.clear()
    this.outputRings.clear()
  }

  list(threadId?: string): Array<{
    ptyId: string
    agentId: string
    threadId: string
    sequence: number
  }> {
    return Array.from(this.sessions.values())
      .filter((s) => (threadId ? s.threadId === threadId : true))
      .map((s) => ({
        ptyId: s.id,
        agentId: s.agentId,
        threadId: s.threadId,
        sequence: s.sequence
      }))
  }

  getScrollbacks(threadId?: string): Record<string, string> {
    if (!threadId) return Object.fromEntries(this.scrollbacks)
    const out: Record<string, string> = {}
    for (const [ptyId, session] of this.sessions) {
      if (session.threadId === threadId) {
        out[ptyId] = this.scrollbacks.get(ptyId) ?? ''
      }
    }
    // Also include pure scrollback-only (dead) entries if tagged — keep full map keys that match live sessions.
    return out
  }

  getScrollback(ptyId: string): string {
    return this.scrollbacks.get(ptyId) ?? ''
  }

  /**
   * Output chunks with sequence > afterSequence, for reconnect without silent loss.
   */
  getOutputSince(ptyId: string, afterSequence: number): {
    sequence: number
    gap: boolean
    chunks: PtyOutputChunk[]
    scrollback: string
  } {
    const session = this.sessions.get(ptyId)
    const ring = this.outputRings.get(ptyId) ?? []
    const currentSeq = session?.sequence ?? ring[ring.length - 1]?.sequence ?? 0
    if (ring.length === 0) {
      return {
        sequence: currentSeq,
        gap: false,
        chunks: [],
        scrollback: this.scrollbacks.get(ptyId) ?? ''
      }
    }
    const oldest = ring[0].sequence
    const gap = afterSequence < oldest - 1
    return {
      sequence: currentSeq,
      gap,
      chunks: ring.filter((c) => c.sequence > afterSequence),
      scrollback: this.scrollbacks.get(ptyId) ?? ''
    }
  }

  loadScrollbacks(data: Record<string, string>): void {
    // Merge rather than replace — multi-thread must not wipe other threads' buffers.
    for (const [k, v] of Object.entries(data)) {
      this.scrollbacks.set(k, v)
    }
  }

  clearScrollbacks(): void {
    this.scrollbacks.clear()
  }

  clearScrollbacksForThread(threadId: string): void {
    for (const [ptyId, session] of this.sessions) {
      if (session.threadId === threadId) {
        this.scrollbacks.delete(ptyId)
      }
    }
  }
}
