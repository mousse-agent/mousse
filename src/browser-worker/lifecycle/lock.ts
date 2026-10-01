import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { isProcessAlive } from './process'

/**
 * Exclusive workspace writer lock. Lives in the worker so Chromium user-data
 * never has two writers. Reclaims only a dead PID; never kills by process name.
 */

export interface WorkspaceLockOwner {
  pid: number
  token: string
  sessionId: string
  generation: number
  acquiredAt: string
}

export class WorkspaceLockBusyError extends Error {
  constructor(readonly lockPath: string, readonly owner: WorkspaceLockOwner | null) {
    super(owner ? `Workspace lock busy: ${lockPath} (pid ${owner.pid})` : `Workspace lock busy: ${lockPath}`)
    this.name = 'WorkspaceLockBusyError'
  }
}

export function readWorkspaceLock(lockPath: string): WorkspaceLockOwner | null {
  try {
    if (!existsSync(lockPath)) return null
    const parsed = JSON.parse(readFileSync(lockPath, 'utf-8')) as Partial<WorkspaceLockOwner>
    if (!Number.isInteger(parsed.pid) || typeof parsed.token !== 'string' || typeof parsed.sessionId !== 'string') return null
    return {
      pid: parsed.pid as number,
      token: parsed.token,
      sessionId: parsed.sessionId,
      generation: typeof parsed.generation === 'number' ? parsed.generation : 1,
      acquiredAt: typeof parsed.acquiredAt === 'string' ? parsed.acquiredAt : new Date(0).toISOString()
    }
  } catch {
    return null
  }
}

export class WorkspaceLock {
  private fd: number | null = null
  private owner: WorkspaceLockOwner | null = null

  constructor(readonly lockPath: string) {}

  acquire(sessionId: string, generation: number): WorkspaceLockOwner {
    mkdirSync(dirname(this.lockPath), { recursive: true })
    const existing = readWorkspaceLock(this.lockPath)
    if (existing && isProcessAlive(existing.pid) && existing.pid !== process.pid) {
      throw new WorkspaceLockBusyError(this.lockPath, existing)
    }
    if (existing && !isProcessAlive(existing.pid)) {
      try { unlinkSync(this.lockPath) } catch { /* race */ }
    }
    try {
      const fd = openSync(this.lockPath, 'wx')
      const owner: WorkspaceLockOwner = {
        pid: process.pid,
        token: randomBytes(16).toString('hex'),
        sessionId,
        generation,
        acquiredAt: new Date().toISOString()
      }
      writeSync(fd, JSON.stringify(owner, null, 2))
      this.fd = fd
      this.owner = owner
      return owner
    } catch {
      throw new WorkspaceLockBusyError(this.lockPath, readWorkspaceLock(this.lockPath))
    }
  }

  release(): void {
    const token = this.owner?.token
    try { if (this.fd !== null) closeSync(this.fd) } catch { /* ignore */ }
    this.fd = null
    this.owner = null
    if (!token) return
    try {
      const still = readWorkspaceLock(this.lockPath)
      if (still && still.token === token) unlinkSync(this.lockPath)
    } catch { /* ignore */ }
  }
}
