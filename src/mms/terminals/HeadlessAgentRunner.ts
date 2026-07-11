import { EventEmitter } from 'events'
import { spawn, type ChildProcess } from 'child_process'
import { v4 as uuidv4 } from 'uuid'
import type { TerminalSendSink } from './PtyManager'

export interface HeadlessSession {
  id: string
  agentId: string
  process: ChildProcess
}

export interface HeadlessSpawnOptions {
  env?: Record<string, string>
}

export class HeadlessAgentRunner extends EventEmitter {
  private sessions = new Map<string, HeadlessSession>()
  private scrollbacks = new Map<string, string>()
  private sendSink: TerminalSendSink | null = null

  setSendSink(sink: TerminalSendSink): void {
    this.sendSink = sink
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
    const processId = uuidv4()
    const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || 'bash'
    const shellArgs =
      process.platform === 'win32'
        ? ['-NoLogo', '-NoProfile', '-Command', `Set-Location '${cwd.replace(/'/g, "''")}'; ${shellCommand}`]
        : ['-lc', `cd ${shellQuote(cwd)} && ${shellCommand}`]

    const proc = spawn(shell, shellArgs, {
      cwd,
      env: { ...process.env, ...(options.env ?? {}) } as Record<string, string>,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const session: HeadlessSession = { id: processId, agentId, process: proc }
    this.sessions.set(processId, session)

    const appendOutput = (stream: 'stdout' | 'stderr', data: Buffer): void => {
      const chunk = data.toString()
      const prefix = stream === 'stderr' ? '[stderr] ' : ''
      const existing = this.scrollbacks.get(processId) || ''
      this.scrollbacks.set(processId, existing + prefix + chunk)
      this.emit('data', { processId, agentId, data: chunk, stream })
      this.emitToSink('headless:data', { processId, agentId, data: chunk, stream })
    }

    proc.stdout?.on('data', (data) => appendOutput('stdout', data))
    proc.stderr?.on('data', (data) => appendOutput('stderr', data))

    proc.on('exit', (code, signal) => {
      this.sessions.delete(processId)
      const payload = { processId, agentId, exitCode: code, signal }
      this.emit('exit', payload)
      this.emitToSink('headless:exit', payload)
    })

    return processId
  }

  has(processId: string): boolean {
    return this.sessions.has(processId)
  }

  kill(processId: string): void {
    const session = this.sessions.get(processId)
    if (!session) return
    session.process.kill()
    this.sessions.delete(processId)
  }

  killByAgentId(agentId: string): void {
    for (const [processId, session] of this.sessions) {
      if (session.agentId === agentId) {
        session.process.kill()
        this.sessions.delete(processId)
      }
    }
  }

  killAll(): void {
    for (const session of this.sessions.values()) {
      session.process.kill()
    }
    this.sessions.clear()
  }

  list(): Array<{ processId: string; agentId: string }> {
    return Array.from(this.sessions.values()).map((session) => ({
      processId: session.id,
      agentId: session.agentId
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

function shellQuote(value: string): string {
  if (process.platform === 'win32') {
    return `'${value.replace(/'/g, "''")}'`
  }
  return `'${value.replace(/'/g, "'\\''")}'`
}
