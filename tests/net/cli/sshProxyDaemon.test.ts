import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runSshProxy, type SshProxyIo } from '../../../src/cli/fastpath/sshProxy'
import { MousseMainService } from '../../../src/mms/MousseMainService'
import { NetService } from '../../../src/mms/net/NetService'
import { LocalMmsClient, MmsProtocolServer } from '../../../src/mms/protocol'
import type { NodeId } from '../../../src/shared/net'
import { proxyMessage, SSH_PROXY_EXIT } from '../../../src/shared/net/editorProxy'
import type { EditorSshResult } from '../../../src/shared/net/local'
import { KEY_A } from '../ssh/bed'

// The proxy never runs `ssh` here, and Mousse's editor settings must not read the real ssh: the check that
// `~/.ssh/config` can still be read is replaced by one that always passes.
vi.mock('../../../src/mms/net/editor/sshConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/mms/net/editor/sshConfig')>()),
  systemSshVerifier: () => async () => ({ ok: true as const })
}))

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.unstubAllEnvs()
})
const TOKEN = 'fixture-owner-token'

async function directory(prefix: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  cleanup.push(() => rm(path, { recursive: true, force: true }))
  return path
}

/** An echo server where the SSH server of the other computer would be, on loopback. */
async function echoServer() {
  const sockets = new Set<Socket>()
  const echo = { port: 0, sockets, connections: 0, server: undefined as unknown as Server }
  echo.server = createServer({ allowHalfOpen: true }, (socket) => {
    echo.connections++
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    socket.pipe(socket)
  })
  await new Promise<void>((resolve) => echo.server.listen(0, '127.0.0.1', resolve))
  echo.port = (echo.server.address() as { port: number }).port
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        echo.server.close(() => resolve())
      })
  )
  return echo
}

function wire() {
  const stdin = new PassThrough()
  const out: Buffer[] = []
  const err: string[] = []
  const io = (home: string): SshProxyIo => ({
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
  })
  return { stdin, io, stdout: () => Buffer.concat(out), stderr: () => err.join('') }
}

/**
 * The real daemon of this computer (`MousseMainService` behind the framed `MmsProtocolServer`), whose profile has
 * a real Net service, paired over loopback with a second Net service that carries the far end (an echo server
 * where its SSH server would be). The proxy runs against it exactly as an editor's `ssh` would start it.
 */
async function bed() {
  const root = await directory('mousse proxy daemon ')
  // The editor settings of the profile write under the home directory: a throwaway one.
  const userHome = join(root, 'user')
  await mkdir(userHome, { recursive: true })
  vi.stubEnv('USERPROFILE', userHome)
  vi.stubEnv('HOME', userHome)
  const echo = await echoServer()
  const keys = await directory('mousse owner host keys ')
  await writeFile(join(keys, 'ssh_host_ed25519_key.pub'), `${KEY_A.type} ${KEY_A.key} root@owner\n`)

  const home = join(root, 'home')
  const main = await MousseMainService.create({
    homeDir: home,
    repoRoot: root,
    requireOwnership: false,
    headless: true
  })
  const server = new MmsProtocolServer({ mms: main, ownerToken: TOKEN })
  const endpoint = await server.start()
  const owner = new NetService({
    profileDir: await directory('proxy-owner-'),
    editorTunnel: { farEnd: [{ host: '127.0.0.1', port: echo.port }], hostKeyDirectories: [keys] }
  })
  cleanup.push(async () => {
    await owner.shutdown()
    await server.stop()
    await main.stop()
  })
  // The proxy finds the daemon through the owner file, as it does for the real one.
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

  const client = new LocalMmsClient({
    homeDir: home,
    endpoint,
    ownerToken: TOKEN,
    clientType: 'cli',
    requestedCapabilities: ['net.v1', 'profiles-v1']
  })
  await client.connect()
  cleanup.push(() => client.close())
  const status = await client.request<{ defaultProfileId: string }>('profiles.status')
  const profile = status.defaultProfileId
  await client.request('profiles.bind', { profile })
  const authority = (await main.getProfileServices(profile)).net
  await authority.request('net.init', { name: 'this computer', listen: true, port: 0 })
  await authority.request('net.protect', { passphrase: 'test-authority-protection' })
  const invite = ((await authority.request('bridge.invite', {})) as { invite: string }).invite
  const joined = (await owner.request('bridge.join', { invite, name: 'Computer B' })) as {
    node: NodeId
  }
  const self = authority.runtime().identity.self()!.node
  await vi.waitFor(() => expect(owner.status().peers).toContainEqual({ node: self, state: 'open' }), {
    timeout: 15_000
  })
  await vi.waitFor(
    () => expect(authority.status().peers).toContainEqual({ node: joined.node, state: 'open' }),
    { timeout: 15_000 }
  )
  return {
    home,
    profile,
    owner: joined.node,
    self,
    echo,
    ownerNet: owner,
    allow: (editor: boolean) => owner.request('bridge.policy', { node: self, editor }),
    prepare: () => client.request<EditorSshResult>('net.editor.ssh.prepare')
  }
}

const proxyArgv = (b: { owner: NodeId; profile: string; home: string }) => [
  'net',
  'ssh-proxy',
  b.owner,
  '--profile',
  b.profile,
  '--home',
  b.home
]

describe('the proxy against the real daemon', () => {
  it('says hello, binds the profile, opens a tunnel, carries bytes both ways and closes it', async () => {
    const b = await bed()
    await b.allow(true)
    const prepared = await b.prepare()
    expect(prepared).toMatchObject({ ok: true })
    const t = wire()
    const run = runSshProxy(proxyArgv(b), t.io(b.home))

    const text = 'SSH-2.0-OpenSSH_for_Test\r\n'
    t.stdin.write(text)
    await vi.waitFor(() => expect(t.stdout().toString()).toBe(text), { timeout: 15_000 })
    expect(b.echo.connections).toBe(1)
    expect(b.ownerNet.editorTunnelList()).toHaveLength(1)
    // More than one piece, every byte value.
    const big = Buffer.concat([
      Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
      Buffer.alloc(100_000, 7)
    ])
    t.stdin.write(big)
    await vi.waitFor(() => expect(t.stdout().length).toBe(text.length + big.length), {
      timeout: 15_000
    })
    expect(t.stdout().subarray(text.length).equals(big)).toBe(true)

    // ssh closes its end: the write side is half-closed, the far end ends, the tunnel is gone, exit 0.
    t.stdin.end()
    expect(await run).toBe(SSH_PROXY_EXIT.ok)
    expect(t.stderr()).toBe('')
    await vi.waitFor(() => expect(b.ownerNet.editorTunnelList()).toEqual([]))
    await vi.waitFor(() => expect(b.echo.sockets.size).toBe(0))
  }, 60_000)

  it('is refused with a typed reason when the owner’s switch is off, and opens nothing', async () => {
    const b = await bed()
    await b.prepare()
    const t = wire()
    expect(await runSshProxy(proxyArgv(b), t.io(b.home))).toBe(SSH_PROXY_EXIT.refused)
    expect(t.stderr()).toBe(`${proxyMessage('editor_off', 'Computer B')}\n`)
    expect(t.stdout().length).toBe(0)
    expect(b.echo.connections).toBe(0)
  }, 60_000)

  it('is told when the owner ends the tunnel, with the owner’s reason', async () => {
    const b = await bed()
    await b.allow(true)
    await b.prepare()
    const t = wire()
    const run = runSshProxy(proxyArgv(b), t.io(b.home))
    t.stdin.write('hello')
    await vi.waitFor(() => expect(t.stdout().toString()).toBe('hello'), { timeout: 15_000 })
    await b.ownerNet.request('bridge.policy', { node: b.self, blocked: true })
    expect(await run).toBe(SSH_PROXY_EXIT.refused)
    expect(t.stderr()).toBe(`${proxyMessage('blocked', 'Computer B')}\n`)
  }, 60_000)

  it('says the profile does not exist, with the daemon’s own refusal', async () => {
    const b = await bed()
    const t = wire()
    expect(await runSshProxy(proxyArgv({ ...b, profile: 'no-such-profile' }), t.io(b.home))).toBe(
      SSH_PROXY_EXIT.refused
    )
    expect(t.stderr()).toBe(`${proxyMessage('profile')}\n`)
  }, 60_000)
})
