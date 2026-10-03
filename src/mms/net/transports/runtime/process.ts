import { spawn, execFile, type ChildProcess } from 'node:child_process'
import type { Clock } from '../../contracts'
import { NetError } from '../../../../shared/net/errors'

export function runBinary(binary: string, args: string[], options: { timeoutMs?: number; maximumBytes?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: options.timeoutMs ?? 5000, maxBuffer: options.maximumBytes ?? 64 * 1024, windowsHide: true, encoding: 'utf8', env: cleanEnvironment() }, (error, stdout) => {
      if (error) reject(new NetError('route_unreachable', 'The transport command failed.'))
      else resolve(stdout)
    })
  })
}

/** No inherited token/config/log overrides may redirect a managed tunnel. */
export function cleanEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('TUNNEL_') && !['NO_AUTOUPDATE', 'NO_TLS_VERIFY'].includes(key)))
}

export class ProcessSupervisor {
  private child?: ChildProcess
  private stopped = false
  private restarts = 0
  private restartTimer?: { cancel(): void }
  private tail = ''
  private readonly exitWaiters = new Set<() => void>()
  constructor(private readonly options: { binary: string; args: string[]; clock: Clock; line(line: string): void; state(state: 'provisioning' | 'degraded' | 'failed'): void; maxRestarts?: number; cwd?: string }) {}
  start(): void {
    if (this.child || this.stopped) return
    this.options.state('provisioning')
    const child = this.child = spawn(this.options.binary, this.options.args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: cleanEnvironment(), cwd: this.options.cwd })
    const read = (chunk: Buffer) => {
      this.tail = (this.tail + chunk.toString('utf8')).slice(-16 * 1024)
      let newline: number
      while ((newline = this.tail.indexOf('\n')) >= 0) {
        const line = this.tail.slice(0, newline); this.tail = this.tail.slice(newline + 1)
        this.options.line(line)
      }
    }
    child.stdout?.on('data', read); child.stderr?.on('data', read)
    let finished = false
    const ended = () => {
      if (finished) return; finished = true
      if (this.child === child) this.child = undefined
      this.tail = ''
      for (const waiter of this.exitWaiters) waiter(); this.exitWaiters.clear()
      if (this.stopped) return
      this.options.state('degraded')
      if (++this.restarts > (this.options.maxRestarts ?? 6)) { this.options.state('failed'); return }
      this.restartTimer = this.options.clock.setTimeout(() => { this.restartTimer = undefined; this.start() }, Math.min(60_000, 1000 * 2 ** (this.restarts - 1)))
    }
    child.on('error', ended); child.once('exit', ended)
  }
  async stop(): Promise<void> {
    this.stopped = true; this.restartTimer?.cancel(); this.restartTimer = undefined
    const child = this.child
    if (!child) return
    await new Promise<void>(resolve => {
      let timer: ReturnType<typeof setTimeout>
      const done = () => { clearTimeout(timer); this.exitWaiters.delete(done); resolve() }
      this.exitWaiters.add(done)
      timer = setTimeout(() => { child.kill('SIGKILL'); done() }, 3000)
      child.kill('SIGTERM')
    })
  }
}
