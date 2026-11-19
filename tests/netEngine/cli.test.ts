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
  joinDestinations,
  netEngineFailure,
  prepareNetEngineCommand,
  readRequestLine,
  routeLabel,
  runNetEngineSshRemote,
  type NetEngineCliClient,
  type NetEngineCliIO
} from '../../src/cli/commands/netEngine'
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

  it('lists what a link would dial on its own, what needs a yes, and what it never dials', () => {
    expect(joinDestinations(LINK)).toEqual({
      automatic: ['tcp://192.168.1.5:7000'],
      approve: ['tcp://100.101.1.2:7000', 'wss://x.example/mousse-net/1'],
      skipped: ['ws://127.0.0.1:9/mousse-net/1']
    })
    expect(['tcp://192.168.1.5:7000', 'tcp://100.101.1.2:7000', 'tcp://203.0.113.7:1', 'wss://x.example/mousse-net/1'].map(routeLabel)).toEqual(
      ['LAN', 'Tailnet', 'Internet', 'Tunnel']
    )
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

    await executeNetEngineCommand({ kind: 'remove', device: 'Caller Computer' }, cli(owner), terminal().io)
    await eventually(() => expect(rowFor(owner, caller)).toBeUndefined())
  }, 60_000)

  it('a device that is not there is refused by name', async () => {
    const error = await executeNetEngineCommand({ kind: 'remove', device: 'nobody' }, cli(owner), terminal().io).catch((e) => e)
    expect(netEngineFailure(error)).toMatchObject({ code: 'bad_request', exitCode: 2, error: expect.stringMatching(/No device is called nobody/) })
  })
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
          return { devices: [], approvals: [], joins: pending ? [{ invitation: '09'.repeat(16), codeNeeded: true, attemptsLeft: tries, failed: tries < 3 }] : [] } as never
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
    expect(term.said[0]).toMatch(/192\.168\.1\.5:7000 \(LAN\).*100\.101\.1\.2:7000 \(Tailnet\).*x\.example \(Tunnel\)/s)
    expect(term.said[0]).toMatch(/Skipped: 127\.0\.0\.1:9 \(Tunnel\)/)
    const join = calls.find(([method]) => method === 'netEngine.join')![1]
    expect(join).toEqual({ ticket: LINK, arrival: 'link', approved: ['tcp://100.101.1.2:7000', 'wss://x.example/mousse-net/1'] })
    // The five-digit one never left the terminal.
    expect(calls.filter(([method]) => method === 'netEngine.join.code').map(([, p]) => p.code)).toEqual(['111111', '123456'])
    expect(term.said.some((line) => /didn't work/.test(line))).toBe(true)
    expect(term.emitted[0]!.text).toMatch(/Paired with Studio/)
  })

  it('a No sends nothing; without a terminal nothing is asked or sent, --yes included', async () => {
    const no = service('123456')
    expect(await executeNetEngineCommand({ kind: 'join', ticket: LINK, yes: false }, no.client, terminal(['n']).io)).toBe(1)
    expect(no.calls).toEqual([])
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
  const args = parseArgs(['net-engine', 'ssh'])
  async function run(input: string | Buffer, connect: any): Promise<string[]> {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const out: string[] = []
    stdout.on('data', (chunk) => out.push(String(chunk)))
    stdin.end(input)
    await runNetEngineSshRemote(args, stdin, stdout, connect)
    return out.join('').split('\n').filter(Boolean)
  }

  it('writes the marker first and never starts the service', async () => {
    const connect = vi.fn(async () => {
      throw new Error('MMS daemon is not running')
    })
    expect(await run('{"op":"profiles"}\n', connect)).toEqual(['mousse-ssh/1', '{"error":"remote_not_running"}'])
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ disableAutoStart: true }))
  })

  it('passes one request to the running service and answers its reply on one line', async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === 'profiles.status') return { defaultProfileId: 'p1' }
      if (method === 'netEngine.ssh.remote') return { computer: 'box', profiles: [], echo: params }
      return {}
    })
    const lines = await run('{"op":"profiles"}\n', async () => ({ request, close: async () => undefined }))
    expect(lines[0]).toBe('mousse-ssh/1')
    expect(JSON.parse(lines[1]!)).toEqual({ computer: 'box', profiles: [], echo: { request: { op: 'profiles' } } })
    expect(request).toHaveBeenCalledWith('profiles.bind', { profile: 'p1' })
  })

  it('refuses a request past its limit, or not an object, without reaching the service', async () => {
    const connect = vi.fn()
    expect(await run(`${'x'.repeat(70 * 1024)}\n`, connect)).toEqual(['mousse-ssh/1', '{"error":"bad_request"}'])
    expect(await run('[1]\n', connect)).toEqual(['mousse-ssh/1', '{"error":"bad_request"}'])
    expect(connect).not.toHaveBeenCalled()
  })

  it('a service without the 1b methods says the command is not there yet', () => {
    // What the service answers for a method it does not have (`validateRequest`).
    expect(netEngineFailure({ code: 'method_not_allowed', message: 'Method not allowed: netEngine.routes.config' })).toMatchObject({ code: 'not_supported' })
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

  it('reads one line, at most the limit, within the wait', async () => {
    const quiet = new PassThrough()
    await expect(readRequestLine(quiet, 10, 20)).rejects.toThrow('timeout')
    const split = new PassThrough()
    const reading = readRequestLine(split, 10, 1000)
    split.write('{"a"')
    split.write(':1}\nrest')
    expect(await reading).toBe('{"a":1}')
  })
})
