import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NetService, type NetDomainComposition } from '../../../src/mms/net/NetService'
import type { SshVerifier } from '../../../src/mms/net/editor/sshConfig'
import { TunnelError, type ClientTunnel } from '../../../src/mms/net/editor/tunnel'
import { NetError, type NodeId } from '../../../src/shared/net'
import type { EditorSshStatus } from '../../../src/shared/net/local'
import { KEY_A, KEY_B } from '../ssh/bed'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function directory(prefix: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  cleanups.push(() => rm(path, { recursive: true, force: true }))
  return path
}
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const passes: SshVerifier = async () => ({ ok: true })

interface Echo {
  port: number
  connections: number
  sockets: Set<Socket>
  server: Server
}
async function echoServer(): Promise<Echo> {
  const echo: Echo = { port: 0, connections: 0, sockets: new Set(), server: undefined as never }
  echo.server = createServer({ allowHalfOpen: true }, (socket) => {
    echo.connections++
    echo.sockets.add(socket)
    socket.on('close', () => echo.sockets.delete(socket))
    socket.on('error', () => {})
    socket.pipe(socket)
  })
  await new Promise<void>((resolve) => echo.server.listen(0, '127.0.0.1', resolve))
  echo.port = (echo.server.address() as { port: number }).port
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of echo.sockets) socket.destroy()
        echo.server.close(() => resolve())
      })
  )
  return echo
}

function readAll(stream: Duplex, size: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let count = 0
    stream.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      count += chunk.length
      if (count >= size) resolve(Buffer.concat(chunks))
    })
    stream.once('error', reject)
    stream.once('close', () => resolve(Buffer.concat(chunks)))
  })
}

async function reason(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (error) {
    expect(error).toBeInstanceOf(TunnelError)
    return (error as TunnelError).reason
  }
  throw new Error('Expected the open to be refused.')
}

/**
 * An owner that carries the far end (an echo server standing in for its SSH server, and a folder holding its
 * public host key) and a laptop that opens tunnels to it, over a real Net session on loopback. The laptop's
 * sessions list their capabilities like the Bridge does, so a tunnel needs `tunnel.v1` added to that list.
 */
async function pair(
  options: {
    editorSsh?: boolean
    keys?: Array<{ type: string; key: string }>
    /** The computer that opens tunnels is the authority, and the one that carries the far end has joined it. */
    callerIsAuthority?: boolean
  } = {}
) {
  const echo = await echoServer()
  const keys = await directory('mousse owner host keys ')
  const keyFile = join(keys, 'ssh_host_ed25519_key.pub')
  await writeFile(
    keyFile,
    `${(options.keys?.[0] ?? KEY_A).type} ${(options.keys?.[0] ?? KEY_A).key} root@owner\n`
  )
  const owner = new NetService({
    profileDir: await directory('net-tunnel-owner-'),
    editorTunnel: { farEnd: [{ host: '127.0.0.1', port: echo.port }], hostKeyDirectories: [keys] }
  })
  cleanups.push(() => owner.shutdown())
  const home = await directory('mousse editor home ')
  const mousseHome = join(home, '.mousse')
  await mkdir(mousseHome, { recursive: true })
  const laptop = new NetService({
    profileDir: await directory('net-tunnel-laptop-'),
    composeRuntime: (): NetDomainComposition => ({
      session: { capabilities: ['streams.v1', 'blobs.v1', 'rpc.v1'] }
    }),
    ...(options.editorSsh
      ? {
          editorSsh: {
            home,
            mousseHome,
            cli: '/usr/local/bin/mousse-cli',
            profile: 'default',
            verify: passes
          }
        }
      : {})
  })
  cleanups.push(() => laptop.shutdown())
  const [authority, follower] = options.callerIsAuthority ? [laptop, owner] : [owner, laptop]
  await authority.request('net.init', { name: 'authority', listen: true, port: 0 })
  await authority.request('net.protect', { passphrase: 'test-authority-protection' })
  const invite = ((await authority.request('bridge.invite', {})) as { invite: string }).invite
  const joined = (await follower.request('bridge.join', { invite, name: 'follower' })) as {
    node: NodeId
  }
  const authorityNode = authority.runtime().identity.self()!.node
  const [self, laptopNode] = options.callerIsAuthority
    ? [joined.node, authorityNode]
    : [authorityNode, joined.node]
  await vi.waitFor(
    () => expect(owner.status().peers).toContainEqual({ node: laptopNode, state: 'open' }),
    { timeout: 10_000 }
  )
  await vi.waitFor(
    () => expect(laptop.status().peers).toContainEqual({ node: self, state: 'open' }),
    { timeout: 10_000 }
  )
  const policy = (change: Record<string, unknown>) =>
    owner.request('bridge.policy', { node: laptopNode, ...change })
  const open = (signal?: AbortSignal) => laptop.openEditorTunnel(self, signal)
  const closes = () =>
    owner
      .runtime()
      .audit.recent(100, laptopNode)
      .filter((row) => row.method === 'editor.close')
      .map((row) => row.outcome)
  return {
    owner,
    laptop,
    echo,
    self: { node: self },
    laptopNode,
    policy,
    open,
    closes,
    home,
    mousseHome,
    keyFile
  }
}

async function echoed(tunnel: ClientTunnel, text = 'SSH-2.0-mousse'): Promise<void> {
  const back = readAll(tunnel.stream, text.length)
  tunnel.stream.write(text)
  expect((await back).toString()).toBe(text)
}

describe('editor tunnels over a real session', () => {
  it('are off by default, then carry bytes to the far end once the owner turns the switch on', async () => {
    const t = await pair()
    const firstOpens: NodeId[] = []
    t.owner.onEditorFirstOpen((node) => firstOpens.push(node))

    // Off until the owner turns it on: the far end is not even touched.
    expect(t.owner.runtime().policy.get(t.laptopNode).editor).toBe(false)
    expect(await reason(t.open())).toBe('editor_off')
    expect(t.echo.connections).toBe(0)
    expect(t.owner.runtime().audit.recent(10, t.laptopNode)).toEqual([
      expect.objectContaining({ method: 'editor.open', kind: 'refused', outcome: 'editor_off' })
    ])
    expect(firstOpens).toEqual([])

    await t.policy({ editor: true })
    const { tunnel, info } = await t.open()
    expect(info).toEqual({ path: 'direct', transport: expect.any(String), hostKey: 'unpinned' })
    expect(tunnel.hostKeys).toEqual([KEY_A])
    expect(firstOpens).toEqual([t.laptopNode])

    // A megabyte goes to the far end and comes back unchanged, on the lane of its own.
    const payload = randomBytes(1024 * 1024 + 17)
    const back = readAll(tunnel.stream, payload.length)
    for (let at = 0; at < payload.length; at += 60_000)
      tunnel.stream.write(payload.subarray(at, at + 60_000))
    expect(sha(await back)).toBe(sha(payload))
    expect(t.echo.connections).toBe(1)
    expect(t.owner.editorTunnelList(t.laptopNode)).toHaveLength(1)

    tunnel.close()
    expect(await tunnel.closed).toBe('closed')
    await vi.waitFor(() => expect(t.owner.editorTunnelList()).toEqual([]))
    await vi.waitFor(() => expect(t.closes()).toHaveLength(1))
    expect(t.closes()[0]).toMatch(/^closed; direct; in 1048593 B; out 1048593 B; \d+ s$/u)
    expect(
      t.owner
        .runtime()
        .audit.reads(t.laptopNode)
        .reduce((n, row) => n + row.bytes, 0)
    ).toBe(1_048_593)

    // The second tunnel is not a "first" one.
    const second = await t.open()
    await echoed(second.tunnel)
    expect(firstOpens).toEqual([t.laptopNode])
    expect(
      t.owner
        .runtime()
        .audit.recent(100, t.laptopNode)
        .filter((row) => row.method === 'editor.open' && row.kind === 'change')
    ).toHaveLength(2)
  }, 60_000)

  it('is refused for each missing permission, with a reason that says which', async () => {
    const t = await pair()
    await t.policy({ editor: true })

    // Blocked.
    await t.policy({ blocked: true })
    expect(await reason(t.open())).toBe('blocked')
    await t.policy({ blocked: false })

    // No "Works on threads".
    await t.owner.request('bridge.setCaps', { node: t.laptopNode, caps: ['read', 'chat', 'write'] })
    expect(await reason(t.open())).toBe('capability')
    await t.owner.request('bridge.setCaps', {
      node: t.laptopNode,
      caps: ['read', 'chat', 'write', 'settings']
    })

    // The owner's switch for other computers.
    await t.owner.request('bridge.workOnThreads', { enabled: false })
    expect(await reason(t.open())).toBe('setting_off')
    await t.owner.request('bridge.workOnThreads', { enabled: true })

    // The device's own switch.
    await t.policy({ editor: false })
    expect(await reason(t.open())).toBe('editor_off')

    // Nothing above reached the far end, and the owner is allowed again once all is in order.
    expect(t.echo.connections).toBe(0)
    await t.policy({ editor: true })
    const { tunnel } = await t.open()
    await echoed(tunnel)
  }, 60_000)

  it('says when nothing listens on the SSH port and when the host key cannot be read', async () => {
    const t = await pair()
    await t.policy({ editor: true })
    await rm(t.keyFile)
    expect(await reason(t.open())).toBe('no_host_key')
    await writeFile(t.keyFile, `${KEY_A.type} ${KEY_A.key} root@owner\n`)
    await new Promise<void>((resolve) => {
      for (const socket of t.echo.sockets) socket.destroy()
      t.echo.server.close(() => resolve())
    })
    expect(await reason(t.open())).toBe('no_ssh_server')
  }, 60_000)

  it.each([
    [
      'the device is blocked',
      'blocked',
      (t: Awaited<ReturnType<typeof pair>>) => t.policy({ blocked: true })
    ],
    [
      'the editor switch goes off',
      'editor_off',
      (t: Awaited<ReturnType<typeof pair>>) => t.policy({ editor: false })
    ],
    [
      'the owner’s switch for other computers goes off',
      'setting_off',
      (t: Awaited<ReturnType<typeof pair>>) =>
        t.owner.request('bridge.workOnThreads', { enabled: false })
    ],
    [
      'the device loses "Works on threads"',
      'access_lost',
      (t: Awaited<ReturnType<typeof pair>>) =>
        t.owner.request('bridge.setCaps', { node: t.laptopNode, caps: ['read', 'chat', 'write'] })
    ]
  ] as const)(
    'ends every tunnel of the device at once when %s',
    async (_name, ended, change) => {
      const t = await pair()
      await t.policy({ editor: true })
      const tunnels = [(await t.open()).tunnel, (await t.open()).tunnel, (await t.open()).tunnel]
      for (const tunnel of tunnels) await echoed(tunnel)
      expect(t.echo.sockets.size).toBe(3)

      await change(t)

      // The far ends are closed, the owner holds none, and the laptop is told why.
      await vi.waitFor(() => expect(t.echo.sockets.size).toBe(0))
      expect(t.owner.editorTunnelList()).toEqual([])
      expect(await Promise.all(tunnels.map((tunnel) => tunnel.closed))).toEqual([
        ended,
        ended,
        ended
      ])
      await vi.waitFor(() => expect(t.closes()).toHaveLength(3))
      for (const outcome of t.closes()) expect(outcome.startsWith(`${ended}; direct; `)).toBe(true)
      // And nothing new opens while the reason stands.
      expect(await reason(t.open())).toBe(ended === 'access_lost' ? 'capability' : ended)
    },
    60_000
  )

  it('ends every tunnel when the device is revoked', async () => {
    const t = await pair()
    await t.policy({ editor: true })
    const { tunnel } = await t.open()
    await echoed(tunnel)
    await t.owner.request('bridge.revoke', { node: t.laptopNode })
    await vi.waitFor(() => expect(t.echo.sockets.size).toBe(0))
    expect(t.owner.editorTunnelList()).toEqual([])
    // The laptop is told why, or loses the session first; either way its stream has ended.
    expect(['access_lost', 'offline', 'revoked']).toContain(await tunnel.closed)
    await vi.waitFor(() => expect(t.closes()).toHaveLength(1))
    expect(t.closes()[0]).toMatch(/^(access_lost|session_closed); /u)
  }, 60_000)

  it('ends every tunnel, on both computers, when Net is turned off on the owner', async () => {
    const t = await pair()
    await t.policy({ editor: true })
    const { tunnel } = await t.open()
    await echoed(tunnel)
    await t.owner.request('net.disable', {})
    expect(t.owner.editorTunnelList()).toEqual([])
    await vi.waitFor(() => expect(t.echo.sockets.size).toBe(0))
    expect(['net_off', 'offline']).toContain(await tunnel.closed)
    // The end is written down, with its reason.
    await vi.waitFor(() =>
      expect(
        t.owner
          .runtime()
          .audit.recent(100, t.laptopNode)
          .filter((row) => row.method === 'editor.close')
          .map((row) => row.outcome.split(';')[0])
      ).toEqual(['net_off'])
    )
  }, 60_000)

  it('ends the tunnels a computer opened when Net is turned off on that computer', async () => {
    const t = await pair()
    await t.policy({ editor: true })
    const { tunnel } = await t.open()
    await echoed(tunnel)
    await t.laptop.request('net.disable', {})
    expect(t.laptop.editorTunnelList()).toEqual([])
    expect(['net_off', 'offline']).toContain(await tunnel.closed)
    await vi.waitFor(() => expect(t.echo.sockets.size).toBe(0))
  }, 60_000)

  it('refuses to open to itself, and while Net is off', async () => {
    const t = await pair()
    await expect(t.owner.openEditorTunnel(t.self.node)).rejects.toBeInstanceOf(NetError)
    await t.laptop.request('net.disable', {})
    await expect(t.open()).rejects.toMatchObject({ code: 'disabled' })
  }, 60_000)
})

describe('host keys', () => {
  it('are pinned in Mousse’s own known_hosts before the stream is handed over, and replaced when the computer’s key changes', async () => {
    // The authority records which devices are computers, so it is the computer that gets the aliases.
    const t = await pair({ editorSsh: true, callerIsAuthority: true })
    await t.policy({ editor: true })
    await t.laptop.request('net.editor.ssh.enable', {})
    let alias = ''
    await vi.waitFor(async () => {
      const status = (await t.laptop.request('net.editor.ssh.status', {})) as EditorSshStatus
      expect(status.computers.map((row) => row.node)).toEqual([t.self.node])
      alias = status.computers[0]!.alias
    })
    const knownHosts = join(t.mousseHome, 'ssh', 'known_hosts')

    const first = await t.open()
    expect(first.info.hostKey).toBe('added')
    expect(await readFile(knownHosts, 'utf8')).toContain(`${alias} ${KEY_A.type} ${KEY_A.key}`)
    first.tunnel.close()

    const second = await t.open()
    expect(second.info.hostKey).toBe('present')
    second.tunnel.close()

    // The owner's SSH server got a new key: the owner vouches for it over Net, so it is pinned, not asked about.
    await writeFile(t.keyFile, `${KEY_B.type} ${KEY_B.key} root@owner\n`)
    const third = await t.open()
    expect(third.info.hostKey).toBe('replaced')
    const text = await readFile(knownHosts, 'utf8')
    expect(text).toContain(`${alias} ${KEY_B.type} ${KEY_B.key}`)
    expect(text).not.toContain(KEY_A.key)
    third.tunnel.close()
  }, 60_000)

  it('leave nothing open when they cannot be pinned', async () => {
    // This computer keeps editor settings, but has no alias for the owner yet: strict checking would refuse the key.
    const t = await pair({ editorSsh: true, callerIsAuthority: true })
    await t.policy({ editor: true })
    await expect(t.open()).rejects.toMatchObject({ code: 'unknown_computer' })
    await vi.waitFor(() => expect(t.laptop.editorTunnelList()).toEqual([]))
    await vi.waitFor(() => expect(t.echo.sockets.size).toBe(0))
  }, 60_000)
})
