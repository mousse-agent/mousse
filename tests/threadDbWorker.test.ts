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

  it('returns errors from the worker as errors', async () => {
    expect(() => client.callSync('load', join(out, 'missing'))).toThrow(/No thread database/)
    await expect(client.call('load', join(out, 'missing'))).rejects.toThrow(/No thread database/)
  })
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
