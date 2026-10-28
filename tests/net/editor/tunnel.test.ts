import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EditorTunnels,
  SSH_FAR_END,
  TunnelError,
  defaultHostKeyDirectories,
  readHostKeys,
  type ClientTunnel,
  type EditorTunnelOptions
} from '../../../src/mms/net/editor/tunnel'
import type { Clock, TunnelLink } from '../../../src/mms/net/contracts'
import { decodeMessage, encodeMessage } from '../../../src/mms/net/sync/codec'
import { NetError, newId, type NodeId } from '../../../src/shared/net'
import {
  EDITOR_TUNNELS_PER_NODE,
  TUNNEL_CHUNK_BYTES,
  TUNNEL_REASONS,
  TUNNEL_WINDOW_BYTES,
  tunnelPathOf,
  type TunnelReason
} from '../../../src/shared/net/tunnel'
import { laneFor, type TunnelMessage } from '../../../src/shared/net/wire'
import { validateWireMessage } from '../../../src/shared/net/schemas'
import { FakeClock } from '../harness/FakeClock'
import { KEY_A, KEY_B, KEY_RSA } from '../ssh/bed'

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const settle = async (ms = 20): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms))
}
async function until(check: () => boolean, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await settle(5)
  }
}

// ---------------------------------------------------------------------------------------- the wire

const ID = '0123456789abcdef0123456789abcdef'
const frame = (header: unknown): Uint8Array => {
  const json = new TextEncoder().encode(JSON.stringify(header))
  const out = new Uint8Array(4 + json.length)
  new DataView(out.buffer).setUint32(0, json.length)
  out.set(json, 4)
  return out
}
const codeOf = (work: () => unknown): string | undefined => {
  try {
    work()
  } catch (error) {
    return (error as NetError).code
  }
  return undefined
}

describe('the messages of a tunnel', () => {
  it('has no field in which to name a host or a port, and refuses one that is added', () => {
    const open = { t: 'tunnel.open', tunnel: ID, kind: 'ssh' }
    expect(validateWireMessage(open)).toBe(true)
    for (const extra of [
      { host: '10.0.0.5' },
      { port: 22 },
      { address: '10.0.0.5:22' },
      { host: '127.0.0.1', port: 2222 },
      { target: 'localhost:5432' }
    ]) {
      const header = { ...open, ...extra }
      expect(validateWireMessage(header)).toBe(false)
      expect(codeOf(() => encodeMessage(header as never))).toBe('bad_request')
      // A peer that sends it anyway is refused when it is read, and the session ends.
      expect(codeOf(() => decodeMessage(frame(header), 'control'))).toBe('bad_request')
    }
  })

  it('opens an SSH tunnel and nothing else', () => {
    for (const kind of ['tcp', 'http', 'socks', 'SSH', 'ssh ', '', 'ssh://10.0.0.5:22', 5, null])
      expect(validateWireMessage({ t: 'tunnel.open', tunnel: ID, kind })).toBe(false)
    expect(validateWireMessage({ t: 'tunnel.open', tunnel: ID })).toBe(false)
  })

  it('names a tunnel by 128 random bits and by nothing else', () => {
    for (const tunnel of [
      '',
      'abc',
      ID.toUpperCase(),
      `${ID}0`,
      ID.slice(1),
      'g'.repeat(32),
      `${ID}\n`
    ])
      expect(validateWireMessage({ t: 'tunnel.open', tunnel, kind: 'ssh' })).toBe(false)
  })

  it('bounds a credit by the window and a piece by the chunk, and lets only an end be empty', () => {
    expect(validateWireMessage({ t: 'tunnel.credit', tunnel: ID, bytes: 1 })).toBe(true)
    expect(
      validateWireMessage({ t: 'tunnel.credit', tunnel: ID, bytes: TUNNEL_WINDOW_BYTES })
    ).toBe(true)
    for (const bytes of [0, -1, TUNNEL_WINDOW_BYTES + 1, 1.5])
      expect(validateWireMessage({ t: 'tunnel.credit', tunnel: ID, bytes })).toBe(false)

    expect(validateWireMessage({ t: 'tunnel.data', tunnel: ID, parts: [TUNNEL_CHUNK_BYTES] })).toBe(
      true
    )
    expect(
      validateWireMessage({ t: 'tunnel.data', tunnel: ID, parts: [TUNNEL_CHUNK_BYTES + 1] })
    ).toBe(false)
    expect(validateWireMessage({ t: 'tunnel.data', tunnel: ID, parts: [1, 1] })).toBe(false)
    expect(validateWireMessage({ t: 'tunnel.data', tunnel: ID, parts: [] })).toBe(false)
    const empty = { t: 'tunnel.data', tunnel: ID, parts: [0] } as const
    expect(codeOf(() => encodeMessage(empty, [new Uint8Array(0)]))).toBe('bad_request')
    const end = { ...empty, end: true } as const
    expect(decodeMessage(encodeMessage(end, [new Uint8Array(0)]), 'tunnel').header).toEqual(end)
    // The part must be the length the header says.
    expect(
      codeOf(() => encodeMessage({ t: 'tunnel.data', tunnel: ID, parts: [5] }, [new Uint8Array(4)]))
    ).toBe('bad_request')
  })

  it('sends the bytes on the tunnel lane and everything else on control', () => {
    expect(laneFor({ t: 'tunnel.data', tunnel: ID, parts: [1] })).toBe('tunnel')
    for (const header of [
      { t: 'tunnel.open', tunnel: ID, kind: 'ssh' },
      { t: 'tunnel.opened', tunnel: ID, hostKeys: [KEY_A] },
      { t: 'tunnel.credit', tunnel: ID, bytes: 1 },
      { t: 'tunnel.close', tunnel: ID, reason: 'blocked' }
    ] as const)
      expect(laneFor(header)).toBe('control')
    // The wrong lane is refused when read.
    const data = encodeMessage({ t: 'tunnel.data', tunnel: ID, parts: [1] }, [new Uint8Array(1)])
    expect(codeOf(() => decodeMessage(data, 'bulk'))).toBe('bad_request')
    expect(codeOf(() => decodeMessage(data, 'control'))).toBe('bad_request')
  })

  it('ends only for a reason from the list, and vouches for one to eight keys', () => {
    for (const reason of TUNNEL_REASONS)
      expect(validateWireMessage({ t: 'tunnel.close', tunnel: ID, reason })).toBe(true)
    for (const reason of ['', 'because', 'Blocked', 'offline', 'timeout', undefined])
      expect(validateWireMessage({ t: 'tunnel.close', tunnel: ID, reason })).toBe(false)
    const opened = (hostKeys: unknown) => ({ t: 'tunnel.opened', tunnel: ID, hostKeys })
    expect(validateWireMessage(opened([KEY_A]))).toBe(true)
    expect(validateWireMessage(opened([KEY_A, KEY_B, KEY_RSA]))).toBe(true)
    expect(validateWireMessage(opened([]))).toBe(false)
    expect(validateWireMessage(opened(Array.from({ length: 9 }, () => KEY_A)))).toBe(false)
    expect(validateWireMessage(opened([{ type: 'ssh-ed25519', key: 'not base64!!' }]))).toBe(false)
    expect(validateWireMessage(opened([{ type: 'ssh-ed25519', key: 'short' }]))).toBe(false)
    expect(validateWireMessage(opened([{ ...KEY_A, comment: 'root@box' }]))).toBe(false)
  })

  it('is a path through a Mousse relay only for the relay transports', () => {
    expect(tunnelPathOf('relay')).toBe('relay')
    expect(tunnelPathOf('plus-relay')).toBe('relay')
    for (const transport of ['direct', 'tailscale', 'cloudflared', 'ssh', 'memory', undefined])
      expect(tunnelPathOf(transport)).toBe('direct')
  })
})

// ------------------------------------------------------------------------------- the far end and keys

describe('the far end', () => {
  it('is this computer’s own SSH server on loopback port 22, as a frozen list', () => {
    expect(SSH_FAR_END).toEqual([
      { host: '127.0.0.1', port: 22 },
      { host: '::1', port: 22 }
    ])
    expect(Object.isFrozen(SSH_FAR_END)).toBe(true)
    expect(Object.isFrozen(SSH_FAR_END[0])).toBe(true)
  })

  it('can only be configured to a loopback address', () => {
    const options = base()
    for (const farEnd of [
      [{ host: '10.0.0.5', port: 22 }],
      [{ host: '192.168.1.2', port: 22 }],
      [{ host: 'example.com', port: 22 }],
      [{ host: 'localhost', port: 22 }],
      [{ host: '0.0.0.0', port: 22 }],
      [
        { host: '127.0.0.1', port: 22 },
        { host: '8.8.8.8', port: 22 }
      ],
      []
    ])
      expect(() => new EditorTunnels({ ...options, farEnd })).toThrow(/loopback/u)
    expect(
      () => new EditorTunnels({ ...options, farEnd: [{ host: '::1', port: 2222 }] })
    ).not.toThrow()
  })
})

describe('the public host keys', () => {
  async function folder(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'mousse host keys '))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    return directory
  }
  const pub = (key: { type: string; key: string }, comment = 'root@box') =>
    `${key.type} ${key.key} ${comment}\n`

  it('reads the public files only and never a private key or a certificate', async () => {
    const dir = await folder()
    await writeFile(join(dir, 'ssh_host_ed25519_key.pub'), pub(KEY_A))
    await writeFile(join(dir, 'ssh_host_rsa_key.pub'), pub(KEY_RSA))
    // A private key, a certificate and a file of another name hold a marker that must never come out.
    const secret = '-----BEGIN OPENSSH PRIVATE KEY-----\nSECRET-MARKER\n'
    await writeFile(join(dir, 'ssh_host_ed25519_key'), secret)
    await writeFile(
      join(dir, 'ssh_host_ed25519_key-cert.pub'),
      `ssh-ed25519-cert-v01@openssh.com AAAA${'B'.repeat(30)}\n`
    )
    await writeFile(join(dir, 'ssh_host_dsa_key'), secret)
    await writeFile(join(dir, 'ssh_config'), 'Host *\n')
    await writeFile(join(dir, 'authorized_keys.pub'), pub(KEY_B))
    const keys = await readHostKeys([dir])
    expect(keys).toEqual([KEY_A, KEY_RSA])
    expect(JSON.stringify(keys)).not.toContain('SECRET-MARKER')
  })

  it('skips what is not a key, is too large, or is not a plain file', async () => {
    const dir = await folder()
    await writeFile(join(dir, 'ssh_host_a_key.pub'), 'not a key at all\n')
    await writeFile(join(dir, 'ssh_host_b_key.pub'), 'ssh-dss AAAA' + 'B'.repeat(40) + ' old\n')
    await writeFile(join(dir, 'ssh_host_c_key.pub'), `ssh-ed25519 ${'A'.repeat(20_000)} huge\n`)
    await mkdir(join(dir, 'ssh_host_d_key.pub'))
    await writeFile(join(dir, 'real.pub'), pub(KEY_B))
    try {
      await symlink(join(dir, 'real.pub'), join(dir, 'ssh_host_e_key.pub'))
    } catch {
      // Symbolic links need a privilege on Windows; the rest of the test still holds.
    }
    await writeFile(join(dir, 'ssh_host_f_key.pub'), pub(KEY_A))
    expect(await readHostKeys([dir])).toEqual([KEY_A])
  })

  it('has no keys for a folder that is not there, one copy of a repeated key, and at most eight', async () => {
    expect(await readHostKeys([join(tmpdir(), 'mousse no such folder')])).toEqual([])
    const dir = await folder()
    for (let index = 0; index < 12; index++)
      await writeFile(
        join(dir, `ssh_host_k${index}_key.pub`),
        pub({
          type: 'ssh-ed25519',
          key: Buffer.from(`mousse test host key ${index}`).toString('base64')
        })
      )
    expect(await readHostKeys([dir])).toHaveLength(8)
    const twice = await folder()
    await writeFile(join(twice, 'ssh_host_a_key.pub'), pub(KEY_A))
    await writeFile(join(twice, 'ssh_host_b_key.pub'), pub(KEY_A, 'other comment'))
    expect(await readHostKeys([twice])).toEqual([KEY_A])
  })

  it('looks in /etc/ssh, and in ProgramData on Windows', () => {
    expect(defaultHostKeyDirectories('linux')).toEqual(['/etc/ssh'])
    expect(defaultHostKeyDirectories('darwin')).toEqual(['/etc/ssh'])
    const [windows] = defaultHostKeyDirectories('win32', 'D:\\ProgramData')
    expect(windows).toMatch(/ProgramData/u)
    expect(windows).toMatch(/ssh$/u)
    expect(defaultHostKeyDirectories('win32', undefined)[0]).toMatch(/ProgramData/u)
  })
})

// ----------------------------------------------------------------------------- two computers, in process

const USER = 'usr_00000000000000000000000000'
const HOST = newId('node')
const CALLER = newId('node')

interface Row {
  node: NodeId
  method: string
  outcome: string
  kind: 'change' | 'refused'
  thread?: string
  project?: string
}
function auditLog() {
  const rows: Row[] = []
  const reads: Array<[NodeId, number]> = []
  return {
    rows,
    reads,
    record(entry: Row) {
      rows.push(entry)
    },
    has(node: NodeId, method: string) {
      return rows.some((row) => row.node === node && row.method === method && row.kind === 'change')
    },
    countRead(node: NodeId, bytes: number) {
      reads.push([node, bytes])
    }
  }
}

/** One end of a session between two computers: what one side sends reaches the other side's service in order. */
class FakeLink implements TunnelLink {
  closed = false
  supported = true
  other!: FakeLink
  readonly sent: TunnelMessage[] = []
  private readonly listeners = new Set<(error?: Error) => void>()
  constructor(
    private readonly service: () => EditorTunnels,
    private readonly peerNode: NodeId
  ) {}
  get peer() {
    return {
      node: this.peerNode,
      user: USER,
      delegation: { caps: ['read', 'chat', 'write', 'settings'] }
    } as unknown as TunnelLink['peer']
  }
  state() {
    return this.closed ? ('closed' as const) : ('open' as const)
  }
  supportsTunnels() {
    return this.supported && !this.closed
  }
  sendTunnel(message: TunnelMessage, bytes?: Uint8Array): Promise<void> {
    if (this.closed) return Promise.reject(new NetError('peer_offline'))
    this.sent.push(message)
    const far = this.other
    queueMicrotask(() => {
      if (!far.closed)
        far.service().receive(far, message, message.t === 'tunnel.data' ? bytes : undefined)
    })
    return Promise.resolve()
  }
  onClosed(listener: (error?: Error) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  /** The session is lost on both ends. */
  cut(): void {
    for (const end of [this, this.other]) {
      if (end.closed) continue
      end.closed = true
      for (const listener of [...end.listeners]) listener(new NetError('peer_offline'))
    }
  }
  /** Bytes of data pieces this end has sent, and credit it has been given back. */
  get dataBytes(): number {
    return this.sent.reduce((n, m) => n + (m.t === 'tunnel.data' ? m.parts[0] : 0), 0)
  }
}

interface Echo {
  port: number
  connections: number
  sockets: Set<Socket>
  received: Buffer[]
  server: Server
}
async function echoServer(
  handler: (socket: Socket, echo: Echo) => void = (socket) => socket.pipe(socket)
): Promise<Echo> {
  const echo: Echo = {
    port: 0,
    connections: 0,
    sockets: new Set(),
    received: [],
    server: undefined as never
  }
  // Half-open, so a far end can answer after the caller's end, as an SSH server may.
  echo.server = createServer({ allowHalfOpen: true }, (socket) => {
    echo.connections++
    echo.sockets.add(socket)
    socket.on('close', () => echo.sockets.delete(socket))
    socket.on('error', () => {})
    socket.on('data', (chunk) => echo.received.push(chunk))
    handler(socket, echo)
  })
  await new Promise<void>((resolve) => echo.server.listen(0, '127.0.0.1', resolve))
  echo.port = (echo.server.address() as { port: number }).port
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of echo.sockets) socket.destroy()
        echo.server.close(() => resolve())
      })
  )
  return echo
}

async function keyFolder(keys: Array<{ type: string; key: string }> = [KEY_A]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mousse host keys '))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  for (const [index, key] of keys.entries())
    await writeFile(
      join(directory, `ssh_host_k${index}_key.pub`),
      `${key.type} ${key.key} root@box\n`
    )
  return directory
}

function base(): EditorTunnelOptions {
  return {
    clock: new FakeClock(),
    audit: auditLog(),
    refusal: () => undefined,
    transportOf: () => 'direct',
    farEnd: [{ host: '127.0.0.1', port: 1 }],
    hostKeyDirectories: []
  }
}

interface Bed {
  host: EditorTunnels
  caller: EditorTunnels
  /** The link the caller holds to the host, and the host's to the caller. */
  toHost: FakeLink
  toCaller: FakeLink
  hostAudit: ReturnType<typeof auditLog>
  callerAudit: ReturnType<typeof auditLog>
  echo: Echo
  clock: FakeClock
  /** Why the host refuses the device right now. */
  refusal: {
    current: TunnelReason | undefined
    calls: number
    after?: (calls: number) => TunnelReason | undefined
  }
  firstOpens: NodeId[]
  open(): Promise<ClientTunnel>
}

async function bed(
  options: {
    echo?: Echo
    transport?: string
    host?: Partial<EditorTunnelOptions>
    caller?: Partial<EditorTunnelOptions>
    keys?: Array<{ type: string; key: string }>
  } = {}
): Promise<Bed> {
  const echo = options.echo ?? (await echoServer())
  const clock = new FakeClock()
  const hostAudit = auditLog()
  const callerAudit = auditLog()
  const refusal: Bed['refusal'] = { current: undefined, calls: 0 }
  const firstOpens: NodeId[] = []
  const keyDir = await keyFolder(options.keys)
  let toHost!: FakeLink
  let toCaller!: FakeLink
  const host: EditorTunnels = new EditorTunnels({
    clock,
    audit: hostAudit,
    refusal: () => {
      refusal.calls++
      return refusal.after ? refusal.after(refusal.calls) : refusal.current
    },
    transportOf: () => options.transport ?? 'direct',
    onFirstOpen: (node) => firstOpens.push(node),
    farEnd: [{ host: '127.0.0.1', port: echo.port }],
    hostKeyDirectories: [keyDir],
    ...options.host
  })
  const caller: EditorTunnels = new EditorTunnels({
    clock,
    audit: callerAudit,
    refusal: () => undefined,
    transportOf: () => options.transport ?? 'direct',
    perNode: 50,
    ...options.caller
  })
  toHost = new FakeLink(() => caller, HOST)
  toCaller = new FakeLink(() => host, CALLER)
  toHost.other = toCaller
  toCaller.other = toHost
  cleanup.push(() => {
    host.endAll('closed')
    caller.endAll('closed')
  })
  return {
    host,
    caller,
    toHost,
    toCaller,
    hostAudit,
    callerAudit,
    echo,
    clock,
    refusal,
    firstOpens,
    open: () => caller.open(toHost)
  }
}

async function rejection(work: Promise<unknown>): Promise<TunnelError> {
  try {
    await work
  } catch (error) {
    expect(error).toBeInstanceOf(TunnelError)
    return error as TunnelError
  }
  throw new Error('Expected the open to be refused.')
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
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

describe('a tunnel carries bytes to the far end and back', () => {
  it('opens, echoes, and hands the caller the host keys and the path', async () => {
    const t = await bed({ keys: [KEY_A, KEY_RSA] })
    const tunnel = await t.open()
    expect(tunnel.hostKeys).toEqual([KEY_A, KEY_RSA])
    expect(tunnel.path).toBe('direct')
    expect(tunnel.transport).toBe('direct')
    const echoed = readAll(tunnel.stream, 11)
    tunnel.stream.write('SSH-2.0-test')
    expect((await echoed).toString()).toBe('SSH-2.0-test')
    expect(t.echo.connections).toBe(1)
    tunnel.close()
    expect(await tunnel.closed).toBe('closed')
  })

  it('moves a megabyte of random bytes both ways, in order and unchanged', async () => {
    const t = await bed()
    const tunnel = await t.open()
    const payload = randomBytes(1024 * 1024 + 123)
    const back = readAll(tunnel.stream, payload.length)
    for (let at = 0; at < payload.length; at += 50_000)
      tunnel.stream.write(payload.subarray(at, at + 50_000))
    const echoed = await back
    expect(echoed.length).toBe(payload.length)
    expect(sha(echoed)).toBe(sha(payload))
  })

  it('never has more in flight than the window, in either direction', async () => {
    const t = await bed()
    const tunnel = await t.open()
    // Credits come back on the other link: outstanding = bytes sent - bytes granted back by the receiver.
    let worst = 0
    const watch = setInterval(() => {
      const toward =
        t.toHost.dataBytes -
        t.toCaller.sent.reduce((n, m) => n + (m.t === 'tunnel.credit' ? m.bytes : 0), 0)
      const back =
        t.toCaller.dataBytes -
        t.toHost.sent.reduce((n, m) => n + (m.t === 'tunnel.credit' ? m.bytes : 0), 0)
      worst = Math.max(worst, toward, back)
    }, 1)
    cleanup.push(() => clearInterval(watch))
    const payload = randomBytes(3 * 1024 * 1024)
    const back = readAll(tunnel.stream, payload.length)
    for (let at = 0; at < payload.length; at += 40_000)
      tunnel.stream.write(payload.subarray(at, at + 40_000))
    expect(sha(await back)).toBe(sha(payload))
    clearInterval(watch)
    expect(worst).toBeGreaterThan(0)
    expect(worst).toBeLessThanOrEqual(TUNNEL_WINDOW_BYTES)
    // No piece is larger than a chunk.
    for (const message of [...t.toHost.sent, ...t.toCaller.sent])
      if (message.t === 'tunnel.data')
        expect(message.parts[0]).toBeLessThanOrEqual(TUNNEL_CHUNK_BYTES)
  }, 30_000)

  it('holds a fast far end back while the caller does not read, and loses nothing when it does', async () => {
    const total = 12 * 1024 * 1024
    const flood = randomBytes(total)
    const echo = await echoServer((socket) => {
      socket.write(flood)
    })
    const t = await bed({ echo })
    const tunnel = await t.open()
    tunnel.stream.pause()
    await settle(300)
    // The far end offered 12 MiB; only what the window (and the pipe) holds went over the link.
    expect(t.toCaller.dataBytes).toBeLessThan(TUNNEL_WINDOW_BYTES + 256 * 1024)
    expect(t.toCaller.dataBytes).toBeGreaterThan(0)
    const all = readAll(tunnel.stream, total)
    tunnel.stream.resume()
    expect(sha(await all)).toBe(sha(flood))
  }, 30_000)

  it('ends in order: what was sent before the end arrives before it, and each side may end first', async () => {
    const echo = await echoServer((socket) => {
      socket.on('end', () => socket.end('bye'))
    })
    const t = await bed({ echo })
    const tunnel = await t.open()
    tunnel.stream.write(Buffer.alloc(100_000, 1))
    tunnel.stream.end()
    const reply = await readAll(tunnel.stream, 3)
    expect(reply.toString()).toBe('bye')
    expect(Buffer.concat(echo.received).length).toBe(100_000)
    expect(await tunnel.closed).toBe('closed')
    await until(() => t.host.list().length === 0, 'the host to let the tunnel go')
    expect(t.hostAudit.rows.at(-1)).toMatchObject({ method: 'editor.close' })
    expect(t.hostAudit.rows.at(-1)!.outcome).toMatch(/^closed; direct; in 100000 B; out 3 B; /u)
  })

  it('goes where the far end is and nowhere else, whatever the bytes say', async () => {
    const decoy = await echoServer()
    const t = await bed()
    const tunnel = await t.open()
    const text = Buffer.from(
      `CONNECT 127.0.0.1:${decoy.port} HTTP/1.1\r\nHost: 127.0.0.1:${decoy.port}\r\n\r\n`
    )
    const echoed = readAll(tunnel.stream, text.length)
    tunnel.stream.write(text)
    expect((await echoed).toString()).toBe(text.toString())
    await settle(50)
    expect(decoy.connections).toBe(0)
    expect(t.echo.connections).toBe(1)
    // Nothing in what the caller sends says where to connect: the only message that opens is `ssh`.
    const opens = t.toHost.sent.filter((message) => message.t === 'tunnel.open')
    expect(opens).toHaveLength(1)
    expect(Object.keys(opens[0]!).sort()).toEqual(['kind', 't', 'tunnel'])
    expect(opens[0]).toMatchObject({ kind: 'ssh' })
  })
})

describe('what a tunnel refuses', () => {
  it.each(['net_off', 'blocked', 'capability', 'setting_off', 'editor_off'] as const)(
    'refuses with %s, before the far end is touched',
    async (reason) => {
      const t = await bed()
      t.refusal.current = reason
      const error = await rejection(t.open())
      expect(error.reason).toBe(reason)
      expect(error.message.length).toBeGreaterThan(10)
      expect(t.echo.connections).toBe(0)
      expect(t.host.count(CALLER)).toBe(0)
      expect(t.firstOpens).toEqual([])
      // Only a refusal that tells the owner something is a row; a blocked device cannot fill the audit.
      const rows = t.hostAudit.rows.filter((row) => row.method === 'editor.open')
      expect(rows.map((row) => `${row.kind}:${row.outcome}`)).toEqual(
        reason === 'editor_off' ? ['refused:editor_off'] : []
      )
    }
  )

  it('is allowed once the switch is on, and refused again when it goes off', async () => {
    const t = await bed()
    t.refusal.current = 'editor_off'
    expect((await rejection(t.open())).reason).toBe('editor_off')
    t.refusal.current = undefined
    const tunnel = await t.open()
    expect(tunnel.path).toBe('direct')
    t.refusal.current = 'editor_off'
    expect((await rejection(t.open())).reason).toBe('editor_off')
  })

  it('says there is no SSH server when nothing listens, and no host key when none can be read', async () => {
    const dead = await echoServer()
    const port = dead.port
    await new Promise<void>((resolve) => {
      for (const socket of dead.sockets) socket.destroy()
      dead.server.close(() => resolve())
    })
    const noServer = await bed({ echo: { ...dead, port } })
    expect((await rejection(noServer.open())).reason).toBe('no_ssh_server')
    expect(noServer.hostAudit.rows).toEqual([
      expect.objectContaining({ method: 'editor.open', kind: 'refused', outcome: 'no_ssh_server' })
    ])

    const noKeys = await bed({ keys: [] })
    expect((await rejection(noKeys.open())).reason).toBe('no_host_key')
    // The far end was reached to find out, and is let go at once.
    expect(noKeys.echo.connections).toBe(1)
    await until(() => noKeys.echo.sockets.size === 0, 'the far end to be closed')
    expect(noKeys.hostAudit.rows).toEqual([
      expect.objectContaining({ method: 'editor.open', kind: 'refused', outcome: 'no_host_key' })
    ])
    expect(noKeys.host.count(CALLER)).toBe(0)
  })

  it('asks again after the far end is reached: a block that comes while it is being opened ends the open', async () => {
    const t = await bed()
    t.refusal.after = (calls) => (calls >= 2 ? 'blocked' : undefined)
    expect((await rejection(t.open())).reason).toBe('blocked')
    await until(() => t.echo.sockets.size === 0, 'the far end to be closed')
    expect(t.host.count(CALLER)).toBe(0)
    expect(
      t.hostAudit.rows.some((row) => row.method === 'editor.open' && row.kind === 'change')
    ).toBe(false)
  })

  it('says so when the other computer cannot carry tunnels, or is gone, or the caller already cancelled', async () => {
    const t = await bed()
    t.toHost.supported = false
    expect((await rejection(t.open())).reason).toBe('unsupported')
    t.toHost.supported = true
    const controller = new AbortController()
    controller.abort()
    expect((await rejection(t.caller.open(t.toHost, controller.signal))).reason).toBe('cancelled')
    t.toHost.cut()
    expect((await rejection(t.open())).reason).toBe('offline')
    expect(t.echo.connections).toBe(0)
  })

  it('tells the other computer to forget an open that was cancelled while it had not answered', async () => {
    const t = await bed()
    // The host never hears of the open: the session swallows it.
    t.toHost.sendTunnel = (message) => {
      t.toHost.sent.push(message)
      return Promise.resolve()
    }
    const controller = new AbortController()
    const pending = rejection(t.caller.open(t.toHost, controller.signal))
    await tick()
    controller.abort()
    expect((await pending).reason).toBe('cancelled')
    expect(t.toHost.sent.at(-1)).toMatchObject({ t: 'tunnel.close', reason: 'closed' })
  })
})

describe('limits', () => {
  it('allows four tunnels per device, refuses the fifth with `limit`, and frees the slot when one closes', async () => {
    expect(EDITOR_TUNNELS_PER_NODE).toBe(4)
    const t = await bed()
    const open: ClientTunnel[] = []
    for (let index = 0; index < 4; index++) open.push(await t.open())
    expect(t.host.count(CALLER)).toBe(4)
    expect((await rejection(t.open())).reason).toBe('limit')
    expect(t.hostAudit.rows.filter((row) => row.kind === 'refused')).toEqual([
      expect.objectContaining({ method: 'editor.open', outcome: 'limit' })
    ])
    open[0]!.close()
    await until(() => t.host.count(CALLER) === 3, 'a slot to be free')
    const again = await t.open()
    expect(again.hostKeys).toEqual([KEY_A])
    expect(t.host.count(CALLER)).toBe(4)
  })

  it('counts a device’s tunnels apart from another device’s', async () => {
    const t = await bed()
    const second = newId('node')
    const secondCaller = new EditorTunnels({ ...base(), perNode: 50 })
    const toHost = new FakeLink(() => secondCaller, HOST)
    const toCaller = new FakeLink(() => t.host, second)
    toHost.other = toCaller
    toCaller.other = toHost
    cleanup.push(() => secondCaller.endAll('closed'))
    for (let index = 0; index < 4; index++) await t.open()
    expect((await rejection(t.open())).reason).toBe('limit')
    // The other device has all of its own four.
    const mine: ClientTunnel[] = []
    for (let index = 0; index < 4; index++) mine.push(await secondCaller.open(toHost))
    expect(t.host.count(CALLER)).toBe(4)
    expect(t.host.count(second)).toBe(4)
    expect((await rejection(secondCaller.open(toHost))).reason).toBe('limit')
  })

  it('also keeps a ceiling on all devices together', async () => {
    const t = await bed({ host: { perNode: 4, total: 5 } })
    const second = newId('node')
    const secondCaller = new EditorTunnels({ ...base(), perNode: 50 })
    const toHost = new FakeLink(() => secondCaller, HOST)
    const toCaller = new FakeLink(() => t.host, second)
    toHost.other = toCaller
    toCaller.other = toHost
    cleanup.push(() => secondCaller.endAll('closed'))
    for (let index = 0; index < 4; index++) await t.open()
    await secondCaller.open(toHost)
    expect((await rejection(secondCaller.open(toHost))).reason).toBe('limit')
  })

  it('limits the caller’s own tunnels to one computer, without asking it', async () => {
    const t = await bed({ caller: { perNode: 2 } })
    await t.open()
    await t.open()
    const before = t.toHost.sent.length
    expect((await rejection(t.open())).reason).toBe('limit')
    expect(t.toHost.sent.length).toBe(before)
  })

  it('refuses opens made faster than the rate, and takes them again a minute later', async () => {
    const t = await bed({ host: { opensPerMinute: 3, perNode: 20 } })
    for (let index = 0; index < 3; index++) await t.open()
    expect((await rejection(t.open())).reason).toBe('rate_limited')
    // Nothing is written for it: refusing must stay cheap.
    expect(t.hostAudit.rows.filter((row) => row.kind === 'refused')).toEqual([])
    t.clock.setWallTime(t.clock.now() + 61_000)
    await t.open()
  })
})

describe('what ends a tunnel at once', () => {
  async function liveTunnel(options: Parameters<typeof bed>[0] = {}) {
    const t = await bed(options)
    const tunnel = await t.open()
    const echoed = readAll(tunnel.stream, 4)
    tunnel.stream.write('ping')
    await echoed
    return { t, tunnel }
  }

  it.each([
    ['blocked', 'blocked'],
    ['editor_off', 'editor_off'],
    ['setting_off', 'setting_off'],
    ['net_off', 'net_off'],
    ['capability', 'access_lost']
  ] as const)('ends every tunnel of the device when the rules say %s', async (reason, ended) => {
    const t = await bed()
    const tunnels = await Promise.all([t.open(), t.open(), t.open()])
    expect(t.echo.sockets.size).toBe(3)
    t.refusal.current = reason
    expect(t.host.reconcile()).toBe(3)
    // The far end is closed, the host has none left and the caller is told why.
    await until(() => t.echo.sockets.size === 0, 'the far ends to close')
    expect(t.host.count(CALLER)).toBe(0)
    expect(await Promise.all(tunnels.map((tunnel) => tunnel.closed))).toEqual([ended, ended, ended])
    for (const tunnel of tunnels) expect(tunnel.stream.destroyed).toBe(true)
    const closes = t.hostAudit.rows.filter((row) => row.method === 'editor.close')
    expect(closes).toHaveLength(3)
    for (const row of closes) expect(row.outcome.startsWith(`${ended}; direct; `)).toBe(true)
    // A tunnel that was not affected stays: nothing to reconcile now.
    t.refusal.current = undefined
    expect(t.host.reconcile()).toBe(0)
  })

  it('leaves tunnels alone while the rules still allow them', async () => {
    const { t, tunnel } = await liveTunnel()
    expect(t.host.reconcile()).toBe(0)
    expect(t.host.count(CALLER)).toBe(1)
    expect(tunnel.stream.destroyed).toBe(false)
  })

  it('ends a tunnel when its session is lost, and nothing is left open on the far end', async () => {
    const { t, tunnel } = await liveTunnel()
    t.toHost.cut()
    await until(() => t.echo.sockets.size === 0, 'the far end to close')
    expect(await tunnel.closed).toBe('offline')
    expect(t.host.count(CALLER)).toBe(0)
    expect(t.caller.list()).toEqual([])
    expect(t.hostAudit.rows.at(-1)!.outcome.startsWith('session_closed; direct; ')).toBe(true)
  })

  it('ends the tunnels it carries and the ones it opened when Net is turned off, and writes each end to the audit', async () => {
    const { t, tunnel } = await liveTunnel()
    expect(t.host.endAll('net_off')).toBe(1)
    expect(await tunnel.closed).toBe('net_off')
    await until(() => t.echo.sockets.size === 0, 'the far end to close')
    expect(t.hostAudit.rows.at(-1)!.outcome.startsWith('net_off; ')).toBe(true)
    expect(t.host.list()).toEqual([])
    // The same call ends a tunnel this computer opened itself, with the other computer told.
    expect(t.caller.list()).toEqual([])
    const mine = await t.open()
    expect(t.caller.endAll('net_off')).toBe(1)
    expect(await mine.closed).toBe('net_off')
    await until(() => t.host.list().length === 0, 'the other computer to let go')
    expect(t.hostAudit.rows.at(-1)!.outcome.startsWith('closed; ')).toBe(true)
  })

  it('ends when the caller closes its stream', async () => {
    const { t, tunnel } = await liveTunnel()
    tunnel.stream.destroy()
    await until(() => t.echo.sockets.size === 0, 'the far end to close')
    expect(await tunnel.closed).toBe('closed')
    expect(t.host.count(CALLER)).toBe(0)
  })

  it('ends with `far_end_error` when the SSH server drops the connection before the tunnel took it over', async () => {
    // The server closes at once, while the host is still reading the host keys: no unhandled error, and no tunnel left open.
    const echo = await echoServer((socket) => socket.resetAndDestroy())
    const t = await bed({ echo })
    const outcome = await t.open().then(
      async (tunnel) => await tunnel.closed,
      (error: TunnelError) => error.reason
    )
    expect(['far_end_error', 'closed']).toContain(outcome)
    await until(() => t.host.count(CALLER) === 0, 'the host to let the tunnel go')
    expect(t.host.list()).toEqual([])
  })

  it('ends with `far_end_error` when the SSH server resets the connection', async () => {
    const echo = await echoServer((socket) => {
      socket.on('data', () => socket.resetAndDestroy())
    })
    const t = await bed({ echo })
    const tunnel = await t.open()
    tunnel.stream.write('x')
    expect(await tunnel.closed).toBe('far_end_error')
    expect(t.hostAudit.rows.at(-1)!.outcome.startsWith('far_end_error; ')).toBe(true)
  })

  it('still ends, and is audited, when the session throws instead of sending (it is closing or revoked)', async () => {
    const { t, tunnel } = await liveTunnel()
    const throwing = (): never => {
      throw new NetError('revoked')
    }
    t.toCaller.sendTunnel = throwing
    t.refusal.current = 'capability'
    expect(t.host.reconcile()).toBe(1)
    await until(() => t.echo.sockets.size === 0, 'the far end to close')
    expect(t.hostAudit.rows.at(-1)!.outcome.startsWith('access_lost; direct; ')).toBe(true)
    expect(t.host.count(CALLER)).toBe(0)
    void tunnel
  })

  it('treats a check that fails as a no, and ends the tunnel', async () => {
    const t = await bed({
      host: {
        refusal: () => {
          throw new Error('roster unreadable')
        }
      }
    })
    expect((await rejection(t.open())).reason).toBe('capability')
    expect(t.echo.connections).toBe(0)

    // A check that starts failing after the tunnel opened ends it.
    let calls = 0
    const later = await bed({
      host: {
        refusal: () => {
          if (++calls > 2) throw new Error('roster unreadable')
          return undefined
        }
      }
    })
    const tunnel = await later.open()
    expect(later.host.reconcile()).toBe(1)
    expect(await tunnel.closed).toBe('access_lost')
  })

  it('does not let one session touch the tunnels of another', async () => {
    const t = await bed()
    const tunnel = await t.open()
    const id = (t.toHost.sent.find((message) => message.t === 'tunnel.open') as { tunnel: string })
      .tunnel
    // Another device, on a link of its own, names this tunnel's id.
    const intruder = new FakeLink(() => t.host, newId('node'))
    t.host.receive(intruder, { t: 'tunnel.close', tunnel: id, reason: 'closed' }, undefined)
    t.host.receive(
      intruder,
      { t: 'tunnel.data', tunnel: id, end: true, parts: [0] },
      new Uint8Array(0)
    )
    t.host.receive(intruder, { t: 'tunnel.credit', tunnel: id, bytes: 100 }, undefined)
    await settle(20)
    expect(t.host.count(CALLER)).toBe(1)
    const echoed = readAll(tunnel.stream, 2)
    tunnel.stream.write('ok')
    expect((await echoed).toString()).toBe('ok')
  })

  it('ends a tunnel whose other side sends more than it was given credit for, or credit it never earned', async () => {
    const t = await bed()
    const tunnel = await t.open()
    const id = (t.toHost.sent.find((message) => message.t === 'tunnel.open') as { tunnel: string })
      .tunnel
    const piece = new Uint8Array(TUNNEL_CHUNK_BYTES)
    // Nine pieces are more than the window of eight, and none of them was credited back.
    for (let index = 0; index < 9; index++)
      t.host.receive(t.toCaller, { t: 'tunnel.data', tunnel: id, parts: [piece.length] }, piece)
    expect(await tunnel.closed).toBe('protocol')
    await until(() => t.echo.sockets.size === 0, 'the far end to close')
    expect(t.hostAudit.rows.at(-1)!.outcome.startsWith('protocol; ')).toBe(true)

    const second = await t.open()
    const secondId = (
      t.toHost.sent.filter((message) => message.t === 'tunnel.open').at(-1) as { tunnel: string }
    ).tunnel
    // Credit for bytes the host never sent.
    t.caller.receive(t.toHost, { t: 'tunnel.credit', tunnel: secondId, bytes: 10 }, undefined)
    expect(await second.closed).toBe('protocol')
  })
})

describe('what the owner can see afterwards', () => {
  it('writes a row for each open and each end, with the path and the bytes each way', async () => {
    const t = await bed({ transport: 'plus-relay' })
    const tunnel = await t.open()
    expect(tunnel.path).toBe('relay')
    expect(tunnel.transport).toBe('plus-relay')
    const out = randomBytes(70_000)
    const back = readAll(tunnel.stream, out.length)
    tunnel.stream.write(out)
    await back
    tunnel.close()
    await until(() => t.host.list().length === 0, 'the tunnel to end')
    const rows = t.hostAudit.rows
    expect(rows[0]).toEqual({
      node: CALLER,
      method: 'editor.open',
      outcome: 'relay; plus-relay',
      kind: 'change'
    })
    expect(rows[1]).toMatchObject({ node: CALLER, method: 'editor.close', kind: 'change' })
    expect(rows[1]!.outcome).toMatch(/^closed; relay; in 70000 B; out 70000 B; \d+ s$/u)
    for (const row of rows) expect(row.outcome.length).toBeLessThanOrEqual(96)
    // What the far end sent counts as read, as terminal output does.
    expect(t.hostAudit.reads).toEqual([[CALLER, 70_000]])
  })

  it('labels the path of a direct route as direct, whatever the transport', async () => {
    for (const transport of ['direct', 'tailscale', 'cloudflared', 'ssh']) {
      const t = await bed({ transport })
      const tunnel = await t.open()
      expect(tunnel.path).toBe('direct')
      expect(t.hostAudit.rows[0]!.outcome).toBe(`direct; ${transport}`)
      tunnel.close()
    }
  })

  it('tells the owner of the first tunnel a device opens, once', async () => {
    const t = await bed()
    const first = await t.open()
    expect(t.firstOpens).toEqual([CALLER])
    first.close()
    await until(() => t.host.list().length === 0, 'the tunnel to end')
    await t.open()
    expect(t.firstOpens).toEqual([CALLER])
    expect(
      t.hostAudit.rows.filter((row) => row.method === 'editor.open' && row.kind === 'change')
    ).toHaveLength(2)
  })

  it('does not let a notice that fails stop the tunnel', async () => {
    const t = await bed({
      host: {
        onFirstOpen: () => {
          throw new Error('no windows')
        }
      }
    })
    const tunnel = await t.open()
    const echoed = readAll(tunnel.stream, 1)
    tunnel.stream.write('x')
    expect((await echoed).toString()).toBe('x')
  })
})
