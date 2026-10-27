import { afterEach, expect, it, vi } from 'vitest'
import { newId } from '../../../../src/shared/net'
import { systemClock } from '../../../../src/mms/net/clock'
import { executeBridgeHubLocal } from '../../../../src/mms/bridge/hub'
import { fixture, cleanup, scriptTurns } from './fixture'
afterEach(cleanup)

const rows = (f: Awaited<ReturnType<typeof fixture>>): number =>
  Number(
    (
      f.callerDb().database.prepare('SELECT count(*) AS n FROM net_bridge_hub_requests').get() as {
        n: number
      }
    ).n
  )
const create = (f: Awaited<ReturnType<typeof fixture>>, name: string) =>
  executeBridgeHubLocal(f.hub(), 'bridge.hub.create', { target: f.targetNode, name }) as Promise<{
    thread: { id: string }
  }>

function stubModel(f: Awaited<ReturnType<typeof fixture>>) {
  scriptTurns(f.mms, () => 'ok')
}

it('does not journal reads, so polling a computer never fills the journal', async () => {
  const f = await fixture(['read', 'chat', 'write'], undefined, { maxJournalRecords: 8 })
  await f.connect()
  for (let round = 0; round < 60; round += 1) {
    await executeBridgeHubLocal(f.hub(), 'bridge.hub.threads', { target: f.targetNode })
    await executeBridgeHubLocal(f.hub(), 'bridge.hub.projects', { target: f.targetNode })
    if (round % 6 === 0)
      await executeBridgeHubLocal(f.hub(), 'bridge.hub.composerOptions', { target: f.targetNode })
  }
  expect(rows(f)).toBe(0)
  // Far more reads than the cap allows rows, and a write still goes through.
  await expect(create(f, 'After many reads')).resolves.toMatchObject({ thread: { id: expect.any(String) } })
})

it('journals a read only when the caller names an id or key to find it by', async () => {
  const f = await fixture()
  await f.connect()
  await executeBridgeHubLocal(f.hub(), 'bridge.hub.threads', { target: f.targetNode })
  expect(rows(f)).toBe(0)
  await f.hub().call(f.targetNode, 'threads.list', {}, { idem: 'find-me-again' })
  expect(rows(f)).toBe(1)
})

it('stages an image of many slices without a journal row for each', async () => {
  const f = await fixture(['read', 'chat', 'write'], undefined, { maxJournalRecords: 8 })
  await f.connect()
  const data = Buffer.from('slice').toString('base64')
  for (let index = 0; index < 64; index += 1)
    expect(
      await executeBridgeHubLocal(f.hub(), 'bridge.hub.stageAttachment', {
        target: f.targetNode,
        upload: 'upload-many-slices',
        index,
        total: 64,
        name: 'big.png',
        mimeType: 'image/png',
        data
      })
    ).toMatchObject({ ok: true, total: 64 })
  expect(rows(f)).toBe(0)
})

it('keeps the journal under its cap through many writes and sends over time', async () => {
  const f = await fixture(['read', 'chat', 'write'], undefined, { maxJournalRecords: 12 })
  stubModel(f)
  await f.connect()
  const first = await create(f, 'Long lived')
  const ref = { nodeId: f.targetNode, entityId: first.thread.id }
  let sent = 0
  for (let round = 0; round < 40; round += 1) {
    await create(f, `Thread ${round}`)
    await executeBridgeHubLocal(f.hub(), 'bridge.hub.threads', { target: f.targetNode })
    if (round % 8 === 0) {
      await executeBridgeHubLocal(f.hub(), 'bridge.hub.send', { ref, content: `Message ${sent}` })
      sent += 1
    }
    expect(rows(f)).toBeLessThanOrEqual(12)
  }
  expect(sent).toBe(5)
  await vi.waitFor(() =>
    expect(f.mms.orchestrator.getMessages(first.thread.id).filter((m) => m.role === 'user')).toHaveLength(5)
  )
})

it('drops requests a week old and leaves recent ones', async () => {
  let skew = 0
  const f = await fixture(['read', 'chat', 'write'], undefined, {
    clock: { ...systemClock, now: () => systemClock.now() + skew }
  })
  await f.connect()
  for (let index = 0; index < 5; index += 1) await create(f, `Old ${index}`)
  expect(rows(f)).toBe(5)
  const week = 8 * 24 * 60 * 60_000
  f.callerDb()
    .database.prepare("UPDATE net_bridge_hub_requests SET record=json_set(record,'$.updatedAt',?)")
    .run(systemClock.now() - week)
  // The sweep runs at most every ten minutes.
  skew = 11 * 60_000
  await create(f, 'Recent')
  expect(rows(f)).toBe(1)
  await create(f, 'Recent too')
  expect(rows(f)).toBe(2)
})

it('reports the thread of a chat request and whether this computer is still waiting on it', async () => {
  const f = await fixture()
  stubModel(f)
  await f.connect()
  const first = await create(f, 'Status'),
    ref = { nodeId: f.targetNode, entityId: first.thread.id }
  await executeBridgeHubLocal(f.hub(), 'bridge.hub.send', {
    ref,
    content: 'Hello',
    options: { id: newId('rpc') }
  })
  const listed = (await executeBridgeHubLocal(f.hub(), 'bridge.hub.requests', {
    target: f.targetNode
  })) as Array<{ method: string; threadId?: string; running?: boolean; state: string }>
  expect(listed.find((row) => row.method === 'orchestrator.send')).toMatchObject({
    threadId: first.thread.id,
    state: 'completed'
  })
  expect(listed.some((row) => row.running)).toBe(false)
})
