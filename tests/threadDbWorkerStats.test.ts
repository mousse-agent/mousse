import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getThreadDbWorkerBuildOptions } from '../scripts/build-cli.mjs'
import { ThreadDbClient, WORKER_STAT_ALIVE } from '../src/mms/data/threadDb/threadDbClient'

/**
 * The memory monitor's view of the thread database workers: each worker writes its own stats into shared memory,
 * and `diagnostics()` only reads them. Real workers, built as the app ships them.
 */
describe('thread database worker stats', () => {
  let out: string
  let script: string

  beforeAll(async () => {
    out = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-threaddb-stats-')))
    const options = getThreadDbWorkerBuildOptions(resolve(__dirname, '..'), 'out/cli')
    script = join(out, 'threadDbWorker.js')
    await build({ ...options, outfile: script, logLevel: 'silent' })
  }, 60_000)

  afterAll(() => {
    rmSync(out, { recursive: true, force: true })
  })

  async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 10_000): Promise<T> {
    const end = Date.now() + ms
    let value = await read()
    while (!done(value) && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 25))
      value = await read()
    }
    return value
  }

  type Internals = {
    reader: { call: (...args: unknown[]) => Promise<unknown>; stats: Int32Array }
    indexer?: { terminate: () => Promise<number>; stats: Int32Array }
    writer: { terminate: () => Promise<number> }
    writerStats: Int32Array
    startWriter: () => void
  }

  it('counts the running workers, their connections and heaps, without sending them a request', async () => {
    const client = new ThreadDbClient({ script })
    const internals = client as unknown as Internals
    try {
      const started = await until(() => client.diagnostics(), (d) => d.workers === 2)
      expect(started.workers).toBe(2)
      expect(started.workerHeaps).toHaveLength(2)
      expect(started.workerHeaps.every((bytes) => bytes > 100_000)).toBe(true)

      // A save leaves the write worker's connection open for a moment: the shared counter shows it.
      const dir = join(out, 'thread-a')
      mkdirSync(dir)
      client.callSync('create', dir)
      client.callSync('info', dir)
      expect((await client.diagnostics()).connections).toBeGreaterThanOrEqual(1)

      // Reading the stats sends nothing to any worker.
      let calls = 0
      const call = internals.reader.call.bind(internals.reader)
      internals.reader.call = (...args: unknown[]) => { calls += 1; return call(...args) }
      for (let i = 0; i < 20; i++) await client.diagnostics()
      expect(calls).toBe(0)
    } finally {
      await client.close()
    }
  }, 30_000)

  it('never starts, keeps or counts a worker that ended, or one this client let go (#884 ends idle ones)', async () => {
    const client = new ThreadDbClient({ script })
    const internals = client as unknown as Internals
    try {
      await until(() => client.diagnostics(), (d) => d.workers === 2)
      // Asking does not start the index worker.
      expect(internals.indexer).toBeUndefined()
      await client.diagnostics()
      expect(internals.indexer).toBeUndefined()

      const dir = join(out, 'thread-b')
      mkdirSync(dir)
      client.callSync('create', dir)
      await client.callIndex('exists', dir)
      expect((await until(() => client.diagnostics(), (d) => d.workers === 3)).workers).toBe(3)

      // The worker ends: its stats read 0 and it is not counted, and asking does not start a new one. The client
      // forgets a worker that ended, so the next request (not a diagnostics read) starts a fresh one.
      const ended = internals.indexer!
      await ended.terminate()
      const after = await until(() => client.diagnostics(), (d) => d.workers === 2)
      expect(after.workers).toBe(2)
      expect(Atomics.load(ended.stats, WORKER_STAT_ALIVE)).toBe(0)
      expect(internals.indexer).toBeUndefined()
      await client.diagnostics()
      expect(internals.indexer).toBeUndefined()
    } finally {
      await client.close()
    }
  }, 30_000)

  it('an index worker ended for being idle drops out of the count, and the next one starts from zero', async () => {
    const client = new ThreadDbClient({ script, idleWorkerStopMs: 300 })
    const internals = client as unknown as Internals
    try {
      await until(() => client.diagnostics(), (d) => d.workers === 2)
      const dir = join(out, 'thread-d')
      mkdirSync(dir)
      client.callSync('create', dir)
      await client.callIndex('exists', dir)
      const first = internals.indexer!
      expect((await until(() => client.diagnostics(), (d) => d.workers === 3)).workers).toBe(3)
      // Sampling the stats is no request: it does not keep the worker past its idle time.
      const idle = await until(() => client.diagnostics(), (d) => d.workers === 2, 5_000)
      expect(idle.workers).toBe(2)
      expect(internals.indexer).toBeUndefined()
      // Forgotten at once; it reads as ended once its retire (close, then exit) has finished.
      await until(() => Atomics.load(first.stats, WORKER_STAT_ALIVE), (alive) => alive === 0, 5_000)
      expect(Atomics.load(first.stats, WORKER_STAT_ALIVE)).toBe(0)
      expect(Atomics.load(first.stats, 0)).toBe(0)

      // A request starts a new worker with stats of its own, which start at zero and then count it.
      const next = client.callIndex('exists', dir)
      const fresh = internals.indexer!
      expect(fresh).not.toBe(first)
      expect(fresh.stats).not.toBe(first.stats)
      await next
      expect((await until(() => client.diagnostics(), (d) => d.workers === 3)).workers).toBe(3)
      expect(Atomics.load(fresh.stats, WORKER_STAT_ALIVE)).toBe(1)
    } finally {
      await client.close()
    }
  }, 30_000)

  it('a replaced write worker cannot leave a stale count: it writes only into stats nobody reads', async () => {
    const client = new ThreadDbClient({ script })
    const internals = client as unknown as Internals
    try {
      await until(() => client.diagnostics(), (d) => d.workers === 2)
      const dir = join(out, 'thread-c')
      mkdirSync(dir)
      client.callSync('create', dir)
      client.callSync('info', dir)
      const oldWriter = internals.writer
      const oldStats = internals.writerStats
      // What a sync timeout does: a new writer, the stuck one terminated afterwards.
      internals.startWriter()
      expect(internals.writerStats).not.toBe(oldStats)
      const fresh = await until(() => client.diagnostics(), (d) => d.workers === 2 && d.connections === 0)
      expect(fresh.connections).toBe(0)
      // The old writer still holds its connection, in its own stats only.
      expect(Atomics.load(oldStats, 0)).toBeGreaterThanOrEqual(1)
      await oldWriter.terminate()
      expect(Atomics.load(oldStats, WORKER_STAT_ALIVE)).toBe(0)
      expect((await client.diagnostics()).connections).toBe(0)
    } finally {
      await client.close()
    }
  }, 30_000)

  it('in-process mode counts the engines directly', async () => {
    const client = new ThreadDbClient({ script: null })
    try {
      expect(await client.diagnostics()).toEqual({ workers: 0, connections: 0, workerHeaps: [], workerCrashes: 0 })
    } finally {
      await client.close()
    }
  })
})
