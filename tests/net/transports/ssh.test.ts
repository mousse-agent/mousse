import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { newId, type NodeId, type Route } from '../../../src/shared/net'
import { DirectTransport } from '../../../src/mms/net/transports/direct'
import { ProfileTransports } from '../../../src/mms/net/transports/manager'
import { TransportRegistry } from '../../../src/mms/net/transports/registry'
import {
  SshDialer,
  SshTransport,
  describeSshFailure,
  parseSshEndpoint,
  parseSshRoute,
  readSshApproval,
  sshAddon,
  sshDialArguments,
  sshKnownHostsPath
} from '../../../src/mms/net/transports/ssh'
import { systemClock } from '../../../src/mms/net/clock'
import { FakeClock } from '../harness/FakeClock'
import { approve, fakeSsh, trustHost, type FakeSsh, type FakeSshMode } from './fakeSsh'

const fixtures = vi.hoisted(() => ({ binaries: new Set<string>() }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: ((...input: unknown[]) => {
      // Windows cannot run a shebang fixture; run it through Node. Every other process keeps its real invocation.
      if (process.platform === 'win32' && fixtures.binaries.has(input[0] as string))
        return Reflect.apply(actual.spawn, undefined, [
          process.execPath,
          [input[0], ...(input[1] as string[])],
          ...input.slice(2)
        ])
      return Reflect.apply(actual.spawn, undefined, input)
    }) as typeof actual.spawn
  }
})

const cleanup: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  fixtures.binaries.clear()
})
/** The directory name has a space on purpose: the known_hosts option value is quoted. */
async function directory() {
  const value = await mkdtemp(join(tmpdir(), 'mousse ssh '))
  cleanup.push(() => rm(value, { recursive: true, force: true }))
  return value
}
async function fake(where: string, mode: FakeSshMode = 'forward', name = 'ssh', config?: string[]) {
  const value = await fakeSsh(where, mode, name, config)
  fixtures.binaries.add(value.binary)
  return value
}
async function spawns(ssh: FakeSsh): Promise<string[][]> {
  if (!existsSync(ssh.log)) return []
  return (await readFile(ssh.log, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[])
}
async function configChecks(ssh: FakeSsh): Promise<string[][]> {
  if (!existsSync(ssh.configLog)) return []
  return (await readFile(ssh.configLog, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[])
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function gone(ssh: FakeSsh) {
  const pid = Number(await readFile(ssh.pid, 'utf8'))
  await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5000 })
}
/** A daemon's loopback listener, as the host runs it. */
async function listener() {
  const direct = new DirectTransport({ enabled: true, host: '127.0.0.1', port: 0 }),
    received: Buffer[] = []
  let server: Duplex | undefined
  await direct.provision()
  await direct.listen((raw) => {
    server = raw
    raw.on('data', (chunk: Buffer) => received.push(chunk))
  })
  cleanup.push(() => direct.teardown())
  return {
    port: Number(new URL(direct.status().routes[0].address).port),
    received: () => Buffer.concat(received).toString(),
    server: () => server
  }
}
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}
function route(endpoint: string, port: number): Route {
  return { transport: 'ssh', address: `ssh://${endpoint}/127.0.0.1:${port}`, priority: 40 }
}
const ENDPOINT = 'me@box.example.com:2222'

async function setup(mode: FakeSshMode = 'forward', clock?: FakeClock, config?: string[]) {
  const where = await directory(),
    ssh = await fake(where, mode, 'ssh', config),
    node = newId('node') as NodeId,
    knownHosts = sshKnownHostsPath(where),
    userKnownHosts = join(where, 'home', '.ssh', 'known_hosts')
  const dialer = new SshDialer({
    clock,
    binary: ssh.binary,
    knownHosts,
    userKnownHosts,
    approval: (peer) => readSshApproval(where, peer)
  })
  return { where, ssh, node, knownHosts, userKnownHosts, dialer }
}
const open = (signal = new AbortController().signal) => signal

describe('ssh add-on settings', () => {
  it('registers with strict settings and refuses anything ssh could read as an option', async () => {
    const registry = new TransportRegistry({ clock: systemClock, profileDir: await directory() })
    cleanup.push(() => registry.teardown())
    registry.register(sshAddon)
    expect(registry.manifests()[0]).toMatchObject({ id: 'ssh', displayName: 'SSH' })
    for (const settings of [
      { endpoint: 'box', port: 4000 },
      { endpoint: 'me@box.example.com:2222', port: 65535 },
      { endpoint: '[::1]:22', port: 1, binary: '/usr/bin/ssh' }
    ])
      expect(() => registry.validate({ id: 'ssh', enabled: true, settings })).not.toThrow()
    for (const settings of [
      { endpoint: '-oProxyCommand=touch x', port: 4000 },
      { endpoint: '-oProxyCommand=x', port: 4000 },
      { endpoint: 'box host', port: 4000 },
      { endpoint: 'box/x', port: 4000 },
      { endpoint: 'me@', port: 4000 },
      { endpoint: '', port: 4000 },
      { endpoint: `${'a'.repeat(254)}`, port: 4000 },
      { endpoint: 'box\n', port: 4000 },
      { endpoint: 'box', port: 0 },
      { endpoint: 'box', port: 65536 },
      { endpoint: 'box', port: '4000' },
      { endpoint: 'box' },
      { port: 4000 },
      { endpoint: 'box', port: 4000, extra: true }
    ])
      expect(
        () => registry.validate({ id: 'ssh', enabled: true, settings }),
        JSON.stringify(settings)
      ).toThrow(/settings/)
  })
  it('refuses an ssh port outside 1..65535 in the endpoint when the profile validates it', async () => {
    const profile = new ProfileTransports({
      clock: systemClock,
      profileDir: await directory(),
      identity: () => {
        throw new Error('unused')
      }
    })
    cleanup.push(() => profile.teardown())
    expect(() =>
      profile.validate({
        id: 'ssh',
        enabled: true,
        settings: { endpoint: 'box:99999', port: 4000 }
      })
    ).toThrow()
    expect(() =>
      profile.validate({ id: 'ssh', enabled: true, settings: { endpoint: 'box:0', port: 4000 } })
    ).toThrow()
    expect(() => new SshTransport({ endpoint: 'box:70000', port: 4000 })).toThrow()
    expect(() =>
      profile.validate({ id: 'ssh', enabled: true, settings: { endpoint: 'box:22', port: 4000 } })
    ).not.toThrow()
  })
  it('splits endpoints and route addresses strictly', () => {
    expect(parseSshEndpoint('me@box.example.com:2222')).toEqual({
      user: 'me',
      host: 'box.example.com',
      port: 2222
    })
    expect(parseSshEndpoint('box')).toEqual({ host: 'box' })
    expect(parseSshEndpoint('[::1]:22')).toEqual({ host: '::1', port: 22 })
    expect(parseSshEndpoint('-box')).toBeUndefined()
    expect(parseSshRoute('ssh://me@box:2222/127.0.0.1:4000')).toEqual({
      endpoint: { user: 'me', host: 'box', port: 2222 },
      port: 4000
    })
    for (const address of [
      'ssh://box/127.0.0.1:0',
      'ssh://box/127.0.0.1:65536',
      'ssh://box/127.0.0.1:04000',
      'ssh://box/10.0.0.1:4000',
      'ssh://box/127.0.0.1:4000/x',
      'ssh://-oProxyCommand=x/127.0.0.1:4000',
      'ssh://box host/127.0.0.1:4000',
      'ws://box/127.0.0.1:4000',
      'ssh://box'
    ])
      expect(parseSshRoute(address), address).toBeUndefined()
  })
})

describe('ssh listening', () => {
  it('advertises an ssh route for its fixed loopback port at priority 40', async () => {
    const port = await freePort()
    const transport = new SshTransport({ endpoint: ENDPOINT, port }, systemClock)
    cleanup.push(() => transport.teardown())
    await transport.provision()
    await transport.listen((raw) => raw.destroy())
    expect(transport.status().routes).toEqual([
      { transport: 'ssh', address: `ssh://${ENDPOINT}/127.0.0.1:${port}`, priority: 40 }
    ])
    await transport.teardown()
    expect(transport.status()).toEqual({ state: 'disabled', routes: [] })
  })
})

describe('ssh dialing', () => {
  it('opens a WebSocket to the daemon through ssh -W and carries bytes both ways', async () => {
    const t = await setup(),
      daemon = await listener()
    await approve(t.where, { [t.node]: ENDPOINT })
    await trustHost(t.knownHosts, 'box.example.com', 2222)
    const raw = await t.dialer.dial(route(ENDPOINT, daemon.port), open(), { peer: t.node })
    cleanup.push(() => raw.destroy())
    raw.write('from the laptop')
    await vi.waitFor(() => expect(daemon.received()).toBe('from the laptop'))
    const got: Buffer[] = []
    raw.on('data', (chunk: Buffer) => got.push(chunk))
    daemon.server()!.write('from the host')
    await vi.waitFor(() => expect(Buffer.concat(got).toString()).toBe('from the host'))
  })
  it('passes the hardened option set with the approved endpoint after --', async () => {
    const t = await setup(),
      daemon = await listener()
    await approve(t.where, { [t.node]: ENDPOINT })
    await trustHost(t.knownHosts, 'box.example.com', 2222)
    const raw = await t.dialer.dial(route(ENDPOINT, daemon.port), open(), { peer: t.node })
    cleanup.push(() => raw.destroy())
    const [argv] = await spawns(t.ssh)
    const options = argv.filter((_, index) => argv[index - 1] === '-o')
    for (const expected of [
      'BatchMode=yes',
      'StrictHostKeyChecking=yes',
      'UpdateHostKeys=no',
      'CheckHostIP=no',
      'VerifyHostKeyDNS=no',
      'PasswordAuthentication=no',
      'KbdInteractiveAuthentication=no',
      'ForwardAgent=no',
      'ForwardX11=no',
      'PermitLocalCommand=no',
      'ClearAllForwardings=yes',
      'ControlMaster=no',
      'ControlPersist=no',
      'LogLevel=ERROR',
      'ConnectTimeout=10',
      'ServerAliveInterval=15',
      'ServerAliveCountMax=3'
    ])
      expect(options).toContain(expected)
    const slashed = (path: string) => path.replace(/\\/g, '/')
    expect(options).toContain(
      `UserKnownHostsFile="${slashed(t.knownHosts)}" "${slashed(t.userKnownHosts)}"`
    )
    expect(argv).toContain('-T')
    // The configuration check sees exactly the options the dial runs with.
    expect(await configChecks(t.ssh)).toEqual([['-G', ...argv]])
    expect(argv.slice(-8)).toEqual([
      '-l',
      'me',
      '-p',
      '2222',
      '-W',
      `127.0.0.1:${daemon.port}`,
      '--',
      'box.example.com'
    ])
    // No invite and no password reaches argv; the only match is the option that turns passwords off.
    expect(argv.filter((value) => /invite|password/i.test(value))).toEqual([
      'PasswordAuthentication=no'
    ])
  })
  it('keeps the known_hosts option value literal for ssh_config', () => {
    const endpoint = { host: 'box' }
    const value = (knownHosts: string, userKnownHosts: string) =>
      sshDialArguments({ endpoint, port: 4000, knownHosts, userKnownHosts }).find((argument) =>
        argument.startsWith('UserKnownHostsFile=')
      )
    expect(value('/p/a b/ssh_known_hosts', '/h/.ssh/known_hosts')).toBe(
      'UserKnownHostsFile="/p/a b/ssh_known_hosts" "/h/.ssh/known_hosts"'
    )
    // `%` is a token in OpenSSH 8.4 and later and literal before it; there is no escaping that is right for both.
    for (const hostile of ['/p/100%/x', '/p/%d/x', '/p/a"b', '/p/${HOME}', '/p/a\nb', '/p/a\rb'])
      expect(() => value(hostile, '/h/.ssh/known_hosts'), hostile).toThrow()
  })
  it('gives ssh no askpass helper to prompt for a password with', async () => {
    const t = await setup(),
      daemon = await listener()
    await approve(t.where, { [t.node]: ENDPOINT })
    await trustHost(t.knownHosts, 'box.example.com', 2222)
    vi.stubEnv('SSH_ASKPASS', '/usr/bin/ssh-askpass')
    vi.stubEnv('SSH_ASKPASS_REQUIRE', 'force')
    cleanup.push(() => vi.unstubAllEnvs())
    const raw = await t.dialer.dial(route(ENDPOINT, daemon.port), open(), { peer: t.node })
    cleanup.push(() => raw.destroy())
    expect(JSON.parse(await readFile(`${t.ssh.log}.env`, 'utf8'))).toEqual({ askpass: [] })
  })
  it.each([
    ['ProxyJump', ['hostname box.example.com', 'proxyjump bastion.example.com']],
    ['ProxyJump', ['proxyjump me@one.example.com:2222,two.example.com']],
    ['ProxyCommand', ['proxycommand cloudflared access ssh --hostname box.example.com']],
    ['ProxyCommand', ['ProxyCommand ssh -W %h:%p bastion']]
  ])(
    'refuses a %s configuration before any connecting ssh runs, so no jump hop can prompt or write known_hosts',
    async (directive, config) => {
      // ssh starts a jump host as a separate ssh that keeps the user's own settings (no BatchMode,
      // no strict host keys, their known_hosts), so a configuration that needs one is not dialed.
      const clock = new FakeClock(),
        t = await setup('forward', clock, config),
        daemon = await listener()
      await approve(t.where, { [t.node]: ENDPOINT })
      await trustHost(t.knownHosts, 'box.example.com', 2222)
      const attempt = () => t.dialer.dial(route(ENDPOINT, daemon.port), open(), { peer: t.node })
      await expect(attempt()).rejects.toMatchObject({
        code: 'route_unreachable',
        message: expect.stringContaining(directive)
      })
      expect(await spawns(t.ssh)).toEqual([])
      expect(await configChecks(t.ssh)).toHaveLength(1)
      // The refusal does not fix itself: the configuration is not re-read, and run, for a minute.
      clock.advance(10_000)
      await expect(attempt()).rejects.toMatchObject({ message: expect.stringMatching(/Waiting/) })
      expect(await configChecks(t.ssh)).toHaveLength(1)
      clock.advance(50_000)
      await expect(attempt()).rejects.toMatchObject({ message: expect.stringContaining(directive) })
      expect(await configChecks(t.ssh)).toHaveLength(2)
      expect(await spawns(t.ssh)).toEqual([])
    }
  )
  it('dials when the configuration sets no proxy', async () => {
    const t = await setup('forward', undefined, [
        'hostname box.example.com',
        'proxyjump none',
        'proxycommand none',
        'proxyusefdpass no'
      ]),
      daemon = await listener()
    await approve(t.where, { [t.node]: ENDPOINT })
    await trustHost(t.knownHosts, 'box.example.com', 2222)
    const raw = await t.dialer.dial(route(ENDPOINT, daemon.port), open(), { peer: t.node })
    cleanup.push(() => raw.destroy())
    expect(await spawns(t.ssh)).toHaveLength(1)
  })
  it('uses the key from either known_hosts file', async () => {
    const t = await setup(),
      daemon = await listener()
    await approve(t.where, { [t.node]: 'box.example.com' })
    await trustHost(t.userKnownHosts, 'box.example.com')
    const raw = await t.dialer.dial(route('box.example.com', daemon.port), open(), { peer: t.node })
    cleanup.push(() => raw.destroy())
    raw.write('x')
    await vi.waitFor(() => expect(daemon.received()).toBe('x'))
  })
  it('spawns nothing for a route this device has not approved for that peer', async () => {
    const t = await setup(),
      daemon = await listener()
    await trustHost(t.knownHosts, 'box.example.com', 2222)
    const stranger = newId('node') as NodeId
    const expectRefused = async (address: Route['address'], peer: NodeId | undefined) => {
      await expect(
        t.dialer.dial(
          { transport: 'ssh', address, priority: 40 },
          open(),
          peer ? { peer } : undefined
        )
      ).rejects.toMatchObject({ code: 'route_unreachable' })
      expect(await spawns(t.ssh)).toEqual([])
    }
    const good = `ssh://${ENDPOINT}/127.0.0.1:${daemon.port}`
    await expectRefused(good, t.node) // no approvals file at all
    await approve(t.where, { [stranger]: ENDPOINT })
    await expectRefused(good, t.node) // approved for a different node
    await expectRefused(good, undefined) // no peer context
    await approve(t.where, { [t.node]: ENDPOINT })
    for (const address of [
      `ssh://-oProxyCommand=touch/127.0.0.1:${daemon.port}`,
      `ssh://box host/127.0.0.1:${daemon.port}`,
      `ssh://box/10.0.0.1:${daemon.port}`,
      'ssh://box/127.0.0.1:0',
      'ssh://box/127.0.0.1:70000',
      'ssh://',
      `ws://box/127.0.0.1:${daemon.port}`
    ])
      await expectRefused(address, t.node) // malformed or option-like
    await expect(
      t.dialer.dial({ transport: 'direct', address: good, priority: 0 }, open(), { peer: t.node })
    ).rejects.toMatchObject({ code: 'route_unreachable' })
    // An edited approvals file that names an option-like endpoint is no approval.
    await approve(t.where, { [t.node]: '-oProxyCommand=touch' })
    await expectRefused(good, t.node)
    expect(await spawns(t.ssh)).toEqual([])
  })
  it('spawns with the approved endpoint, never the route string', async () => {
    const t = await setup(),
      daemon = await listener()
    await approve(t.where, { [t.node]: 'jump@approved.example:2200' })
    await trustHost(t.knownHosts, 'approved.example', 2200)
    const raw = await t.dialer.dial(route('evil@route.example:22', daemon.port), open(), {
      peer: t.node
    })
    cleanup.push(() => raw.destroy())
    const [argv] = await spawns(t.ssh)
    expect(argv.slice(-6)).toEqual([
      '-p',
      '2200',
      '-W',
      `127.0.0.1:${daemon.port}`,
      '--',
      'approved.example'
    ])
    expect(argv[argv.indexOf('-l') + 1]).toBe('jump')
    expect(JSON.stringify(argv)).not.toMatch(/evil|route\.example/)
  })
  it('fails at the host-key stage when neither known_hosts file holds the host', async () => {
    const t = await setup(),
      daemon = await listener()
    await approve(t.where, { [t.node]: ENDPOINT })
    await expect(
      t.dialer.dial(route(ENDPOINT, daemon.port), open(), { peer: t.node })
    ).rejects.toMatchObject({
      code: 'route_unreachable',
      message: expect.stringMatching(/Host key verification failed/)
    })
    expect(await spawns(t.ssh)).toHaveLength(1)
  })
  it.each([
    ['prohibited', /AllowTcpForwarding/],
    ['refused', /daemon on me@box\.example\.com:2222 is not listening on port 4000/],
    ['denied', /Permission denied/]
  ] as const)('maps %s from ssh stderr to a route_unreachable detail', async (mode, detail) => {
    const t = await setup(mode)
    await approve(t.where, { [t.node]: ENDPOINT })
    await trustHost(t.knownHosts, 'box.example.com', 2222)
    await expect(
      t.dialer.dial(route(ENDPOINT, 4000), open(), { peer: t.node })
    ).rejects.toMatchObject({
      code: 'route_unreachable',
      message: expect.stringMatching(detail)
    })
  })
  it('never matches the shared "open failed" prefix on its own', () => {
    expect(describeSshFailure('channel 0: open failed: something else', 'box', 4000)).toMatch(
      /something else/
    )
    expect(describeSshFailure('Connection timed out during banner exchange', 'box', 4000)).toMatch(
      /timed out/
    )
    expect(
      describeSshFailure(
        'ssh: Could not resolve hostname box: Name or service not known',
        'box',
        4000
      )
    ).toMatch(/Could not resolve/)
    expect(describeSshFailure('', 'box', 4000)).toMatch(/closed before the daemon answered/)
  })
  it('connects through a slow host', async () => {
    const t = await setup('slow'),
      daemon = await listener()
    await approve(t.where, { [t.node]: ENDPOINT })
    await trustHost(t.knownHosts, 'box.example.com', 2222)
    const raw = await t.dialer.dial(route(ENDPOINT, daemon.port), open(), { peer: t.node })
    cleanup.push(() => raw.destroy())
    raw.write('late')
    await vi.waitFor(() => expect(daemon.received()).toBe('late'))
  }, 20_000)
  it('spawns once within the 10 s floor, whatever the route string, then again after it', async () => {
    const clock = new FakeClock(),
      t = await setup('refused', clock)
    await approve(t.where, { [t.node]: ENDPOINT })
    await trustHost(t.knownHosts, 'box.example.com', 2222)
    const attempt = (endpoint: string) =>
      t.dialer.dial(route(endpoint, 4000), open(), { peer: t.node })
    await expect(attempt(ENDPOINT)).rejects.toMatchObject({
      message: expect.stringMatching(/not listening/)
    })
    for (const rotated of ['a@one.example', 'b@two.example', ENDPOINT])
      await expect(attempt(rotated)).rejects.toMatchObject({
        code: 'route_unreachable',
        message: expect.stringMatching(/Waiting before trying SSH/)
      })
    expect(await spawns(t.ssh)).toHaveLength(1)
    clock.advance(9_999)
    await expect(attempt(ENDPOINT)).rejects.toMatchObject({
      message: expect.stringMatching(/Waiting/)
    })
    clock.advance(1)
    await expect(attempt(ENDPOINT)).rejects.toMatchObject({
      message: expect.stringMatching(/not listening/)
    })
    expect(await spawns(t.ssh)).toHaveLength(2)
  })
  it.each(['denied', 'forward'] as const)(
    'waits 60 s after a refused key or host key (%s)',
    async (mode) => {
      const clock = new FakeClock(),
        t = await setup(mode, clock)
      await approve(t.where, { [t.node]: ENDPOINT })
      // `forward` without a trusted host key is the host-key failure; `denied` is the key failure.
      if (mode === 'denied') await trustHost(t.knownHosts, 'box.example.com', 2222)
      const attempt = () => t.dialer.dial(route(ENDPOINT, 4000), open(), { peer: t.node })
      await expect(attempt()).rejects.toMatchObject({ code: 'route_unreachable' })
      clock.advance(10_000)
      await expect(attempt()).rejects.toMatchObject({ message: expect.stringMatching(/Waiting/) })
      clock.advance(49_999)
      await expect(attempt()).rejects.toMatchObject({ message: expect.stringMatching(/Waiting/) })
      expect(await spawns(t.ssh)).toHaveLength(1)
      clock.advance(1)
      await expect(attempt()).rejects.toMatchObject({ code: 'route_unreachable' })
      expect(await spawns(t.ssh)).toHaveLength(2)
    }
  )
  it('kills the child when the dial is aborted', async () => {
    const t = await setup('hang'),
      controller = new AbortController()
    await approve(t.where, { [t.node]: ENDPOINT })
    await trustHost(t.knownHosts, 'box.example.com', 2222)
    const pending = t.dialer.dial(route(ENDPOINT, 4000), controller.signal, { peer: t.node })
    const settled = expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    await vi.waitFor(() => expect(existsSync(t.ssh.pid)).toBe(true))
    controller.abort()
    await settled
    await gone(t.ssh)
  })
  it('reports a missing ssh executable', async () => {
    const t = await setup()
    await approve(t.where, { [t.node]: ENDPOINT })
    const dialer = new SshDialer({
      binary: join(t.where, 'no-such-ssh'),
      knownHosts: t.knownHosts,
      approval: (peer) => readSshApproval(t.where, peer)
    })
    await expect(
      dialer.dial(route(ENDPOINT, 4000), open(), { peer: t.node })
    ).rejects.toMatchObject({
      code: 'route_unreachable',
      message: expect.stringMatching(/ssh command was not found/)
    })
  })
  it('leaves no child process after the stream closes', async () => {
    const t = await setup(),
      daemon = await listener()
    await approve(t.where, { [t.node]: ENDPOINT })
    await trustHost(t.knownHosts, 'box.example.com', 2222)
    const raw = await t.dialer.dial(route(ENDPOINT, daemon.port), open(), { peer: t.node })
    expect(alive(Number(await readFile(t.ssh.pid, 'utf8')))).toBe(true)
    raw.destroy()
    await gone(t.ssh)
  })
})

describe('ssh through the profile transports', () => {
  it('dials only approved peers and tears the child down with the profile', async () => {
    const where = await directory(),
      ssh = await fake(where),
      daemon = await listener(),
      node = newId('node') as NodeId
    const profile = new ProfileTransports({
      clock: systemClock,
      profileDir: where,
      identity: () => {
        throw new Error('unused')
      },
      ssh: { binary: ssh.binary, userKnownHosts: join(where, 'home', '.ssh', 'known_hosts') }
    })
    cleanup.push(() => profile.teardown())
    const transport = profile.transports().find((value) => value.id === 'ssh')!
    expect(transport.traits).toMatchObject({
      canDial: true,
      canListen: false,
      readsPlaintext: false
    })
    const address = route(ENDPOINT, daemon.port)
    await expect(transport.dial(address, open(), { peer: node })).rejects.toMatchObject({
      code: 'route_unreachable'
    })
    expect(await spawns(ssh)).toEqual([])
    await approve(where, { [node]: ENDPOINT })
    await trustHost(sshKnownHostsPath(where), 'box.example.com', 2222)
    const raw = await transport.dial(address, open(), { peer: node })
    raw.write('ok')
    await vi.waitFor(() => expect(daemon.received()).toBe('ok'))
    await profile.teardown()
    await gone(ssh)
    expect(raw.destroyed).toBe(true)
  })
})
