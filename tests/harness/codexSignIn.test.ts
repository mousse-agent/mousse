/**
 * A second Codex account with its own home, signed in from the app. An added Codex instance on the
 * user's own Codex CLI has its own `CODEX_HOME`; Mousse runs `codex login --device-auth` there in a
 * terminal and `codex logout` to sign out. Everything here is fake: a terminal driven by the test, a
 * `codex` script that prints a version and signs a home out, a scripted app-server that reads who is
 * signed in from the home it runs in, and temporary homes with made-up accounts. No real sign-in,
 * credential or `~/.codex` is read or written.
 */
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { format } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderOperationEvent } from '../../src/shared/harness/types'
import type { DriverContext, DriverRuntime } from '../../src/mms/harness/driver'
import { CODEX_NOT_STORED_MESSAGE, codexDeviceCode, codexDriver, codexSignInCommand, decodeCodexConfig } from '../../src/mms/harness/drivers/codex'
import { createHarnessGateway, type TurnSpec } from '../../src/mms/harness/gateway'
import { instanceEnv, ownedLaunchEnv, ownedUserEnv, reservedEnvName } from '../../src/mms/harness/env'
import { instanceStateDir, InstanceCounterStore } from '../../src/mms/harness/instances'
import { ownedHomeProblem } from '../../src/mms/harness/ownedHome'
import type { PtySpawn } from '../../src/mms/harness/pty'
import { observeHarnessSpawns, recordHarnessSpawn, type HarnessSpawn } from '../../src/mms/harness/spawn'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import type { CodexLaunch, CodexProcess } from '../../src/mms/providers/codex/CodexAppServerClient'
import { CodexProviderService } from '../../src/mms/providers/codex/CodexProviderService'

const dirs: string[] = []
const stops: Array<() => void> = []

/**
 * The user's own sign-in in every place Codex looks for one, in Mousse's environment: its home and
 * state database, access tokens and keys, OpenAI, Azure OpenAI and ChatGPT routes, login servers and
 * identity services, and Amazon Bedrock. No private home may ever see any of them.
 */
const AMBIENT: Record<string, string> = {
  OPENAI_API_KEY: 'ambient-openai-key',
  CODEX_API_KEY: 'ambient-codex-key',
  CODEX_ACCESS_TOKEN: 'ambient-access-token',
  ACCESS_TOKEN: 'ambient-bare-token',
  CODEX_SQLITE_HOME: 'ambient-users-sqlite',
  CODEX_APP_SERVER_LOGIN_ISSUER: 'https://ambient-issuer.example.test',
  CODEX_AGENT_IDENTITY_JWKS_BASE_URL: 'https://ambient-jwks.example.test',
  CODEX_GITHUB_PERSONAL_ACCESS_TOKEN: 'ambient-github',
  CODEX_AUTH_TOKEN: 'ambient-auth-token',
  OPENAI_BASE_URL: 'https://ambient-gateway.example.test',
  OPENAI_ORG_ID: 'ambient-org',
  AZURE_OPENAI_API_KEY: 'ambient-azure-key',
  AZURE_OPENAI_ENDPOINT: 'https://ambient-azure.example.test',
  AZURE_CLIENT_SECRET: 'ambient-azure-secret',
  CHATGPT_ACCESS_TOKEN: 'ambient-chatgpt',
  AWS_BEARER_TOKEN_BEDROCK: 'ambient-bedrock-token',
  AWS_PROFILE: 'ambient-aws-profile',
  AWS_ACCESS_KEY_ID: 'ambient-aws-key',
  // Not a credential: a company network needs it, so a private home keeps it.
  CODEX_CA_CERTIFICATE: '/ambient/certs/company.pem'
}
const NOT_DROPPED = ['CODEX_CA_CERTIFICATE']
const ambientNames = [...Object.keys(AMBIENT), 'CODEX_HOME']
const ambient = Object.fromEntries(ambientNames.map((name) => [name, process.env[name]]))

/** The user's own Codex home (`~/.codex`) in this test: a temporary folder holding a made-up account. */
let userHome: string

beforeEach(() => {
  userHome = tempDir('mousse-user-codex')
  writeSignIn(userHome, 'acct-own')
  Object.assign(process.env, AMBIENT, { CODEX_HOME: userHome })
})
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  for (const [name, value] of Object.entries(ambient)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A folder whose name has a space in it, as a Windows profile path often does. */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix} `))
  dirs.push(dir)
  return dir
}

/**
 * A `codex` that prints a version and signs a home out (`logout`): a node script, behind an
 * npm-style shim on Windows. Its login is the fake terminal below.
 */
function fakeCodex(): string {
  const dir = tempDir('mousse-fakecodex')
  mkdirSync(join(dir, 'node_modules', 'codex'), { recursive: true })
  const script = join(dir, 'node_modules', 'codex', 'cli.js')
  writeFileSync(join(dir, 'node_modules', 'codex', 'package.json'), JSON.stringify({ name: 'codex' }))
  writeFileSync(script, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    'const args = process.argv.slice(2)',
    "if (args.includes('--version')) { console.log('codex-cli 0.162.1'); process.exit(0) }",
    'const home = process.env.CODEX_HOME',
    "if (args[0] === 'logout') {",
    // A logout that fails, or says it worked and did nothing (set on the instance's variables).
    "  if (process.env.FAKE_LOGOUT === 'fail') process.exit(3)",
    "  if (process.env.FAKE_LOGOUT === 'noop') process.exit(0)",
    "  const file = home ? path.join(home, 'auth.json') : ''",
    '  if (!file || !fs.existsSync(file)) process.exit(1)',
    '  fs.rmSync(file)',
    '  process.exit(0)',
    '}',
    'process.exit(2)'
  ].join('\n') + '\n')
  if (process.platform === 'win32') {
    const shim = join(dir, 'codex.cmd')
    writeFileSync(shim, `@ECHO off\r\n"%~dp0\\node_modules\\codex\\cli.js" %*\r\n`)
    return shim
  }
  chmodSync(script, 0o755)
  return script
}

/** What a completed Codex sign-in leaves in a home: the account the app-server reads, and a fake secret. */
function writeSignIn(home: string, account: string): void {
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ account, tokens: { refresh_token: `secret-token-of-${account}` } }))
}

/** The account a home holds, as the scripted app-server answers `account/read` for it. */
function accountOf(home: string | undefined): string | undefined {
  if (!home) return undefined
  try {
    return (JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8')) as { account: string }).account
  } catch {
    return undefined
  }
}

interface FakeTerminal {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  cols: number
  cwd: string | undefined
  written: string[]
  kills: number
  /** App-servers still running when this terminal started. */
  serversRunning: number
  /** The command prints `text`. */
  print(text: string): void
  /** The command ends; with `account` and code 0 it has signed that account in to its home. */
  exit(code: number, account?: string): void
}

function terminalFactory(running: () => number) {
  const terminals: FakeTerminal[] = []
  const spawn: PtySpawn = (command, args, options) => {
    let data: (text: string) => void = () => {}
    let onExit: (event: { exitCode: number }) => void = () => {}
    let ended = false
    const end = (code: number) => {
      if (ended) return
      ended = true
      onExit({ exitCode: code })
    }
    const terminal: FakeTerminal = {
      command,
      args,
      env: options.env,
      cols: options.cols,
      cwd: options.cwd,
      written: [],
      kills: 0,
      serversRunning: running(),
      print: (text) => data(text),
      exit: (code, account) => {
        if (ended) return
        const home = options.env.CODEX_HOME
        if (code === 0 && account && home) writeSignIn(home, account)
        end(code)
      }
    }
    terminals.push(terminal)
    return {
      pid: 0,
      onData: (listener) => ((data = listener), { dispose: () => {} }),
      onExit: (listener) => ((onExit = listener), { dispose: () => {} }),
      // A killed command ends, as it does in a real terminal.
      kill: () => {
        terminal.kills += 1
        queueMicrotask(() => end(1))
      },
      write: (text) => void terminal.written.push(text)
    }
  }
  return { terminals, spawn }
}

type Message = { id?: number | string; method?: string; params?: unknown }

/**
 * Codex app-servers that answer from the home they run in: signed in when the home holds
 * `auth.json`. Every launch is recorded with its environment; a process is "running" until killed.
 */
function appServers() {
  const launches: Array<{ env: NodeJS.ProcessEnv; cwd: string | undefined; args: string[] }> = []
  const processes: Array<EventEmitter & CodexProcess> = []
  const launch = (spec: CodexLaunch): CodexProcess => {
    launches.push({ env: spec.env, cwd: spec.cwd, args: spec.args })
    const stdout = new PassThrough()
    const stdin = new PassThrough()
    const process = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill(signal: NodeJS.Signals = 'SIGTERM') {
        if (process.signalCode) return false
        process.signalCode = signal
        setImmediate(() => process.emit('exit', null, signal))
        return true
      }
    })
    let pending = ''
    stdin.on('data', (chunk: Buffer) => {
      pending += chunk.toString()
      let end: number
      while ((end = pending.indexOf('\n')) !== -1) {
        const message = JSON.parse(pending.slice(0, end)) as Message
        pending = pending.slice(end + 1)
        if (message.id === undefined || !message.method) continue
        let reply: unknown
        if (message.method === 'initialize') reply = { result: { userAgent: 'test', codexHome: spec.env.CODEX_HOME, platformFamily: 'unix', platformOs: 'macos' } }
        else if (message.method === 'account/read') {
          const account = accountOf(spec.env.CODEX_HOME)
          reply = { result: { account: account ? { type: 'chatgpt', email: `${account}@example.test`, planType: 'plus' } : null, requiresOpenaiAuth: true } }
        } else if (message.method === 'model/list') reply = { result: { data: [{ id: 'gpt-test', displayName: 'GPT Test', hidden: false, supportedReasoningEfforts: [] }], nextCursor: null } }
        else reply = { error: { code: -32000, message: 'replay ends here' } }
        stdout.write(JSON.stringify({ id: message.id, ...(reply as object) }) + '\n')
      }
    })
    processes.push(process as unknown as EventEmitter & CodexProcess)
    return process as unknown as CodexProcess
  }
  const running = () => processes.filter((entry) => entry.signalCode === null && entry.exitCode === null).length
  return { launch, launches, processes, running }
}

const WORK = 'codex:work'
const HOME = 'codex:home'
const OWN_HOME = 'codex:mine'

/** An added entry on the user's own Codex CLI, with a home of its own. */
const privateEntry = (displayName: string, binary: string, extra: Record<string, unknown> = {}) =>
  ({ driver: 'codex', enabled: true, config: { home: 'private', setup: 'existing', displayName, binaryPath: binary, ...extra } })

interface WorldOptions {
  profileHome?: string
  /** The stored instances, given this world's `codex` (default: the user's own and `codex:work`). */
  stored?: (binary: string) => Record<string, unknown>
  /** A sign-in terminal runs (default); false: none runs here. */
  terminal?: boolean
  signInTimeoutMs?: number
  /** A managed entry's runtime (default: none is stored, so none is built). */
  managed?: (context: DriverContext) => DriverRuntime
}

function world(options: WorldOptions = {}) {
  const profileHome = options.profileHome ?? tempDir('mousse-codex-signin')
  const binary = fakeCodex()
  const questions = new UserQuestionService()
  const servers = appServers()
  const terminal = terminalFactory(servers.running)
  const spawns: HarnessSpawn[] = []
  // The user's own Codex: the profile's service, as `MmsProfileServices` builds it.
  const builtInServers = appServers()
  const builtIn = new CodexProviderService(profileHome, questions, {
    findBinary: () => binary,
    launch: (spec) => {
      // `MmsProfileServices` reports the built-in's app-server to the spawn observers the same way.
      recordHarnessSpawn({ instanceId: 'codex', purpose: 'app-server', command: spec.binary, args: spec.args, env: spec.env })
      return builtInServers.launch(spec)
    }
  }, { launch: () => ({ binaryPath: binary }) })
  let stored: unknown = options.stored?.(binary) ?? {
    codex: { driver: 'codex', enabled: true },
    [WORK]: privateEntry('Work', binary)
  }
  const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
  const harness = createHarnessGateway({
    profileHome,
    installationHome: profileHome,
    instanceMap: instances,
    questions,
    shellPath: async () => ({ entries: [], source: 'failed' }),
    drivers: [
      codexDriver({
        builtIn: () => builtIn,
        pty: { available: () => options.terminal !== false, spawn: terminal.spawn },
        launch: servers.launch,
        ...(options.managed ? { managed: options.managed } : {}),
        ...(options.signInTimeoutMs ? { signInTimeoutMs: options.signInTimeoutMs } : {})
      })
    ]
  })
  const unobserve = observeHarnessSpawns((spawned) => spawns.push(spawned))
  const stop = () => {
    unobserve()
    harness.stop()
    builtIn.stop()
  }
  stops.push(stop)
  const homeOf = (instanceId: string) => join(instanceStateDir(profileHome, instanceId), 'home')
  return { profileHome, binary, harness, builtIn, builtInServers, servers, terminals: terminal.terminals, spawns, homeOf, stop, stored: () => stored }
}

type World = ReturnType<typeof world>

/** Starts a sign-in and collects its operation events. */
async function startSignIn(w: World, instanceId: string) {
  const events: ProviderOperationEvent[] = []
  const unsubscribe = w.harness.instances.subscribe((event) => {
    if (event.type === 'operation' && event.data.instanceId === instanceId) events.push(event.data)
  })
  stops.push(unsubscribe)
  const seen = w.terminals.length
  const started = await w.harness.instances.signIn(instanceId)
  const terminal = async () => {
    await vi.waitFor(() => expect(w.terminals.length).toBeGreaterThan(seen), { timeout: 5_000 })
    return w.terminals[seen]!
  }
  const settled = async () => {
    await vi.waitFor(() => expect(events.some((event) => ['completed', 'failed', 'cancelled'].includes(event.phase))).toBe(true), { timeout: 5_000 })
    return events.find((event) => ['completed', 'failed', 'cancelled'].includes(event.phase))!
  }
  const prompts = () => events.flatMap((event) => (event.phase === 'prompt' ? [event.prompt] : []))
  return { started, events, terminal, settled, prompts }
}

/** What `codex login --device-auth` prints (the wording is Codex's own; the code and link are made up). */
const DEVICE_OUTPUT =
  'Welcome to Codex\r\n\r\nFollow these steps to sign in with ChatGPT using device code authorization:\r\n\r\n' +
  '1. Open this link in your browser and sign in to your account\r\n   https://auth.openai.com/codex/device\r\n\r\n' +
  '2. Enter this one-time code (expires in 15 minutes)\r\n   ABCD-EFGHI\r\n\r\nDevice codes are a common phishing target. Never share this code.\r\n'

function turnSpec(instanceId: string, binding: TurnSpec['binding'], cwd: string): TurnSpec {
  const noop = () => {}
  return {
    binding,
    input: {
      runId: `run-${instanceId}`, attemptId: `attempt-${instanceId}`, threadId: `thread-${instanceId}`, cwd, instanceId,
      model: 'gpt-test', llmProvider: 'codex', modelPinned: true, mode: 'agent', prompt: 'hello',
      messages: [], nativeHistory: '', signal: new AbortController().signal
    },
    sink: {
      text: noop, thinking: noop, tool: noop, nativeMessages: noop, compaction: noop, retry: noop, progress: noop,
      usage: noop, providerRef: noop, steerAccepted: noop, providerMetrics: noop, lineEdits: noop
    },
    control: { drainSteer: () => undefined, heartbeat: noop },
    host: { tools: {}, context: { recoverOverflow: () => null, prepareNativeContext: () => null, nativeHistoryAfterTurn: () => '' } }
  }
}

/** A turn on `instanceId`; the scripted app-server ends it at once, after the process was launched with its environment. */
async function turn(w: World, instanceId: string, purpose: 'turn' | 'delegate_task' = 'turn'): Promise<void> {
  const resolved = w.harness.resolveStored({ instanceId, llmProvider: '', model: 'gpt-test' }, { purpose })
  const spec = turnSpec(instanceId, await w.harness.bind(resolved, { mode: 'agent' }), tempDir('mousse-cwd'))
  await w.harness.startTurn(spec).result.catch(() => undefined)
}

const accountGeneration = (w: World, instanceId: string) =>
  new InstanceCounterStore(w.profileHome).get(instanceId).accountGeneration

/** Every environment a process of `instanceId` started with in `w`: checks, chats, version, sign-in and sign-out. */
const envsOf = (w: World, instanceId: string, ...more: NodeJS.ProcessEnv[]): NodeJS.ProcessEnv[] => [
  ...w.spawns.filter((spawned) => spawned.instanceId === instanceId).map((spawned) => spawned.env),
  ...more
]

describe('sign in from the app', () => {
  it('runs `codex login --device-auth` in the private home, shows the code once, and counts only a confirmed sign-in', async () => {
    const w = world()
    const before = await w.harness.instances.recheck(WORK)
    // The page offers the Sign in button, with the command to copy kept beside it.
    expect(before.auth).toMatchObject({ state: 'signed_out', canSignIn: true })
    expect(before.nextStep).toMatchObject({ action: 'sign_in', label: 'Sign in', command: expect.stringContaining(w.homeOf(WORK)) })
    expect(before.nextStep?.command).toContain('codex login --device-auth')
    const generation = accountGeneration(w, WORK)

    const signIn = await startSignIn(w, WORK)
    const terminal = await signIn.terminal()
    expect(terminal.args.slice(-2)).toEqual(['login', '--device-auth'])
    // It starts in the private home, so no project settings of Mousse's own folder are read.
    expect(terminal.cwd).toBe(w.homeOf(WORK))
    // The private home is set; `HOME` is the user's own, and no ambient credential comes along.
    expect(terminal.env.CODEX_HOME).toBe(w.homeOf(WORK))
    expect(terminal.env.HOME).toBe(process.env.HOME)
    expect(terminal.env.OPENAI_API_KEY).toBeUndefined()
    expect(terminal.env.CODEX_API_KEY).toBeUndefined()
    // Wide enough that a long link is not cut into lines.
    expect(terminal.cols).toBeGreaterThanOrEqual(500)

    // The same output twice still shows one code.
    terminal.print(DEVICE_OUTPUT)
    terminal.print(DEVICE_OUTPUT)
    await vi.waitFor(() => expect(signIn.prompts().some((prompt) => prompt.type === 'device_code')).toBe(true))
    const codes = signIn.prompts().filter((prompt) => prompt.type === 'device_code')
    expect(codes).toHaveLength(1)
    expect(codes[0]).toMatchObject({ userCode: 'ABCD-EFGHI', verificationUri: 'https://auth.openai.com/codex/device', expiresInSeconds: 900 })
    // Codex asks for nothing to be pasted: nothing is typed into the terminal.
    expect(terminal.written).toEqual([])

    terminal.print('\r\nSuccessfully logged in\r\n')
    terminal.exit(0, 'acct-work')
    expect((await signIn.settled()).phase).toBe('completed')
    expect(accountGeneration(w, WORK)).toBeGreaterThan(generation)
    const after = await w.harness.instances.recheck(WORK)
    expect(after.auth).toMatchObject({ state: 'signed_in', canSignOut: true })
    expect(after.auth.canSignIn).toBeUndefined()
    // The account's models are listed, so the pickers offer it.
    expect(after.models.entries.map((entry) => entry.id)).toContain('gpt-test')
  })

  it('stops every app-server of the home before the sign-in starts, and starts a new one to read the result', async () => {
    const w = world()
    await w.harness.instances.recheck(WORK)
    expect(w.servers.running()).toBeGreaterThan(0)
    const launched = w.servers.launches.length
    const signIn = await startSignIn(w, WORK)
    const terminal = await signIn.terminal()
    // A running one keeps the account it started with and would write it back over the new sign-in.
    expect(terminal.serversRunning).toBe(0)
    terminal.exit(0, 'acct-work')
    expect((await signIn.settled()).phase).toBe('completed')
    expect(w.servers.launches.length).toBeGreaterThan(launched)
    expect(accountOf(w.homeOf(WORK))).toBe('acct-work')
  })

  it('shows the link and code only for Codex\'s own sign-in step, and only once the code line is complete', () => {
    expect(codexDeviceCode(DEVICE_OUTPUT)).toEqual({ url: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGHI' })
    // Behind terminal colours and cursor codes.
    expect(codexDeviceCode(DEVICE_OUTPUT.replace('ABCD-EFGHI', '\x1b[94mABCD-EFGHI\x1b[0m').replace('https', '\x1b]8;;x\x07https'))).toMatchObject({ userCode: 'ABCD-EFGHI' })
    // An update notice before the step is not the sign-in link.
    expect(codexDeviceCode('Update available! https://github.com/example/releases/latest\r\n' + DEVICE_OUTPUT)?.url).toBe('https://auth.openai.com/codex/device')
    // Half a code, half a link, or the step without a code: nothing yet.
    expect(codexDeviceCode(DEVICE_OUTPUT.slice(0, DEVICE_OUTPUT.indexOf('EFGHI')))).toBeUndefined()
    expect(codexDeviceCode(DEVICE_OUTPUT.slice(0, DEVICE_OUTPUT.indexOf('/codex/device') + 5))).toBeUndefined()
    expect(codexDeviceCode('Update available! https://github.com/example/releases/latest\r\n')).toBeUndefined()
    expect(codexDeviceCode('')).toBeUndefined()
  })

  it('cancel ends the terminal and its tree, and a late success changes nothing', async () => {
    const w = world()
    await w.harness.instances.recheck(WORK)
    const generation = accountGeneration(w, WORK)
    const signIn = await startSignIn(w, WORK)
    const terminal = await signIn.terminal()
    terminal.print(DEVICE_OUTPUT)
    await vi.waitFor(() => expect(signIn.prompts().length).toBeGreaterThan(0))
    expect(await w.harness.instances.respondSignIn(signIn.started.operationId, { kind: 'cancel' })).toBe(true)
    expect((await signIn.settled()).phase).toBe('cancelled')
    expect(terminal.kills).toBeGreaterThan(0)
    // The browser finishes after the cancel: nothing is signed in.
    terminal.exit(0, 'acct-work')
    expect(existsSync(join(w.homeOf(WORK), 'auth.json'))).toBe(false)
    expect(accountGeneration(w, WORK)).toBe(generation)
    expect((await w.harness.instances.recheck(WORK)).auth.state).toBe('signed_out')
  })

  it('a cancel after Codex accepted the sign-in lets it finish its files, then takes the account up', async () => {
    const w = world()
    await w.harness.instances.recheck(WORK)
    const signIn = await startSignIn(w, WORK)
    const terminal = await signIn.terminal()
    terminal.print(DEVICE_OUTPUT + 'Successfully logged in\r\n')
    await vi.waitFor(() => expect(signIn.prompts().length).toBeGreaterThan(0))
    await w.harness.instances.respondSignIn(signIn.started.operationId, { kind: 'cancel' })
    // Not killed while it writes its files: it gets time to exit by itself.
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(terminal.kills).toBe(0)
    terminal.exit(0, 'acct-work')
    expect((await signIn.settled()).phase).toBe('cancelled')
    expect((await w.harness.instances.recheck(WORK)).auth).toMatchObject({ state: 'signed_in', canSignOut: true })
  })

  it('a sign-in nobody finishes is ended after its time and reports why', async () => {
    const w = world({ signInTimeoutMs: 40 })
    await w.harness.instances.recheck(WORK)
    const signIn = await startSignIn(w, WORK)
    const terminal = await signIn.terminal()
    terminal.print(DEVICE_OUTPUT)
    const result = await signIn.settled()
    expect(result).toMatchObject({ phase: 'failed', error: { message: 'Sign-in timed out. Start it again.' } })
    expect(terminal.kills).toBeGreaterThan(0)
    expect((await w.harness.instances.recheck(WORK)).auth.state).toBe('signed_out')
  })

  it('a command that exits with an error fails the sign-in without a new account', async () => {
    const w = world()
    await w.harness.instances.recheck(WORK)
    const generation = accountGeneration(w, WORK)
    const signIn = await startSignIn(w, WORK)
    const terminal = await signIn.terminal()
    terminal.exit(1)
    expect(await signIn.settled()).toMatchObject({ phase: 'failed', error: { message: 'codex login exited with code 1.' } })
    expect(accountGeneration(w, WORK)).toBe(generation)
  })

  it('exit 0 without a sign-in in the home is a failure that names the credential store, with no new account', async () => {
    const w = world()
    await w.harness.instances.recheck(WORK)
    const generation = accountGeneration(w, WORK)
    const signIn = await startSignIn(w, WORK)
    const terminal = await signIn.terminal()
    terminal.exit(0)
    const failed = await signIn.settled()
    expect(failed).toMatchObject({ phase: 'failed', error: { message: CODEX_NOT_STORED_MESSAGE } })
    expect(CODEX_NOT_STORED_MESSAGE).toMatch(/credential store.*file/)
    expect(accountGeneration(w, WORK)).toBe(generation)
    expect((await w.harness.instances.recheck(WORK)).auth.canSignOut).toBe(false)
  })

  it('without a sign-in terminal the page shows the command to copy, with the private home in it, and checks again on request', async () => {
    const w = world({ terminal: false })
    const snapshot = await w.harness.instances.recheck(WORK)
    expect(snapshot.auth.canSignIn).toBeUndefined()
    expect(snapshot.nextStep?.command).toContain(w.homeOf(WORK))
    expect(snapshot.nextStep?.command).toContain('codex login --device-auth')
    // Starting one anyway spawns no terminal: it waits for the sign-in made in the user's own.
    const signIn = await startSignIn(w, WORK)
    await vi.waitFor(() => expect(signIn.prompts().some((prompt) => prompt.type === 'select')).toBe(true))
    expect(w.terminals).toHaveLength(0)
    expect(JSON.stringify(signIn.prompts())).toContain(JSON.stringify(w.homeOf(WORK)).slice(1, -1))
    // The user ran it: the next check starts a new Codex process and finds the account.
    writeSignIn(w.homeOf(WORK), 'acct-work')
    const select = signIn.prompts().find((prompt) => prompt.type === 'select')!
    await w.harness.instances.respondSignIn(signIn.started.operationId, { promptId: select.promptId, kind: 'select', value: 'check' })
    expect((await signIn.settled()).phase).toBe('completed')
    expect((await w.harness.instances.recheck(WORK)).auth).toMatchObject({ state: 'signed_in', canSignOut: true })
  })

  it('sign in, sign out, sign in again; the second sign-in works after the service is rebuilt from disk', async () => {
    const profileHome = tempDir('mousse-codex-cycle')
    const first = world({ profileHome })
    await first.harness.instances.recheck(WORK)
    const signIn = async (w: World, account: string) => {
      const running = await startSignIn(w, WORK)
      const terminal = await running.terminal()
      terminal.print(DEVICE_OUTPUT)
      terminal.exit(0, account)
      expect((await running.settled()).phase).toBe('completed')
    }
    await signIn(first, 'acct-1')
    expect((await first.harness.instances.recheck(WORK)).auth.state).toBe('signed_in')

    const signedOut = await first.harness.instances.signOut(WORK)
    expect(signedOut.auth.state).toBe('signed_out')
    // `codex logout` ran in the private home, and the file it signs out is gone.
    const logout = first.spawns.find((spawned) => spawned.purpose === 'auth' && spawned.args.at(-1) === 'logout')
    expect(logout?.instanceId).toBe(WORK)
    expect(logout?.env.CODEX_HOME).toBe(first.homeOf(WORK))
    expect(existsSync(join(first.homeOf(WORK), 'auth.json'))).toBe(false)
    first.stop()

    // The disconnect is on disk (`settings.json`): the rebuilt service still starts signed out, and signs in again.
    expect(JSON.parse(readFileSync(join(instanceStateDir(profileHome, WORK), 'settings.json'), 'utf8')).disconnected).toBe(true)
    const second = world({ profileHome, stored: () => first.stored() as Record<string, unknown> })
    expect((await second.harness.instances.recheck(WORK)).auth.state).toBe('signed_out')
    await signIn(second, 'acct-2')
    expect((await second.harness.instances.recheck(WORK)).auth).toMatchObject({ state: 'signed_in', canSignOut: true })
    expect(JSON.parse(readFileSync(join(instanceStateDir(profileHome, WORK), 'settings.json'), 'utf8')).disconnected).toBeUndefined()
  })

  it('the user\'s own Codex never gets `logout`: its sign-in is the terminal\'s', async () => {
    const w = world()
    const own = await w.harness.instances.recheck('codex')
    expect(own.auth).toMatchObject({ state: 'signed_in', canSignOut: false })
    expect(own.auth.canSignIn).toBeUndefined()
    await w.harness.instances.signOut('codex')
    expect(w.spawns.filter((spawned) => spawned.args.includes('logout'))).toEqual([])
    expect(w.terminals).toHaveLength(0)
    // Its sign-in is still the terminal's, untouched.
    expect(accountOf(userHome)).toBe('acct-own')
  })
})

describe('signing out', () => {
  const signedInWorld = (env: Record<string, string> = {}) => {
    const w = world({ stored: (binary) => ({ codex: { driver: 'codex', enabled: true }, [WORK]: privateEntry('Work', binary, { env }) }) })
    writeSignIn(w.homeOf(WORK), 'acct-work')
    return w
  }
  const settings = (w: World) => JSON.parse(readFileSync(join(instanceStateDir(w.profileHome, WORK), 'settings.json'), 'utf8'))

  it('stops the home\'s app-server before it logs out, so nothing writes the sign-in back, and confirms with a new one', async () => {
    const w = signedInWorld()
    expect((await w.harness.instances.recheck(WORK)).auth.state).toBe('signed_in')
    expect(w.servers.running()).toBeGreaterThan(0)
    const done = await w.harness.instances.signOut(WORK)
    expect(done.auth.state).toBe('signed_out')
    expect(existsSync(join(w.homeOf(WORK), 'auth.json'))).toBe(false)
    const logout = w.spawns.findIndex((spawned) => spawned.args.at(-1) === 'logout')
    expect(logout).toBeGreaterThanOrEqual(0)
    expect(settings(w).disconnected).toBe(true)
  })

  it('a logout that fails while the account is still signed in is an error the user sees', async () => {
    const w = signedInWorld({ FAKE_LOGOUT: 'fail' })
    expect((await w.harness.instances.recheck(WORK)).auth.state).toBe('signed_in')
    await expect(w.harness.instances.signOut(WORK)).rejects.toThrow(/exited with code 3.*still signed in/)
    // The sign-in is still in the home; the gateway stopped using the account (it fails closed) and says so.
    expect(existsSync(join(w.homeOf(WORK), 'auth.json'))).toBe(true)
    const after = await w.harness.instances.recheck(WORK)
    expect(after.auth).toMatchObject({ state: 'signed_out', message: expect.stringContaining('Signed out in Mousse') })
  })

  it('a logout that says it worked while the account still reads signed in is an error too', async () => {
    const w = signedInWorld({ FAKE_LOGOUT: 'noop' })
    await w.harness.instances.recheck(WORK)
    await expect(w.harness.instances.signOut(WORK)).rejects.toThrow(/still reads signed in/)
    expect(existsSync(join(w.homeOf(WORK), 'auth.json'))).toBe(true)
  })

  it('a missing executable is an error the user sees, not a quiet sign-out', async () => {
    const w = world({ stored: () => ({ codex: { driver: 'codex', enabled: true }, [WORK]: privateEntry('Work', join(tempDir('mousse-nothing'), 'codex.exe')) }) })
    writeSignIn(w.homeOf(WORK), 'acct-work')
    await expect(w.harness.instances.signOut(WORK)).rejects.toThrow(/not found/)
    expect(existsSync(join(w.homeOf(WORK), 'auth.json'))).toBe(true)
    expect(w.spawns.filter((spawned) => spawned.args.includes('logout'))).toEqual([])
  })

  it('an executable that cannot start is an error the user sees', async () => {
    // A file that exists but is not a program: the spawn fails, and the account still reads signed in.
    const notProgram = join(tempDir('mousse-notprogram'), process.platform === 'win32' ? 'codex.exe' : 'codex')
    writeFileSync(notProgram, 'not a program')
    chmodSync(notProgram, 0o755)
    const w = world({ stored: () => ({ codex: { driver: 'codex', enabled: true }, [WORK]: privateEntry('Work', notProgram) }) })
    writeSignIn(w.homeOf(WORK), 'acct-work')
    await expect(w.harness.instances.signOut(WORK)).rejects.toThrow(/Codex was not signed out/)
    expect(existsSync(join(w.homeOf(WORK), 'auth.json'))).toBe(true)
  })

  it('a non-zero exit from an account that was already signed out is a sign-out', async () => {
    const w = world()
    expect((await w.harness.instances.recheck(WORK)).auth.state).toBe('signed_out')
    // The CLI exits 1: there is nothing to log out of, and the status check confirms it.
    const done = await w.harness.instances.signOut(WORK)
    expect(done.auth.state).toBe('signed_out')
    expect(w.spawns.some((spawned) => spawned.args.at(-1) === 'logout')).toBe(true)
    expect(settings(w).disconnected).toBe(true)
  })
})

describe('instance environment', () => {
  const user = 'C:\\Users\\me\\.codex'

  it('a configured home or key never reaches a status check, a turn, the sign-in or the sign-out of a private home, in any case', async () => {
    const w = world({
      stored: (binary) => ({
        codex: { driver: 'codex', enabled: true },
        [WORK]: privateEntry('Work', binary, {
          env: { codex_home: user, Codex_Home: user, CODEX_SQLITE_HOME: user, openai_api_key: 'configured-key', CODEX_API_KEY: 'configured-codex-key', Azure_OpenAI_Api_Key: 'configured-azure', OPENAI_BASE_URL: 'https://configured.example.test', aws_bearer_token_bedrock: 'x', KEEP_ME: '1' }
        })
      })
    })
    const home = w.homeOf(WORK)
    writeSignIn(home, 'acct-env')
    expect((await w.harness.instances.recheck(WORK)).auth.state).toBe('signed_in')
    await turn(w, WORK)
    // Sign-out and sign-in of that instance.
    await w.harness.instances.signOut(WORK)
    const signIn = await startSignIn(w, WORK)
    const terminal = await signIn.terminal()
    terminal.exit(1)
    await signIn.settled()

    const envs = [...w.servers.launches.map((launched) => launched.env), ...envsOf(w, WORK, terminal.env)]
    const kinds = new Set(w.spawns.filter((spawned) => spawned.instanceId === WORK).map((spawned) => spawned.purpose))
    expect([...kinds]).toEqual(expect.arrayContaining(['app-server', 'version', 'auth']))
    expect(envs.length).toBeGreaterThanOrEqual(6)
    for (const env of envs) {
      const names = Object.keys(env)
      // One spelling of each home variable, and it is the instance's own.
      expect(names.filter((name) => name.toUpperCase() === 'CODEX_HOME')).toHaveLength(1)
      expect(names.filter((name) => name.toUpperCase() === 'CODEX_SQLITE_HOME')).toHaveLength(1)
      expect(env.CODEX_HOME).toBe(home)
      expect(env.CODEX_SQLITE_HOME).toBe(home)
      expect(names.filter((name) => /^(OPENAI_|AZURE_|CHATGPT_|AWS_)|^CODEX_(?!HOME$|SQLITE_HOME$|CA_CERTIFICATE$)|^ACCESS_TOKEN$/i.test(name)), JSON.stringify(names)).toEqual([])
    }
    // What the user did configure and is free to set still applies.
    expect(terminal.env.KEEP_ME).toBe('1')
  })

  it('a private home runs on its own sign-in whatever route the user\'s environment selects; the user\'s own Codex is untouched', async () => {
    const w = world({ stored: (binary) => ({ codex: { driver: 'codex', enabled: true }, [WORK]: privateEntry('Work', binary) }) })
    const home = w.homeOf(WORK)
    writeSignIn(home, 'acct-work')
    await w.harness.instances.recheck(WORK)
    await turn(w, WORK)
    const signIn = await startSignIn(w, WORK)
    const terminal = await signIn.terminal()
    terminal.exit(1)
    await signIn.settled()
    await w.harness.instances.signOut(WORK).catch(() => undefined)
    const privateEnvs = [...w.servers.launches.map((launched) => launched.env), ...envsOf(w, WORK, terminal.env)]
    expect(privateEnvs.length).toBeGreaterThanOrEqual(6)
    // The state database is set to the home, so the user's own value is overridden rather than dropped.
    const dropped = Object.keys(AMBIENT).filter((name) => !NOT_DROPPED.includes(name) && name !== 'CODEX_SQLITE_HOME')
    for (const env of privateEnvs) {
      expect(env.CODEX_HOME).toBe(home)
      expect(env.CODEX_SQLITE_HOME).toBe(home)
      // No key, token, route, issuer or cloud credential of the user's survives, in any case of its name.
      for (const name of dropped) expect(Object.keys(env).filter((key) => key.toUpperCase() === name), name).toEqual([])
      // Not a credential: kept.
      expect(env.CODEX_CA_CERTIFICATE).toBe(AMBIENT.CODEX_CA_CERTIFICATE)
    }

    // The user's own Codex runs as before: its home, state and routes are the ones it inherited; only the keys it always dropped are gone.
    await w.harness.instances.recheck('codex')
    await turn(w, 'codex')
    const own = [...w.builtInServers.launches.map((launched) => launched.env), ...envsOf(w, 'codex')]
    expect(w.builtInServers.launches.length).toBeGreaterThanOrEqual(1)
    for (const env of w.builtInServers.launches.map((launched) => launched.env)) {
      expect(env.CODEX_HOME).toBe(userHome)
      for (const name of ['CODEX_SQLITE_HOME', 'CODEX_APP_SERVER_LOGIN_ISSUER', 'AWS_PROFILE', 'CODEX_CA_CERTIFICATE', 'ACCESS_TOKEN']) expect(env[name], name).toBe(AMBIENT[name])
      // The terminal sign-in is what it uses: Codex never runs on an API key here.
      expect(env.OPENAI_API_KEY).toBeUndefined()
    }
    expect(own.length).toBeGreaterThanOrEqual(2)
    for (const env of envsOf(w, 'codex')) expect(env.CODEX_HOME).toBe(userHome)
  })

  it.each([
    ['CODEX_HOME'], ['codex_home'], ['CODEX_SQLITE_HOME'], ['OPENAI_API_KEY'], ['openai_api_key'], ['CODEX_API_KEY'], ['CODEX_ACCESS_TOKEN'], ['ACCESS_TOKEN'],
    ['OPENAI_BASE_URL'], ['AZURE_OPENAI_API_KEY'], ['AZURE_OPENAI_ENDPOINT'], ['CHATGPT_ACCESS_TOKEN'], ['CODEX_APP_SERVER_LOGIN_ISSUER'],
    ['CODEX_AGENT_IDENTITY_JWKS_BASE_URL'], ['AWS_BEARER_TOKEN_BEDROCK'], ['AWS_PROFILE']
  ])('Settings refuses %s on a private home, and the user\'s own Codex may set it', async (name) => {
    const w = world()
    await expect(w.harness.instances.configure(WORK, { env: { [name]: 'x' } })).rejects.toMatchObject({ code: 'unsupported' })
    await expect(w.harness.instances.add({ driver: 'codex', config: { setup: 'existing', displayName: 'Other', env: { [name]: 'x' } } })).rejects.toMatchObject({ code: 'unsupported' })
    await expect(w.harness.instances.configure('codex', { env: { [name]: 'mine' } })).resolves.toBeDefined()
  })

  it('a variable that is free to set is welcome, and the editor says which stored ones are not used', async () => {
    const w = world({ stored: (binary) => ({ codex: { driver: 'codex', enabled: true }, [WORK]: privateEntry('Work', binary, { env: { OPENAI_API_KEY: 'x', CODEX_CA_CERTIFICATE: '/mine.pem', KEEP_ME: '1' } }) }) })
    const snapshot = await w.harness.instances.recheck(WORK)
    expect(snapshot.auth.message).toContain('Not used: OPENAI_API_KEY.')
    expect(snapshot.auth.message).not.toContain('KEEP_ME')
    expect(snapshot.auth.message).not.toContain('CODEX_CA_CERTIFICATE')
    const patched = await w.harness.instances.configure(WORK, { env: { CODEX_CA_CERTIFICATE: '/mine.pem', KEEP_ME: '1' } })
    expect(patched.config?.env).toEqual({ CODEX_CA_CERTIFICATE: '/mine.pem', KEEP_ME: '1' })
    expect((await w.harness.instances.recheck('codex')).auth.message).toBeUndefined()
  })

  it('on Windows names: one of each home variable whatever the case, spaces and backslashes kept, credentials gone', () => {
    const home = 'C:\\Users\\me\\Mousse Profiles\\p one\\harness\\codex_work\\home'
    const base = instanceEnv({
      instanceId: WORK,
      driver: 'codex',
      configRevision: 0,
      home,
      searchPath: [],
      base: { Path: 'C:\\Windows', Openai_Api_Key: 'user-key', codex_access_token: 'user-token', Aws_Profile: 'p', Azure_Client_Secret: 's', Codex_Ca_Certificate: 'C:\\ca.pem', KEEP: '1' }
    })
    const env = ownedLaunchEnv('codex', base, { Codex_Home: user, openai_api_key: 'x', PATH: 'C:\\Tools', KEEP: '2' })
    for (const name of ['CODEX_HOME', 'CODEX_SQLITE_HOME']) expect(Object.keys(env).filter((key) => key.toUpperCase() === name), name).toEqual([name])
    expect(env.CODEX_HOME).toBe(home)
    expect(env.CODEX_SQLITE_HOME).toBe(home)
    expect(Object.keys(env).filter((name) => /^(openai_|aws_|azure_|codex_access)/i.test(name))).toEqual([])
    expect(env.Codex_Ca_Certificate).toBe('C:\\ca.pem')
    expect(env.KEEP).toBe('2')
    expect(env.PATH ?? env.Path).toBeDefined()
    // An instance without a home runs as configured, and other drivers keep their own rules.
    expect(ownedLaunchEnv('codex', { env: { A: '1' } }, { OPENAI_API_KEY: 'mine' })).toEqual({ A: '1', OPENAI_API_KEY: 'mine' })
    expect(ownedUserEnv('codex', { codex_home: user, FINE: 'yes', CODEX_CA_CERTIFICATE: 'c' })).toEqual({ FINE: 'yes', CODEX_CA_CERTIFICATE: 'c' })
    expect(reservedEnvName('codex', 'Codex_Home')).toEqual({ kind: 'home', variable: 'CODEX_HOME' })
    expect(reservedEnvName('codex', 'CODEX_SQLITE_HOME')).toEqual({ kind: 'home', variable: 'CODEX_SQLITE_HOME' })
    expect(reservedEnvName('codex', 'openai_api_key')?.kind).toBe('credential')
    expect(reservedEnvName('codex', 'HOME')).toBeUndefined()
    expect(reservedEnvName('codex', 'CODEX_CA_CERTIFICATE')).toBeUndefined()
    expect(reservedEnvName('grok', 'GROK_HOME')).toBeUndefined()
  })

  it('the sign-in command passes the home as an environment value that Command Prompt, PowerShell and a shell all read', () => {
    const home = 'C:\\Users\\me\\Mousse Profiles\\p one\\harness\\codex_work\\home'
    expect(codexSignInCommand(home, 'win32')).toBe(`cmd /c "set CODEX_HOME=${home}&& codex login --device-auth"`)
    expect(codexSignInCommand('/home/me/Mousse Profiles/it\'s/home', 'linux')).toBe(`CODEX_HOME='/home/me/Mousse Profiles/it'\\''s/home' codex login --device-auth`)
    // The user's own Codex signs in as it always did.
    expect(codexSignInCommand(undefined, 'win32')).toBe('codex login')
  })

  it('a profile path with a space runs the sign-in from that home, passed as an argument-free environment value', async () => {
    const w = world()
    expect(w.profileHome).toContain(' ')
    await w.harness.instances.recheck(WORK)
    const signIn = await startSignIn(w, WORK)
    const terminal = await signIn.terminal()
    expect(terminal.env.CODEX_HOME).toBe(w.homeOf(WORK))
    expect(terminal.args.join(' ')).not.toContain(w.homeOf(WORK))
    terminal.exit(1)
    await signIn.settled()
  })
})

describe('two Codex accounts', () => {
  const threeAccounts = (binary: string) => ({
    codex: { driver: 'codex', enabled: true },
    [WORK]: privateEntry('Work', binary),
    [HOME]: privateEntry('Home', binary)
  })
  const snapshotOf = async (w: World, instanceId: string) => (await w.harness.instances.snapshots({ kind: 'device' })).find((snapshot) => snapshot.instanceId === instanceId)!

  it('each account keeps to its own home and its own app-server: nothing of one reaches the other or the user\'s own Codex', async () => {
    const w = world({ stored: threeAccounts })
    writeSignIn(w.homeOf(WORK), 'acct-work')
    writeSignIn(w.homeOf(HOME), 'acct-home')
    const written: string[] = []
    const consoles = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) => vi.spyOn(console, name).mockImplementation((...args: unknown[]) => void written.push(format(...args))))
    const events: unknown[] = []
    stops.push(w.harness.instances.subscribe((event) => events.push(event)))

    for (const id of [WORK, HOME, 'codex']) await w.harness.instances.recheck(id)
    for (const id of [WORK, HOME, 'codex']) await turn(w, id)
    await w.harness.instances.signOut(HOME)
    const signIn = await startSignIn(w, HOME)
    const terminal = await signIn.terminal()
    terminal.print(DEVICE_OUTPUT)
    await vi.waitFor(() => expect(signIn.prompts().some((prompt) => prompt.type === 'device_code')).toBe(true))
    terminal.exit(1)
    const failed = await signIn.settled()
    const snapshots = JSON.stringify(await w.harness.instances.snapshots({ kind: 'device' }))

    // Each instance's processes carry its own home and never another's.
    const spawned = w.spawns.filter((entry) => entry.instanceId.startsWith('codex'))
    expect(new Set(spawned.map((entry) => entry.instanceId))).toEqual(new Set(['codex', WORK, HOME]))
    const ownHome = (instanceId: string) => (instanceId === 'codex' ? userHome : w.homeOf(instanceId))
    for (const entry of spawned) {
      expect(entry.env.CODEX_HOME, `${entry.instanceId} ${entry.purpose}`).toBe(ownHome(entry.instanceId))
      const others = [WORK, HOME].filter((other) => other !== entry.instanceId).map((other) => w.homeOf(other))
      for (const value of Object.values(entry.env)) for (const other of others) expect(String(value), entry.instanceId).not.toContain(other)
    }
    expect(terminal.env.CODEX_HOME).toBe(w.homeOf(HOME))
    // Three app-servers, one per instance: no process is shared.
    expect(spawned.filter((entry) => entry.purpose === 'app-server').map((entry) => entry.instanceId).sort()).toEqual(expect.arrayContaining(['codex', WORK, HOME]))
    // Settings and saved threads live in their own folders.
    expect(existsSync(join(instanceStateDir(w.profileHome, WORK), 'settings.json'))).toBe(true)
    expect(existsSync(join(instanceStateDir(w.profileHome, HOME), 'settings.json'))).toBe(true)
    expect(instanceStateDir(w.profileHome, WORK)).not.toBe(instanceStateDir(w.profileHome, HOME))
    expect(readdirSync(join(w.profileHome, 'providers', 'codex'))).not.toContain('home')
    // The accounts, their sign-in files and the user's own are untouched by the other's sign-out and sign-in.
    expect(accountOf(w.homeOf(WORK))).toBe('acct-work')
    expect(accountOf(userHome)).toBe('acct-own')

    // Nothing of a credential or a link's code reaches a log, an event's text outside its own prompt, or a snapshot.
    const everything = [...written, snapshots, JSON.stringify(failed)].join('\n')
    for (const secret of ['ABCD-EFGHI', 'secret-token-of-acct-work', 'secret-token-of-acct-home', 'secret-token-of-acct-own', ...Object.values(AMBIENT).filter((value) => value.startsWith('ambient-')), 'acct-work', 'acct-home', 'acct-own'])
      expect(everything, secret).not.toContain(secret)
    // The code is shown to the user, and is in the prompt only: no file of the profile holds it or the link.
    expect(JSON.stringify(events).split('ABCD-EFGHI').length - 1).toBeGreaterThanOrEqual(1)
    const onDisk = (dir: string): string =>
      readdirSync(dir, { withFileTypes: true })
        .map((entry) => (entry.isDirectory() ? onDisk(join(dir, entry.name)) : readFileSync(join(dir, entry.name), 'utf8')))
        .join('\n')
    expect(onDisk(w.profileHome)).not.toMatch(/ABCD-EFGHI|auth\.openai\.com\/codex\/device/)
    consoles.forEach((spy) => spy.mockRestore())
  })

  it('a chat child bound to the added instance launches with that home, and one on the user\'s own Codex with theirs', async () => {
    const w = world()
    writeSignIn(w.homeOf(WORK), 'acct-work')
    await w.harness.instances.recheck(WORK)
    await w.harness.instances.recheck('codex')
    const before = { work: w.servers.launches.length, own: w.builtInServers.launches.length }
    await turn(w, WORK, 'delegate_task')
    await turn(w, 'codex', 'delegate_task')
    for (const launched of w.servers.launches) expect(launched.env.CODEX_HOME).toBe(w.homeOf(WORK))
    for (const launched of w.builtInServers.launches) expect(launched.env.CODEX_HOME).toBe(userHome)
    expect(w.servers.launches.length).toBeGreaterThanOrEqual(before.work)
    expect(w.builtInServers.launches.length).toBeGreaterThanOrEqual(before.own)
  })

  it('adding and signing in a second account leaves the first as it was', async () => {
    const w = world()
    writeSignIn(w.homeOf(WORK), 'acct-work')
    const before = await w.harness.instances.recheck(WORK)
    const ownBefore = await w.harness.instances.recheck('codex')
    expect(before.auth.state).toBe('signed_in')
    const counters = () => JSON.parse(readFileSync(join(w.profileHome, 'harness', 'state.json'), 'utf8')).instances[WORK]
    const files = (dir: string) => Object.fromEntries(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), 'utf8')]))
    const homeBefore = files(w.homeOf(WORK))
    const settingsBefore = readFileSync(join(instanceStateDir(w.profileHome, WORK), 'settings.json'), 'utf8')
    const countersBefore = counters()
    const launchesBefore = w.servers.launches.filter((launched) => launched.env.CODEX_HOME === w.homeOf(WORK)).length

    const added = await w.harness.instances.add({ driver: 'codex', config: { displayName: 'Personal', setup: 'existing', binaryPath: w.binary } })
    expect(added.instanceId).toBe('codex:personal')
    expect(added.config).toMatchObject({ home: 'private', setup: 'existing' })
    const signIn = await startSignIn(w, 'codex:personal')
    const terminal = await signIn.terminal()
    expect(terminal.env.CODEX_HOME).toBe(w.homeOf('codex:personal'))
    terminal.print(DEVICE_OUTPUT)
    terminal.exit(0, 'acct-personal')
    expect((await signIn.settled()).phase).toBe('completed')
    // The second sign-in never started a process in the first account's home.
    expect(w.servers.launches.filter((launched) => launched.env.CODEX_HOME === w.homeOf(WORK)).length).toBe(launchesBefore)

    const after = await w.harness.instances.recheck(WORK)
    expect(after.auth).toEqual(before.auth)
    expect(await w.harness.instances.recheck('codex')).toMatchObject({ auth: ownBefore.auth, config: ownBefore.config })
    expect(counters()).toEqual(countersBefore)
    expect(files(w.homeOf(WORK))).toEqual(homeBefore)
    expect(readFileSync(join(instanceStateDir(w.profileHome, WORK), 'settings.json'), 'utf8')).toBe(settingsBefore)
    const personal = await snapshotOf(w, 'codex:personal')
    expect(personal.auth.state).toBe('signed_in')
    expect(personal.auth.account?.id).not.toBe(after.auth.account?.id)
    expect(personal.auth.message).toBeUndefined()
  })

  it('removing one account deletes only its own Mousse data and leaves the other accounts and their sign-ins', async () => {
    const w = world({ stored: threeAccounts })
    writeSignIn(w.homeOf(WORK), 'acct-work')
    writeSignIn(w.homeOf(HOME), 'acct-home')
    for (const id of ['codex', WORK, HOME]) await w.harness.instances.recheck(id)
    const tree = (dir: string): Record<string, string> => {
      const found: Record<string, string> = {}
      const walk = (path: string, prefix: string) => {
        for (const name of readdirSync(path, { withFileTypes: true })) {
          if (name.isDirectory()) walk(join(path, name.name), `${prefix}${name.name}/`)
          else found[`${prefix}${name.name}`] = readFileSync(join(path, name.name), 'utf8')
        }
      }
      walk(dir, '')
      return found
    }
    const workDir = instanceStateDir(w.profileHome, WORK)
    const homeDir = instanceStateDir(w.profileHome, HOME)
    const workBefore = tree(workDir)
    const ownSettings = join(w.profileHome, 'providers', 'codex', 'settings.json')
    const ownBefore = existsSync(ownSettings) ? readFileSync(ownSettings, 'utf8') : undefined
    expect(Object.keys(tree(homeDir))).toEqual(expect.arrayContaining(['settings.json', 'home/auth.json']))

    await w.harness.instances.remove(HOME)
    await vi.waitFor(() => expect(existsSync(join(homeDir, 'settings.json'))).toBe(false))
    // Its Mousse state is gone; the sign-in in its home stays (signing out removes it).
    expect(Object.keys(tree(homeDir))).toEqual(['home/auth.json'])
    // The other account and the user's own Codex are untouched.
    expect(tree(workDir)).toEqual(workBefore)
    expect(existsSync(ownSettings) ? readFileSync(ownSettings, 'utf8') : undefined).toBe(ownBefore)
    expect(accountOf(userHome)).toBe('acct-own')
    expect((await w.harness.instances.snapshots({ kind: 'device' })).map((snapshot) => snapshot.instanceId).sort()).toEqual(['codex', WORK])
    expect((await w.harness.instances.recheck(WORK)).auth.state).toBe('signed_in')
  })

  it('removing an account ends its app-server and its sign-in terminal', async () => {
    const w = world()
    await w.harness.instances.recheck(WORK)
    const signIn = await startSignIn(w, WORK)
    const terminal = await signIn.terminal()
    await w.harness.instances.remove(WORK)
    expect((await signIn.settled()).phase).toBe('cancelled')
    expect(terminal.kills).toBeGreaterThan(0)
    await vi.waitFor(() => expect(w.servers.running()).toBe(0))
  })

  it('tells the user when two instances are signed in to the same account, and not when they differ', async () => {
    const w = world({ stored: threeAccounts })
    writeSignIn(w.homeOf(WORK), 'acct-same')
    writeSignIn(w.homeOf(HOME), 'acct-same')
    const checked = async () => {
      for (const id of ['codex', WORK, HOME]) await w.harness.instances.recheck(id)
      return { work: await snapshotOf(w, WORK), home: await snapshotOf(w, HOME), own: await snapshotOf(w, 'codex') }
    }
    const same = await checked()
    expect(same.work.auth.message).toBe('Same account as Home.')
    expect(same.home.auth.message).toBe('Same account as Work.')
    expect(same.own.auth.message).toBeUndefined()
    // The accounts differ by home (their identities), so no state of one resumes in the other.
    expect(same.work.auth.account?.id).not.toBe(same.home.auth.account?.id)

    writeSignIn(w.homeOf(HOME), 'acct-other')
    const different = await checked()
    expect(different.work.auth.message).toBeUndefined()
    expect(different.home.auth.message).toBeUndefined()
    // Not kept on disk.
    expect(readFileSync(join(w.profileHome, 'harness', 'state.json'), 'utf8')).not.toMatch(/fingerprint|same/i)
  })
})

describe('an added entry on the user\'s own home', () => {
  const ownHomeWorld = () => world({ stored: (binary) => ({ codex: { driver: 'codex', enabled: true }, [OWN_HOME]: { driver: 'codex', enabled: true, config: { home: 'default', setup: 'existing', displayName: 'Mine too', binaryPath: binary } } }) })

  it('runs on the user\'s home with the terminal sign-in: no terminal, no logout, no private folder, nothing it signs out', async () => {
    const w = ownHomeWorld()
    const snapshot = await w.harness.instances.recheck(OWN_HOME)
    expect(snapshot.config).toMatchObject({ home: 'default', setup: 'existing' })
    expect(snapshot.config?.homePath).toBeUndefined()
    expect(snapshot.auth).toMatchObject({ state: 'signed_in', canSignOut: false })
    expect(snapshot.auth.canSignIn).toBeUndefined()
    await turn(w, OWN_HOME)
    await w.harness.instances.signOut(OWN_HOME)
    expect(w.servers.launches.length).toBeGreaterThan(0)
    for (const launched of w.servers.launches) expect(launched.env.CODEX_HOME).toBe(userHome)
    expect(w.spawns.filter((spawned) => spawned.args.includes('logout'))).toEqual([])
    expect(w.terminals).toHaveLength(0)
    expect(existsSync(join(instanceStateDir(w.profileHome, OWN_HOME), 'home'))).toBe(false)
    expect(accountOf(userHome)).toBe('acct-own')
  })

  it('keeps its own settings and sessions apart from the user\'s own entry, in its own folder', async () => {
    const w = ownHomeWorld()
    await w.harness.instances.recheck(OWN_HOME)
    await w.harness.instances.recheck('codex')
    expect(existsSync(join(instanceStateDir(w.profileHome, OWN_HOME), 'settings.json'))).toBe(true)
    expect(w.servers.launches.every((launched) => launched.cwd === instanceStateDir(w.profileHome, OWN_HOME))).toBe(true)
    expect(w.builtInServers.launches.every((launched) => launched.cwd !== instanceStateDir(w.profileHome, OWN_HOME))).toBe(true)
  })

  it('can be added with either home, and the built-in never takes a private one', async () => {
    const w = world({ stored: () => ({ codex: { driver: 'codex', enabled: true } }) })
    const added = await w.harness.instances.add({ driver: 'codex', config: { setup: 'existing', displayName: 'Mine too', home: 'default' } })
    expect(added).toMatchObject({ builtIn: false, config: { home: 'default', setup: 'existing' } })
    const another = await w.harness.instances.add({ driver: 'codex', config: { setup: 'existing', displayName: 'Work' } })
    expect(another).toMatchObject({ instanceId: 'codex:work', config: { home: 'private' } })
    await expect(w.harness.instances.configure('codex', { home: 'private' })).rejects.toMatchObject({ code: 'unsupported' })
    // An added entry may switch homes; a stored home on the built-in id is ignored.
    expect((await w.harness.instances.configure('codex:work', { home: 'default' })).config?.home).toBe('default')
    expect(decodeCodexConfig({ setup: 'existing', home: 'private' }, 'codex').home).toBe('default')
    expect(decodeCodexConfig({ setup: 'existing', home: 'private' }, 'codex:work')).toMatchObject({ home: 'private', setup: 'existing' })
    expect(decodeCodexConfig({ setup: 'managed', home: 'default' }, 'codex:m')).toMatchObject({ home: 'private', setup: 'managed' })
  })
})

describe('a private home that is a link', () => {
  /** Two accounts: WORK's own folder, and a folder of another account WORK's path is turned into a link to. */
  function linked(w: World, where: 'home' | 'ancestor') {
    const other = tempDir('mousse-other-account')
    writeSignIn(join(other, where === 'home' ? '' : 'home'), 'acct-other')
    const stateDir = instanceStateDir(w.profileHome, WORK)
    const target = where === 'home' ? w.homeOf(WORK) : stateDir
    // The gateway made the folder when it built the runtime: replace it with the link.
    rmSync(target, { recursive: true, force: true })
    mkdirSync(join(target, '..'), { recursive: true })
    symlinkSync(where === 'home' ? join(other, '') : other, target, 'junction')
    const files = (dir: string) => Object.fromEntries(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), 'utf8')]))
    const otherHome = where === 'home' ? other : join(other, 'home')
    return { otherHome, before: files(otherHome), files }
  }

  it.each(['home', 'ancestor'] as const)('sign-in is refused when the %s is a link, and the other account is not touched', async (where) => {
    const w = world()
    const { otherHome, before, files } = linked(w, where)
    const signIn = await startSignIn(w, WORK)
    const result = await signIn.settled()
    expect(result).toMatchObject({ phase: 'failed', error: { message: expect.stringContaining('link') } })
    expect(w.terminals).toHaveLength(0)
    expect(files(otherHome)).toEqual(before)
  })

  it.each(['home', 'ancestor'] as const)('sign-in without a terminal is refused too when the %s is a link', async (where) => {
    const w = world({ terminal: false })
    const { otherHome, before, files } = linked(w, where)
    const signIn = await startSignIn(w, WORK)
    expect(await signIn.settled()).toMatchObject({ phase: 'failed', error: { message: expect.stringContaining('link') } })
    expect(files(otherHome)).toEqual(before)
  })

  it.each(['home', 'ancestor'] as const)('sign-out is refused when the %s is a link: no logout runs against the other account', async (where) => {
    const w = world()
    const { otherHome, before, files } = linked(w, where)
    await expect(w.harness.instances.signOut(WORK)).rejects.toThrow(/link/)
    expect(w.spawns.filter((spawned) => spawned.args.includes('logout'))).toEqual([])
    expect(files(otherHome)).toEqual(before)
  })

  it.each(['home', 'ancestor'] as const)('no check or chat starts Codex in the other account\'s folder when the %s is a link', async (where) => {
    const w = world()
    linked(w, where)
    const snapshot = await w.harness.instances.recheck(WORK)
    expect(snapshot.auth).toMatchObject({ state: 'unknown', message: expect.stringContaining('link') })
    expect(snapshot.auth.canSignOut).toBe(false)
    await turn(w, WORK)
    expect(w.servers.launches).toEqual([])
    expect(w.spawns.filter((spawned) => spawned.purpose === 'app-server')).toEqual([])
  })

  it('a folder of Mousse\'s own, outside it, or not there yet is judged by where it really is', () => {
    const root = tempDir('mousse-owned-root')
    const own = join(root, 'harness', 'codex_work', 'home')
    expect(ownedHomeProblem(own, root)).toBeUndefined()
    mkdirSync(own, { recursive: true })
    expect(ownedHomeProblem(own, root)).toBeUndefined()
    expect(ownedHomeProblem(join(tempDir('mousse-elsewhere'), 'home'), root)).toMatch(/outside/)
    expect(ownedHomeProblem(root, root)).toMatch(/outside/)
  })
})

describe('a managed entry beside the added ones', () => {
  const MANAGED = 'codex:managed'

  it('keeps its own runtime and its own sign-in: no terminal, no `codex login` or `logout`, whatever the added ones do', async () => {
    const calls: string[] = []
    const contexts: DriverContext[] = []
    const managed = (context: DriverContext): DriverRuntime => {
      contexts.push(context)
      return {
        adapter: { startTurn: () => { throw new Error('unused') } } as never,
        configured: () => true,
        models: () => [],
        auth: async () => ({ state: 'signed_in', methodLabel: 'ChatGPT plan', ownedByMousse: true, canSignIn: true }),
        signIn: async (session) => {
          calls.push('managed sign-in')
          return { success: true, sessionId: session.sessionId }
        },
        signOut: async () => void calls.push('managed sign-out'),
        stop: () => {}
      }
    }
    const w = world({
      managed,
      stored: (binary) => ({
        codex: { driver: 'codex', enabled: true },
        [WORK]: privateEntry('Work', binary),
        [MANAGED]: { driver: 'codex', enabled: true, config: { setup: 'managed', home: 'private', displayName: 'Managed' } }
      })
    })
    // Its runtime is the managed one: the added entry's rules never reach it.
    const snapshot = await w.harness.instances.recheck(MANAGED)
    expect(contexts.length).toBeGreaterThanOrEqual(1)
    expect(contexts.every((context) => context.instanceId === MANAGED && !context.builtIn && context.config.setup === 'managed' && context.config.home === 'private')).toBe(true)
    expect(snapshot.auth).toMatchObject({ state: 'signed_in', methodLabel: 'ChatGPT plan', canSignOut: true, canSignIn: true })
    await w.harness.instances.recheck(WORK)
    const signIn = await startSignIn(w, MANAGED)
    expect((await signIn.settled()).phase).toBe('completed')
    await w.harness.instances.signOut(MANAGED)
    expect(calls).toEqual(['managed sign-in', 'managed sign-out'])
    expect(w.terminals).toHaveLength(0)
    expect(w.spawns.filter((spawned) => spawned.instanceId === MANAGED && /login|logout/.test(spawned.args.join(' ')))).toEqual([])
    // Its home is its own and no credential of the user's reaches it either.
    const env = contexts[0]!.env.env
    expect(env.CODEX_HOME).toBe(w.homeOf(MANAGED))
    expect(env.CODEX_SQLITE_HOME).toBe(w.homeOf(MANAGED))
    for (const name of Object.keys(AMBIENT).filter((entry) => !NOT_DROPPED.includes(entry) && entry !== 'CODEX_SQLITE_HOME')) expect(Object.keys(env).filter((key) => key.toUpperCase() === name), name).toEqual([])
    // The added entry still signs in with its own terminal.
    const added = await startSignIn(w, WORK)
    const terminal = await added.terminal()
    expect(terminal.env.CODEX_HOME).toBe(w.homeOf(WORK))
    terminal.exit(1)
    await added.settled()
  })
})

describe('the service of a Codex account', () => {
  const service = (dir: string, binary: string, signedOut = false) => {
    const servers = appServers()
    const instance = new CodexProviderService(dir, new UserQuestionService(), { findBinary: () => binary, launch: servers.launch }, {
      dir: join(dir, 'state'),
      env: () => ({ CODEX_HOME: join(dir, 'home') }),
      signedOut: () => signedOut
    })
    stops.push(() => instance.stop())
    return { instance, servers }
  }

  it('reconnect ends the process that knew the old account, forgets the models, and reads the new one', async () => {
    const dir = tempDir('mousse-codex-service')
    const { instance, servers } = service(dir, fakeCodex())
    expect(await instance.authState()).toBe('signed_out')
    expect(servers.running()).toBe(1)
    writeSignIn(join(dir, 'home'), 'acct-new')
    // The running process answers for the account it started with; a reconnect starts another.
    expect(await instance.reconnect()).toBe(true)
    expect(servers.launches).toHaveLength(2)
    expect(servers.processes[0]!.signalCode).not.toBeNull()
    expect(instance.account()).toBeUndefined()
    expect(await instance.status({ force: true })).toMatchObject({ state: 'connected' })
    expect(instance.account()?.subject).toBe('chatgpt:acct-new@example.test')
  })

  it('reads the account whatever Mousse recorded, and leaves what it recorded alone', async () => {
    const dir = tempDir('mousse-codex-service')
    const { instance } = service(dir, fakeCodex(), true)
    writeSignIn(join(dir, 'home'), 'acct-new')
    // Disconnected in Mousse: the status says so without asking; the CLI's own state is another question.
    expect(await instance.status({ force: true })).toMatchObject({ state: 'disconnected' })
    expect(await instance.authState()).toBe('signed_in')
    expect(await instance.reconnect()).toBe(true)
    expect(await instance.status({ force: true })).toMatchObject({ state: 'disconnected' })
  })

  it('does not know without an executable, and a frozen service never writes its settings again', async () => {
    const dir = tempDir('mousse-codex-service')
    const { instance } = service(dir, join(dir, 'nothing'))
    expect(await instance.authState()).toBe('unknown')
    expect(instance.authLaunch()).toBeUndefined()
    const { instance: live } = service(dir, fakeCodex())
    expect(live.authLaunch()).toMatchObject({ env: { CODEX_HOME: join(dir, 'home') } })
    await live.logout()
    const settings = join(dir, 'state', 'settings.json')
    expect(existsSync(settings)).toBe(true)
    rmSync(settings)
    live.freezeSettings()
    await live.logout()
    expect(existsSync(settings)).toBe(false)
  })
})
