/**
 * A window's thread search finds archived threads too (they show in the palette marked Archived); an agent's own
 * search keeps leaving them out unless it asks.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { dispatchMethod, type HandlerContext } from '../src/mms/protocol/handlers'
import type { ThreadSearchResult } from '../src/shared/types'

describe('searching archived threads', () => {
  let home: string
  let mms: MousseMainService

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-archived-search-'))
    process.env.MOUSSE_HOME = home
    mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    await mms.start()
  })

  afterEach(async () => {
    await mms.stop()
    try { rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
    delete process.env.MOUSSE_HOME
  })

  const gui = (method: string, params: Record<string, unknown> = {}) =>
    dispatchMethod({ mms, globalSequence: () => 0, connection: { id: 'gui-1', clientType: 'gui' } } as unknown as HandlerContext, method, params)

  it('finds an archived thread by its title from a window', async () => {
    const open = mms.threads.createThread('Budget open', undefined, undefined, { started: true })
    const archived = mms.threads.createThread('Budget archived', undefined, undefined, { started: true })
    await gui('threads.settle', { threadId: archived.id, settled: true })

    const { results } = (await gui('threads.search', { query: 'budget' })) as { results: ThreadSearchResult[] }
    expect(results.map((hit) => hit.threadId).sort()).toEqual([open.id, archived.id].sort())
    // An agent's search (thread_search) is unchanged: archived threads only when it asks.
    expect((await mms.threads.searchThreadsAsync('budget')).map((hit) => hit.threadId)).toEqual([open.id])
  }, 60_000)
})
