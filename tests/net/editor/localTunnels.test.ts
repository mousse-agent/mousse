import { randomBytes } from 'node:crypto'
import { duplexPair } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalEditorTunnels, type LocalTunnelsHost } from '../../../src/mms/net/editor/localTunnels'
import { EditorSshError } from '../../../src/mms/net/editor/sshConfig'
import { TunnelError, type ClientTunnel } from '../../../src/mms/net/editor/tunnel'
import { DomainHandlerRegistry } from '../../../src/mms/protocol/domainRegistry'
import type { HandlerContext } from '../../../src/mms/protocol/handlers'
import {
  registerEditorTunnelMethods,
  type EditorTunnelLocalService
} from '../../../src/mms/net/registerMethods'
import { NetError, newId, type NodeId } from '../../../src/shared/net'
import {
  EDITOR_TUNNEL_LOCAL_CHUNK_BYTES,
  EDITOR_TUNNEL_LOCAL_METHODS,
  type EditorTunnelOpenAnswer
} from '../../../src/shared/net/editorProxy'
import { NET_LOCAL_METHODS } from '../../../src/shared/net/local'
import type { TunnelFailure } from '../../../src/shared/net/tunnel'

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const NODE = newId('node')

function memoryTunnel() {
  const [user, local] = duplexPair()
  let settle!: (reason: TunnelFailure) => void
  const closed = new Promise<TunnelFailure>((resolve) => (settle = resolve))
  const log = { closeCalls: 0 }
  local.on('error', () => {})
  user.on('error', () => {})
  const tunnel: ClientTunnel = {
    stream: user,
    hostKeys: [],
    path: 'direct',
    closed,
    close: () => {
      log.closeCalls++
      settle('closed')
      local.end()
      user.destroy()
    }
  }
  const received: Buffer[] = []
  local.on('data', (chunk: Buffer) => received.push(chunk))
  return {
    tunnel,
    log,
    far: {
      write: (bytes: Buffer | string) => local.write(bytes),
      end: (reason: TunnelFailure = 'closed') => {
        settle(reason)
        local.end()
      },
      received: () => Buffer.concat(received),
      stream: local
    }
  }
}

function host(
  make: (node: NodeId) => Promise<ReturnType<typeof memoryTunnel>> | ReturnType<typeof memoryTunnel>
): LocalTunnelsHost & {
  opened: Array<ReturnType<typeof memoryTunnel>>
  signals: Array<AbortSignal | undefined>
} {
  const opened: Array<ReturnType<typeof memoryTunnel>> = []
  const signals: Array<AbortSignal | undefined> = []
  return {
    opened,
    signals,
    open: async (node, signal) => {
      signals.push(signal)
      const made = await make(node)
      opened.push(made)
      return { tunnel: made.tunnel, info: { path: 'direct', hostKey: 'unpinned' } }
    },
    computerName: () => 'Computer B'
  }
}

const ok = (answer: EditorTunnelOpenAnswer) => {
  if (!answer.ok) throw new Error(`refused: ${answer.reason}`)
  return answer
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const tick = () => new Promise((resolve) => setImmediate(resolve))

describe('the tunnels a local connection holds', () => {
  it('opens one, and carries bytes both ways', async () => {
    const h = host(() => memoryTunnel())
    const tunnels = new LocalEditorTunnels(h)
    cleanup.push(() => tunnels.closeAll())
    const open = ok(await tunnels.open({ id: 'c1' }, NODE))
    expect(open).toMatchObject({ computer: 'Computer B', path: 'direct' })
    expect(open.handle).toMatch(/^[0-9a-f]{32}$/u)
    expect(tunnels.count('c1')).toBe(1)

    expect(await tunnels.write('c1', open.handle, Buffer.from('hello'))).toEqual({ ok: true })
    await wait(10)
    expect(h.opened[0]!.far.received().toString()).toBe('hello')
    h.opened[0]!.far.write('world')
    const read = await tunnels.read('c1', open.handle, 500)
    expect(Buffer.from(read.data!, 'base64').toString()).toBe('world')
  })

  it('belongs to the connection that opened it: another cannot read, write or close it', async () => {
    const h = host(() => memoryTunnel())
    const tunnels = new LocalEditorTunnels(h)
    cleanup.push(() => tunnels.closeAll())
    const { handle } = ok(await tunnels.open({ id: 'c1' }, NODE))
    await expect(tunnels.read('c2', handle, 10)).rejects.toBeInstanceOf(NetError)
    await expect(tunnels.write('c2', handle, Buffer.from('x'))).rejects.toBeInstanceOf(NetError)
    tunnels.close('c2', handle)
    expect(tunnels.count()).toBe(1)
    expect(h.opened[0]!.log.closeCalls).toBe(0)
    await expect(tunnels.read('c1', 'not a handle', 10)).rejects.toBeInstanceOf(NetError)
    tunnels.close('c1', handle)
    expect(tunnels.count()).toBe(0)
    expect(h.opened[0]!.log.closeCalls).toBe(1)
  })

  it('ends a connection’s tunnels when the connection ends, and lets the open see the connection’s lifetime', async () => {
    const h = host(() => memoryTunnel())
    const tunnels = new LocalEditorTunnels(h)
    cleanup.push(() => tunnels.closeAll())
    const life = new AbortController()
    ok(await tunnels.open({ id: 'c1', lifetime: life.signal }, NODE))
    ok(await tunnels.open({ id: 'c2' }, NODE))
    expect(h.signals[0]).toBe(life.signal)
    life.abort()
    expect(tunnels.count('c1')).toBe(0)
    expect(h.opened[0]!.log.closeCalls).toBe(1)
    expect(tunnels.count('c2')).toBe(1)
    tunnels.closeConnection('c2')
    expect(tunnels.count()).toBe(0)
  })

  it('wakes a read that waits when its connection goes away', async () => {
    const h = host(() => memoryTunnel())
    const tunnels = new LocalEditorTunnels(h)
    cleanup.push(() => tunnels.closeAll())
    const life = new AbortController()
    const { handle } = ok(await tunnels.open({ id: 'c1', lifetime: life.signal }, NODE))
    const waiting = tunnels.read('c1', handle, 10_000)
    await tick()
    life.abort()
    expect(await waiting).toEqual({ end: 'closed' })
  })

  it('does not open for a connection that is already gone, and lets a tunnel that opens late go', async () => {
    const gone = new AbortController()
    gone.abort()
    const h = host(() => memoryTunnel())
    const tunnels = new LocalEditorTunnels(h)
    expect(await tunnels.open({ id: 'c1', lifetime: gone.signal }, NODE)).toEqual({
      ok: false,
      reason: 'cancelled',
      computer: 'Computer B'
    })
    expect(h.opened).toHaveLength(0)

    const late = new AbortController()
    let release!: () => void
    const slow = host(async () => {
      await new Promise<void>((resolve) => (release = resolve))
      return memoryTunnel()
    })
    const other = new LocalEditorTunnels(slow)
    const opening = other.open({ id: 'c2', lifetime: late.signal }, NODE)
    await tick()
    late.abort()
    release()
    expect(await opening).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(slow.opened[0]!.log.closeCalls).toBe(1)
    expect(other.count()).toBe(0)
  })

  it('holds at most so many tunnels per connection', async () => {
    const h = host(() => memoryTunnel())
    const tunnels = new LocalEditorTunnels(h, { perConnection: 2 })
    cleanup.push(() => tunnels.closeAll())
    ok(await tunnels.open({ id: 'c1' }, NODE))
    ok(await tunnels.open({ id: 'c1' }, NODE))
    expect(await tunnels.open({ id: 'c1' }, NODE)).toMatchObject({ ok: false, reason: 'limit' })
    ok(await tunnels.open({ id: 'c2' }, NODE))
    expect(h.opened).toHaveLength(3)
  })

  it('answers a refusal as a reason with the computer’s name, never as an error', async () => {
    const cases: Array<[Error, string]> = [
      [new TunnelError('editor_off'), 'editor_off'],
      [new TunnelError('no_ssh_server'), 'no_ssh_server'],
      [new TunnelError('offline'), 'offline'],
      [new EditorSshError('unknown_computer', 'no alias'), 'unknown_computer'],
      [new EditorSshError('unwritable', 'cannot'), 'ssh_settings'],
      [new NetError('bad_request'), 'unknown_computer'],
      [new NetError('peer_offline'), 'offline'],
      [new NetError('disabled'), 'net_disabled'],
      [new NetError('not_enrolled'), 'net_disabled'],
      // Anything else is not "Net is off".
      [new NetError('keystore_locked'), 'failed'],
      [new NetError('internal'), 'failed'],
      [new NetError('cancelled'), 'cancelled'],
      [new Error('boom with C:\\secret\\path'), 'failed']
    ]
    for (const [error, reason] of cases) {
      const tunnels = new LocalEditorTunnels({
        open: async () => {
          throw error
        },
        computerName: () => 'Computer B'
      })
      expect(await tunnels.open({ id: 'c1' }, NODE), reason).toEqual({
        ok: false,
        reason,
        computer: 'Computer B'
      })
    }
  })

  it('reads at most one piece at a time, in order, and holds back the other computer while nobody reads', async () => {
    const h = host(() => memoryTunnel())
    const tunnels = new LocalEditorTunnels(h, { holdBytes: 64 * 1024 })
    cleanup.push(() => tunnels.closeAll())
    const { handle } = ok(await tunnels.open({ id: 'c1' }, NODE))
    const far = h.opened[0]!.far
    const bytes = randomBytes(EDITOR_TUNNEL_LOCAL_CHUNK_BYTES * 6 + 17)
    far.write(bytes)
    await wait(30)
    // Nothing was read yet: the tunnel's stream is paused, so the far side's writes would back up.
    expect(h.opened[0]!.tunnel.stream.isPaused()).toBe(true)
    const got: Buffer[] = []
    for (;;) {
      const read = await tunnels.read('c1', handle, 50)
      if (!read.data) break
      const piece = Buffer.from(read.data, 'base64')
      expect(piece.length).toBeLessThanOrEqual(EDITOR_TUNNEL_LOCAL_CHUNK_BYTES)
      got.push(piece)
    }
    expect(Buffer.concat(got).equals(bytes)).toBe(true)
    expect(got.length).toBeGreaterThan(5)
  })

  it('answers a read with nothing when nothing comes in time', async () => {
    const h = host(() => memoryTunnel())
    const tunnels = new LocalEditorTunnels(h, { readWaitMs: 30 })
    cleanup.push(() => tunnels.closeAll())
    const { handle } = ok(await tunnels.open({ id: 'c1' }, NODE))
    const started = Date.now()
    expect(await tunnels.read('c1', handle, 5_000)).toEqual({})
    // The wait is capped by the daemon, whatever the caller asks.
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('tells why a tunnel ended, after the bytes it sent were read, and then forgets it', async () => {
    const h = host(() => memoryTunnel())
    const tunnels = new LocalEditorTunnels(h)
    cleanup.push(() => tunnels.closeAll())
    const { handle } = ok(await tunnels.open({ id: 'c1' }, NODE))
    const far = h.opened[0]!.far
    far.write('last words')
    far.end('blocked')
    const first = await tunnels.read('c1', handle, 500)
    expect(Buffer.from(first.data!, 'base64').toString()).toBe('last words')
    expect(await tunnels.read('c1', handle, 500)).toEqual({ end: 'blocked' })
    expect(tunnels.count()).toBe(0)
    expect(h.opened[0]!.log.closeCalls).toBe(1)
    // A late read or write is told the tunnel is over, with the same reason, not that the handle is unknown.
    expect(await tunnels.read('c1', handle, 10)).toEqual({ end: 'blocked' })
    expect(await tunnels.write('c1', handle, Buffer.from('x'))).toEqual({ end: 'blocked' })
    expect(await tunnels.end('c1', handle)).toEqual({ end: 'blocked' })
    // Only for the connection that owned it.
    await expect(tunnels.read('c2', handle, 10)).rejects.toBeInstanceOf(NetError)
  })

  it('half-closes the write side on end, and keeps reading what the other computer sends after it', async () => {
    const h = host(() => memoryTunnel())
    const tunnels = new LocalEditorTunnels(h)
    cleanup.push(() => tunnels.closeAll())
    const { handle } = ok(await tunnels.open({ id: 'c1' }, NODE))
    const far = h.opened[0]!
    let ended = false
    far.far.stream.on('end', () => {
      ended = true
      far.far.write('after the end')
    })
    await tunnels.write('c1', handle, Buffer.from('before the end'))
    expect(await tunnels.end('c1', handle)).toEqual({ ok: true })
    await wait(30)
    expect(ended).toBe(true)
    expect(far.far.received().toString()).toBe('before the end')
    // Not closed: the tunnel is still held and still readable.
    expect(tunnels.count()).toBe(1)
    expect(far.log.closeCalls).toBe(0)
    const read = await tunnels.read('c1', handle, 500)
    expect(Buffer.from(read.data!, 'base64').toString()).toBe('after the end')
    // Writing after the end says it is over for writing.
    expect(await tunnels.write('c1', handle, Buffer.from('x'))).toMatchObject({
      end: expect.any(String)
    })
    // A second end is harmless.
    expect(await tunnels.end('c1', handle)).toMatchObject({})
  })

  it('tells a writer that the tunnel is over, with the reason', async () => {
    const h = host(() => memoryTunnel())
    const tunnels = new LocalEditorTunnels(h)
    cleanup.push(() => tunnels.closeAll())
    const { handle } = ok(await tunnels.open({ id: 'c1' }, NODE))
    h.opened[0]!.far.end('editor_off')
    await wait(20)
    expect(await tunnels.write('c1', handle, Buffer.from('x'))).toEqual({ end: 'editor_off' })
  })

  it('refuses a write larger than a piece', async () => {
    const h = host(() => memoryTunnel())
    const tunnels = new LocalEditorTunnels(h)
    cleanup.push(() => tunnels.closeAll())
    const { handle } = ok(await tunnels.open({ id: 'c1' }, NODE))
    await expect(
      tunnels.write('c1', handle, Buffer.alloc(EDITOR_TUNNEL_LOCAL_CHUNK_BYTES + 1))
    ).rejects.toBeInstanceOf(NetError)
  })

  it('closes a tunnel nobody talks to, so a proxy that is stuck does not keep a connection to a computer open', async () => {
    const h = host(() => memoryTunnel())
    const tunnels = new LocalEditorTunnels(h, { idleMs: 40 })
    cleanup.push(() => tunnels.closeAll())
    const a = ok(await tunnels.open({ id: 'c1' }, NODE))
    const b = ok(await tunnels.open({ id: 'c1' }, NODE))
    // A tunnel that is read from stays; one that is not goes.
    const keep = setInterval(() => void tunnels.read('c1', a.handle, 5).catch(() => {}), 10)
    await wait(150)
    clearInterval(keep)
    expect(h.opened[0]!.log.closeCalls).toBe(0)
    expect(h.opened[1]!.log.closeCalls).toBe(1)
    // The proxy that comes back for it is told it ended, not that something is wrong with the daemon.
    expect(await tunnels.read('c1', b.handle, 5)).toEqual({ end: 'closed' })
  })
})

describe('the local methods', () => {
  const connection = (patch: Record<string, unknown> = {}) =>
    ({
      mms: {} as never,
      globalSequence: () => 0,
      connection: {
        id: 'c1',
        binding: { profileId: 'p1', epoch: 1 },
        capabilities: new Set(['net.v1']),
        clientType: 'cli',
        ...patch
      }
    }) as unknown as HandlerContext

  function setup() {
    const registry = new DomainHandlerRegistry()
    const calls: unknown[][] = []
    const closed: string[] = []
    const service: EditorTunnelLocalService = {
      editorTunnelRequest: (method, params, conn) => {
        calls.push([method, params, conn.id])
        return { ok: true }
      },
      editorTunnelConnectionClosed: (id) => closed.push(id)
    }
    registerEditorTunnelMethods(registry, () => service)
    return { registry, calls, closed }
  }

  it('are not among the methods a client can list, and are separate from net.v1’s own list', () => {
    expect(EDITOR_TUNNEL_LOCAL_METHODS.length).toBe(5)
    for (const method of EDITOR_TUNNEL_LOCAL_METHODS)
      expect((NET_LOCAL_METHODS as readonly string[]).includes(method)).toBe(false)
  })

  it('need the net.v1 capability and a bound profile', async () => {
    const { registry } = setup()
    const params = { node: NODE }
    await expect(
      registry.dispatch(connection({ capabilities: new Set() }), 'net.editor.tunnel.open', params)
    ).rejects.toMatchObject({ code: 'capability_required' })
    await expect(
      registry.dispatch(connection({ binding: undefined }), 'net.editor.tunnel.open', params)
    ).rejects.toMatchObject({ code: 'profile_binding_required' })
  })

  it('pass the connection’s own id, never one from the params', async () => {
    const { registry, calls } = setup()
    await registry.dispatch(connection(), 'net.editor.tunnel.open', { node: NODE })
    expect(calls).toEqual([['net.editor.tunnel.open', { node: NODE }, 'c1']])
    await expect(
      registry.dispatch(connection(), 'net.editor.tunnel.open', { node: NODE, connection: 'c9' })
    ).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('refuse a call from another computer, and a malformed one', async () => {
    const { registry, calls } = setup()
    await expect(
      registry.dispatch(
        connection({
          clientType: 'bridge',
          bridgeCaller: { node: NODE, user: 'u', maxPermissionMode: 'ask' }
        }),
        'net.editor.tunnel.open',
        { node: NODE }
      )
    ).rejects.toMatchObject({ code: 'forbidden' })
    for (const [method, params] of [
      ['net.editor.tunnel.open', {}],
      ['net.editor.tunnel.open', { node: 'nod_x' }],
      ['net.editor.tunnel.read', {}],
      ['net.editor.tunnel.read', { tunnel: 'a'.repeat(32), waitMs: -1 }],
      ['net.editor.tunnel.write', { tunnel: 'a'.repeat(32) }],
      ['net.editor.tunnel.write', { tunnel: 'a'.repeat(32), data: 'x'.repeat(70_000) }],
      ['net.editor.tunnel.end', {}],
      ['net.editor.tunnel.end', { tunnel: 'a'.repeat(32), data: 'x' }],
      ['net.editor.tunnel.close', { tunnel: 'a'.repeat(32), host: '10.0.0.1' }]
    ] as const)
      await expect(registry.dispatch(connection(), method, params), method).rejects.toMatchObject({
        code: 'bad_request'
      })
    expect(calls).toHaveLength(0)
  })

  it('end a connection’s tunnels when the connection closes', async () => {
    const { registry, closed } = setup()
    await registry.dispatch(connection(), 'net.editor.tunnel.open', { node: NODE })
    registry.notifyConnectionClosed('c1')
    expect(closed).toEqual(['c1'])
  })
})
