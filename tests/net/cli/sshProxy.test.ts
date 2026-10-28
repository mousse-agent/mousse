import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { duplexPair, PassThrough } from 'node:stream'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isSshProxyArgv,
  localEndpoint,
  parseSshProxyArgv,
  readDaemon,
  runSshProxy,
  type SshProxyIo
} from '../../../src/cli/fastpath/sshProxy'
import { readOwnerRecord } from '../../../src/mms/ownership/MmsOwnerLease'
import {
  resolveLocalEndpoint,
  unixSocketPath,
  windowsNamedPipePath
} from '../../../src/mms/protocol/endpoint'
import { FrameDecoder, encodeFrame } from '../../../src/mms/protocol/framing'
import { MMS_PROTOCOL_VERSION } from '../../../src/mms/protocol/types'
import { LocalEditorTunnels } from '../../../src/mms/net/editor/localTunnels'
import {
  EditorSshConfig,
  EditorSshError,
  findSshClients,
  proxyCommand
} from '../../../src/mms/net/editor/sshConfig'
import { TunnelError, type ClientTunnel } from '../../../src/mms/net/editor/tunnel'
import { NetError, newId, type NodeId } from '../../../src/shared/net'
import {
  EDITOR_TUNNEL_LOCAL_CHUNK_BYTES,
  SSH_PROXY_EXIT,
  proxyMessage
} from '../../../src/shared/net/editorProxy'
import { TUNNEL_REFUSALS, type TunnelFailure } from '../../../src/shared/net/tunnel'

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function until(check: () => boolean, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const NODE = newId('node')
const TOKEN = 'test-owner-token-0123456789'

/** The other end of an in-memory tunnel: what the owner's SSH server would be. */
interface FarEnd {
  /** What the proxy's side wrote into the tunnel. */
  received: Buffer[]
  write(bytes: Buffer | string): void
  /** The tunnel ends from the other computer's side, with a reason. */
  end(reason?: TunnelFailure): void
  stream: NodeJS.ReadWriteStream
  closedByCaller(): boolean
  /** The proxy's side ended its write side (a half-close), as the far end sees it. */
  onWriteEnd(callback: () => void): void
}

function memoryTunnel(options: { echo?: boolean } = {}): { tunnel: ClientTunnel; far: FarEnd } {
  const [user, local] = duplexPair()
  let settle!: (reason: TunnelFailure) => void
  const closed = new Promise<TunnelFailure>((resolve) => (settle = resolve))
  let caller = false
  const received: Buffer[] = []
  local.on('data', (chunk: Buffer) => {
    received.push(chunk)
    if (options.echo) local.write(chunk)
  })
  local.on('error', () => {})
  user.on('error', () => {})
  const endListeners: Array<() => void> = []
  local.on('end', () => endListeners.forEach((callback) => callback()))
  const finish = (reason: TunnelFailure): void => {
    settle(reason)
    local.end()
  }
  return {
    tunnel: {
      stream: user,
      hostKeys: [],
      path: 'direct',
      closed,
      close: () => {
        caller = true
        finish('closed')
        user.destroy()
      }
    },
    far: {
      received,
      write: (bytes) => local.write(bytes),
      end: (reason = 'closed') => finish(reason),
      stream: local,
      closedByCaller: () => caller,
      onWriteEnd: (callback) => endListeners.push(callback)
    }
  }
}

interface Daemon {
  home: string
  endpoint: string
  requests: Array<{ method: string; params: unknown }>
  tunnels: LocalEditorTunnels
  connections: Set<Socket>
  /** Drops every connection, as a daemon that stopped would. */
  stop(): void
}

/**
 * A daemon of this computer on a socket of its own: it speaks the local protocol (hello, `profiles.bind`) and
 * serves the four tunnel methods from the real `LocalEditorTunnels`, whose tunnels are in memory. Nothing here
 * reaches a real host or the real Mousse home.
 */
async function fakeDaemon(
  options: {
    open?: (node: NodeId) => Promise<{ tunnel: ClientTunnel; far?: FarEnd }>
    profiles?: string[]
    helloError?: string
    methodsMissing?: boolean
    computer?: string | undefined
    /** False: the daemon's home has no space in its path (see the Git for Windows test). */
    spaces?: boolean
  } = {}
): Promise<Daemon> {
  const root = await mkdtemp(
    join(tmpdir(), options.spaces === false ? 'mousse-proxy-' : 'mousse proxy ')
  )
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\mousse-proxy-test-${randomBytes(6).toString('hex')}`
      : join(root, 'm.sock')
  const requests: Daemon['requests'] = []
  const tunnels = new LocalEditorTunnels(
    {
      open: async (node) => {
        const opened = await (options.open ?? (async () => memoryTunnel({ echo: true })))(node)
        return { tunnel: opened.tunnel, info: { path: 'direct', hostKey: 'unpinned' } }
      },
      computerName: () => ('computer' in options ? options.computer : 'Computer B')
    },
    { readWaitMs: 400 }
  )
  cleanup.push(() => tunnels.closeAll())
  const connections = new Set<Socket>()
  let counter = 0
  const server: Server = createServer((socket) => {
    const id = `c${++counter}`
    connections.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => {
      connections.delete(socket)
      tunnels.closeConnection(id)
    })
    const decoder = new FrameDecoder()
    let bound = false
    let granted: string[] = []
    const send = (value: unknown): void => {
      if (!socket.destroyed) socket.write(encodeFrame(value))
    }
    socket.on('data', (chunk: Buffer) => {
      decoder.push(chunk)
      for (const frame of decoder.shiftAll() as Array<Record<string, unknown>>) {
        if (frame.kind === 'hello') {
          if (options.helloError)
            return send({ kind: 'hello_err', code: options.helloError, message: 'no' })
          if (frame.ownerToken !== TOKEN)
            return send({ kind: 'hello_err', code: 'unauthorized', message: 'no' })
          // Like the real daemon: a capability is granted only when the hello asked for it.
          granted = ((frame.requestedCapabilities ?? []) as string[]).filter((name) =>
            ['net.v1', 'profiles-v1'].includes(name)
          )
          send({
            kind: 'hello_ok',
            protocolVersion: MMS_PROTOCOL_VERSION,
            instanceId: 'test',
            capabilities: granted,
            globalSequence: 0
          })
          continue
        }
        if (frame.kind !== 'req') continue
        const method = String(frame.method)
        const params = (frame.params ?? {}) as Record<string, unknown>
        requests.push({ method, params })
        const reply = (result: unknown): void =>
          send({ kind: 'res', id: frame.id, ok: true, result })
        const fail = (code: string): void =>
          send({ kind: 'res', id: frame.id, ok: false, error: { code, message: code } })
        void (async () => {
          try {
            if (method === 'profiles.bind') {
              if (!granted.includes('profiles-v1')) return fail('capability_required')
              if (!(options.profiles ?? ['default']).includes(String(params.profile)))
                return fail('profile_not_found')
              bound = true
              return reply({ profileId: params.profile })
            }
            if (!bound) return fail('profile_binding_required')
            if (!granted.includes('net.v1')) return fail('capability_required')
            if (options.methodsMissing) return fail('method_not_available')
            const connection = { id }
            switch (method) {
              case 'net.editor.tunnel.open':
                return reply(await tunnels.open(connection, params.node as NodeId))
              case 'net.editor.tunnel.read':
                return reply(await tunnels.read(id, String(params.tunnel), Number(params.waitMs)))
              case 'net.editor.tunnel.write':
                return reply(
                  await tunnels.write(
                    id,
                    String(params.tunnel),
                    Buffer.from(String(params.data), 'base64')
                  )
                )
              case 'net.editor.tunnel.end':
                return reply(await tunnels.end(id, String(params.tunnel)))
              case 'net.editor.tunnel.close':
                tunnels.close(id, String(params.tunnel))
                return reply({ ok: true })
              default:
                return fail('method_not_available')
            }
          } catch (error) {
            fail(error instanceof NetError ? error.code : 'internal')
          }
        })()
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(endpoint, resolve))
  const stop = (): void => {
    for (const socket of connections) socket.destroy()
  }
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        stop()
        server.close(() => resolve())
      })
  )
  await writeFile(
    join(home, 'mms.owner.json'),
    JSON.stringify({
      pid: process.pid,
      processInstanceId: 'test',
      token: TOKEN,
      home,
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      kind: 'daemon',
      protocolVersion: 1,
      endpoint
    })
  )
  return { home, endpoint, requests, tunnels, connections, stop }
}

/** What `ssh` is to the proxy: a pipe in, a pipe out, and a place for its words. */
function wire(home: string) {
  const stdin = new PassThrough()
  const out: Buffer[] = []
  const err: string[] = []
  const io: SshProxyIo = {
    stdin,
    stdout: {
      write(chunk, callback) {
        out.push(Buffer.from(chunk))
        callback()
        return true
      }
    },
    stderr: {
      write(text, callback) {
        err.push(text)
        callback?.()
        return true
      }
    },
    env: {},
    platform: process.platform,
    home: () => home
  }
  return { stdin, io, stdout: () => Buffer.concat(out), stderr: () => err.join('') }
}

const argv = (node: string = NODE, profile = 'default') => [
  'net',
  'ssh-proxy',
  node,
  '--profile',
  profile
]

describe('the command line', () => {
  it('is `net ssh-proxy <node> --profile <id>`, the form the ProxyCommand in Mousse’s config has', () => {
    expect(isSshProxyArgv(argv())).toBe(true)
    expect(isSshProxyArgv(['net', 'status'])).toBe(false)
    expect(parseSshProxyArgv(argv(NODE, 'work-2'))).toEqual({ node: NODE, profile: 'work-2' })
    expect(parseSshProxyArgv([...argv(), '--home', '/h/.mousse'])).toEqual({
      node: NODE,
      profile: 'default',
      home: '/h/.mousse'
    })
    expect(parseSshProxyArgv(['net', 'ssh-proxy', '--profile=p1', NODE])).toEqual({
      node: NODE,
      profile: 'p1'
    })
  })

  it('refuses anything else', () => {
    for (const bad of [
      ['net', 'ssh-proxy'],
      ['net', 'ssh-proxy', NODE],
      ['net', 'ssh-proxy', '--profile', 'default'],
      ['net', 'ssh-proxy', 'not-a-node', '--profile', 'default'],
      ['net', 'ssh-proxy', NODE, '--profile'],
      ['net', 'ssh-proxy', NODE, '--profile', '-x'],
      ['net', 'ssh-proxy', NODE, '--profile', 'a b'],
      ['net', 'ssh-proxy', NODE, '--profile', 'a', '--profile', 'b'],
      ['net', 'ssh-proxy', NODE, '--profile', 'a', '--json'],
      ['net', 'ssh-proxy', NODE, newId('node'), '--profile', 'a'],
      ['net', 'status']
    ])
      expect(parseSshProxyArgv(bad), bad.join(' ')).toBeUndefined()
  })

  it('prints the usage and exits 2 for a bad command line, before it touches anything', async () => {
    const { io, stdout, stderr } = wire(join(tmpdir(), 'nowhere'))
    expect(await runSshProxy(['net', 'ssh-proxy', 'x'], io)).toBe(SSH_PROXY_EXIT.usage)
    expect(stdout().length).toBe(0)
    expect(stderr()).toBe('Mousse: Usage: mousse-cli net ssh-proxy <node-id> --profile <profile>\n')
  })
})

describe('finding the daemon', () => {
  it('uses the same endpoint and owner file as the daemon does', async () => {
    const d = await fakeDaemon()
    expect(localEndpoint(d.home, 'win32')).toBe(windowsNamedPipePath(d.home))
    expect(localEndpoint(d.home, 'linux')).toBe(unixSocketPath(d.home))
    expect(localEndpoint(d.home, 'darwin')).toBe(unixSocketPath(d.home))
    expect(localEndpoint(d.home, process.platform)).toBe(resolveLocalEndpoint(d.home).path)
    expect(readDaemon(d.home, process.platform)).toEqual({ token: TOKEN, endpoint: d.endpoint })
    expect(readOwnerRecord(d.home)?.token).toBe(TOKEN)
  })

  it('falls back to the endpoint worked out from the home when the owner file names none', async () => {
    const d = await fakeDaemon()
    const path = join(d.home, 'mms.owner.json')
    const record = JSON.parse(readFileSync(path, 'utf8'))
    delete record.endpoint
    await writeFile(path, JSON.stringify(record))
    expect(readDaemon(d.home, process.platform)).toEqual({
      token: TOKEN,
      endpoint: resolveLocalEndpoint(d.home).path
    })
  })

  it('says Mousse is not running when there is no owner file, and when nothing listens', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'mousse proxy empty '))
    cleanup.push(() => rm(empty, { recursive: true, force: true }))
    const a = wire(empty)
    expect(await runSshProxy(argv(), a.io)).toBe(SSH_PROXY_EXIT.refused)
    expect(a.stderr()).toBe(`${proxyMessage('not_running')}\n`)
    expect(a.stdout().length).toBe(0)

    const d = await fakeDaemon()
    d.stop()
    const record = JSON.parse(readFileSync(join(d.home, 'mms.owner.json'), 'utf8'))
    await writeFile(
      join(d.home, 'mms.owner.json'),
      JSON.stringify({ ...record, endpoint: `${d.endpoint}-gone` })
    )
    const b = wire(d.home)
    expect(await runSshProxy(argv(), b.io)).toBe(SSH_PROXY_EXIT.refused)
    expect(b.stderr()).toBe(`${proxyMessage('not_running')}\n`)
  })
})

describe('carrying the editor’s ssh', () => {
  it('pipes stdin and stdout through the tunnel, raw: every byte value, in order, more than one piece', async () => {
    const d = await fakeDaemon()
    const t = wire(d.home)
    const bytes = Buffer.concat([
      Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
      randomBytes(EDITOR_TUNNEL_LOCAL_CHUNK_BYTES * 5 + 123),
      // What would break a text channel: line endings, a ^Z, NULs, and a byte order mark.
      Buffer.from('\r\n\r\n\x1a\x00\x00\xEF\xBB\xBF\n')
    ])
    const run = runSshProxy(argv(), t.io)
    // ssh writes in pieces of its own size, not ours.
    for (let at = 0; at < bytes.length; at += 7001) t.stdin.write(bytes.subarray(at, at + 7001))
    await until(() => t.stdout().length >= bytes.length, 'the echoed bytes')
    t.stdin.end()
    expect(await run).toBe(SSH_PROXY_EXIT.ok)
    expect(t.stdout().equals(bytes)).toBe(true)
    // Nothing but the tunnel's bytes on stdout, and no word on stderr for an ordinary end.
    expect(t.stderr()).toBe('')
  })

  it('carries the other computer’s bytes to stdout before anything was written to it', async () => {
    const opened = memoryTunnel()
    const d = await fakeDaemon({ open: async () => opened })
    const t = wire(d.home)
    const run = runSshProxy(argv(), t.io)
    await until(() => d.tunnels.count() === 1, 'the tunnel')
    opened.far.write('SSH-2.0-OpenSSH_9.6\r\n')
    await until(() => t.stdout().length > 0, 'the banner')
    expect(t.stdout().toString('latin1')).toBe('SSH-2.0-OpenSSH_9.6\r\n')
    t.stdin.write(Buffer.from('SSH-2.0-client\r\n'))
    await until(() => Buffer.concat(opened.far.received).length > 0, 'the client banner')
    expect(Buffer.concat(opened.far.received).toString()).toBe('SSH-2.0-client\r\n')
    t.stdin.end()
    expect(await run).toBe(0)
  })

  it('asks for the computer in the command line and binds the profile in the command line', async () => {
    const d = await fakeDaemon({ profiles: ['default', 'work.2'] })
    const t = wire(d.home)
    const run = runSshProxy(argv(NODE, 'work.2'), t.io)
    await until(() => d.tunnels.count() === 1, 'the tunnel')
    t.stdin.end()
    await run
    expect(d.requests.slice(0, 2)).toEqual([
      { method: 'profiles.bind', params: { profile: 'work.2' } },
      { method: 'net.editor.tunnel.open', params: { node: NODE } }
    ])
    // The proxy never says a host or a port: the other computer chooses its far end.
    expect(JSON.stringify(d.requests)).not.toMatch(/"(host|port|address)"/u)
  })

  it('names a profile that does not exist, and exits 1', async () => {
    const d = await fakeDaemon({ profiles: ['default'] })
    const t = wire(d.home)
    expect(await runSshProxy(argv(NODE, 'nope'), t.io)).toBe(SSH_PROXY_EXIT.refused)
    expect(t.stderr()).toBe(`${proxyMessage('profile')}\n`)
    expect(t.stdout().length).toBe(0)
    expect(d.tunnels.count()).toBe(0)
  })

  it('ends with exit 0 when the other computer’s SSH server closes the connection', async () => {
    const opened = memoryTunnel()
    const d = await fakeDaemon({ open: async () => opened })
    const t = wire(d.home)
    const run = runSshProxy(argv(), t.io)
    await until(() => d.tunnels.count() === 1, 'the tunnel')
    opened.far.write('bye')
    opened.far.end('closed')
    expect(await run).toBe(SSH_PROXY_EXIT.ok)
    // What it sent before it closed still arrives.
    expect(t.stdout().toString()).toBe('bye')
    expect(t.stderr()).toBe('')
  })

  it('ends with exit 0 and lets the tunnel go when ssh closes its end', async () => {
    const opened = memoryTunnel()
    const d = await fakeDaemon({ open: async () => opened })
    const t = wire(d.home)
    const run = runSshProxy(argv(), t.io)
    await until(() => d.tunnels.count() === 1, 'the tunnel')
    t.stdin.write('last bytes')
    t.stdin.end()
    expect(await run).toBe(0)
    // What was written before the end reached the far end, and the tunnel was closed.
    expect(Buffer.concat(opened.far.received).toString()).toBe('last bytes')
    expect(opened.far.closedByCaller()).toBe(true)
    await until(() => d.tunnels.count() === 0, 'the tunnel to be let go')
  })

  it('says why a tunnel that ends with a refusal ended, and exits 1', async () => {
    for (const reason of [
      'blocked',
      'editor_off',
      'access_lost',
      'net_off',
      'far_end_error'
    ] as const) {
      const opened = memoryTunnel()
      const d = await fakeDaemon({ open: async () => opened })
      const t = wire(d.home)
      const run = runSshProxy(argv(), t.io)
      await until(() => d.tunnels.count() === 1, 'the tunnel')
      opened.far.end(reason)
      expect(await run, reason).toBe(SSH_PROXY_EXIT.refused)
      expect(t.stderr()).toBe(`${proxyMessage(reason, 'Computer B')}\n`)
      expect(t.stdout().length).toBe(0)
    }
  })

  it('exits 1 with a plain line when the daemon stops while a tunnel is open', async () => {
    const d = await fakeDaemon()
    const t = wire(d.home)
    const run = runSshProxy(argv(), t.io)
    await until(() => d.tunnels.count() === 1, 'the tunnel')
    d.stop()
    expect(await run).toBe(SSH_PROXY_EXIT.refused)
    expect(t.stderr()).toBe(`${proxyMessage('daemon_lost')}\n`)
    expect(t.stdout().length).toBe(0)
  })

  it('does not hold the daemon’s tunnel when its own stdin is destroyed or the daemon ends the connection', async () => {
    const d = await fakeDaemon()
    const t = wire(d.home)
    const run = runSshProxy(argv(), t.io)
    await until(() => d.tunnels.count() === 1, 'the tunnel')
    t.stdin.destroy()
    expect(await run).toBe(0)
    await until(() => d.tunnels.count() === 0, 'the tunnel to be let go')
  })
})

describe('what it says when it cannot carry the connection', () => {
  const failing = (error: Error) => async () => {
    throw error
  }

  it('words each refusal of the other computer on stderr, in one line, with nothing on stdout', async () => {
    const cases: Array<[Error, string]> = [
      ...(TUNNEL_REFUSALS as readonly string[]).map((reason): [Error, string] => [
        new TunnelError(reason as never),
        reason
      ]),
      [new TunnelError('offline'), 'offline'],
      [new TunnelError('timeout'), 'timeout'],
      [new TunnelError('unsupported'), 'unsupported'],
      [new EditorSshError('unknown_computer', 'x'), 'unknown_computer'],
      [new EditorSshError('unwritable', 'x'), 'ssh_settings'],
      [new NetError('disabled'), 'net_disabled'],
      [new Error('boom'), 'failed']
    ]
    for (const [error, reason] of cases) {
      const d = await fakeDaemon({ open: failing(error) })
      const t = wire(d.home)
      expect(await runSshProxy(argv(), t.io), reason).toBe(SSH_PROXY_EXIT.refused)
      expect(t.stderr(), reason).toBe(`${proxyMessage(reason as never, 'Computer B')}\n`)
      expect(t.stderr().trimEnd().split('\n'), reason).toHaveLength(1)
      expect(t.stdout().length, reason).toBe(0)
      expect(d.tunnels.count()).toBe(0)
    }
  })

  it('uses the words the Remote - SSH output will show', async () => {
    const words = async (error: Error, ...nameless: [] | [true]) => {
      const d = await fakeDaemon({
        open: failing(error),
        ...(nameless.length ? { computer: undefined } : {})
      })
      const t = wire(d.home)
      await runSshProxy(argv(), t.io)
      return t.stderr()
    }
    expect(await words(new TunnelError('offline'))).toBe('Mousse: Computer B is offline.\n')
    expect(await words(new TunnelError('editor_off'))).toBe(
      'Mousse: Editor connections are off for this computer on Computer B.\n'
    )
    expect(await words(new TunnelError('no_ssh_server'))).toBe(
      'Mousse: Computer B has no SSH server.\n'
    )
    // A computer whose name is not known still gets a sentence.
    expect(await words(new TunnelError('offline'), true)).toBe(
      'Mousse: The other computer is offline.\n'
    )
  })

  it('never prints a name that could add lines or escape codes to the log', () => {
    const line = proxyMessage(
      'offline',
      ['Bob\r\n', '\x1b[31mfake\x00', String.fromCharCode(0x2028), 'second'].join('')
    )
    expect(line).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/u)
    expect(line).not.toContain(String.fromCharCode(0x2028))
    expect(proxyMessage('offline', 'x'.repeat(500)).length).toBeLessThan(120)
  })

  it('tells a person to restart Mousse when its running daemon is older or speaks another version', async () => {
    const old = await fakeDaemon({ methodsMissing: true })
    const a = wire(old.home)
    expect(await runSshProxy(argv(), a.io)).toBe(SSH_PROXY_EXIT.refused)
    expect(a.stderr()).toBe(`${proxyMessage('daemon_old')}\n`)

    const other = await fakeDaemon({ helloError: 'protocol_version' })
    const b = wire(other.home)
    expect(await runSshProxy(argv(), b.io)).toBe(SSH_PROXY_EXIT.refused)
    expect(b.stderr()).toBe(`${proxyMessage('daemon_version')}\n`)
    expect(a.stdout().length + b.stdout().length).toBe(0)
  })

  it('is the same sentence in the shared words and in the proxy, for every reason', () => {
    for (const reason of [
      ...TUNNEL_REFUSALS,
      'offline',
      'timeout',
      'unsupported',
      'far_end_error'
    ] as const) {
      const text = proxyMessage(reason, 'Computer B')
      expect(text.startsWith('Mousse')).toBe(true)
      expect(text.endsWith('.')).toBe(true)
      expect(text).not.toContain('\n')
      if (reason !== 'rate_limited') expect(text).toContain('Computer B')
    }
  })
})

describe('stdout', () => {
  it('is written only with the tunnel’s bytes: the source has no other way to print', () => {
    const source = readFileSync(
      new URL('../../../src/cli/fastpath/sshProxy.ts', import.meta.url),
      'utf8'
    )
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '')
    expect(code).not.toMatch(/console\./u)
    // Only the default `io` of the real process names it.
    expect(code.match(/process\.stdout/gu)).toHaveLength(1)
    // The one write to the output stream carries tunnel bytes (`flushed`), and it is called from one place.
    expect(code.match(/stream\.write\(bytes/gu)).toHaveLength(1)
    expect(code.match(/io\.stdout/gu)).toHaveLength(1)
    // Its own modules print nothing either.
    for (const file of [
      '../../../src/shared/net/editorProxy.ts',
      '../../../src/cli/fastpath/sshProxyMain.ts'
    ]) {
      const text = readFileSync(new URL(file, import.meta.url), 'utf8')
      expect(text).not.toMatch(/console\.|process\.stdout/u)
    }
  })

  it('stays empty through a run that is refused, whatever the reason', async () => {
    const d = await fakeDaemon({ open: async () => Promise.reject(new TunnelError('editor_off')) })
    const t = wire(d.home)
    await runSshProxy(argv(), t.io)
    expect(t.stdout().length).toBe(0)
  })
})

describe('the ProxyCommand Mousse writes', () => {
  it('quotes a Windows program path with spaces, in the form the proxy’s command line parses', () => {
    const line = proxyCommand(
      { program: String.raw`C:\Program Files\Mousse\mousse-cli.cmd` },
      NODE,
      'default',
      'win32'
    )
    expect(line).toBe(
      `"C:/Program Files/Mousse/mousse-cli.cmd" net ssh-proxy ${NODE} --profile default`
    )
    // Whatever the shell makes of it, the arguments the proxy receives are what it expects.
    expect(parseSshProxyArgv(line.split('" ')[1]!.split(' '))).toEqual({
      node: NODE,
      profile: 'default'
    })
    expect(
      proxyCommand(
        { program: String.raw`C:\Users\Jo Doe\AppData\Local\Programs\Mousse\mousse-cli.cmd` },
        NODE,
        'work',
        'win32'
      )
    ).toBe(
      `"C:/Users/Jo Doe/AppData/Local/Programs/Mousse/mousse-cli.cmd" net ssh-proxy ${NODE} --profile work`
    )
  })
})

/**
 * On Windows, with the real resources/cli/mousse-cli.cmd in a folder named like "C:\Program Files & Co": the
 * launcher's own check finds resources\app.asar, sets ELECTRON_RUN_AS_NODE and starts mousse-cli.exe on the
 * proxy script. Node stands in for the exe (it understands the same script) and a folder for the asar. The daemon
 * behind it is the fake above, so no real host and no real Mousse home is ever reached, and the environment given
 * to ssh has no MOUSSE_HOME: the --home in the ProxyCommand is what finds the daemon.
 */
describe.skipIf(process.platform !== 'win32')(
  'the real launcher and ssh on Windows, from a path with spaces and an ampersand',
  () => {
    const clients = process.platform === 'win32' ? findSshClients() : []
    const forward = (path: string): string => path.split(sep).join('/')

    /**
     * `folder` is the install folder's name. Git for Windows' ssh runs the command through its own sh, which does not
     * pass a launcher in a folder with an ampersand to cmd intact; Win32-OpenSSH and cmd do, so only the direct test
     * has one.
     */
    async function bedFor(folder = 'Program Files') {
      const root = await mkdtemp(join(tmpdir(), 'mousse windows proxy '))
      cleanup.push(() => rm(root, { recursive: true, force: true }))
      const app = join(root, folder, 'Mousse app')
      const script = join(app, 'resources', 'app.asar', 'out', 'cli')
      await mkdir(script, { recursive: true })
      await build({
        entryPoints: [
          fileURLToPath(new URL('../../../src/cli/fastpath/sshProxyMain.ts', import.meta.url))
        ],
        outfile: join(script, 'ssh-proxy.js'),
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node20',
        logLevel: 'silent'
      })
      await writeFile(join(script, 'package.json'), '{"type":"module"}')
      await copyFile(process.execPath, join(app, 'mousse-cli.exe'))
      const launcher = join(app, 'mousse-cli.cmd')
      await copyFile(
        fileURLToPath(new URL('../../../resources/cli/mousse-cli.cmd', import.meta.url)),
        launcher
      )
      return { root, launcher }
    }

    /** What ssh runs: the ProxyCommand text, through cmd /d /s /c. */
    function runProxyCommand(command: string, env: NodeJS.ProcessEnv) {
      return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], {
        windowsVerbatimArguments: true,
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    }

    async function configFor(root: string, launcher: string, home: string) {
      const user = join(root, 'home dir')
      await mkdir(user, { recursive: true })
      const editor = new EditorSshConfig({
        home: user,
        mousseHome: home,
        cli: launcher,
        profile: 'default',
        verify: async () => ({ ok: true })
      })
      const prepared = await editor.prepare([{ node: NODE, name: 'Work box', user: 'bob' }])
      if (!prepared.ok) throw new Error(prepared.message)
      const command = /ProxyCommand (.*)/u.exec(readFileSync(editor.paths.config, 'utf8'))![1]!
      return { alias: prepared.status.computers[0]!.alias, config: editor.paths.config, command }
    }

    const cleanEnv = (): NodeJS.ProcessEnv => {
      const env = { ...process.env }
      delete env.MOUSSE_HOME
      return env
    }

    it('carries 75 KB of every byte value through the launcher unchanged, and passes the exit code on', async () => {
      const { root, launcher } = await bedFor('Program Files & Co')
      const d = await fakeDaemon()
      const { command } = await configFor(root, launcher, d.home)
      expect(command).toContain(`--home "${forward(d.home)}"`)
      const child = runProxyCommand(command, cleanEnv())
      const chunks: Buffer[] = []
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
      cleanup.push(() => child.kill())
      const exited = new Promise<number | null>((resolve) => child.on('close', resolve))
      const row = Buffer.from(Array.from({ length: 256 }, (_, i) => i))
      const bytes = Buffer.concat(Array.from({ length: 300 }, () => row))
      child.stdin.write(bytes)
      await until(() => Buffer.concat(chunks).length >= bytes.length, 'the echoed bytes', 30_000)
      child.stdin.end()
      expect(await exited).toBe(0)
      expect(Buffer.concat(chunks).equals(bytes)).toBe(true)
      expect(stderr).toBe('')

      // A refusal: exit code 1 reaches the caller, the words are on stderr, stdout is empty.
      const refused = await fakeDaemon({
        open: async () => Promise.reject(new TunnelError('editor_off'))
      })
      const second = await configFor(root, launcher, refused.home)
      const again = runProxyCommand(second.command, cleanEnv())
      let out2 = ''
      let err2 = ''
      again.stdout.on('data', (chunk: Buffer) => (out2 += chunk.toString()))
      again.stderr.on('data', (chunk: Buffer) => (err2 += chunk.toString()))
      cleanup.push(() => again.kill())
      again.stdin.end()
      expect(await new Promise<number | null>((resolve) => again.on('close', resolve))).toBe(1)
      expect(out2).toBe('')
      expect(err2.trim()).toBe(proxyMessage('editor_off', 'Computer B').trim())
    }, 60_000)

    it.each(clients.map((client) => [client]))(
      '%s: -G shows the ProxyCommand with the quoted launcher and the home',
      async (client) => {
        const { root, launcher } = await bedFor()
        const d = await fakeDaemon()
        const { alias, config } = await configFor(root, launcher, d.home)
        const run = spawnSync(client, ['-F', config, '-G', alias], { encoding: 'utf8' })
        expect(run.status, run.stderr).toBe(0)
        expect(/^proxycommand (.*)$/mu.exec(run.stdout)?.[1]).toBe(
          `"${forward(launcher)}" net ssh-proxy ${NODE} --profile default --home "${forward(d.home)}"`
        )
      }
    )

    it.each(clients.map((client) => [client]))(
      '%s: runs it, and the first bytes ssh sends reach the far end of the tunnel',
      async (client) => {
        const { root, launcher } = await bedFor()
        const opened = memoryTunnel()
        // Git for Windows' ssh gives cmd a command with two quoted paths, and cmd drops the outer quotes then: a
        // launcher path and a --home path that both have spaces do not run there (Win32-OpenSSH does).
        const d = await fakeDaemon({ open: async () => opened, spaces: !/Git/u.test(client) })
        const { alias, config } = await configFor(root, launcher, d.home)
        opened.far.write('SSH-2.0-StandIn\r\n')
        const child = spawn(
          client,
          [
            '-F',
            config,
            '-o',
            'BatchMode=yes',
            '-o',
            'ConnectTimeout=20',
            '-o',
            'LogLevel=ERROR',
            alias,
            'exit'
          ],
          { env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] }
        )
        let stderr = ''
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
        child.stdout.resume()
        const exited = new Promise<number | null>((resolve) => child.on('close', resolve))
        cleanup.push(() => child.kill())
        await until(
          () => Buffer.concat(opened.far.received).length > 0,
          'the first bytes of ssh',
          20_000
        )
        expect(Buffer.concat(opened.far.received).toString('latin1')).toMatch(/^SSH-2\.0-/u)
        expect(d.requests.slice(0, 2)).toEqual([
          { method: 'profiles.bind', params: { profile: 'default' } },
          { method: 'net.editor.tunnel.open', params: { node: NODE } }
        ])
        // The stand-in does not speak SSH: ending it ends ssh, which is not a success.
        opened.far.end('closed')
        expect(await exited).not.toBe(0)
        expect(stderr).not.toMatch(/Bad permissions|Could not|not recognized|cannot find/iu)
      },
      60_000
    )
  }
)

describe('closing', () => {
  it('half-closes when ssh closes its end, and keeps reading until the far end is done', async () => {
    const opened = memoryTunnel()
    // The far end answers the end of what it was sent with its last words, then ends the tunnel.
    opened.far.onWriteEnd(() => {
      opened.far.write('SSH_MSG_DISCONNECT')
      opened.far.end('closed')
    })
    const d = await fakeDaemon({ open: async () => opened })
    const t = wire(d.home)
    const run = runSshProxy(argv(), t.io)
    await until(() => d.tunnels.count() === 1, 'the tunnel')
    t.stdin.write('last bytes')
    t.stdin.end()
    expect(await run).toBe(SSH_PROXY_EXIT.ok)
    // What ssh wrote reached the far end first, and what the far end said after the end reached stdout.
    expect(Buffer.concat(opened.far.received).toString()).toBe('last bytes')
    expect(t.stdout().toString()).toBe('SSH_MSG_DISCONNECT')
    expect(t.stderr()).toBe('')
    expect(d.requests.map((row) => row.method)).toContain('net.editor.tunnel.end')
  })

  it('waits only a little for a far end that does not answer the half-close', async () => {
    const opened = memoryTunnel()
    const d = await fakeDaemon({ open: async () => opened })
    const t = wire(d.home)
    const started = Date.now()
    const run = runSshProxy(argv(), { ...t.io, halfCloseWaitMs: 150 })
    await until(() => d.tunnels.count() === 1, 'the tunnel')
    t.stdin.end()
    expect(await run).toBe(SSH_PROXY_EXIT.ok)
    expect(Date.now() - started).toBeLessThan(3000)
    await until(() => d.tunnels.count() === 0, 'the tunnel to be let go')
  })

  it('is told the reason when the far end ends the tunnel with one while it is half-closed', async () => {
    const opened = memoryTunnel()
    opened.far.onWriteEnd(() => opened.far.end('far_end_error'))
    const d = await fakeDaemon({ open: async () => opened })
    const t = wire(d.home)
    const run = runSshProxy(argv(), t.io)
    await until(() => d.tunnels.count() === 1, 'the tunnel')
    t.stdin.end()
    expect(await run).toBe(SSH_PROXY_EXIT.refused)
    expect(t.stderr()).toBe(`${proxyMessage('far_end_error', 'Computer B')}\n`)
  })
})

describe('which daemon', () => {
  it('reads --home from the command line, whatever home the environment names', async () => {
    const d = await fakeDaemon()
    const elsewhere = await mkdtemp(join(tmpdir(), 'mousse proxy other '))
    cleanup.push(() => rm(elsewhere, { recursive: true, force: true }))
    const t = wire(elsewhere)
    const run = runSshProxy([...argv(), '--home', d.home], t.io)
    await until(() => d.tunnels.count() === 1, 'the tunnel through the daemon of --home')
    t.stdin.end()
    expect(await run).toBe(SSH_PROXY_EXIT.ok)
    // Without it the proxy looks in the environment's home, finds no daemon, and says so.
    const lost = wire(elsewhere)
    expect(await runSshProxy(argv(), lost.io)).toBe(SSH_PROXY_EXIT.refused)
    expect(lost.stderr()).toBe(`${proxyMessage('not_running')}\n`)
  })

  it('reads back the home that Mousse writes into the ProxyCommand, quoted for the shell', () => {
    const posix = proxyCommand(
      '/opt/Mousse App/mousse-cli',
      NODE,
      'default',
      'linux',
      "/data/my mousse's home"
    )
    expect(posix).toBe(
      `'/opt/Mousse App/mousse-cli' net ssh-proxy ${NODE} --profile default --home '/data/my mousse'"'"'s home'`
    )
    const win = proxyCommand(
      { program: String.raw`C:\Program Files\Mousse\mousse-cli.cmd` },
      NODE,
      'default',
      'win32',
      String.raw`D:\Mousse Data\home`
    )
    expect(win).toBe(
      `"C:/Program Files/Mousse/mousse-cli.cmd" net ssh-proxy ${NODE} --profile default --home "D:/Mousse Data/home"`
    )
    // The proxy's own parser sees the same arguments once the shell has taken the quotes off.
    expect(
      parseSshProxyArgv([
        'net',
        'ssh-proxy',
        NODE,
        '--profile',
        'default',
        '--home',
        'D:/Mousse Data/home'
      ])
    ).toEqual({ node: NODE, profile: 'default', home: 'D:/Mousse Data/home' })
    // No --home for the default home.
    expect(proxyCommand('/usr/bin/mousse-cli', NODE, 'default', 'linux')).not.toContain('--home')
  })
})
