import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { MousseMainService } from '../../src/mms/MousseMainService'
import { dispatchMethod } from '../../src/mms/protocol/handlers'

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => { await cleanup?.(); cleanup = undefined })

// Fork from a turn reads the turn's run with `runs.get` and forks the thread at its ordinal: a run of another thread
// named with this one must not answer, or the fork would start at an unrelated turn.
it('runs.get answers a run named with its own thread, and refuses one named with another thread', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mousse-runs-get-'))
  const mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
  cleanup = async () => { await mms.stop(); rmSync(home, { recursive: true, force: true }) }
  await mms.start()
  const a = mms.threads.createThread('A')
  const b = mms.threads.createThread('B')
  const sent = await mms.runEngine.dispatch({ kind: 'send', threadId: b.id, clientRequestId: 'b-1', source: 'gui' })
  if (sent.status !== 'accepted') throw new Error('send rejected')
  const call = (params: Record<string, unknown>) => dispatchMethod({ mms, globalSequence: () => 0 }, 'runs.get', params)
  await expect(call({ threadId: b.id, runId: sent.runId })).resolves.toMatchObject({ run: { runId: sent.runId, threadId: b.id } })
  await expect(call({ runId: sent.runId })).resolves.toMatchObject({ run: { runId: sent.runId } })
  await expect(call({ threadId: a.id, runId: sent.runId })).rejects.toMatchObject({ code: 'run_not_found' })
}, 30_000)
