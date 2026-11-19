/**
 * `mousse-cli net-engine` (Phase 1b M12, design §8): what each command line asks for before anything connects; the
 * commands run against a profile's real local methods (invite answered from the terminal, devices, status, remove,
 * a 1b method this service does not have yet); the Send link join's terminal-only code; and
 * `mousse-cli net-engine ssh`, which another computer runs over SSH: the marker first, a bounded request, and never
 * starting the service.
 */
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  executeNetEngineCommand,
  netEngineFailure,
  prepareNetEngineCommand,
  type NetEngineCliClient,
  type NetEngineCliIO
} from '../../src/cli/commands/netEngine'
import { runNetEngineSsh } from '../../src/cli/commands/netEngineSsh'
import { parseArgs } from '../../src/cli/parseArgs'
import { ENGINE_LIMIT_DEFAULTS, readEngineLimits } from '../../src/mms/netEngine/limits'
import type { NetEngineStatus } from '../../src/shared/netEngine/local'
import { eventually, Fabric, rowFor, type Computer } from './checks/harness'

/** A ticket as the helper writes one: a CBOR map {1: 1, 2: kind, 3: host, 4: invitation, 7: routes}. */
function ticket(kind: number, routes: string[]): string {
  const head = (major: number, value: number): Buffer =>
    value < 24 ? Buffer.from([(major << 5) | value]) : Buffer.from([(major << 5) | 24, value])
  const bytes = (value: Buffer): Buffer => Buffer.concat([head(2, value.byteLength), value])
  const text = (value: string): Buffer => Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)])
  const encoded = Buffer.concat([
    head(5, 5),
    head(0, 1), head(0, 1),
    head(0, 2), head(0, kind),
    head(0, 3), bytes(Buffer.alloc(32, 4)),
    head(0, 4), bytes(Buffer.alloc(16, 9)),
    head(0, 7), head(4, routes.length), ...routes.map(text)
  ]).toString('base64url')
  return `mousse://pair?n=Studio#${encoded}`
}

const LINK = ticket(2, ['tcp://192.168.1.5:7000', 'tcp://100.101.1.2:7000', 'wss://x.example/mousse-net/1', 'ws://127.0.0.1:9/mousse-net/1'])
const SELECTOR = 'abcdefghijklmnopqrstuvwxyz'

const prepare = (...argv: string[]) => prepareNetEngineCommand(parseArgs(['net-engine', ...argv]))

describe('net-engine command lines', () => {
  it.each([
    [['status'], { kind: 'status' }],
    [['devices'], { kind: 'devices' }],
    [['invite'], { kind: 'invite', link: false }],
    [['invite', '--link'], { kind: 'invite', link: true }],
    [['join', LINK, '--yes'], { kind: 'join', ticket: LINK, yes: true }],
    [['remove', 'Studio'], { kind: 'remove', device: 'Studio' }],
    [['addresses', 'Studio', 'tcp://203.0.113.7:7443', 'ssh://me@box'], { kind: 'addresses', device: 'Studio', routes: ['tcp://203.0.113.7:7443', 'ssh://me@box'] }],
    [['addresses', 'Studio'], { kind: 'addresses', device: 'Studio', routes: [] }],
    [
      ['routes', '--lan', 'off', '--public', '203.0.113.7:7443', '--tunnel', 'https://Box.example/', '--port', '47100', '--test'],
      { kind: 'routes', test: true, config: { lan: false, public: ['tcp://203.0.113.7:7443'], tunnels: ['wss://box.example/mousse-net/1'], port: 47100 } }
    ],
    [['routes', '--public', 'none'], { kind: 'routes', test: false, config: { public: [] } }],
    [['ssh'], { kind: 'ssh-remote' }],
    [['ssh', 'add', 'me@box', '--profile', SELECTOR], { kind: 'ssh-add', target: 'me@box', selector: SELECTOR }],
    [['ssh', 'add', 'box', '--new', 'Work', '--local-profile', 'p1'], { kind: 'ssh-add', target: 'box', newLabel: 'Work', localProfile: 'p1' }]
  ])('%j', (argv, expected) => {
    expect(prepare(...argv)).toEqual(expected)
  })

  it.each([
    [['frobnicate'], /Unknown net-engine command/],
    [['status', 'extra'], /takes no arguments/],
    [['join'], /one link/],
    [['join', 'not a link'], /damaged/],
    // An in-person code is for a camera; a terminal joins only a Send link.
    [['join', ticket(1, ['tcp://192.168.1.5:7000'])], /in-person pairing code/],
    [['remove'], /one device/],
    [['routes', '--lan', 'maybe'], /on or off/],
    [['routes', '--port', '70000'], /port number/],
    [['routes', '--tunnel', 'http://box.example'], /https:\/\//],
    [['ssh', 'add', '-oProxyCommand=x'], /user@host/],
    [['ssh', 'add', 'me@box', '--profile', 'Default'], /selector/],
    [['ssh', 'add', 'me@box', '--profile', SELECTOR, '--new', 'Work'], /not both/],
    [['ssh', 'list'], /add <target>/]
  ])('%j is refused', (argv, message) => {
    expect(() => prepare(...argv)).toThrow(message)
  })
})

/** A terminal for one command: what it printed, and answers typed in turn. */
function terminal(answers: string[] = [], tty = true) {
  const emitted: Array<{ value: any; text: string }> = []
  const said: string[] = []
  const asked: string[] = []
  const interrupt = new AbortController()
  const io: NetEngineCliIO = {
    emit: (value, text) => emitted.push({ value, text }),
    say: (text) => said.push(text),
    tty,
    ask: async (question) => {
      asked.push(question)
      return answers.shift()
    },
    changed: (signal) =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, 20)
        signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true })
      }),
    interrupted: interrupt.signal
  }
  return { io, emitted, said, asked, interrupt }
}

describe('net-engine through a profile\'s local methods', () => {
  const fabric = new Fabric()
  let owner: Computer
  let caller: Computer
  const cli = (on: Computer): NetEngineCliClient => ({ request: (method, params) => on.dispatch(method, params ?? {}, true) })
  beforeAll(async () => {
    owner = await fabric.computer('owner')
    caller = await fabric.computer('caller')
  }, 120_000)
  afterAll(() => fabric.close(), 120_000)

  it('invite shows a code, asks at the terminal when a computer asks to join, and ends once it joined', async () => {
    const term = terminal(['y'])
    const inviting = executeNetEngineCommand({ kind: 'invite', link: false }, cli(owner), term.io)
    await eventually(() => expect(term.emitted).toHaveLength(1))
    const { uri } = term.emitted[0]!.value
    // The other computer scans it with Add device.
    const joined = await caller.dispatch('netEngine.join', { ticket: uri }, true)
    expect(await inviting).toBe(0)
    expect(term.asked).toEqual([expect.stringMatching(/^Is caller computer .* next to you\?/)])
    expect(joined.node).toBeTruthy()
    await eventually(() => expect(rowFor(owner, caller)?.state).toBeTruthy())
  }, 60_000)

  it('a No at the terminal lets nobody in', async () => {
    const third = await fabric.computer('third')
    const term = terminal(['n'])
    const inviting = executeNetEngineCommand({ kind: 'invite', link: false }, cli(owner), term.io)
    await eventually(() => expect(term.emitted).toHaveLength(1))
    const joining = third.dispatch('netEngine.join', { ticket: term.emitted[0]!.value.uri }, true)
    await expect(joining).rejects.toBeTruthy()
    term.interrupt.abort()
    expect(await inviting).toBe(130)
    expect(rowFor(owner, third)).toBeUndefined()
  }, 60_000)

  it('status and devices read the profile; remove takes a device by its name', async () => {
    const status = terminal()
    expect(await executeNetEngineCommand({ kind: 'status' }, cli(owner), status.io)).toBe(0)
    expect(status.emitted[0]!.value.on).toBe(true)
    expect(status.emitted[0]!.text).toMatch(/^Networking: on/)

    const devices = terminal()
    await executeNetEngineCommand({ kind: 'devices' }, cli(owner), devices.io)
    const row = (devices.emitted[0]!.value as NetEngineStatus['devices']).find((device) => device.name === 'caller computer')
    expect(row).toBeTruthy()

    // addresses sets exactly the routes given, and none clears them.
    const set = terminal()
    await executeNetEngineCommand({ kind: 'addresses', device: row!.node, routes: ['tcp://192.168.7.9:47100'] }, cli(owner), set.io)
    expect(set.emitted[0]!.value.addresses).toEqual(['tcp://192.168.7.9:47100'])
    await executeNetEngineCommand({ kind: 'addresses', device: row!.node, routes: ['tcp://192.168.7.10:47100'] }, cli(owner), terminal().io)
    expect((await owner.dispatch('netEngine.status', {}, true)).devices.find((device: { node: string }) => device.node === row!.node).addresses).toEqual(['tcp://192.168.7.10:47100'])
    const cleared = terminal()
    await executeNetEngineCommand({ kind: 'addresses', device: row!.node, routes: [] }, cli(owner), cleared.io)
    expect(cleared.emitted[0]!.text).toMatch(/local network only/)

    await executeNetEngineCommand({ kind: 'remove', device: 'Caller Computer' }, cli(owner), terminal().io)
    await eventually(() => expect(rowFor(owner, caller)).toBeUndefined())
  }, 60_000)

  it('a device that is not there is refused by name', async () => {
    const error = await executeNetEngineCommand({ kind: 'remove', device: 'nobody' }, cli(owner), terminal().io).catch((e) => e)
    expect(netEngineFailure(error)).toMatchObject({ code: 'bad_request', exitCode: 2, error: expect.stringMatching(/No device is called nobody/) })
  })
})

describe('net-engine routes through a profile with a 1.1 helper', () => {
  const fabric = new Fabric()
  let one: Computer
  beforeAll(async () => {
    fabric.network.minor = 1
    one = await fabric.computer('routes')
  }, 120_000)
  afterAll(() => fabric.close(), 120_000)
  const cli = (): NetEngineCliClient => ({ request: (method, params) => one.dispatch(method, params ?? {}, true) })

  // A public address (documentation ranges are refused as no class); nothing is dialled.
  it('saves a port forward, says when networking restarted for it, and tests each route', async () => {
    const term = terminal()
    const change = prepare('routes', '--public', '93.184.216.34:7443', '--test')
    expect(await executeNetEngineCommand(change, cli(), term.io)).toBe(0)
    const value = term.emitted[0]!.value
    expect(value.reach.public).toEqual(['tcp://93.184.216.34:7443'])
    expect(value.routes).toContain('tcp://93.184.216.34:7443')
    expect(value.restarted).toBe(true)
    expect(value.tests.map((test: { route: string }) => test.route)).toEqual(value.routes)
    // Read back without a change: nothing restarts.
    const read = terminal()
    await executeNetEngineCommand(prepare('routes'), cli(), read.io)
    expect(read.emitted[0]!.value).toMatchObject({ reach: { public: ['tcp://93.184.216.34:7443'] } })
    expect(read.emitted[0]!.value.restarted).toBeUndefined()
  }, 120_000)
})

describe('net-engine join of a Send link', () => {
  /** A service that wants the code once the join is under way, and takes `good`. */
  function service(good: string) {
    const calls: Array<[string, any]> = []
    let pending = false
    let tries = 3
    let finish!: (value: unknown) => void
    const client: NetEngineCliClient = {
      async request(method: string, params?: any) {
        calls.push([method, params])
        if (method === 'netEngine.status')
          return { devices: [], approvals: [], joins: pending ? [{ invitation: '09'.repeat(16), needsCode: true, attemptsLeft: tries, wrong: tries < 3 }] : [] } as never
        if (method === 'netEngine.join.preview')
          return {
            name: 'Studio',
            kind: 2,
            destinations: [
              { route: 'tcp://192.168.1.5:7000', label: '192.168.1.5:7000', cls: 'lan', automatic: true },
              { route: 'tcp://100.101.1.2:7000', label: '100.101.1.2:7000', cls: 'tailnet', automatic: false }
            ],
            shareable: []
          } as never
        if (method === 'netEngine.join') {
          pending = true
          return new Promise((resolve) => (finish = resolve)) as never
        }
        if (method === 'netEngine.join.code') {
          if (params.code === good) {
            pending = false
            finish({ node: 'n1', status: { devices: [{ node: 'n1', name: 'Studio' }] } })
          } else tries -= 1
          return {} as never
        }
        throw new Error(method)
      }
    }
    return { client, calls }
  }

  it('lists the destinations, asks before dialling, and sends only the code typed at the terminal', async () => {
    const { client, calls } = service('123456')
    const term = terminal(['y', '111 111', '12345', '123 456'])
    expect(await executeNetEngineCommand({ kind: 'join', ticket: LINK, yes: false }, client, term.io)).toBe(0)
    // The destinations are the service's, by class, as the join dialog lists them.
    expect(term.said[0]).toMatch(/192\.168\.1\.5:7000 \(lan\).*100\.101\.1\.2:7000 \(tailnet\)/s)
    const join = calls.find(([method]) => method === 'netEngine.join')![1]
    expect(join).toEqual({ ticket: LINK, arrival: 'link' })
    // The five-digit one never left the terminal.
    expect(calls.filter(([method]) => method === 'netEngine.join.code').map(([, p]) => p.code)).toEqual(['111111', '123456'])
    expect(term.said.some((line) => /didn't work/.test(line))).toBe(true)
    expect(term.emitted[0]!.text).toMatch(/Paired with Studio/)
  })

  it('a No sends nothing; without a terminal nothing is asked or sent, --yes included', async () => {
    const no = service('123456')
    expect(await executeNetEngineCommand({ kind: 'join', ticket: LINK, yes: false }, no.client, terminal(['n']).io)).toBe(1)
    // Only the preview was read: nothing was dialled.
    expect(no.calls.map(([method]) => method)).toEqual(['netEngine.join.preview'])
    for (const yes of [false, true]) {
      const piped = service('123456')
      await expect(executeNetEngineCommand({ kind: 'join', ticket: LINK, yes }, piped.client, terminal(['y', '123456'], false).io)).rejects.toThrow(
        /terminal/
      )
      expect(piped.calls).toEqual([])
    }
  })
})

describe('net-engine ssh (run by the other computer)', () => {
  /** What `runNetEngineSsh` writes for `input`, asking `serve` for the reply. */
  async function run(input: string, serve: (request: unknown) => Promise<Record<string, unknown> | undefined>) {
    const stdin = new PassThrough()
    let out = ''
    const done = runNetEngineSsh({ stdin, stdout: { write: (text: string) => (out += text) }, serve })
    stdin.write(input)
    await done
    stdin.destroy()
    return out.split('\n').filter(Boolean)
  }

  it('refuses a request past its limit, or one that never ends its line, without reaching the service', async () => {
    const serve = vi.fn(async () => ({}))
    expect(await run(`${'x'.repeat(70 * 1024)}\n`, serve)).toEqual(['mousse-ssh/1', '{"error":"bad_request"}'])
    expect(serve).not.toHaveBeenCalled()
    vi.useFakeTimers()
    try {
      const reading = run('{"op":', serve)
      await vi.advanceTimersByTimeAsync(ENGINE_LIMIT_DEFAULTS.sshRemoteReadMs + 1)
      expect(await reading).toEqual(['mousse-ssh/1', '{"error":"bad_request"}'])
    } finally {
      vi.useRealTimers()
    }
    expect(serve).not.toHaveBeenCalled()
  })

  it('its request limits can only be lowered', () => {
    const lower = readEngineLimits({ MOUSSE_NET_ENGINE_SSH_REMOTE_REQUEST_MAX_BYTES: '1024', MOUSSE_NET_ENGINE_SSH_REMOTE_READ_MS: '5000' })
    expect(lower.limits).toMatchObject({ sshRemoteRequestMaxBytes: 1024, sshRemoteReadMs: 5000 })
    const higher = readEngineLimits({ MOUSSE_NET_ENGINE_SSH_REMOTE_REQUEST_MAX_BYTES: String(1 << 30), MOUSSE_NET_ENGINE_SSH_REMOTE_READ_MS: '3600000' })
    expect(higher.limits).toMatchObject({
      sshRemoteRequestMaxBytes: ENGINE_LIMIT_DEFAULTS.sshRemoteRequestMaxBytes,
      sshRemoteReadMs: ENGINE_LIMIT_DEFAULTS.sshRemoteReadMs
    })
    expect(higher.problems).toHaveLength(2)
  })

  it('a service without a method says the command is not there yet', () => {
    // What the service answers for a method it does not have (`validateRequest`).
    expect(netEngineFailure({ code: 'method_not_allowed', message: 'Method not allowed: netEngine.join.code' })).toMatchObject({ code: 'not_supported' })
  })
})
