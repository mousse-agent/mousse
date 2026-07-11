import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import { resolve } from 'path'
import * as pty from 'node-pty'

export interface PtySession {
  id: string
  agentId: string
  pty: pty.IPty
}

export interface PtyCreateOptions {
  env?: Record<string, string>
  shellArgs?: string[]
}

export type TerminalSendSink = (channel: string, data: unknown) => void

export class PtyManager extends EventEmitter {
  private sessions = new Map<string, PtySession>()
  private scrollbacks = new Map<string, string>()
  private sendSink: TerminalSendSink | null = null
  private focusWindowFn: (() => void) | null = null

  setSendSink(sink: TerminalSendSink): void {
    this.sendSink = sink
  }

  setFocusWindow(fn: () => void): void {
    this.focusWindowFn = fn
  }

  focusWindow(): void {
    this.focusWindowFn?.()
  }

  private emitToSink(channel: string, data: unknown): void {
    this.sendSink?.(channel, data)
  }

  create(agentId: string, cwd: string, command?: string, options: PtyCreateOptions = {}): string {
    const ptyId = uuidv4()
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

    const session: PtySession = { id: ptyId, agentId, pty: instance }
    this.sessions.set(ptyId, session)

    instance.onData((data) => {
      const existing = this.scrollbacks.get(ptyId) || ''
      this.scrollbacks.set(ptyId, existing + data)
      this.emit('data', { ptyId, data })
      this.emitToSink('pty:data', { ptyId, data })
    })

    instance.onExit(() => {
      this.sessions.delete(ptyId)
      this.emit('exit', { ptyId, agentId })
      this.emitToSink('pty:exit', { ptyId, agentId })
    })

    return ptyId
  }

  write(ptyId: string, data: string): void {
    const session = this.sessions.get(ptyId)
    session?.pty.write(data)
  }

  has(ptyId: string): boolean {
    return this.sessions.has(ptyId)
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
  }

  killByAgentId(agentId: string): void {
    for (const [ptyId, session] of this.sessions) {
      if (session.agentId === agentId) {
        session.pty.kill()
        this.sessions.delete(ptyId)
      }
    }
  }

  killAll(): void {
    for (const session of this.sessions.values()) {
      session.pty.kill()
    }
    this.sessions.clear()
  }

  list(): Array<{ ptyId: string; agentId: string }> {
    return Array.from(this.sessions.values()).map((s) => ({
      ptyId: s.id,
      agentId: s.agentId
    }))
  }

  getScrollbacks(): Record<string, string> {
    return Object.fromEntries(this.scrollbacks)
  }

  loadScrollbacks(data: Record<string, string>): void {
    this.scrollbacks = new Map(Object.entries(data))
  }

  clearScrollbacks(): void {
    this.scrollbacks.clear()
  }
}
