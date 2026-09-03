/**
 * Local IPC endpoint resolution for MMS protocol.
 * Windows named pipe from SHA-256 of canonical home; Unix socket under home.
 */

import { createHash } from 'crypto'
import { existsSync, lstatSync, unlinkSync } from 'fs'
import { join } from 'path'
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
 * Safe stale Unix socket cleanup: remove only if path is a socket and owner is ours/dead.
 * Never deletes a live foreign owner's socket based on guesswork.
 */
export function cleanupStaleUnixSocket(homeDir: string): { removed: boolean; reason: string } {
  if (process.platform === 'win32') {
    return { removed: false, reason: 'windows-named-pipe' }
  }
  const sock = unixSocketPath(homeDir)
  if (!existsSync(sock)) {
    return { removed: false, reason: 'missing' }
  }
  try {
    const st = lstatSync(sock)
    if (!st.isSocket()) {
      return { removed: false, reason: 'not-a-socket' }
    }
  } catch {
    return { removed: false, reason: 'stat-failed' }
  }

  const owner = readOwnerRecord(homeDir)
  if (owner) {
    // A same-process owner can still have a live server listening on this
    // socket (for example, a second service instance in one test/runtime).
    // Never unlink it speculatively; a clean stop removes its own socket.
    if (owner.pid === process.pid) {
      return { removed: false, reason: 'same-process-owner' }
    }
    if (isProcessAlive(owner.pid)) {
      return { removed: false, reason: 'live-owner' }
    }
    // Dead owner — safe to remove stale socket
    try {
      unlinkSync(sock)
      return { removed: true, reason: 'dead-owner' }
    } catch {
      return { removed: false, reason: 'unlink-failed' }
    }
  }

  // No owner record: only remove if we cannot connect (caller may try listen first).
  // Conservative: do not unlink without owner proof.
  return { removed: false, reason: 'no-owner-record' }
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
