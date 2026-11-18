/**
 * Owner check `phase1a.private-streams`: one owner paired with two callers. The first caller opens a thread view,
 * a terminal, a durable answer sent as an artifact and a staged write on the owner, through a window's calls. The
 * second caller then asks the owner for each of those streams, for their blobs, and to write into the first
 * caller's input artifact, as a caller that binds whatever it likes on its own side would. Every ask is refused,
 * before and after the first caller is removed.
 *
 * Its control (`MOUSSE_NET_ENGINE_CONTROL=second-reader`) serves a stream with no binding to the caller and fails
 * it with `foreign_read`. `scripts/net-engine-check.mjs phase1a.private-streams` runs it and prints the marker.
 */
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { newId, type BlobId, type EventId, type NodeId, type StreamDescriptor, type StreamId } from '../../../src/shared/net'
import { PROJECT_SHELL_AGENT_ID } from '../../../src/shared/types'
import type { Crossed } from '../fakeHelper'
import { codeOf, eventually, Fabric, refused, step, type Computer } from './harness'

describe('phase1a.private-streams', () => {
  const fabric = new Fabric()
  let owner: Computer, first: Computer, second: Computer
  let firstOnOwner: NodeId, ownerOnFirst: NodeId, ownerOnSecond: NodeId
  /** What the first caller opened on the owner, as the fake network saw it cross. */
  const opened = {
    streams: new Set<StreamId>(),
    blobs: [] as Array<{ stream: StreamId; blob: BlobId }>,
    inputs: [] as Array<{ stream: StreamId; id: EventId; envelope: Uint8Array; sig: Uint8Array }>
  }

  beforeAll(async () => {
    owner = await fabric.computer('owner')
    first = await fabric.computer('first')
    second = await fabric.computer('second')
    ;({ callerOnOwner: firstOnOwner, ownerOnCaller: ownerOnFirst } = await fabric.pair(owner, first))
    ;({ ownerOnCaller: ownerOnSecond } = await fabric.pair(owner, second))
    fabric.shells(owner)
    await fabric.connect(first, ownerOnFirst)
    await fabric.connect(second, ownerOnSecond)
    await owner.dispatch('bridge.policy', { node: firstOnOwner, terminal: true }, true)
  }, 120_000)
  afterAll(() => fabric.close())

  const fromFirst = (row: Crossed) => row.from === first.endpoint
  const fromOwner = (row: Crossed) => row.from === owner.endpoint

  it('the first caller opens a thread, a terminal, an artifact answer and a staged write', async () => {
    const node = ownerOnFirst
    const from = fabric.network.crossed.length
    const project = await step(undefined, () => first.dispatch('projects.open', { node, path: fabric.folder() }))
    const created = await step(undefined, () =>
      first.dispatch('threads.create', { node, name: 'Private', projectId: (project.project ?? project).id })
    )
    // The router answers ids qualified with the computer they live on.
    const threadId = (created.thread ?? created).id as string
    await step(undefined, () => first.dispatch('thread.snapshot', { threadId }))
    await step(undefined, () => first.dispatch('pty.create', { threadId, agentId: `${PROJECT_SHELL_AGENT_ID}:tab-1` }))
    // An answer over a reply's size comes back as an artifact; a message over a request's size is staged.
    await step(undefined, () => first.dispatch('tasks.create', { threadId, description: 'd'.repeat(40 * 1024) }))
    const send = vi.spyOn(owner.mms.orchestrator, 'send').mockResolvedValue({ accepted: true } as never)
    try {
      await step(undefined, () =>
        first.dispatch('orchestrator.send', { threadId, content: 'y'.repeat(100 * 1024), requestId: 'staged-1' })
      )
    } finally {
      send.mockRestore()
    }
    await eventually(() => {
      opened.streams.clear()
      opened.blobs.length = 0
      opened.inputs.length = 0
      for (const row of fabric.network.crossed.slice(from)) {
        const h = row.header as Record<string, any>
        if (fromFirst(row) && row.label === 'mousse.sub' && h.t === 'subscribe') opened.streams.add(h.stream)
        if (fromFirst(row) && row.label === 'mousse.put' && h.t === 'append')
          opened.inputs.push({ stream: h.stream, id: h.id, envelope: row.parts[0]!, sig: row.parts[1]! })
        if (fromOwner(row) && row.label === 'mousse.rpc' && h.t === 'result' && h.result?.kind === 'bridge.artifact.result.v1') {
          const result = h.result as { descriptor: StreamDescriptor; artifact: { stream: StreamId; blob: BlobId } }
          opened.streams.add(result.descriptor.id)
          opened.blobs.push({ stream: result.artifact.stream, blob: result.artifact.blob })
        }
      }
      expect(opened.inputs.length).toBeGreaterThan(0)
      expect(opened.blobs.length).toBeGreaterThan(0)
    })
    for (const input of opened.inputs) opened.streams.add(input.stream)
    // The thread view, the terminal, the answer artifact and the input artifact at least.
    expect(opened.streams.size).toBeGreaterThanOrEqual(4)
  }, 120_000)

  /** The second caller stores the stream on its side and binds it to its own pairing, then asks for it. */
  function adopt(stream: StreamId): void {
    const store = second.mms.bridge.threads.store
    if (!store.getStream(stream)) {
      const descriptor = owner.mms.bridge.threads.store.getStream(stream)
      expect(descriptor).toBeTruthy()
      store.createStream({ ...descriptor!, authority: ownerOnSecond }, 1)
    }
    second.mms.netEngine.bind(stream, ownerOnSecond)
  }

  function read(stream: StreamId): Promise<void> {
    adopt(stream)
    const client = second.mms.netEngine.client(ownerOnSecond)
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no answer')), 20_000)
      const done = (error?: Error) => {
        clearTimeout(timer)
        subscription.close()
        error ? reject(error) : resolve()
      }
      const subscription = client.subscribe(stream, {
        onRecord: () => done(),
        onCaughtUp: () => done(),
        onSnapshotInstalled: () => done(),
        onError: (code) => done(Object.assign(new Error(code), { code }))
      })
    })
  }

  /** Refused by the owner (not a timeout, nor this side's own checks). */
  async function ownerRefused(reason: string, work: () => Promise<unknown>): Promise<void> {
    const error = await refused(reason, work)
    expect(codeOf(error), String(error)).toBe('forbidden')
  }

  async function nothingServed(when: string): Promise<void> {
    const client = () => second.mms.netEngine.client(ownerOnSecond)
    for (const stream of opened.streams) await ownerRefused('foreign_read', () => read(stream))
    for (const { stream, blob } of opened.blobs) {
      adopt(stream)
      await ownerRefused('foreign_read', () => client().getBlob(stream, blob))
    }
    for (const input of opened.inputs) {
      adopt(input.stream)
      // The first caller's own record, sent again, and a fresh one.
      await ownerRefused('foreign_write', () => client().append(input.stream, input.id, input.envelope, input.sig))
      await ownerRefused('foreign_write', () =>
        client().append(input.stream, newId('event') as EventId, input.envelope, input.sig)
      )
      const bytes = new TextEncoder().encode(`written by the second caller ${when}`)
      const blob = `blb_${createHash('sha256').update(bytes).digest('hex')}` as BlobId
      await ownerRefused('foreign_write', () => client().putBlob(input.stream, blob, bytes, false))
    }
  }

  it('the second caller cannot read, fetch blobs from or write to any of them', async () => {
    await nothingServed('before')
  }, 120_000)

  it('nor after the first caller is removed', async () => {
    // The removal ceremony lands with its slice; this is its effect on the owner: removing, torn down, removed.
    const peers = (owner.mms.netEngine as unknown as { started: { peers: { setState(n: NodeId, s: string): void } } })
      .started.peers
    peers.setState(firstOnOwner, 'removing')
    owner.mms.netEngine.teardown(firstOnOwner)
    peers.setState(firstOnOwner, 'removed')
    await nothingServed('after')
  }, 120_000)
})
