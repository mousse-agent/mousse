import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { RelayServer } from '../../../src/mms/net/relay/server'
import { FakeClock } from '../harness/FakeClock'
import { endpoint, identity } from './endpoints'

const cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})

async function setup(options: Partial<ConstructorParameters<typeof RelayServer>[0]> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mnfix-relay-accounting-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const a = identity()
  const b = identity()
  const databasePath = join(directory, 'relay.sqlite')
  const serverOptions = { databasePath, allowNodes: [a, b], ...options }
  const server = new RelayServer(serverOptions)
  cleanup.push(() => server.close())
  await server.listen()
  const left = endpoint(server.address())
  const right = endpoint(server.address())
  cleanup.push(() => {
    left.ws.terminate()
    right.ws.terminate()
  })
  const rightAuth = await right.authenticate(b, 'listen')
  expect(rightAuth.reply).toEqual({ t: 'ready' })
  const leftAuth = await left.authenticate(a, 'dial', b.node)
  expect(leftAuth.reply).toEqual({ t: 'ready' })
  expect(JSON.parse((await left.next()).toString()).t).toBe('paired')
  expect(JSON.parse((await right.next()).toString()).t).toBe('paired')
  const send = async (bytes: Buffer) => {
    left.ws.send(bytes)
    expect(await right.next()).toEqual(bytes)
  }
  return { server, serverOptions, left, right, leftAuth, rightAuth, a, send }
}

it('enforces the byte quota exactly at the limit before a persistence flush', async () => {
  const p = await setup({ bytesPerHour: 1024 })
  await p.send(Buffer.alloc(1024 - p.leftAuth.bytes - 1))
  await p.send(Buffer.from([42]))
  p.left.ws.send(Buffer.from([43]))
  expect(JSON.parse((await p.left.next()).toString())).toEqual({ t: 'error', code: 'quota_exceeded' })
})

it('persists forwarded bytes on clean close and enforces them after restart', async () => {
  const p = await setup({ bytesPerHour: 1024 })
  await p.send(Buffer.alloc(1024 - p.leftAuth.bytes))
  await p.server.close()
  const restarted = new RelayServer(p.serverOptions)
  cleanup.push(() => restarted.close())
  await restarted.listen()
  const denied = endpoint(restarted.address())
  cleanup.push(() => denied.ws.terminate())
  expect((await denied.authenticate(p.a, 'listen')).reply).toEqual({ t: 'error', code: 'quota_exceeded' })
})

it('forwards 100 frames without a durable transaction in the frame handlers', async () => {
  const clock = new FakeClock()
  const p = await setup({ clock })
  const exec = vi.spyOn(DatabaseSync.prototype, 'exec')
  for (let i = 0; i < 100; i++) await p.send(Buffer.alloc(1024, i))
  expect(exec.mock.calls.filter(([sql]) => sql === 'BEGIN IMMEDIATE')).toHaveLength(0)
  clock.advance(1000)
  expect(exec.mock.calls.filter(([sql]) => sql === 'BEGIN IMMEDIATE')).toHaveLength(1)
  const db = new DatabaseSync(p.serverOptions.databasePath, { readOnly: true })
  try {
    expect(Number(db.prepare('SELECT bytes FROM relay_usage WHERE principal=?').get(`node:${p.a.node}`)!.bytes))
      .toBe(p.leftAuth.bytes + 100 * 1024)
  } finally { db.close() }
})

it('rejects backward clock movement within a process before any flush', async () => {
  const clock = new FakeClock()
  const p = await setup({ clock })
  await p.send(Buffer.from('first'))
  clock.setWallTime(clock.now() - 1)
  p.left.ws.send(Buffer.from('second'))
  expect(JSON.parse((await p.left.next()).toString())).toEqual({ t: 'error', code: 'clock_skew' })
})

it('bounds the global unflushed window across principals and waits for the deferred threshold flush', async () => {
  const clock = new FakeClock()
  const p = await setup({ clock })
  const exec = vi.spyOn(DatabaseSync.prototype, 'exec')
  const frame = Buffer.alloc(64 * 1024, 9)
  for (let i = 0; i < 8; i++) {
    await p.send(frame)
    p.right.ws.send(frame)
    expect(await p.left.next()).toEqual(frame)
  }
  expect(exec.mock.calls.filter(([sql]) => sql === 'BEGIN IMMEDIATE')).toHaveLength(0)
  let forwarded = false
  const arrived = p.right.next().then(bytes => {
    forwarded = true
    return bytes
  })
  p.left.ws.send(frame)
  // Give the real sockets time to deliver the 17th frame without advancing the accounting timer.
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(forwarded).toBe(false)
  clock.advance(0)
  expect(await arrived).toEqual(frame)
  expect(exec.mock.calls.filter(([sql]) => sql === 'BEGIN IMMEDIATE')).toHaveLength(1)
  const db = new DatabaseSync(p.serverOptions.databasePath, { readOnly: true })
  try {
    const total = Number(db.prepare('SELECT SUM(bytes) AS n FROM relay_usage').get()!.n)
    expect(total).toBe(1024 * 1024 + p.leftAuth.bytes + p.rightAuth.bytes)
  } finally { db.close() }
})

it('flushes byte usage when an endpoint disconnects without stopping the relay', async () => {
  const clock = new FakeClock()
  const p = await setup({ clock })
  await p.send(Buffer.from('last frame'))
  const closed = new Promise(resolve => p.right.ws.once('close', resolve))
  p.left.ws.close()
  await closed
  const db = new DatabaseSync(p.serverOptions.databasePath, { readOnly: true })
  try {
    expect(Number(db.prepare('SELECT bytes FROM relay_usage WHERE principal=?').get(`node:${p.a.node}`)!.bytes))
      .toBe(p.leftAuth.bytes + 10)
  } finally { db.close() }
})
