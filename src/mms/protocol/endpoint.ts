/**
 * Local IPC endpoint resolution for MMS protocol.
 * Windows named pipe from SHA-256 of canonical home; Unix socket under home.
 */

import { createHash } from 'crypto'
import { existsSync, lstatSync, unlinkSync } from 'fs'
import { join } from 'path'
import { createConnection } from 'net'
import { isProcessAlive } from '../queue/processLiveness'
import { canonicalizeHome, readOwnerRecord } from '../ownership/MmsOwnerLease'

export function hashHomeForEndpoint(homeDir: string): string {
  return createHash('sha256').update(canonicalizeHome(homeDir), 'utf-8').digest('hex').slice(0, 32)
}

/** Windows named pipe path for this home (not a filesystem path). */
export function windowsNamedPipePath(homeDir: string): string {
  const h = hashHomeForEndpoint(homeDir)
  return `\\\\.\\pipe\\mousse-mms-${h}`
}

/** Unix domain socket path under MOUSSE_HOME. */
export function unixSocketPath(homeDir: string): string {
  return join(canonicalizeHome(homeDir), 'mms.sock')
}

export function resolveLocalEndpoint(homeDir: string): {
  path: string
  platform: 'win32' | 'unix'
} {
  if (process.platform === 'win32') {
    return { path: windowsNamedPipePath(homeDir), platform: 'win32' }
  }
  return { path: unixSocketPath(homeDir), platform: 'unix' }
}

/**
 * Safe stale Unix socket cleanup: require owner proof and a refused connection.
 * Never deletes a live foreign owner's socket based on guesswork.
 */
export async function cleanupStaleUnixSocket(homeDir: string, ownerToken?: string): Promise<{ removed: boolean; reason: string }> {
  if (process.platform === 'win32') {
    return { removed: false, reason: 'windows-named-pipe' }
  }
  const sock = unixSocketPath(homeDir)
  if (!existsSync(sock)) {
    return { removed: false, reason: 'missing' }
  }
  let original: ReturnType<typeof lstatSync>
  try {
    const st = original = lstatSync(sock)
    if (!st.isSocket()) {
      return { removed: false, reason: 'not-a-socket' }
    }
  } catch {
    return { removed: false, reason: 'stat-failed' }
  }

  const owner = readOwnerRecord(homeDir)
  if (!owner) return { removed: false, reason: 'no-owner-record' }
  // Startup acquires/replaces the owner lease before opening its endpoint. The
  // stale socket may therefore belong to a crashed predecessor, while metadata
  // already names this process. Its exact lease token is necessary, not enough:
  // a same-process or foreign server could still be listening at this path.
  const ownsLease = owner.pid === process.pid && owner.token === ownerToken
  if (!ownsLease && isProcessAlive(owner.pid)) return { removed: false, reason: 'live-owner' }
  const refused = await new Promise<boolean>((resolve) => {
    const socket = createConnection(sock)
    const done = (value: boolean): void => { clearTimeout(timer); socket.destroy(); resolve(value) }
    const timer = setTimeout(() => done(false), 500)
    socket.once('connect', () => done(false))
    socket.once('error', (error: NodeJS.ErrnoException) => done(error.code === 'ECONNREFUSED'))
  })
  if (!refused) return { removed: false, reason: 'not-proven-stale' }
  const currentOwner = readOwnerRecord(homeDir)
  if (currentOwner?.token !== owner.token || currentOwner.pid !== owner.pid) {
    return { removed: false, reason: 'owner-changed' }
  }
  try {
    const current = lstatSync(sock)
    if (!current.isSocket() || current.dev !== original.dev || current.ino !== original.ino) {
      return { removed: false, reason: 'socket-changed' }
    }
    unlinkSync(sock)
    return { removed: true, reason: ownsLease ? 'refused-predecessor-socket' : 'dead-owner' }
  } catch {
    return { removed: false, reason: 'unlink-failed' }
  }
}

/** Force-remove unix socket for our listen attempt after ownership confirmed. */
export function unlinkUnixSocketIfExists(homeDir: string): void {
  if (process.platform === 'win32') return
  const sock = unixSocketPath(homeDir)
  try {
    if (existsSync(sock)) unlinkSync(sock)
  } catch {
    /* ignore */
  }
}
