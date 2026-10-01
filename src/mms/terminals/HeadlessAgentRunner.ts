import { EventEmitter } from 'events'
import { spawn, type ChildProcess, type SpawnOptions } from 'child_process'
import { v4 as uuidv4 } from 'uuid'
import type { TerminalSendSink } from './PtyManager'
import { WorkerHandle } from './WorkerHandle'
import {
  ProcessLifecycleController,
  createDefaultProcessTreeSignaler,
  type ProcessShutdownOptions,
  type TerminalProcessLifecycleOptions
} from './processLifecycle'

export {
  ProcessAdmissionError,
  ProcessShutdownError,
  type ProcessShutdownOptions
} from './processLifecycle'

export const MAX_HEADLESS_SCROLLBACK_CHARS = 256_000

export type HeadlessSpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions
) => ChildProcess

export interface HeadlessAgentRunnerOptions extends TerminalProcessLifecycleOptions {
  /** Test-only spawn injection. Production leaves this unset. */
  spawn?: HeadlessSpawnFn
}

export interface HeadlessSession {
  id: string
  agentId: string
  process: ChildProcess
  handle: WorkerHandle
}

export interface HeadlessSpawnOptions {
  env?: Record<string, string>
}

export interface InjectedHeadlessTransport {
  handle: WorkerHandle
  pid?: number
  signal?: (force: boolean) => void
}

export class HeadlessAgentRunner extends EventEmitter {
  private sessions = new Map<string, HeadlessSession>()
  private scrollbacks = new Map<string, string>()
  private sendSink: TerminalSendSink | null = null
  private readonly lifecycle: ProcessLifecycleController
  private readonly spawnImpl: HeadlessSpawnFn

  constructor(options: HeadlessAgentRunnerOptions = {}) {
    super()
    this.lifecycle = new ProcessLifecycleController(
      'headless',
      options.treeSignaler ?? createDefaultProcessTreeSignaler()
    )
    this.spawnImpl = options.spawn ?? spawn
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

  private emitToSink(channel: string, data: unknown): void {
    this.sendSink?.(channel, data)
  }

  spawn(
    agentId: string,
    cwd: string,
    shellCommand: string,
    options: HeadlessSpawnOptions = {}
  ): string {
    this.lifecycle.assertAdmits('spawn')
    const processId = uuidv4()
    const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || 'bash'
    const shellArgs =
      process.platform === 'win32'
        ? ['-NoLogo', '-NoProfile', '-Command', `Set-Location '${cwd.replace(/'/g, "''")}'; ${shellCommand}`]
        : ['-lc', `cd ${shellQuote(cwd)} && ${shellCommand}`]

    const proc = this.spawnImpl(shell, shellArgs, {
      cwd,
      env: { ...process.env, ...(options.env ?? {}) } as Record<string, string>,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const handle = new WorkerHandle(processId, agentId, 'headless')
    const session: HeadlessSession = { id: processId, agentId, process: proc, handle }
    this.trackProcess(session)
    return processId
  }

  /**
   * Test-only: own a handle/transport without spawning a shell.
   * Distinguishes deterministic timeout/error cases from real process evidence.
   */
  adoptTransportForTests(transport: InjectedHeadlessTransport): string {
    this.lifecycle.assertAdmits('spawn')
    const { handle } = transport
    this.lifecycle.track({
      id: handle.id,
      agentId: handle.agentId,
      kind: 'headless',
      pid: transport.pid,
      handle,
      signaled: false,
      signalLocal: transport.signal
    })
    return handle.id
  }

  private trackProcess(session: HeadlessSession): void {
    const { id: processId, agentId, process: proc, handle } = session
    this.sessions.set(processId, session)
    this.lifecycle.track({
      id: processId,
      agentId,
      kind: 'headless',
      pid: isRecordablePid(proc.pid) ? proc.pid : undefined,
      handle,
      signaled: false,
      signalLocal: (force) => {
        // Windows ChildProcess.kill is TerminateProcess on this PID only and can
        // orphan descendants if it runs before/instead of taskkill /T.
        if (process.platform === 'win32' && isRecordablePid(proc.pid)) return
        try {
          proc.kill(force ? 'SIGKILL' : 'SIGTERM')
        } catch {
          /* already exited */
        }
      }
    })

    const appendOutput = (stream: 'stdout' | 'stderr', data: Buffer): void => {
      const chunk = data.toString()
      const prefix = stream === 'stderr' ? '[stderr] ' : ''
      const existing = this.scrollbacks.get(processId) || ''
      const next = existing + prefix + chunk
      this.scrollbacks.set(
        processId,
        next.length > MAX_HEADLESS_SCROLLBACK_CHARS
          ? next.slice(next.length - MAX_HEADLESS_SCROLLBACK_CHARS)
          : next
      )
      this.emit('data', { processId, agentId, data: chunk, stream })
      this.emitToSink('headless:data', { processId, agentId, data: chunk, stream })
    }

    proc.stdout?.on('data', (data) => appendOutput('stdout', data))
    proc.stderr?.on('data', (data) => appendOutput('stderr', data))

    const reportExit = (code: number | null, signal: string | null, error?: unknown): void => {
      if (!handle.alive) return
      const metadata = handle.recordExit(code, signal, error)
      // An explicit kill may have removed the session already; still publish its final exit once.
      this.sessions.delete(processId)
      const payload = { processId, agentId, exitCode: metadata.code, signal: metadata.signal, exit: metadata }
      this.emit('exit', payload)
      this.emitToSink('headless:exit', payload)
    }
    proc.on('error', (error) => reportExit(null, null, error))
    proc.on('exit', (code, signal) => reportExit(code, signal))
    proc.on('close', () => {
      handle.recordClose()
      if (this.lifecycle.getPhase() !== 'idle') {
        this.scrollbacks.delete(processId)
      }
      proc.stdout?.removeAllListeners()
      proc.stderr?.removeAllListeners()
      this.lifecycle.untrackIfSettled(processId)
    })
  }

  has(processId: string): boolean {
    return this.sessions.has(processId)
  }

  getHandle(processId: string): WorkerHandle | undefined {
    return this.sessions.get(processId)?.handle
  }

  kill(processId: string): void {
    const session = this.sessions.get(processId)
    if (!session) return
    this.lifecycle.signalWorker(processId, false)
    this.sessions.delete(processId)
  }

  killByAgentId(agentId: string): void {
    for (const [processId, session] of [...this.sessions]) {
      if (session.agentId === agentId) {
        this.kill(processId)
      }
    }
  }

  killAll(): void {
    for (const processId of [...this.sessions.keys()]) {
      this.kill(processId)
    }
  }

  list(): Array<{ processId: string; agentId: string; startedAt: string }> {
    return Array.from(this.sessions.values()).map((session) => ({
      processId: session.id,
      agentId: session.agentId,
      startedAt: session.handle.startedAt
    }))
  }

  getScrollbacks(): Record<string, string> {
    return Object.fromEntries(this.scrollbacks)
  }

  loadScrollbacks(data: Record<string, string>): void {
    this.lifecycle.assertAdmits('loadScrollbacks')
    this.scrollbacks = new Map(Object.entries(data))
  }

  clearScrollbacks(): void {
    this.scrollbacks.clear()
  }
}

function isRecordablePid(pid: number | undefined): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && pid !== process.pid
}

function shellQuote(value: string): string {
  if (process.platform === 'win32') {
    return `'${value.replace(/'/g, "''")}'`
  }
  return `'${value.replace(/'/g, "'\\''")}'`
}
