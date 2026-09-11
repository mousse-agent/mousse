import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import { resolve } from 'path'
import * as pty from 'node-pty'
import { WorkerHandle } from './WorkerHandle'
import {
  ProcessLifecycleController,
  createDefaultProcessTreeSignaler,
  isOwnedPidAlive,
  type ProcessShutdownOptions,
  type TerminalProcessLifecycleOptions
} from './processLifecycle'

export {
  ProcessAdmissionError,
  ProcessShutdownError,
  type ProcessShutdownOptions
} from './processLifecycle'

/** Cap in-memory scrollback per PTY so long-running shells cannot grow without bound. */
export const MAX_PTY_SCROLLBACK_CHARS = 256_000
/** Bounded ring of sequenced output chunks for reconnect replay. */
export const MAX_PTY_OUTPUT_RING = 2_000

export type PtySpawnFn = typeof pty.spawn

export interface PtyManagerOptions extends TerminalProcessLifecycleOptions {
  /** Test-only PTY spawn injection. Production leaves this unset. */
  spawnPty?: PtySpawnFn
}

export interface PtySession {
  id: string
  agentId: string
  threadId: string
  pty: pty.IPty
  /** Monotonic per-PTY output sequence (starts at 0; first chunk is 1). */
  sequence: number
  /** Interrupted after daemon restart (process not reattachable). */
  interrupted: boolean
  handle: WorkerHandle
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

export interface InjectedPtyTransport {
  handle: WorkerHandle
  pid?: number
  signal?: (force: boolean) => void
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
  private readonly lifecycle: ProcessLifecycleController
  private readonly spawnPty: PtySpawnFn

  constructor(options: PtyManagerOptions = {}) {
    super()
    this.lifecycle = new ProcessLifecycleController(
      'pty',
      options.treeSignaler ?? createDefaultProcessTreeSignaler()
    )
    this.spawnPty = options.spawnPty ?? pty.spawn
  }

  setSendSink(sink: TerminalSendSink): void {
    this.sendSink = sink
  }

  beginShutdown(): void {
    this.lifecycle.beginShutdown()
  }

  getActiveCount(): number {
    return this.lifecycle.getActiveCount()
  }

  shutdown(options?: ProcessShutdownOptions): Promise<void> {
    return this.lifecycle.shutdown(options)
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
    this.lifecycle.assertAdmits('create')
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

    const instance = this.spawnPty(shell, shellArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: resolvedCwd,
      env: { ...process.env, ...(options.env ?? {}) } as Record<string, string>
    })

    const handle = new WorkerHandle(ptyId, agentId, 'pty')
    const session: PtySession = {
      id: ptyId,
      agentId,
      threadId,
      pty: instance,
      sequence: 0,
      interrupted: false,
      handle
    }
    this.sessions.set(ptyId, session)
    this.scrollbacks.set(ptyId, '')
    this.outputRings.set(ptyId, [])
    this.lifecycle.track({
      id: ptyId,
      agentId,
      kind: 'pty',
      pid: isRecordablePid(instance.pid) ? instance.pid : undefined,
      handle,
      signaled: false,
      signalLocal: (force) => {
        if (isRecordablePid(instance.pid) && !isOwnedPidAlive(instance.pid)) return
        try {
          if (process.platform === 'win32') instance.kill()
          else instance.kill(force ? 'SIGKILL' : 'SIGTERM')
        } catch {
          /* already exited */
        }
      }
    })

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

    instance.onExit(({ exitCode, signal }) => {
      const normalizedSignal = signal === undefined || signal === null ? null : String(signal)
      const exit = session.handle.recordExit(exitCode, normalizedSignal)
      // node-pty does not expose a later stdio/handle close; onExit is the close observation.
      session.handle.recordClose()
      this.sessions.delete(ptyId)
      this.scrollbacks.delete(ptyId)
      this.outputRings.delete(ptyId)
      this.lifecycle.untrackIfSettled(ptyId)
      const payload = { ptyId, agentId, threadId, exitCode, signal: normalizedSignal, exit }
      this.emit('exit', payload)
      this.emitToSink('pty:exit', payload)
    })

    this.emit('created', { ptyId, agentId, threadId })
    return ptyId
  }

  /**
   * Test-only: own a handle/transport without opening a PTY.
   * Distinguishes deterministic timeout/error cases from real process evidence.
   */
  adoptTransportForTests(transport: InjectedPtyTransport): string {
    this.lifecycle.assertAdmits('create')
    const { handle } = transport
    this.lifecycle.track({
      id: handle.id,
      agentId: handle.agentId,
      kind: 'pty',
      pid: transport.pid,
      handle,
      signaled: false,
      signalLocal: transport.signal
    })
    return handle.id
  }

  write(ptyId: string, data: string): void {
    this.lifecycle.assertAdmits('write')
    const session = this.sessions.get(ptyId)
    session?.pty.write(data)
  }

  has(ptyId: string): boolean {
    return this.sessions.has(ptyId)
  }

  isAlive(ptyId: string): boolean {
    return this.sessions.has(ptyId)
  }

  getHandle(ptyId: string): WorkerHandle | undefined {
    return this.sessions.get(ptyId)?.handle
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
    this.lifecycle.assertAdmits('resize')
    const session = this.sessions.get(ptyId)
    session?.pty.resize(cols, rows)
  }

  kill(ptyId: string): void {
    const session = this.sessions.get(ptyId)
    if (session) {
      this.lifecycle.signalWorker(ptyId, false)
      this.sessions.delete(ptyId)
    }
    this.scrollbacks.delete(ptyId)
    this.outputRings.delete(ptyId)
  }

  killByAgentId(agentId: string): void {
    for (const [ptyId, session] of [...this.sessions]) {
      if (session.agentId === agentId) {
        this.kill(ptyId)
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
    for (const ptyId of [...this.sessions.keys()]) {
      this.kill(ptyId)
    }
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
    this.lifecycle.assertAdmits('getOutputSince')
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
    this.lifecycle.assertAdmits('loadScrollbacks')
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

function isRecordablePid(pid: number | undefined): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && pid !== process.pid
}
