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
