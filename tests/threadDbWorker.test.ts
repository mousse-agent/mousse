import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getThreadDbWorkerBuildOptions } from '../scripts/build-cli.mjs'
import { ThreadDbClient } from '../src/mms/data/threadDb/threadDbClient'
import { ThreadDbStore } from '../src/mms/data/threadDb/threadDbStore'
import type { ChatMessage } from '../src/shared/types'

/** The worker as the build ships it, built into a temporary folder from the real build options. */
describe('thread database workers', () => {
  let out: string
  let dir: string
  let client: ThreadDbClient

  beforeAll(async () => {
    out = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-threaddb-worker-')))
    const options = getThreadDbWorkerBuildOptions(resolve(__dirname, '..'), 'out/cli')
    await build({ ...options, outfile: join(out, 'threadDbWorker.js'), logLevel: 'silent' })
    dir = join(out, 'thread')
    client = new ThreadDbClient({ script: join(out, 'threadDbWorker.js') })
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir)
  }, 60_000)

  afterAll(async () => {
    await client.close()
    rmSync(out, { recursive: true, force: true })
  })

  it('runs saves synchronously and reads off the event loop', async () => {
    expect(client.mode).toBe('worker')
    client.callSync('create', dir)
    const store = new ThreadDbStore(client)
    const messages = Array.from({ length: 200 }, (_, i) => ({ id: `m${i}`, role: 'user', content: `text ${i}`, timestamp: 't' }) as ChatMessage)
    expect(store.save(dir, { messages }).inserted).toBe(200)
    const pending = client.call('load', dir)
    // A save while a read is in flight is not held up by it: they run in different workers.
    const loaded = store.load(dir).messages
    loaded.push({ id: 'late', role: 'user', content: 'late', timestamp: 't' } as ChatMessage)
    expect(store.save(dir, { messages: loaded }).inserted).toBe(1)
    const read = await pending
    expect(read.rows.length).toBeGreaterThanOrEqual(200)
    const warmed = new ThreadDbStore(client)
    await warmed.warm(dir)
    expect(warmed.isWarm(dir)).toBe(true)
    expect(warmed.load(dir).messages).toHaveLength(201)
    expect(warmed.coldLoads).toBe(0)
  })

  it('answers a page while a large import is being built', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { legacyFingerprint } = await import('../src/mms/data/legacyThreadData')
    const source = join(out, 'big-json-thread')
    mkdirSync(source)
    const big = Array.from({ length: 4_000 }, (_, i) => ({ id: `b${i}`, role: 'user', content: `${i} `.repeat(2_000), timestamp: 't' }))
    writeFileSync(join(source, 'messages.json'), JSON.stringify(big))
    const importing = client.callImport('build', source, { tmpName: 'thread.db.import-test', fingerprint: legacyFingerprint(source) })
    // Let the import start before asking for the page.
    await new Promise((resolve) => setTimeout(resolve, 50))
    const started = performance.now()
    let pageAt = 0
    const page = client.call('page', dir, { limit: 5, maxBytes: 1_000_000 }).then((value) => { pageAt = performance.now(); return value })
    const [built] = await Promise.all([importing.then((value) => ({ value, at: performance.now() })), page])
    expect(built.value).toMatchObject({ ok: true })
    expect((await page).messages).toHaveLength(5)
    // The page came back before the import finished: they run in different workers.
    expect(pageAt).toBeLessThan(built.at)
    expect(pageAt - started).toBeLessThan(500)
  }, 60_000)

  it('returns errors from the worker as errors', async () => {
    expect(() => client.callSync('load', join(out, 'missing'))).toThrow(/No thread database/)
    await expect(client.call('load', join(out, 'missing'))).rejects.toThrow(/No thread database/)
  })
})

describe('index and import workers', () => {
  it('end once idle and start again on the next request', async () => {
    const out = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-threaddb-idle-')))
    const options = getThreadDbWorkerBuildOptions(resolve(__dirname, '..'), 'out/cli')
    await build({ ...options, outfile: join(out, 'threadDbWorker.js'), logLevel: 'silent' })
    const client = new ThreadDbClient({ script: join(out, 'threadDbWorker.js'), idleWorkerStopMs: 300 })
    const wait = (ms: number) => new Promise((done) => setTimeout(done, ms))
    try {
      expect(client.workerRoles()).toEqual(['write', 'read'])
      expect(await client.callIndex('exists', out)).toBe(false)
      expect(await client.callImport('exists', out)).toBe(false)
      expect(client.workerRoles()).toEqual(['write', 'read', 'index', 'import'])
      // Requests inside the idle time keep the worker.
      for (let i = 0; i < 3; i++) {
        await wait(150)
        expect(await client.callIndex('exists', out)).toBe(false)
      }
      expect(client.workerRoles()).toContain('index')
      await wait(700)
      expect(client.workerRoles()).toEqual(['write', 'read'])
      // A request after the stop starts a new worker that answers.
      expect(await client.callIndex('exists', out)).toBe(false)
      expect(client.workerRoles()).toEqual(['write', 'read', 'index'])
    } finally {
      await client.close()
      rmSync(out, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  }, 60_000)
})

describe('workers that are slow or die', () => {
  /**
   * Speaks the workers' protocols: "slow" answers after 600 ms, "die" ends the worker thread, anything else answers at
   * once with its own name and the worker's start count, so a test can tell a new worker from the old one.
   */
  async function fakeClient(idleWorkerStopMs: number): Promise<{ client: ThreadDbClient; out: string }> {
    const out = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-threaddb-fake-')))
    const script = join(out, 'fake.mjs')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(script, `
      import { parentPort, workerData, threadId } from 'node:worker_threads'
      const { role, flag, port } = workerData
      if (role === 'write') parentPort.on('message', (request) => {
        port.postMessage({ id: request.id, ok: true, value: request.op })
        Atomics.store(flag, 0, 1)
        Atomics.notify(flag, 0)
      })
      else parentPort.on('message', (request) => {
        if (request.op === 'die') process.exit(3)
        if (request.op === 'slow') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600)
        parentPort.postMessage({ id: request.id, ok: true, value: request.op + ':' + threadId })
      })
    `)
    return { client: new ThreadDbClient({ script, idleWorkerStopMs }), out }
  }
  const wait = (ms: number) => new Promise((done) => setTimeout(done, ms))

  it('a request slower than the idle time keeps its worker', async () => {
    const { client, out } = await fakeClient(200)
    try {
      const first = await client.callIndex('info' as never) as unknown as string
      expect(await client.callIndex('slow' as never)).toBe(`slow:${first.split(':')[1]}`)
      // The idle time counts from the answer: the same worker answers right after.
      expect(await client.callIndex('info' as never)).toBe(first)
      expect(client.workerRoles()).toContain('index')
    } finally {
      await client.close()
      rmSync(out, { recursive: true, force: true })
    }
  })

  it('a worker that died is replaced by the next request, and closing does not wait on it', async () => {
    const { client, out } = await fakeClient(200)
    try {
      for (const call of [(op: string) => client.callIndex(op as never), (op: string) => client.callImport(op as never), (op: string) => client.call(op as never)]) {
        const before = await call('info') as unknown as string
        await expect(call('die')).rejects.toThrow(/stopped \(3\)/)
        const after = await call('info') as unknown as string
        expect(after).toMatch(/^info:/)
        expect(after).not.toBe(before)
      }
      // An index worker that died while idle is not retired again: its idle time passes and closing still finishes.
      await expect(client.callIndex('die' as never)).rejects.toThrow()
      expect(client.workerRoles()).not.toContain('index')
      await wait(600)
      expect(client.workerRoles()).toEqual(['write', 'read'])
    } finally {
      await client.close()
      rmSync(out, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('a write worker that does not answer in time', () => {
  it('is replaced, and its late reply never answers the next request', async () => {
    const out = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-threaddb-slow-')))
    const script = join(out, 'slow.mjs')
    // Speaks the write worker's protocol: "slow" answers after 400 ms, anything else at once with its own name.
    const { writeFileSync } = await import('node:fs')
    writeFileSync(script, `
      import { parentPort, workerData } from 'node:worker_threads'
      const { role, flag, port } = workerData
      if (role === 'write') parentPort.on('message', (request) => {
        if (request.op === 'slow') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400)
        port.postMessage({ id: request.id, ok: true, value: request.op })
        Atomics.store(flag, 0, 1)
        Atomics.notify(flag, 0)
      })
    `)
    const slow = new ThreadDbClient({ script, syncTimeoutMs: 100 })
    try {
      expect(() => slow.callSync('slow' as never)).toThrow(/did not finish/)
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(slow.callSync('info' as never)).toBe('info')
    } finally {
      await slow.close()
      rmSync(out, { recursive: true, force: true })
    }
  })
})
