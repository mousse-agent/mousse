import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ChatGptStore, chatgptStorePath, emptyStore } from '../../../src/mms/harness/chatgpt/store'
import { crashChild } from '../../support/build'
import { plainCodec } from './fakeIssuer'

// Maintenance (settling the encryption marker, finishing a swap, clearing replacement files)
// raced by several processes. Each test pauses one process inside its maintenance and starts a
// reader in another: the reader must wait for the mutex, never act on the paused work.

let childExecutable: string
beforeAll(async () => {
  childExecutable = await crashChild('tests/harness/chatgpt/store-child.ts', { target: 'node24' })
}, 120_000)

const roots: string[] = []
const children: ChildProcess[] = []
afterEach(() => {
  for (const child of children.splice(0)) child.kill()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function setup(): { path: string; barrier: string } {
  const root = mkdtempSync(join(tmpdir(), 'mousse-chatgpt-processes-'))
  roots.push(root)
  const barrier = join(root, 'barrier')
  mkdirSync(barrier)
  return { path: chatgptStorePath(join(root, 'profile'), 'codex:managed'), barrier }
}

interface Run {
  child: ChildProcess
  done: Promise<{ code: number | null; output: string }>
}

function start(args: string[]): Run {
  const child = spawn(process.execPath, [childExecutable, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  let output = ''
  child.stdout!.on('data', (chunk) => (output += chunk))
  const done = new Promise<{ code: number | null; output: string }>((resolve) => child.on('exit', (code) => resolve({ code, output })))
  return { child, done }
}

async function paused(barrier: string): Promise<void> {
  await vi.waitFor(() => expect(existsSync(join(barrier, 'ready'))).toBe(true), { timeout: 30_000, interval: 20 })
}

/** Resolves true if `run` is still going after `ms`: it is waiting for the mutex. */
async function stillWaiting(run: Run, ms = 600): Promise<boolean> {
  const finished = await Promise.race([run.done.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))])
  return !finished
}

function release(barrier: string): void {
  writeFileSync(join(barrier, 'go'), '')
}

function damage(path: string): void {
  const bytes = readFileSync(path)
  bytes.fill(0x21, 0, 100)
  writeFileSync(path, bytes)
}

function row(path: string): { encrypted: number } | undefined {
  const database = new DatabaseSync(path)
  try {
    return database.prepare('SELECT encrypted FROM store WHERE id = 1').get() as never
  } finally {
    database.close()
  }
}

const markers = (path: string) => readdirSync(dirname(path)).filter((name) => name.startsWith('chatgpt.encrypted')).sort()

describe('ChatGPT store maintenance across processes', () => {
  it('a reader waits for an encrypted write in progress; when the writer dies after its commit, the marker is promoted', async () => {
    const { path, barrier } = setup()
    new ChatGptStore(path, plainCodec).write({ ...emptyStore(), credentialEpoch: 1 })
    const writer = start(['write-encrypted', path, barrier])
    await paused(barrier)
    // The writer committed an encrypted row and holds the mutex before promoting its marker.
    expect(markers(path)).toEqual(['chatgpt.encrypted.pending'])
    const reader = start(['read', path])
    expect(await stillWaiting(reader)).toBe(true)
    expect(markers(path)).toEqual(['chatgpt.encrypted.pending'])
    // The writer crashes: its mutex ends with it, and the reader settles from the committed row.
    writer.child.kill('SIGKILL')
    await writer.done
    const result = JSON.parse((await reader.done).output)
    expect(result).toMatchObject({ ok: false, failure: 'storage_locked' })
    expect(markers(path)).toEqual(['chatgpt.encrypted'])
    expect(row(path)).toMatchObject({ encrypted: 1 })
  }, 60_000)

  it('a reader waits for a swap in progress instead of finishing it, then reads the replacement', async () => {
    const { path, barrier } = setup()
    new ChatGptStore(path, plainCodec).write({ ...emptyStore(), credentialEpoch: 1 })
    damage(path)
    const recovering = start(['recover', path, barrier, 'swap-moved'])
    await paused(barrier)
    // The original is aside and the replacement not yet in place.
    expect(existsSync(path)).toBe(false)
    const reader = start(['read', path])
    expect(await stillWaiting(reader)).toBe(true)
    release(barrier)
    expect((await recovering.done).code).toBe(0)
    const result = JSON.parse((await reader.done).output)
    expect(result).toMatchObject({ ok: true, revision: 1 })
    expect(result.fence).toBeGreaterThan(1_000_000_000_000)
  }, 60_000)

  it('a swap whose process dies midway is finished by the next reader', async () => {
    const { path, barrier } = setup()
    new ChatGptStore(path, plainCodec).write({ ...emptyStore(), credentialEpoch: 1 })
    damage(path)
    const recovering = start(['recover', path, barrier, 'swap-moved'])
    await paused(barrier)
    const reader = start(['read', path])
    expect(await stillWaiting(reader)).toBe(true)
    recovering.child.kill('SIGKILL')
    await recovering.done
    expect(JSON.parse((await reader.done).output)).toMatchObject({ ok: true, revision: 1 })
    expect(readdirSync(dirname(path)).some((name) => name.endsWith('.swap') || name.includes('.new-'))).toBe(false)
  }, 60_000)

  it('a replacement being built is never cleared by a reader, however old it looks', async () => {
    const { path, barrier } = setup()
    new ChatGptStore(path, plainCodec).write({ ...emptyStore(), credentialEpoch: 1 })
    damage(path)
    const recovering = start(['recover', path, barrier, 'swap-built'])
    await paused(barrier)
    // The process looks suspended for a long time before saving its swap intent.
    const temporary = readdirSync(dirname(path)).find((name) => name.includes('.new-'))!
    const longAgo = new Date(Date.now() - 60 * 60_000)
    utimesSync(join(dirname(path), temporary), longAgo, longAgo)
    const reader = start(['read', path])
    expect(await stillWaiting(reader)).toBe(true)
    expect(existsSync(join(dirname(path), temporary))).toBe(true)
    release(barrier)
    expect((await recovering.done).code).toBe(0)
    expect(JSON.parse((await reader.done).output)).toMatchObject({ ok: true, revision: 1 })
  }, 60_000)
})
