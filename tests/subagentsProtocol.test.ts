/**
 * `subagents.list` and `subagents.updated` through a real daemon and socket (plan v2 PR B): the
 * method is advertised and required by the GUI, answers per parent thread, and the event reaches
 * clients and the GUI bridge when a delegation is created.
 */
import { afterEach, expect, it } from 'vitest'
import { GUI_REQUIRED_METHODS } from '../src/main/mms/guiDaemonCompatibility'
import { bridgeProtocolEvent } from '../src/main/mms/protocolEventBridge'
import type { ProtocolEvent } from '../src/mms/protocol'
import type { SubagentSummary } from '../src/shared/subagents'
import { lifecycleHarness } from './fixtures/resource-lifecycle-harness'

type Harness = Awaited<ReturnType<typeof lifecycleHarness>>
let f: Harness | undefined
afterEach(async () => {
  await f?.close()
  f = undefined
})

async function waitFor(condition: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

it('advertises subagents.list and the GUI refuses a daemon without it', async () => {
  f = await lifecycleHarness()
  const { methods } = await f.rpc.request<{ methods: string[] }>('capabilities')
  expect(methods).toContain('subagents.list')
  expect(GUI_REQUIRED_METHODS).toContain('subagents.list')
  expect(GUI_REQUIRED_METHODS.filter((method) => !methods.includes(method))).toEqual([])
})

it('lists a parent’s subagents and announces the change to clients and the GUI bridge', async () => {
  f = await lifecycleHarness()
  const { thread: parent } = await f.rpc.request<{ thread: { id: string } }>('threads.create', { name: 'Parent' })
  expect(await f.rpc.request('subagents.list', { threadId: parent.id })).toEqual({ threadId: parent.id, subagents: [] })
  await expect(f.rpc.request('subagents.list', { threadId: parent.id, extra: 1 })).rejects.toThrow()

  const events: ProtocolEvent[] = []
  const off = f.rpc.onEvent((event) => events.push(event))
  await f.rpc.subscribe()
  const engine = f.services.runEngine
  const sent = await engine.dispatch({ kind: 'send', threadId: parent.id, clientRequestId: 'parent-run', source: 'gui' })
  if (sent.status !== 'accepted') throw new Error('send rejected')
  engine.markStarting(sent.runId)
  engine.markRunning(sent.runId)
  const accepted = await engine.requestDelegation({
    parentThreadId: parent.id,
    parentRunId: sent.runId,
    clientRequestId: `delegation:${sent.runId}:call-1`,
    prompt: 'Inspect the module',
    title: 'API reviewer',
    workspace: 'isolated',
    wake: 'settled_only'
  })

  await waitFor(() => events.some((event) => event.type === 'subagents.updated'), 'subagents.updated')
  off()
  const updated = events.find((event) => event.type === 'subagents.updated')!
  expect(updated.data).toEqual({ parentThreadId: parent.id })

  const broadcasts: Array<[string, unknown]> = []
  expect(bridgeProtocolEvent(updated, (channel, data) => broadcasts.push([channel, data]), { getActiveThreadId: () => null } as never)).toBe(true)
  expect(broadcasts).toEqual([['subagents:updated', { parentThreadId: parent.id }]])

  const { subagents } = await f.rpc.request<{ subagents: SubagentSummary[] }>('subagents.list', { threadId: parent.id })
  expect(subagents).toHaveLength(1)
  expect(subagents[0]).toMatchObject({ childThreadId: accepted.childThreadId, latestDelegationId: accepted.delegationId, workspace: 'isolated' })
  expect(subagents[0].title).toBe('API reviewer')
  // The child is not a subagent of anything else.
  expect(await f.rpc.request('subagents.list', { threadId: accepted.childThreadId })).toEqual({ threadId: accepted.childThreadId, subagents: [] })

  // A child's question appearing and clearing, and its rename, each announce the parent again.
  const updatesFor = (parentThreadId: string) => events.filter((event) => event.type === 'subagents.updated' && (event.data as { parentThreadId: string }).parentThreadId === parentThreadId).length
  const off2 = f.rpc.onEvent((event) => events.push(event))
  let seen = updatesFor(parent.id)
  const answered = f.services.questions.requestAnswers([{ id: 'q', prompt: 'Proceed?', options: [{ id: 'yes', label: 'Yes' }] }], accepted.childThreadId)
  await waitFor(() => updatesFor(parent.id) > seen, 'the update for a pending question')
  expect((await f.rpc.request<{ subagents: SubagentSummary[] }>('subagents.list', { threadId: parent.id })).subagents[0]).toMatchObject({ activity: 'needs_input', state: 'needs_input' })
  seen = updatesFor(parent.id)
  f.services.questions.dismissAllForThread(accepted.childThreadId)
  await expect(answered).rejects.toThrow()
  await waitFor(() => updatesFor(parent.id) > seen, 'the update for a cleared question')
  seen = updatesFor(parent.id)
  await f.rpc.request('threads.rename', { threadId: accepted.childThreadId, name: 'Renamed reviewer' })
  await waitFor(() => updatesFor(parent.id) > seen, 'the update for a rename')
  expect((await f.rpc.request<{ subagents: SubagentSummary[] }>('subagents.list', { threadId: parent.id })).subagents[0].title).toBe('Renamed reviewer')
  off2()
})

/** A parent with one running run and one delegated child, over a real daemon, with a subscribed client. */
async function parentWithChild() {
  f = await lifecycleHarness()
  const { thread: parent } = await f.rpc.request<{ thread: { id: string } }>('threads.create', { name: 'Parent' })
  const events: ProtocolEvent[] = []
  f.rpc.onEvent((event) => events.push(event))
  await f.rpc.subscribe()
  const engine = f.services.runEngine
  const sent = await engine.dispatch({ kind: 'send', threadId: parent.id, clientRequestId: 'parent-run', source: 'gui' })
  if (sent.status !== 'accepted') throw new Error('send rejected')
  engine.markStarting(sent.runId)
  engine.markRunning(sent.runId)
  const child = await engine.requestDelegation({
    parentThreadId: parent.id, parentRunId: sent.runId, clientRequestId: `delegation:${sent.runId}:call-1`,
    prompt: 'Inspect the module', title: 'Reviewer', workspace: 'isolated', wake: 'settled_only'
  })
  /** Pushes received so far that name `parentThreadId`. */
  const count = (parentThreadId: string) =>
    events.filter((event) => event.type === 'subagents.updated' && (event.data as { parentThreadId: string }).parentThreadId === parentThreadId).length
  /** A round trip, so every push sent before it has arrived. */
  const settle = async () => {
    await f!.rpc.request('subagents.list', { threadId: parent.id })
  }
  const listed = async () => (await f!.rpc.request<{ subagents: SubagentSummary[] }>('subagents.list', { threadId: parent.id })).subagents[0]
  return { parent, child, engine, count, settle, listed }
}

it('an inbox row appended to or acknowledged on an idle child announces its parent', async () => {
  const { parent, child, engine, count, settle, listed } = await parentWithChild()
  engine.markStarting(child.childRunId)
  engine.markRunning(child.childRunId)
  engine.markTerminal(child.childRunId, 'completed', undefined, { resultText: 'done' })
  expect(await listed()).toMatchObject({ activity: 'idle' })

  await settle()
  let seen = count(parent.id)
  const row = engine.inbox.append({ threadId: child.childThreadId, kind: 'reconcile_notice', payload: {} })
  await waitFor(() => count(parent.id) > seen, 'the update for an appended inbox row')
  expect(await listed()).toMatchObject({ activity: 'waiting' })

  await settle()
  seen = count(parent.id)
  engine.inbox.markAcknowledged([row.inboxId])
  await waitFor(() => count(parent.id) > seen, 'the update for an acknowledged inbox row')
  expect(await listed()).toMatchObject({ activity: 'idle' })
})

it('a change on a nested subagent announces every ancestor', async () => {
  const { parent, child, engine, count, settle } = await parentWithChild()
  engine.markStarting(child.childRunId)
  engine.markRunning(child.childRunId)
  const nested = await engine.requestDelegation({
    parentThreadId: child.childThreadId, parentRunId: child.childRunId, clientRequestId: `delegation:${child.childRunId}:call-1`,
    prompt: 'Look deeper', title: 'Grandchild', workspace: 'isolated', wake: 'settled_only'
  })
  // The new delegation changes G's row in C's list and C's row in P's list.
  await settle()
  let seenParent = count(parent.id)
  let seenChild = count(child.childThreadId)
  expect(seenChild).toBeGreaterThan(0)
  // G's own run moving changes the same two lists.
  engine.markStarting(nested.childRunId)
  await waitFor(() => count(parent.id) > seenParent && count(child.childThreadId) > seenChild, 'updates for both ancestors of a run change')
  await settle()
  seenParent = count(parent.id)
  seenChild = count(child.childThreadId)
  // So does an inbox row on G.
  engine.inbox.append({ threadId: nested.childThreadId, kind: 'reconcile_notice', payload: {} })
  await waitFor(() => count(parent.id) > seenParent && count(child.childThreadId) > seenChild, 'updates for both ancestors of an inbox row')
})

it('boot repair gives older children their lineage, discards a child whose creation never committed, and keeps the rest', async () => {
  f = await lifecycleHarness()
  const { services } = f
  const engine = services.runEngine
  const parent = services.threads.createThread('Parent')
  const sent = await engine.dispatch({ kind: 'send', threadId: parent.id, clientRequestId: 'parent-run', source: 'gui' })
  if (sent.status !== 'accepted') throw new Error('send rejected')
  // An older child: a run-store lineage row, thread metadata without lineage.
  const older = services.threads.createThread('Older child')
  engine.delegations.createLineage({ threadId: older.id, parentThreadId: parent.id, parentRunId: sent.runId, relationship: 'subagent' })
  // A child whose creating command died before its rows committed: lineage in metadata only.
  const orphan = services.threads.createThread('Orphan', undefined, undefined, {
    lineage: { parentThreadId: parent.id, rootThreadId: parent.id, relationship: 'subagent' }, ownerThreadId: parent.id
  })

  ;(services as unknown as { repairSubagentLineage: () => void }).repairSubagentLineage()

  expect(services.threads.getThread(older.id)?.lineage).toEqual({ parentThreadId: parent.id, rootThreadId: parent.id, relationship: 'subagent' })
  expect(services.threads.getThread(orphan.id)).toBeUndefined()
  expect(services.threads.getThread(parent.id)).toBeDefined()
  expect(services.threads.lifecycleStore.require(older.id).parentTaskId).toBeUndefined()
})
