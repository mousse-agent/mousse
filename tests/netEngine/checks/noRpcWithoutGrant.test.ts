/**
 * Owner check `phase1b.no-rpc-without-grant`, the app's side (design §6.3, cases 6 and the app half of 4 to 6): what
 * reaches this computer's daemon from a connection is refused unless it carries the pairing's live grant, and a granted
 * device with its editor switch off reaches the editor tunnels and is refused there. Each case is sent at the stream
 * level, as the route probe sends it, over a link attached to the owner's engine service:
 *
 * - a granted device with the editor off opens `mousse.tunnel` with kind `ssh`: it hears `tunnel.close editor_off`,
 *   and no endpoint session starts and no call is authorized;
 * - a stale grant (a pairing re-made, or one the helper should not have let up) opening `mousse.rpc`,
 *   `mousse.hello` or `mousse.tunnel`: each is refused, and nothing is authorized;
 * - a removed identity: its connection is not attached at all.
 *
 * The wire half of every case, on every route, is the engine kit's probe (`mousse-check probe`, run here with the
 * real helper against the owner, its observer reading what reached this app). Its controls fail it as
 * checks/phase1b.toml says: the app's `tunnel-ignores-editor` with `probe_reached_app`, and the helper's with the
 * reason the probe gives. `scripts/net-engine-check.mjs phase1b.no-rpc-without-grant --route tcp|ws|ssh` runs it.
 */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { newId, type NodeId } from '../../../src/shared/net'
import type { EditorEndpointPort } from '../../../src/mms/net/editor/endpoint/port'
import { MessageReader, type EngineMessage } from '../../../src/mms/netEngine/session/frame'
import {
  Channel,
  type EngineConnection,
  type EngineLabel,
  type EngineStream
} from '../../../src/mms/netEngine/session/transport'
import type { EnginePeerStore } from '../../../src/mms/netEngine/store'
import { KEY_B } from '../../net/ssh/bed'
import { fakeLink } from '../fakeLink'
import { CHECK_ROUTE, Fabric, REAL_HELPER, rowFor, step, type Computer } from './harness'

/** `mousse-check probe` from the kit's checkout (run.mjs builds it), with the real helper. */
const PROBE = process.env.MOUSSE_CHECK_PROBE_BIN?.trim()

/**
 * The probe's cases on the ssh route, in its own order but with the pipe cases before the silent and flood ones:
 * after `admission` the helper still counts the sessions it held as waiting, so a pipe case right after it meets
 * the pipe's pre-auth limit instead of its own close.
 */
const SSH_CASES = [
  'not-tls',
  'tls-no-cert',
  'tls-1.2',
  'tls-wrong-alpn',
  'fresh-open-rpc',
  'fresh-open-tunnel',
  'fresh-bad-proof',
  'join-only-open-rpc',
  'join-only-open-hello',
  'join-only-open-tunnel',
  'join-only-garbage-code',
  'removed-open-rpc',
  'editor-off-tunnel',
  'pipe-wrong-token',
  'pipe-long-line',
  'pipe-not-running',
  'fresh-silence',
  'admission'
]

describe('phase1b.no-rpc-without-grant (app)', () => {
  const fabric = new Fabric()
  const served: NodeId[] = []
  const endpoint: EditorEndpointPort = {
    available: () => true,
    hostKeys: () => [KEY_B],
    serve(stream: Duplex, node: NodeId) {
      served.push(node)
      stream.on('error', () => {})
      stream.pipe(stream)
      return { end: () => stream.destroy(), counts: () => ({ exec: 0, shell: 0, sftp: 0, forwards: 0 }) }
    },
    killDevice: async () => undefined,
    sweep: async () => 0
  }
  let owner: Computer
  let caller: Computer
  let onOwner: NodeId
  let authorized: () => number
  beforeAll(async () => {
    owner = await fabric.computer('owner', (mms) => {
      mms.netEngine.editorTest = { endpoint }
    })
    caller = await fabric.computer('caller')
    ;({ callerOnOwner: onOwner } = await fabric.pair(owner, caller))
    // The caller goes quiet: what reaches the owner from now on is only what the cases send.
    await caller.mms.netEngine.stop()
    // Every call the owner's dispatcher let through the engine's authorization.
    const spy = vi.spyOn(owner.mms.netEngine, 'authorizeEngine')
    authorized = () => spy.mock.results.filter((result) => result.type === 'return').length
    // What reaches the owner's app from its helper, for the probe's observer: connections, streams, refusals.
    const attach = owner.mms.netEngine.attach.bind(owner.mms.netEngine)
    vi.spyOn(owner.mms.netEngine, 'attach').mockImplementation((connection) =>
      attach(observed(connection))
    )
  }, 120_000)
  afterAll(() => fabric.close(), 120_000)

  /** What the owner's app has seen since the run started (the probe's observer, 1b §6.3). */
  const seen = { streams: 0, refusals: 0 }
  /** The connections the owner's helper announced to its app (`conn.up`), taken or not. */
  const connUps = () => fabric.announced.filter((up) => up.to === owner.endpoint).length

  /** `connection` counted as it reaches the app: its streams, and each one the app refuses (once per stream). */
  function observed(connection: EngineConnection): EngineConnection {
    const onStream = connection.onStream.bind(connection)
    connection.onStream = (listener) =>
      onStream((stream) => {
        seen.streams += 1
        listener(refusalsOf(stream))
      })
    return connection
  }
  function refusalsOf(stream: EngineStream): EngineStream {
    const reader = new MessageReader()
    let refused = false
    const refuse = () => {
      if (!refused) seen.refusals += 1
      refused = true
    }
    const write = stream.write.bind(stream)
    stream.write = (bytes) => {
      try {
        for (const message of reader.push(bytes))
          if (message.header.t === 'tunnel.close' || message.header.t === 'error') refuse()
      } catch {
        // Not messages (a tunnel's bytes): nothing to count.
      }
      write(bytes)
    }
    const reset = stream.reset.bind(stream)
    stream.reset = (reason) => {
      refuse()
      reset(reason)
    }
    return stream
  }

  /** A connection to the owner as the helper would report one up for `node`, under `grant`. */
  function link(node: NodeId, grant: string) {
    const row = owner.mms.netEngine.peerRows().find((entry) => entry.localId === node)!
    const pair = fakeLink({ ownerOnCaller: newId('node') as NodeId, callerOnOwner: node, grant, endpoint: row.endpoint })
    return { ...pair, attached: owner.mms.netEngine.attach(pair.inbound) }
  }
  /** Sends `header` on a new stream and resolves with the first message back, or how the stream ended. */
  function probe(outbound: ReturnType<typeof link>['outbound'], label: EngineLabel, header: EngineMessage['header']) {
    const channel = new Channel(outbound.open(label))
    const answer = new Promise<{ message?: EngineMessage['header']; ended?: string }>((resolve) => {
      channel.onMessage((message) => resolve({ message: message.header }))
      channel.onEnd((reason) => resolve({ ended: reason ?? 'fin' }))
    })
    channel.send(header)
    return answer
  }
  const tunnelOpen = () => ({ t: 'tunnel.open', tunnel: randomBytes(16).toString('hex'), kind: 'ssh' })

  it('a granted device with its editor switch off is refused at the tunnels, and no endpoint session starts', async () => {
    const row = rowFor(owner, caller)!
    expect(owner.mms.netEngine.status().devices.find((device) => device.node === onOwner)).toBeTruthy()
    const before = authorized()
    const { outbound, attached } = link(onOwner, row.grant)
    await attached
    const answer = await step('wire_accepted', async () => {
      const heard = await probe(outbound, 'mousse.tunnel', tunnelOpen())
      return heard
    })
    await step('probe_reached_app', () => {
      expect(served).toEqual([])
      expect(authorized()).toBe(before)
    })
    await step('wire_accepted', () => expect(answer.message).toMatchObject({ t: 'tunnel.close', reason: 'editor_off' }))
  }, 60_000)

  it('a stale grant reaches nothing: mousse.rpc, mousse.hello and mousse.tunnel are each refused', async () => {
    const before = authorized()
    const { outbound, attached } = link(onOwner, 'stale-grant')
    await attached
    const rpc = await probe(outbound, 'mousse.rpc', {
      t: 'call',
      id: newId('rpc'),
      method: 'routed.threads.list',
      params: {},
      deadline: 5_000
    })
    const hello = await probe(outbound, 'mousse.hello', { t: 'hello', proto: 1, name: 'probe' })
    const tunnel = await probe(outbound, 'mousse.tunnel', tunnelOpen())
    await step('wire_accepted', () => {
      expect(rpc.message).toMatchObject({ t: 'error', error: { code: 'forbidden' } })
      expect(hello.message).toMatchObject({ t: 'error', error: { code: 'forbidden' } })
      expect(tunnel.ended).toBe('forbidden')
    })
    await step('probe_reached_app', () => {
      expect(served).toEqual([])
      expect(authorized()).toBe(before)
    })
  }, 60_000)

  // The wire half and the app half of every §6.3 case on the route under test, through the kit's probe.
  it.runIf(REAL_HELPER && !!PROBE)(`the kit's probe on ${CHECK_ROUTE}: each case closed, nothing reaching the app`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'engine-probe-'))
    const observer = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          ...seen,
          conn_up: connUps(),
          authorized_calls: authorized(),
          endpoint_sessions: served.length,
          // The engine writes no access ledger of its own: what it lets through is authorized_calls.
          ledger_rows: 0
        })
      )
    })
    await new Promise<void>((resolve) => observer.listen(0, '127.0.0.1', resolve))
    try {
      const probe = (args: string[]) =>
        new Promise<{ code: number; out: string }>((resolve) =>
          execFile(PROBE!, ['probe', ...args], { timeout: 600_000 }, (error, stdout, stderr) =>
            resolve({ code: error ? Number(error.code ?? 1) : 0, out: `${stdout}${stderr}` })
          )
        )
      const key = async (name: string) => {
        const made = await probe(['key', join(dir, name)])
        if (made.code !== 0) throw new Error(made.out)
        return made.out.trim().split(/\s+/).at(-1)!
      }
      // A granted device whose editor is off: a row the owner holds, with its grant.
      const editorOff = await key('editor-off.key')
      const granted = await owner.engine.request('grant.add', { identity: editorOff, name: 'probe' })
      ;(owner.mms.netEngine as unknown as { started: { peers: EnginePeerStore } }).started.peers.add({
        endpoint: editorOff,
        fingerprint: `sha256:${editorOff}`,
        grant: String(granted.grant),
        name: 'probe',
        state: 'connected',
        pairedAt: Date.now()
      })
      // A device whose grant was removed.
      const removed = await key('removed.key')
      const gone = await owner.engine.request('grant.add', { identity: removed, name: 'removed' })
      await owner.engine.request('grant.remove', { grant: gone.grant })
      // A Send link's invitation: every join-only case takes one, the garbage-code case only that kind.
      const invite = await owner.dispatch('netEngine.invite', { kind: 'link' }, true)
      const address = observer.address() as { port: number }
      const result = await probe([
        ...fabric.probeRoute(owner),
        '--invite',
        invite.uri,
        '--grant-key',
        join(dir, 'editor-off.key'),
        '--removed-key',
        join(dir, 'removed.key'),
        '--observe',
        `http://127.0.0.1:${address.port}/counts`,
        ...(CHECK_ROUTE === 'ssh' ? ['--cases', SSH_CASES.join(',')] : []),
        // Its own marker: its lines are not this run's PASS or FAIL.
        '--marker',
        'probe'
      ])
      const out = process.env.MOUSSE_NET_ENGINE_CHECK_OUT
      if (out) writeFileSync(join(out, `probe-${CHECK_ROUTE}.txt`), result.out)
      const lines = result.out.trim().split(/\r?\n/)
      const verdict = lines.at(-1) ?? ''
      const reason = /reason=(\w+)/.exec(verdict)?.[1]
      await step(reason ?? 'probe_error', () =>
        expect(verdict, lines.filter((line) => line.startsWith('FAIL')).join('\n')).toBe('PASS probe')
      )
    } finally {
      observer.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 900_000)

  it('a removed identity is not attached', async () => {
    const removed = await fabric.computer('removed')
    const { callerOnOwner } = await fabric.pair(owner, removed)
    const row = owner.mms.netEngine.peerRows().find((entry) => entry.localId === callerOnOwner)!
    await owner.dispatch('netEngine.remove', { node: callerOnOwner }, true)
    const pair = fakeLink({
      ownerOnCaller: newId('node') as NodeId,
      callerOnOwner,
      grant: row.grant,
      endpoint: row.endpoint
    })
    const before = authorized()
    await step('probe_reached_app', async () => {
      await expect(owner.mms.netEngine.attach(pair.inbound)).rejects.toMatchObject({ code: 'forbidden' })
      expect(pair.inbound.isOpen()).toBe(false)
      expect(authorized()).toBe(before)
    })
  }, 60_000)
})
