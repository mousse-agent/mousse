import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { acquireMmsOwnerLease } from '../src/mms/ownership/MmsOwnerLease'
import { cleanupStaleUnixSocket, unixSocketPath } from '../src/mms/protocol/endpoint'

it.runIf(process.platform !== 'win32')('reclaims a refused predecessor socket under the new lease while preserving live listeners and non-sockets', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mousse-socket-recovery-'))
  let lease = acquireMmsOwnerLease(home, { kind: 'test' })
  const socketPath = unixSocketPath(home)
  const child = spawn(process.execPath, ['-e', `require('node:net').createServer(s => s.end()).listen(process.argv[1], () => process.stdout.write('ready'))`, socketPath], { stdio: ['ignore', 'pipe', 'pipe'] })
  const server = createServer((socket) => socket.end())
  try {
    await once(child.stdout!, 'data')
    await expect(cleanupStaleUnixSocket(home, lease.owner.token)).resolves.toMatchObject({ removed: false, reason: 'not-proven-stale' })
    expect(existsSync(socketPath)).toBe(true)
    const exited = once(child, 'close')
    child.kill('SIGKILL')
    await exited
    expect(existsSync(socketPath)).toBe(true)
    const previousToken = lease.owner.token
    expect(lease.release()).toBe(true)
    lease = acquireMmsOwnerLease(home, { kind: 'test' })
    expect(lease.owner.token).not.toBe(previousToken)
    await expect(cleanupStaleUnixSocket(home, previousToken)).resolves.toMatchObject({ removed: false, reason: 'live-owner' })
    await expect(cleanupStaleUnixSocket(home, lease.owner.token)).resolves.toMatchObject({ removed: true, reason: 'refused-predecessor-socket' })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
    await expect(cleanupStaleUnixSocket(home, lease.owner.token)).resolves.toMatchObject({ removed: false })
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    writeFileSync(socketPath, 'not a socket')
    await expect(cleanupStaleUnixSocket(home, lease.owner.token)).resolves.toMatchObject({ removed: false, reason: 'not-a-socket' })
    expect(readFileSync(socketPath, 'utf8')).toBe('not a socket')
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'close'); child.kill('SIGKILL'); await exited
    }
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
    lease.release()
    rmSync(home, { recursive: true, force: true })
  }
}, 20_000)
