/**
 * Owner check `phase1a.removal`: an owner removes a paired computer while it has a thread view and a terminal open
 * there (§5.4). From the moment the row reads `removing` the removed computer is refused; its subscriptions and its
 * terminal end; once Remove answers, the rows it left are pruned and its row is a tombstone; and its helper can no
 * longer reach the owner. A second computer is then removed while the owner's helper dies right after it saved the
 * removal (its `grant.closed` never reaches the app), with a terminal open: the terminal still ends, and the removal
 * finishes after the helper starts again.
 *
 * Its controls: a helper built with `keep-removed-grant` fails it with `still_connected`; `keep-engine-work` (the
 * host keeps the work) and `teardown-on-event-only` (teardown waits for `grant.closed`) with `stale_work`.
 * `scripts/net-engine-check.mjs phase1a.removal` runs it and prints the marker.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NodeId, StreamId } from '../../../src/shared/net'
import { PROJECT_SHELL_AGENT_ID } from '../../../src/shared/types'
import type { Spawned } from '../../net/bridge/routed/terminalFixture'
import { eventually, Fabric, refused, rowFor, step, type Computer } from './harness'

describe('phase1a.removal', () => {
  const fabric = new Fabric()
  let owner: Computer
  let shells: Spawned[]
  beforeAll(async () => {
    owner = await fabric.computer('owner')
    shells = fabric.shells(owner)
  }, 120_000)
  afterAll(() => fabric.close(), 120_000)

  /** A caller paired with the owner, with terminal access, a thread view and a terminal open there. */
  async function openWork(name: string): Promise<{
    caller: Computer
    onOwner: NodeId
    ownerOn: NodeId
    shell: Spawned
    streams: Set<StreamId>
  }> {
    const caller = await fabric.computer(name)
    const { callerOnOwner: onOwner, ownerOnCaller: ownerOn } = await fabric.pair(owner, caller)
    await fabric.connect(caller, ownerOn)
    await owner.dispatch('bridge.policy', { node: onOwner, terminal: true }, true)
    const from = fabric.crossed.length
    const project = await step(undefined, () =>
      caller.dispatch('projects.open', { node: ownerOn, path: fabric.folder() })
    )
    const created = await step(undefined, () =>
      caller.dispatch('threads.create', {
        node: ownerOn,
        name: `Work of ${name}`,
        projectId: (project.project ?? project).id
      })
    )
    const threadId = (created.thread ?? created).id as string
    await step(undefined, () => caller.dispatch('thread.snapshot', { threadId }))
    const before = shells.length
    await step(undefined, () =>
      caller.dispatch('pty.create', { threadId, agentId: `${PROJECT_SHELL_AGENT_ID}:tab-1` })
    )
    const shell = shells[before]!
    const streams = new Set<StreamId>()
    await eventually(() => {
      for (const row of fabric.crossed.slice(from))
        if (
          row.from === caller.endpoint &&
          row.label === 'mousse.sub' &&
          row.header.t === 'subscribe'
        )
          streams.add(row.header.stream as StreamId)
      expect([...streams].some((stream) => owner.mms.netEngine.isSubscribed(stream, onOwner))).toBe(
        true
      )
    })
    return { caller, onOwner, ownerOn, shell, streams }
  }

  const db = () => owner.mms.net.runtime().db.database
  const count = (sql: string, ...args: unknown[]) =>
    Number(
      db()
        .prepare(sql)
        .get(...(args as never[]))?.n ?? 0
    )

  /** Nothing of `node` is left running on the owner: its terminal and its subscriptions ended. */
  async function workEnded(work: {
    onOwner: NodeId
    shell: Spawned
    streams: Set<StreamId>
  }): Promise<void> {
    await step('stale_work', () =>
      eventually(() => {
        expect(work.shell.pty.killed).toBe(true)
        for (const stream of work.streams)
          expect(owner.mms.netEngine.isSubscribed(stream, work.onOwner)).toBe(false)
      }, 10_000)
    )
  }

  /** The rows the owner kept for `node` are gone, and its row is a tombstone. */
  async function pruned(node: NodeId): Promise<void> {
    await step('not_pruned', () => {
      expect(owner.mms.netEngine.peerRows().find((row) => row.localId === node)?.state).toBe(
        'removed'
      )
      expect(count('SELECT COUNT(*) AS n FROM net_node_policy WHERE node=?', node)).toBe(0)
      expect(
        count('SELECT COUNT(*) AS n FROM net_engine_streams WHERE peer_local_id=?', node)
      ).toBe(0)
      expect(count('SELECT COUNT(*) AS n FROM net_rpc_aliases WHERE caller=?', node)).toBe(0)
      const privates = db()
        .prepare('SELECT thread_id FROM bridge_thread_streams')
        .all()
        .filter(
          (row) =>
            String(row.thread_id).includes(`:${node}:`) ||
            String(row.thread_id).includes(`${node}:`)
        )
      expect(privates).toEqual([])
    })
  }

  it('refuses at once, ends the work, prunes and leaves the removed computer outside', async () => {
    const work = await openWork('first')
    const { caller, onOwner, ownerOn } = work
    const removal = owner.dispatch('netEngine.remove', { node: onOwner }, true)
    await step(undefined, () =>
      eventually(() => expect(rowFor(owner, caller)?.state ?? 'removed').toMatch(/^remov/), 5_000)
    )
    // From `removing` on, nothing the removed computer asks is served.
    await refused('not_refused', () =>
      caller.mms.netEngine
        .client(ownerOn)
        .rpc('net.info', {}, { id: `rpc_${Date.now()}` as never, deadlineMs: 5_000 })
    )
    await step(undefined, () => removal)
    await workEnded(work)
    await pruned(onOwner)
    await step('still_connected', async () => {
      const grants = await owner.engine.request('grants.list')
      expect(
        (grants.grants as Array<{ identity: string }>).map((grant) => grant.identity)
      ).not.toContain(caller.endpoint)
      // The removed computer's helper cannot get in any more.
      await refused('still_connected', () =>
        caller.engine.request('dial', { identity: owner.endpoint }, 15_000)
      )
    })
  }, 180_000)

  it('ends the work when the helper dies after saving the removal, and finishes the removal after', async () => {
    const work = await openWork('second')
    const { onOwner } = work
    // The owner's helper saves the removal, then dies before the app hears `grant.closed`.
    fabric.hold = (message, to) =>
      to === owner.endpoint && message.ev === 'grant.closed' ? 'drop' : undefined
    let killed = false
    owner.mms.netEngine.pairingCrash = (at) => {
      if (at === 'grant-removed' && !killed) {
        killed = true
        owner.kill()
      }
      return false
    }
    try {
      await owner.dispatch('netEngine.remove', { node: onOwner }, true).catch(() => undefined)
      await workEnded(work)
      // The helper starts again; the removal finishes from its `removing` row.
      await step('not_pruned', () =>
        eventually(
          () =>
            expect(
              owner.mms.netEngine.peerRows().find((row) => row.localId === onOwner)?.state
            ).toBe('removed'),
          60_000
        )
      )
      await pruned(onOwner)
    } finally {
      fabric.hold = undefined
      owner.mms.netEngine.pairingCrash = undefined
    }
  }, 180_000)
})
