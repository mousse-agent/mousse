/**
 * Protocol validation of the run-targeted RPCs (docs/run-engine/SPEC.md §6, §12.7, §16): unknown
 * keys and an empty `clientRequestId` are `invalid_params` (M9, S3), `acknowledgeUncertain` needs a
 * continuation, engine refusals surface with their reason as the error code, and `runs.effects`
 * pages (L3).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MousseMainService } from '../../src/mms/MousseMainService'
import { LocalMmsClient } from '../../src/mms/protocol/client'
import { MmsProtocolServer } from '../../src/mms/protocol/server'
import type { EffectRecord } from '../../src/mms/run/types'

describe('run protocol validation', () => {
  let home: string
  let mms: MousseMainService
  let server: MmsProtocolServer
  let client: LocalMmsClient

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-run-protocol-'))
    mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    await mms.start()
    const ownerToken = mms.getOwnerLease()!.owner.token
    server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
    const endpoint = await server.start()
    client = new LocalMmsClient({ homeDir: home, endpoint, ownerToken, clientType: 'gui' })
    await client.connect()
  }, 30_000)
  afterEach(async () => {
    await client?.close()
    await server?.stop()
    await mms?.stop()
    rmSync(home, { recursive: true, force: true })
  })

  it('rejects unknown keys, an empty clientRequestId and a stray acknowledgeUncertain with invalid_params', async () => {
    const thread = mms.threads.createThread('Validation')
    const invalid = { code: 'invalid_params' }
    await expect(client.request('orchestrator.send', { threadId: thread.id, content: 'hi', clientRequestId: '' })).rejects.toMatchObject(invalid)
    await expect(client.request('orchestrator.send', { threadId: thread.id, content: 'hi', bogus: true })).rejects.toMatchObject({ ...invalid, message: expect.stringContaining('bogus') })
    await expect(client.request('orchestrator.send', { threadId: thread.id, content: 'hi', acknowledgeUncertain: true })).rejects.toMatchObject(invalid)
    await expect(client.request('orchestrator.abort', { threadId: thread.id, bogus: 1 })).rejects.toMatchObject(invalid)
    await expect(client.request('orchestrator.abort', { threadId: thread.id, runId: 'run:x', clientRequestId: '' })).rejects.toMatchObject(invalid)
    await expect(client.request('orchestrator.steer', { threadId: thread.id, text: 'x', bogus: 1 })).rejects.toMatchObject(invalid)
    await expect(client.request('runs.effects', { threadId: thread.id, bogus: 1 })).rejects.toMatchObject(invalid)
    expect(mms.runEngine.listRuns(thread.id)).toEqual([])
  }, 30_000)

  it('rejects unknown keys of the pause methods, and a run that is not paused is refused conflict', async () => {
    const invalid = { code: 'invalid_params' }
    await expect(client.request('runs.resumeNow', { runId: 'run:x', bogus: 1 })).rejects.toMatchObject({ ...invalid, message: expect.stringContaining('bogus') })
    await expect(client.request('runs.cancelPause', { runId: 'run:x', bogus: 1 })).rejects.toMatchObject(invalid)
    await expect(client.request('runs.resumeNow', {})).rejects.toMatchObject(invalid)
    await expect(client.request('runs.cancelPause', {})).rejects.toMatchObject(invalid)
    // A banner that has not caught up with a hand-over, a Cancel or a deleted run gets feedback, not silence.
    await expect(client.request('runs.resumeNow', { runId: 'run:missing' })).rejects.toMatchObject({ code: 'conflict' })
    await expect(client.request('runs.cancelPause', { runId: 'run:missing' })).rejects.toMatchObject({ code: 'conflict' })
  }, 30_000)

  it('surfaces engine refusals with their reason as the error code', async () => {
    const thread = mms.threads.createThread('Refusals')
    await expect(client.request('thread.mergeBack', { forkThreadId: thread.id })).rejects.toMatchObject({ code: 'not_a_fork' })
    await expect(client.request('thread.fork', { sourceThreadId: thread.id })).rejects.toMatchObject({ code: 'no_forkable_run' })
    await expect(client.request('thread.fork', { sourceThreadId: thread.id, seedFrom: 'anywhere' })).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(client.request('orchestrator.send', { threadId: thread.id, content: 'x', continuationOfRunId: 'run:missing' })).rejects.toMatchObject({ code: 'continuation_not_found' })
    // A clientRequestId already used by another command kind (M10).
    const ignored = await client.request<{ ok: boolean; ignored: boolean }>('orchestrator.abort', { threadId: thread.id, runId: 'run:none', clientRequestId: 'shared-id' })
    expect(ignored).toMatchObject({ ok: false, ignored: true })
    await expect(client.request('orchestrator.send', { threadId: thread.id, content: 'x', clientRequestId: 'shared-id' })).rejects.toMatchObject({ code: 'client_request_id_conflict' })
  }, 30_000)

  it('pages runs.effects newest first with a cursor (L3)', async () => {
    const thread = mms.threads.createThread('Effects')
    for (let i = 0; i < 3; i++) mms.runEngine.outbox.enqueue({ threadId: thread.id, kind: 'turn.interrupt', availableAt: '2999-01-01T00:00:00.000Z' })
    const newest = await client.request<{ effects: EffectRecord[]; cursor: number; hasMore: boolean }>('runs.effects', { threadId: thread.id, limit: 2 })
    expect(newest.effects.map((effect) => effect.effectId)).toEqual([`effect:${thread.id}:turn.interrupt:2`, `effect:${thread.id}:turn.interrupt:3`])
    expect(newest.hasMore).toBe(true)
    const older = await client.request<{ effects: EffectRecord[]; hasMore: boolean }>('runs.effects', { threadId: thread.id, limit: 2, before: newest.cursor })
    expect(older).toMatchObject({ hasMore: false, effects: [{ effectId: `effect:${thread.id}:turn.interrupt:1` }] })
    await expect(client.request('runs.effects', { threadId: thread.id, limit: 201 })).rejects.toBeTruthy()
  }, 30_000)
})
