/**
 * Signing a second Claude Code account in from the app. An added Claude instance has its own
 * `CLAUDE_CONFIG_DIR`; Mousse runs `claude auth login` there in a terminal (a fake one here, driven
 * by the test: no real sign-in, no real credentials, only temporary homes and fake accounts).
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { format } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderOperationEvent } from '../../src/shared/harness/types'
import { claudeCodeDriver } from '../../src/mms/harness/drivers/claudeCode'
import { createHarnessGateway, type TurnSpec } from '../../src/mms/harness/gateway'
import { instanceEnv, ownedLaunchEnv, ownedUserEnv, reservedEnvName } from '../../src/mms/harness/env'
import { instanceStateDir, InstanceCounterStore } from '../../src/mms/harness/instances'
import { ownedHomeProblem } from '../../src/mms/harness/ownedHome'
import { redactSignIn, runInPty, signInPrompts, type PtySpawn } from '../../src/mms/harness/pty'
import { observeHarnessSpawns, type HarnessSpawn } from '../../src/mms/harness/spawn'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { ClaudeSubscriptionProviderService } from '../../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import { LoginSession } from '../../src/mms/providers/LoginSession'
import { ProviderInstanceService } from '../../src/mms/harness/instanceMap'

const dirs: string[] = []
const stops: Array<() => void> = []
/**
 * The user's own sign-in, in every place Claude Code looks for one, in Mousse's environment: where
 * its credentials live (the secure-storage folder wins over the config dir), an Anthropic profile,
 * tokens and keys, and the cloud routes. No private home may ever see any of them.
 */
const AMBIENT: Record<string, string> = {
  ANTHROPIC_API_KEY: 'ambient-user-key',
  CLAUDE_CODE_OAUTH_TOKEN: 'ambient-user-oauth',
  CLAUDE_SECURESTORAGE_CONFIG_DIR: 'ambient-users-secure-storage',
  ANTHROPIC_CONFIG_DIR: 'ambient-users-anthropic-dir',
  ANTHROPIC_PROFILE: 'ambient-users-profile',
  ANTHROPIC_IDENTITY_TOKEN_FILE: 'ambient-identity-file',
  CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'ambient-refresh',
  CLAUDE_CODE_SESSION_ACCESS_TOKEN: 'ambient-session',
  ANTHROPIC_FOUNDRY_API_KEY: 'ambient-foundry',
  CLAUDE_CODE_USE_BEDROCK: '1',
  AWS_BEARER_TOKEN_BEDROCK: 'ambient-bedrock-token',
  AWS_ACCESS_KEY_ID: 'ambient-aws-key',
  CLAUDE_CODE_USE_VERTEX: '1',
  GOOGLE_APPLICATION_CREDENTIALS: 'ambient-google-file',
  ANTHROPIC_BASE_URL: 'https://ambient-gateway.example.test',
  // Not a credential: Claude Code needs it, so a private home keeps it.
  CLAUDE_CODE_GIT_BASH_PATH: 'C:\\ambient\\Git\\bash.exe'
}
const ambient = Object.fromEntries(Object.keys(AMBIENT).map((name) => [name, process.env[name]]))

beforeEach(() => {
  Object.assign(process.env, AMBIENT)
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
 * A `claude` that prints a version and signs a home out (`auth logout`): a node script, behind an
 * npm-style shim on Windows. Its login is the fake terminal below.
 */
function fakeClaude(): string {
  const dir = tempDir('mousse-fakeclaude')
  mkdirSync(join(dir, 'node_modules', 'claude'), { recursive: true })
  const script = join(dir, 'node_modules', 'claude', 'cli.js')
  writeFileSync(join(dir, 'node_modules', 'claude', 'package.json'), JSON.stringify({ name: 'claude' }))
  writeFileSync(script, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    'const args = process.argv.slice(2)',
    "if (args.includes('--version')) { console.log('2.1.300 (Claude Code)'); process.exit(0) }",
    'const home = process.env.CLAUDE_CONFIG_DIR',
    "if (args[0] === 'auth' && args[1] === 'logout') {",
    // A logout that fails, or says it worked and did nothing (set on the instance's variables).
    "  if (process.env.FAKE_LOGOUT === 'fail') process.exit(3)",
    "  if (process.env.FAKE_LOGOUT === 'noop') process.exit(0)",
    "  const file = home ? path.join(home, '.claude.json') : ''",
    '  if (!file || !fs.existsSync(file)) process.exit(1)',
    "  fs.rmSync(file); fs.rmSync(path.join(home, '.credentials.json'), { force: true })",
    '  process.exit(0)',
    '}',
    'process.exit(2)'
  ].join('\n') + '\n')
  if (process.platform === 'win32') {
    const shim = join(dir, 'claude.cmd')
    writeFileSync(shim, `@ECHO off\r\n"%~dp0\\node_modules\\claude\\cli.js" %*\r\n`)
    return shim
  }
  chmodSync(script, 0o755)
  // A `claude` beside it, as npm links one: the folder is the PATH the user's own Claude is found on.
  const link = join(dir, 'claude')
  symlinkSync(script, link)
  return link
}

/** What `claude auth login` leaves in a home: the account Claude Code reads, and a fake secret. */
function writeSignIn(home: string, account: string): void {
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: account, organizationUuid: 'org-1' } }))
  writeFileSync(join(home, '.credentials.json'), JSON.stringify({ token: `secret-token-of-${account}` }))
}

interface FakeTerminal {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  cols: number
  cwd: string | undefined
  written: string[]
  kills: number
  /** The command prints `text`. */
  print(text: string): void
  /** The command ends; with `account` and code 0 it has signed that account in to its home. */
  exit(code: number, account?: string): void
}

function terminalFactory() {
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
      print: (text) => data(text),
      exit: (code, account) => {
        if (ended) return
        const home = options.env.CLAUDE_CONFIG_DIR
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

type Call = { instanceId: string; args: string[]; env: NodeJS.ProcessEnv }

interface WorldOptions {
  profileHome?: string
  /** The stored instances, given this world's `claude` (default: the user's own and `claude:work`). */
  stored?: (binary: string) => Record<string, unknown>
  /** A sign-in terminal runs (default); false: none runs here. */
  terminal?: boolean
  signInTimeoutMs?: number
}

const WORK = 'claude:work'
const HOME = 'claude:home'

const privateEntry = (displayName: string, binary: string, extra: Record<string, unknown> = {}) =>
  ({ driver: 'claude', enabled: true, config: { home: 'private', displayName, binaryPath: binary, ...extra } })

/** The user's own Claude and two added accounts. */
const threeAccounts = (binary: string) => ({
  claude: { driver: 'claude', enabled: true },
  [WORK]: privateEntry('Work', binary),
  [HOME]: privateEntry('Home', binary)
})

function world(options: WorldOptions = {}) {
  const profileHome = options.profileHome ?? tempDir('mousse-claude-signin')
  const binary = fakeClaude()
  const questions = new UserQuestionService()
  const terminal = terminalFactory()
  const statusCalls: Call[] = []
  const turnEnvs: Array<{ instanceId: string; env: NodeJS.ProcessEnv }> = []
  const spawns: HarnessSpawn[] = []
  // `claude auth status`, as the CLI answers it for the home it runs in.
  const runAuth = (instanceId: string) => async (_binary: string, args: string[], env: NodeJS.ProcessEnv) => {
    statusCalls.push({ instanceId, args, env })
    const home = env.CLAUDE_CONFIG_DIR
    const signedIn = instanceId === 'claude' ? true : Boolean(home && existsSync(join(home, '.claude.json')))
    return JSON.stringify(signedIn ? { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' } : { loggedIn: false })
  }
  const query = (instanceId: string) => (input: { options: { env?: NodeJS.ProcessEnv } }) => {
    turnEnvs.push({ instanceId, env: input.options.env ?? {} })
    throw new Error('replay ends here')
  }
  const builtIn = new ClaudeSubscriptionProviderService(profileHome, questions, {
    findBinary: () => binary,
    runAuth: runAuth('claude'),
    query: query('claude') as never
  })
  let stored: unknown = options.stored?.(binary) ?? {
    claude: { driver: 'claude', enabled: true },
    [WORK]: privateEntry('Work', binary)
  }
  const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
  const harness = createHarnessGateway({
    profileHome,
    installationHome: profileHome,
    instanceMap: instances,
    questions,
    // The user's own CLI is this fake, found on PATH: never one installed on this machine.
    shellPath: async () => ({ entries: [dirname(binary)], source: 'login_shell' }),
    drivers: [
      claudeCodeDriver({
        builtIn: () => builtIn,
        pty: { available: () => options.terminal !== false, spawn: terminal.spawn },
        ...(options.signInTimeoutMs ? { signInTimeoutMs: options.signInTimeoutMs } : {}),
        createService: (context, serviceOptions) => new ClaudeSubscriptionProviderService(context.profileHome, questions, {
          ...serviceOptions,
          runAuth: runAuth(context.instanceId),
          query: query(context.instanceId) as never
        })
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
  return { profileHome, binary, harness, builtIn, terminals: terminal.terminals, statusCalls, turnEnvs, spawns, homeOf, stop, stored: () => stored }
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

const LOGIN_OUTPUT = 'Opening your browser to sign in...\r\nIf it does not open, visit:\r\nhttps://claude.ai/oauth/authorize?code=true&client_id=fake-client&state=fake-state\r\n'

function turnSpec(instanceId: string, binding: TurnSpec['binding'], cwd: string): TurnSpec {
  const noop = () => {}
  return {
    binding,
    input: {
      runId: `run-${instanceId}`, attemptId: `attempt-${instanceId}`, threadId: `thread-${instanceId}`, cwd, instanceId,
      model: 'sonnet', llmProvider: 'claude-subscription', modelPinned: true, mode: 'agent', prompt: 'hello',
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

async function turn(w: World, instanceId: string): Promise<void> {
  const resolved = w.harness.resolveStored({ instanceId, llmProvider: '', model: 'sonnet' }, { purpose: 'turn' })
  const spec = turnSpec(instanceId, await w.harness.bind(resolved, { mode: 'agent' }), tempDir('mousse-cwd'))
  await w.harness.startTurn(spec).result.catch(() => undefined)
}

const accountGeneration = (w: World, instanceId: string) =>
  new InstanceCounterStore(w.profileHome).get(instanceId).accountGeneration

describe('sign in from the app', () => {
  it('runs `claude auth login` in the private home, shows the link once, types the pasted code, and counts only a confirmed sign-in', async () => {
    const w = world()
    const before = await w.harness.instances.recheck(WORK)
    // The page offers the Sign in button, with the command to copy kept beside it.
    expect(before.auth).toMatchObject({ state: 'signed_out', canSignIn: true })
    expect(before.nextStep).toMatchObject({ action: 'sign_in', label: 'Sign in', command: expect.stringContaining(w.homeOf(WORK)) })
    const generation = accountGeneration(w, WORK)

    const signIn = await startSignIn(w, WORK)
    const terminal = await signIn.terminal()
    expect(terminal.args.slice(-2)).toEqual(['auth', 'login'])
    // It starts in the private home, so no project settings of Mousse's own folder are read.
    expect(terminal.cwd).toBe(w.homeOf(WORK))
    // The private home is set; `HOME` is the user's own, and no ambient credential comes along.
    expect(terminal.env.CLAUDE_CONFIG_DIR).toBe(w.homeOf(WORK))
    expect(terminal.env.HOME).toBe(process.env.HOME)
    expect(terminal.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(terminal.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    // Wide enough that the long link is not cut into lines.
    expect(terminal.cols).toBeGreaterThanOrEqual(500)

    terminal.print(LOGIN_OUTPUT)
    terminal.print('Browser sign-in did not finish? Paste code here if prompted > ')
    // The same output twice still shows one link.
    terminal.print('\r\nIf it does not open, visit https://claude.ai/oauth/authorize?code=true&client_id=fake-client&state=fake-state\r\n')
    await vi.waitFor(() => expect(signIn.prompts().some((prompt) => prompt.type === 'auth_url')).toBe(true))
    const links = signIn.prompts().filter((prompt) => prompt.type === 'auth_url')
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ url: 'https://claude.ai/oauth/authorize?code=true&client_id=fake-client&state=fake-state', usesCallbackServer: true, acceptsRedirectPaste: true })

    // The code pasted into Mousse's field goes to the terminal, with Enter.
    const field = signIn.prompts().find((prompt) => prompt.type === 'input')!
    expect(await w.harness.instances.respondSignIn(signIn.started.operationId, { promptId: field.promptId, kind: 'input', value: 'pasted-code#pasted-state' })).toBe(true)
    await vi.waitFor(() => expect(terminal.written).toEqual(['pasted-code#pasted-state\r']))

    terminal.exit(0, 'acct-work')
    expect((await signIn.settled()).phase).toBe('completed')
    expect(accountGeneration(w, WORK)).toBeGreaterThan(generation)
    const after = await w.harness.instances.recheck(WORK)
    expect(after.auth).toMatchObject({ state: 'signed_in', canSignOut: true })
    expect(after.auth.canSignIn).toBeUndefined()
  })

  it('holds a code pasted before Claude asks for it until the prompt shows', async () => {
    const w = world()
    await w.harness.instances.recheck(WORK)
    const signIn = await startSignIn(w, WORK)
    const terminal = await signIn.terminal()
    terminal.print(LOGIN_OUTPUT)
    await vi.waitFor(() => expect(signIn.prompts().some((prompt) => prompt.type === 'input')).toBe(true))
    const field = signIn.prompts().find((prompt) => prompt.type === 'input')!
    await w.harness.instances.respondSignIn(signIn.started.operationId, { promptId: field.promptId, kind: 'input', value: 'early-code' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(terminal.written).toEqual([])
    terminal.print('Paste code here if prompted > ')
    await vi.waitFor(() => expect(terminal.written).toEqual(['early-code\r']))
    terminal.exit(0, 'acct-work')
    expect((await signIn.settled()).phase).toBe('completed')
  })

  it('cancel ends the terminal and its tree, and a late success changes nothing', async () => {
    const w = world()
    await w.harness.instances.recheck(WORK)
    const generation = accountGeneration(w, WORK)
    const signIn = await startSignIn(w, WORK)
    const terminal = await signIn.terminal()
    terminal.print(LOGIN_OUTPUT)
    await vi.waitFor(() => expect(signIn.prompts().length).toBeGreaterThan(0))
    expect(await w.harness.instances.respondSignIn(signIn.started.operationId, { kind: 'cancel' })).toBe(true)
    expect((await signIn.settled()).phase).toBe('cancelled')
    expect(terminal.kills).toBeGreaterThan(0)
    // The browser finishes after the cancel: nothing is signed in.
    terminal.exit(0, 'acct-work')
    expect(existsSync(join(w.homeOf(WORK), '.claude.json'))).toBe(false)
    expect(accountGeneration(w, WORK)).toBe(generation)
    expect((await w.harness.instances.recheck(WORK)).auth.state).toBe('signed_out')
  })

  it('a sign-in nobody finishes is ended after its time and reports why', async () => {
    const w = world({ signInTimeoutMs: 40 })
    await w.harness.instances.recheck(WORK)
    const signIn = await startSignIn(w, WORK)
    const terminal = await signIn.terminal()
    terminal.print(LOGIN_OUTPUT)
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
    expect(await signIn.settled()).toMatchObject({ phase: 'failed', error: { message: 'claude auth login exited with code 1.' } })
    expect(accountGeneration(w, WORK)).toBe(generation)
  })

  it('exit 0 without a sign-in in the home is a failure: Claude must say signed in', async () => {
    const w = world()
    await w.harness.instances.recheck(WORK)
    const generation = accountGeneration(w, WORK)
    const signIn = await startSignIn(w, WORK)
    const terminal = await signIn.terminal()
    terminal.exit(0)
    expect(await signIn.settled()).toMatchObject({ phase: 'failed', error: { message: 'Claude did not report a sign-in.' } })
    expect(accountGeneration(w, WORK)).toBe(generation)
    expect((await w.harness.instances.recheck(WORK)).auth.canSignOut).toBe(false)
  })

  it('without a sign-in terminal the page shows the command to copy, with the private home in it', async () => {
    const w = world({ terminal: false })
    const snapshot = await w.harness.instances.recheck(WORK)
    expect(snapshot.auth.canSignIn).toBeUndefined()
    expect(snapshot.nextStep?.command).toContain(w.homeOf(WORK))
    expect(snapshot.nextStep?.command).toContain('claude auth login')
    // Starting one anyway spawns nothing: it waits for the terminal sign-in, which can be cancelled.
    const signIn = await startSignIn(w, WORK)
    await vi.waitFor(() => expect(signIn.prompts().some((prompt) => prompt.type === 'select')).toBe(true))
    expect(w.terminals).toHaveLength(0)
    await w.harness.instances.respondSignIn(signIn.started.operationId, { kind: 'cancel' })
    expect((await signIn.settled()).phase).toBe('cancelled')
  })

  it('sign in, sign out, sign in again; the second sign-in works after the service is rebuilt from disk', async () => {
    const profileHome = tempDir('mousse-claude-cycle')
    const first = world({ profileHome })
    await first.harness.instances.recheck(WORK)
    const signIn = async (w: World, account: string) => {
      const running = await startSignIn(w, WORK)
      const terminal = await running.terminal()
      terminal.print(LOGIN_OUTPUT)
      terminal.exit(0, account)
      expect((await running.settled()).phase).toBe('completed')
    }
    await signIn(first, 'acct-1')
    expect((await first.harness.instances.recheck(WORK)).auth.state).toBe('signed_in')

    const signedOut = await first.harness.instances.signOut(WORK)
    expect(signedOut.auth.state).toBe('signed_out')
    // `claude auth logout` ran in the private home, and the files it signs out are gone.
    const logout = first.spawns.find((spawned) => spawned.purpose === 'auth' && spawned.args.slice(-2).join(' ') === 'auth logout')
    expect(logout?.instanceId).toBe(WORK)
    expect(logout?.env.CLAUDE_CONFIG_DIR).toBe(first.homeOf(WORK))
    expect(existsSync(join(first.homeOf(WORK), '.claude.json'))).toBe(false)
    first.stop()

    // The disconnect is on disk (`settings.json`): the rebuilt service still starts signed out, and signs in again.
    expect(JSON.parse(readFileSync(join(instanceStateDir(profileHome, WORK), 'settings.json'), 'utf8')).cliDisconnected).toBe(true)
    const second = world({ profileHome, stored: () => first.stored() as Record<string, unknown> })
    expect((await second.harness.instances.recheck(WORK)).auth.state).toBe('signed_out')
    await signIn(second, 'acct-2')
    expect((await second.harness.instances.recheck(WORK)).auth).toMatchObject({ state: 'signed_in', canSignOut: true })
    expect(JSON.parse(readFileSync(join(instanceStateDir(profileHome, WORK), 'settings.json'), 'utf8')).cliDisconnected).toBeUndefined()
  })

  it('the user\'s own Claude never gets `auth logout`: its sign-in is the terminal\'s', async () => {
    const w = world()
    const own = await w.harness.instances.recheck('claude')
    expect(own.auth).toMatchObject({ state: 'signed_in', canSignOut: false })
    expect(own.auth.canSignIn).toBeUndefined()
    await w.harness.instances.signOut('claude')
    expect(w.spawns.filter((spawned) => spawned.args.includes('logout'))).toEqual([])
    expect(w.terminals).toHaveLength(0)
  })
})

describe('instance environment', () => {
  const user = 'C:\\Users\\me\\.claude'

  it('a configured CLAUDE_CONFIG_DIR or key never reaches a status check, a turn, the sign-in or the sign-out of a private home', async () => {
    const w = world({
      stored: (binary) => ({
        claude: { driver: 'claude', enabled: true },
        [WORK]: privateEntry('Work', binary, { env: { claude_config_dir: user, Claude_Config_Dir: user, ANTHROPIC_API_KEY: 'configured-key', anthropic_auth_token: 'configured-token', KEEP_ME: '1' } })
      })
    })
    const home = w.homeOf(WORK)
    writeSignIn(home, 'acct-env')
    expect((await w.harness.instances.recheck(WORK)).auth.state).toBe('signed_in')
    await turn(w, WORK)
    // Sign-in and sign-out of that instance.
    await w.harness.instances.signOut(WORK)
    const signIn = await startSignIn(w, WORK)
    const terminal = await signIn.terminal()
    terminal.exit(1)
    await signIn.settled()

    const envs = [
      ...w.statusCalls.filter((call) => call.instanceId === WORK).map((call) => call.env),
      ...w.turnEnvs.filter((entry) => entry.instanceId === WORK).map((entry) => entry.env),
      terminal.env,
      ...w.spawns.filter((spawned) => spawned.instanceId === WORK).map((spawned) => spawned.env)
    ]
    expect(envs.length).toBeGreaterThanOrEqual(5)
    for (const env of envs) {
      const names = Object.keys(env)
      // One spelling of the home variable, and it is the instance's own.
      expect(names.filter((name) => name.toUpperCase() === 'CLAUDE_CONFIG_DIR')).toHaveLength(1)
      expect(env.CLAUDE_CONFIG_DIR).toBe(home)
      expect(names.filter((name) => /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)$/i.test(name))).toEqual([])
    }
    // What the user did configure still applies.
    expect(terminal.env.KEEP_ME).toBe('1')
  })

  it('rejects a configured variable that moves a private home or brings a key back, on configure and on add', async () => {
    const w = world()
    await expect(w.harness.instances.configure(WORK, { env: { CLAUDE_CONFIG_DIR: user } })).rejects.toMatchObject({ code: 'unsupported' })
    await expect(w.harness.instances.configure(WORK, { env: { claude_config_dir: user } })).rejects.toMatchObject({ code: 'unsupported' })
    await expect(w.harness.instances.configure(WORK, { env: { Anthropic_Api_Key: 'x' } })).rejects.toMatchObject({ code: 'unsupported' })
    await expect(w.harness.instances.add({ driver: 'claude', config: { displayName: 'Other', env: { ANTHROPIC_AUTH_TOKEN: 'x' } } })).rejects.toMatchObject({ code: 'unsupported' })
    // The instance was left as it was, and another variable is welcome.
    expect((await w.harness.instances.snapshots({ kind: 'device' })).map((snapshot) => snapshot.instanceId).sort()).toEqual(['claude', WORK])
    const patched = await w.harness.instances.configure(WORK, { env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '4000' } })
    expect(patched.config?.env).toEqual({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: '4000' })
    // The user's own Claude keeps its freedom (its settings are the user's).
    await expect(w.harness.instances.configure('claude', { env: { ANTHROPIC_API_KEY: 'mine' } })).resolves.toBeDefined()
  })

  it('on Windows names: one home variable whatever the case, spaces and backslashes kept, credentials gone', () => {
    const home = 'C:\\Users\\me\\Mousse Profiles\\p one\\harness\\claude_work\\home'
    const base = instanceEnv({
      instanceId: WORK,
      driver: 'claude',
      configRevision: 0,
      home,
      searchPath: [],
      base: { Path: 'C:\\Windows', ANTHROPIC_API_KEY: 'user-key', claude_code_oauth_token: 'user-token', KEEP: '1' }
    })
    const env = ownedLaunchEnv('claude', base, { Claude_Config_Dir: user, anthropic_api_key: 'x', PATH: 'C:\\Tools', KEEP: '2' })
    expect(Object.keys(env).filter((name) => name.toUpperCase() === 'CLAUDE_CONFIG_DIR')).toEqual(['CLAUDE_CONFIG_DIR'])
    expect(env.CLAUDE_CONFIG_DIR).toBe(home)
    expect(Object.keys(env).filter((name) => /api_key|oauth_token/i.test(name))).toEqual([])
    expect(env.KEEP).toBe('2')
    expect(env.PATH ?? env.Path).toBeDefined()
    // An instance without a home runs as configured.
    expect(ownedLaunchEnv('claude', { env: { A: '1' } }, { ANTHROPIC_API_KEY: 'mine' })).toEqual({ A: '1', ANTHROPIC_API_KEY: 'mine' })
    expect(ownedUserEnv('claude', { claude_config_dir: user, FINE: 'yes' })).toEqual({ FINE: 'yes' })
    expect(reservedEnvName('claude', 'Claude_Config_Dir')).toEqual({ kind: 'home', variable: 'CLAUDE_CONFIG_DIR' })
    expect(reservedEnvName('claude', 'ANTHROPIC_AUTH_TOKEN')?.kind).toBe('credential')
    expect(reservedEnvName('claude', 'HOME')).toBeUndefined()
    // Other drivers keep their own rules.
    expect(reservedEnvName('grok', 'GROK_HOME')).toBeUndefined()
  })

  it('a profile path with a space runs the sign-in from that home, passed as an argument-free environment value', async () => {
    const w = world()
    expect(w.profileHome).toContain(' ')
    await w.harness.instances.recheck(WORK)
    const signIn = await startSignIn(w, WORK)
    const terminal = await signIn.terminal()
    expect(terminal.env.CLAUDE_CONFIG_DIR).toBe(w.homeOf(WORK))
    expect(terminal.args.join(' ')).not.toContain(w.homeOf(WORK))
    terminal.exit(1)
    await signIn.settled()
  })
})

describe('two accounts', () => {
  const snapshotOf = async (w: World, instanceId: string) => (await w.harness.instances.snapshots({ kind: 'device' })).find((snapshot) => snapshot.instanceId === instanceId)!

  it('each account keeps to its own home: every check, turn, sign-in and sign-out of one never touches the other', async () => {
    const w = world({ stored: threeAccounts })
    writeSignIn(w.homeOf(WORK), 'acct-work')
    writeSignIn(w.homeOf(HOME), 'acct-home')
    const written: string[] = []
    const consoles = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) => vi.spyOn(console, name).mockImplementation((...args: unknown[]) => void written.push(format(...args))))
    const events: unknown[] = []
    stops.push(w.harness.instances.subscribe((event) => events.push(event)))

    for (const id of [WORK, HOME, 'claude']) await w.harness.instances.recheck(id)
    for (const id of [WORK, HOME, 'claude']) await turn(w, id)
    await w.harness.instances.signOut(HOME)
    const signIn = await startSignIn(w, HOME)
    const terminal = await signIn.terminal()
    terminal.print(LOGIN_OUTPUT + 'Paste code here if prompted > ')
    await vi.waitFor(() => expect(signIn.prompts().some((prompt) => prompt.type === 'input')).toBe(true))
    const field = signIn.prompts().find((prompt) => prompt.type === 'input')!
    await w.harness.instances.respondSignIn(signIn.started.operationId, { promptId: field.promptId, kind: 'input', value: 'secret-pasted-code' })
    terminal.exit(1)
    const failed = await signIn.settled()
    const snapshots = JSON.stringify(await w.harness.instances.snapshots({ kind: 'device' }))

    const ownHome = (instanceId: string) => (instanceId === 'claude' ? process.env.CLAUDE_CONFIG_DIR : w.homeOf(instanceId))
    const seen: Array<[string, NodeJS.ProcessEnv]> = [
      ...w.statusCalls.map((call): [string, NodeJS.ProcessEnv] => [call.instanceId, call.env]),
      ...w.turnEnvs.map((entry): [string, NodeJS.ProcessEnv] => [entry.instanceId, entry.env]),
      ...w.spawns.filter((spawned) => spawned.instanceId.startsWith('claude')).map((spawned): [string, NodeJS.ProcessEnv] => [spawned.instanceId, spawned.env]),
      [signIn.started.instanceId, terminal.env]
    ]
    expect(new Set(seen.map(([instanceId]) => instanceId))).toEqual(new Set(['claude', WORK, HOME]))
    for (const [instanceId, env] of seen) {
      expect(env.CLAUDE_CONFIG_DIR, instanceId).toBe(ownHome(instanceId))
      const others = [WORK, HOME].filter((other) => other !== instanceId).map((other) => w.homeOf(other))
      for (const value of Object.values(env)) for (const other of others) expect(String(value), instanceId).not.toContain(other)
    }
    // The user's own Claude still runs on the environment it inherited; the private homes never did.
    for (const [instanceId, env] of seen) {
      if (instanceId === 'claude') expect(env.ANTHROPIC_API_KEY).toBe('ambient-user-key')
      else expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    }

    // Nothing of a credential, a pasted code or a link's code reaches a log, an event's text or a snapshot.
    const everything = [...written, JSON.stringify(events), snapshots, JSON.stringify(failed)].join('\n')
    for (const secret of ['secret-pasted-code', 'secret-token-of-acct-work', 'secret-token-of-acct-home', 'ambient-user-key', 'ambient-user-oauth', 'acct-work', 'acct-home'])
      expect(everything, secret).not.toContain(secret)
    consoles.forEach((spy) => spy.mockRestore())
  })

  it('adding and signing in a second account leaves the first as it was', async () => {
    const w = world()
    writeSignIn(w.homeOf(WORK), 'acct-work')
    const before = await w.harness.instances.recheck(WORK)
    const ownBefore = await w.harness.instances.recheck('claude')
    expect(before.auth.state).toBe('signed_in')
    const counters = () => JSON.parse(readFileSync(join(w.profileHome, 'harness', 'state.json'), 'utf8')).instances[WORK]
    const files = (dir: string) => Object.fromEntries(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), 'utf8')]))
    const homeBefore = files(w.homeOf(WORK))
    const settingsBefore = readFileSync(join(instanceStateDir(w.profileHome, WORK), 'settings.json'), 'utf8')
    const countersBefore = counters()
    const callsBefore = w.statusCalls.filter((call) => call.instanceId === WORK).length

    const added = await w.harness.instances.add({ driver: 'claude', config: { displayName: 'Personal', binaryPath: w.binary } })
    expect(added.instanceId).toBe('claude:personal')
    expect(added.config?.home).toBe('private')
    const signIn = await startSignIn(w, 'claude:personal')
    const terminal = await signIn.terminal()
    expect(terminal.env.CLAUDE_CONFIG_DIR).toBe(w.homeOf('claude:personal'))
    terminal.print(LOGIN_OUTPUT)
    terminal.exit(0, 'acct-personal')
    expect((await signIn.settled()).phase).toBe('completed')

    const after = await w.harness.instances.recheck(WORK)
    expect(after.auth).toEqual(before.auth)
    expect(await w.harness.instances.recheck('claude')).toMatchObject({ auth: ownBefore.auth, config: ownBefore.config })
    expect(counters()).toEqual(countersBefore)
    expect(files(w.homeOf(WORK))).toEqual(homeBefore)
    expect(readFileSync(join(instanceStateDir(w.profileHome, WORK), 'settings.json'), 'utf8')).toBe(settingsBefore)
    // The second sign-in never asked Claude about the first account's home.
    expect(w.statusCalls.filter((call) => call.instanceId === 'claude:personal').every((call) => call.env.CLAUDE_CONFIG_DIR === w.homeOf('claude:personal'))).toBe(true)
    expect(w.statusCalls.filter((call) => call.instanceId === WORK).length - callsBefore).toBe(1)
    // Both are in the list, each signed in to its own account.
    const personal = await snapshotOf(w, 'claude:personal')
    expect(personal.auth.state).toBe('signed_in')
    expect(personal.auth.account?.id).not.toBe(after.auth.account?.id)
    expect(personal.auth.message).toBeUndefined()
  })

  it('removing one account deletes only its own Mousse data and leaves the other accounts and their sign-ins', async () => {
    const w = world({ stored: threeAccounts })
    writeSignIn(w.homeOf(WORK), 'acct-work')
    writeSignIn(w.homeOf(HOME), 'acct-home')
    for (const id of ['claude', WORK, HOME]) await w.harness.instances.recheck(id)
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
    const ownSettings = join(w.profileHome, 'providers', 'claude-subscription', 'settings.json')
    const ownBefore = existsSync(ownSettings) ? readFileSync(ownSettings, 'utf8') : undefined
    expect(Object.keys(tree(homeDir))).toEqual(expect.arrayContaining(['settings.json', 'home/.claude.json']))

    await w.harness.instances.remove(HOME)
    await vi.waitFor(() => expect(existsSync(join(homeDir, 'settings.json'))).toBe(false))
    // Its Mousse state is gone; the sign-in files in its home stay (signing out removes them).
    expect(Object.keys(tree(homeDir))).toEqual(['home/.claude.json', 'home/.credentials.json'])
    // The other account and the user's own Claude are untouched.
    expect(tree(workDir)).toEqual(workBefore)
    expect(existsSync(ownSettings) ? readFileSync(ownSettings, 'utf8') : undefined).toBe(ownBefore)
    expect((await w.harness.instances.snapshots({ kind: 'device' })).map((snapshot) => snapshot.instanceId).sort()).toEqual(['claude', WORK])
    expect((await w.harness.instances.recheck(WORK)).auth.state).toBe('signed_in')
  })

  it('tells the user when two instances are signed in to the same account, and not when they differ', async () => {
    const w = world({ stored: threeAccounts })
    writeSignIn(w.homeOf(WORK), 'acct-same')
    writeSignIn(w.homeOf(HOME), 'acct-same')
    const checked = async () => {
      for (const id of ['claude', WORK, HOME]) await w.harness.instances.recheck(id)
      return { work: await snapshotOf(w, WORK), home: await snapshotOf(w, HOME), own: await snapshotOf(w, 'claude') }
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

describe('authentication routes outside the private home', () => {
  /** Every environment an instance's processes started with in `w`: checks, chats, version, sign-in. */
  async function runEverything(w: World, instanceId: string): Promise<NodeJS.ProcessEnv[]> {
    await w.harness.instances.recheck(instanceId)
    await turn(w, instanceId)
    const signIn = await startSignIn(w, instanceId)
    const terminal = await signIn.terminal()
    terminal.exit(1)
    await signIn.settled()
    return [
      ...w.statusCalls.filter((call) => call.instanceId === instanceId).map((call) => call.env),
      ...w.turnEnvs.filter((entry) => entry.instanceId === instanceId).map((entry) => entry.env),
      ...w.spawns.filter((spawned) => spawned.instanceId === instanceId).map((spawned) => spawned.env),
      terminal.env
    ]
  }

  it('a private home runs on its own sign-in whatever route the user\'s environment selects, and the built-in is untouched', async () => {
    const w = world({ stored: threeAccounts })
    const home = w.homeOf(WORK)
    writeSignIn(home, 'acct-work')
    const privateEnvs = await runEverything(w, WORK)
    expect(privateEnvs.length).toBeGreaterThanOrEqual(5)
    const dropped = Object.keys(AMBIENT).filter((name) => !['CLAUDE_CODE_GIT_BASH_PATH', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'ANTHROPIC_CONFIG_DIR'].includes(name))
    for (const env of privateEnvs) {
      // The credential file and the keychain item are the home's own; so is the Anthropic profile folder.
      expect(env.CLAUDE_CONFIG_DIR).toBe(home)
      expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(home)
      expect(env.ANTHROPIC_CONFIG_DIR).toBe(join(home, 'anthropic'))
      // No profile, token, key, cloud route or gateway of the user's survives, in any case of its name.
      for (const name of dropped) expect(Object.keys(env).filter((key) => key.toUpperCase() === name), name).toEqual([])
      expect(Object.keys(env).filter((key) => /^(AWS_|GOOGLE_|AZURE_)/i.test(key))).toEqual([])
      // Not a credential: kept.
      expect(env.CLAUDE_CODE_GIT_BASH_PATH).toBe(AMBIENT.CLAUDE_CODE_GIT_BASH_PATH)
    }
    // The user's own Claude runs exactly as before: every one of them still reaches it.
    const own = [
      ...w.statusCalls.filter((call) => call.instanceId === 'claude').map((call) => call.env)
    ]
    await turn(w, 'claude')
    own.push(...w.turnEnvs.filter((entry) => entry.instanceId === 'claude').map((entry) => entry.env))
    own.push(...w.spawns.filter((spawned) => spawned.instanceId === 'claude').map((spawned) => spawned.env))
    await w.harness.instances.recheck('claude')
    own.push(...w.spawns.filter((spawned) => spawned.instanceId === 'claude').map((spawned) => spawned.env))
    expect(own.length).toBeGreaterThanOrEqual(2)
    for (const env of own) for (const [name, value] of Object.entries(AMBIENT)) expect(env[name], name).toBe(value)
  })

  it('variables stored on the entry cannot bring a route back, and the editor says they are not used', async () => {
    const w = world({
      stored: (binary) => ({
        claude: { driver: 'claude', enabled: true },
        [WORK]: privateEntry('Work', binary, {
          env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '', ANTHROPIC_CONFIG_DIR: 'C:\\Users\\me\\AppData\\Roaming\\Anthropic', ANTHROPIC_PROFILE: 'mine', CLAUDE_CODE_USE_BEDROCK: '1', aws_bearer_token_bedrock: 'x', ANTHROPIC_MODEL: 'kept', KEEP_ME: '1' }
        })
      })
    })
    const home = w.homeOf(WORK)
    const envs = await runEverything(w, WORK)
    for (const env of envs) {
      expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(home)
      expect(env.ANTHROPIC_CONFIG_DIR).toBe(join(home, 'anthropic'))
      expect(env.ANTHROPIC_PROFILE).toBeUndefined()
      expect(Object.keys(env).filter((key) => /^(CLAUDE_CODE_USE_BEDROCK|AWS_BEARER_TOKEN_BEDROCK)$/i.test(key))).toEqual([])
    }
    // What is free to set still applies.
    expect(envs.at(-1)!.KEEP_ME).toBe('1')
    expect(envs.at(-1)!.ANTHROPIC_MODEL).toBe('kept')
    const snapshot = (await w.harness.instances.snapshots({ kind: 'device' })).find((entry) => entry.instanceId === WORK)!
    expect(snapshot.auth.message).toContain('Not used: CLAUDE_SECURESTORAGE_CONFIG_DIR, ANTHROPIC_CONFIG_DIR, ANTHROPIC_PROFILE, CLAUDE_CODE_USE_BEDROCK, aws_bearer_token_bedrock.')
    expect(snapshot.auth.message).not.toContain('KEEP_ME')
    const own = (await w.harness.instances.snapshots({ kind: 'device' })).find((entry) => entry.instanceId === 'claude')!
    expect(own.auth.message).toBeUndefined()
  })

  it.each([
    ['CLAUDE_SECURESTORAGE_CONFIG_DIR'], ['claude_securestorage_config_dir'], ['ANTHROPIC_CONFIG_DIR'], ['ANTHROPIC_PROFILE'],
    ['CLAUDE_CODE_USE_VERTEX'], ['AWS_BEARER_TOKEN_BEDROCK'], ['GOOGLE_APPLICATION_CREDENTIALS'], ['ANTHROPIC_FOUNDRY_API_KEY'], ['CLAUDE_CODE_OAUTH_REFRESH_TOKEN']
  ])('Settings refuses %s on a private home, and the built-in may set it', async (name) => {
    const w = world()
    await expect(w.harness.instances.configure(WORK, { env: { [name]: 'x' } })).rejects.toMatchObject({ code: 'unsupported' })
    await expect(w.harness.instances.add({ driver: 'claude', config: { displayName: 'Other', env: { [name]: 'x' } } })).rejects.toMatchObject({ code: 'unsupported' })
    await expect(w.harness.instances.configure('claude', { env: { [name]: 'mine' } })).resolves.toBeDefined()
  })

  it('names Windows spells every way: one of each home variable, the folder inside the home, spaces kept', () => {
    const home = 'C:\\Users\\me\\Mousse Profiles\\p one\\harness\\claude_work\\home'
    const env = ownedLaunchEnv('claude', { home, env: { Path: 'C:\\Windows', Claude_Securestorage_Config_Dir: 'C:\\Users\\me\\.claude', anthropic_config_dir: 'C:\\Users\\me\\AppData\\Roaming\\Anthropic', Anthropic_Profile: 'p', Aws_Region: 'x' } }, { claude_securestorage_config_dir: '' })
    for (const name of ['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'ANTHROPIC_CONFIG_DIR'])
      expect(Object.keys(env).filter((key) => key.toUpperCase() === name), name).toEqual([name])
    expect(env.CLAUDE_CONFIG_DIR).toBe(home)
    expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(home)
    expect(env.ANTHROPIC_CONFIG_DIR).toBe(join(home, 'anthropic'))
    expect(Object.keys(env).filter((key) => /^(ANTHROPIC_PROFILE|AWS_)/i.test(key))).toEqual([])
    expect(env.Path).toBe('C:\\Windows')
    // Without a home it is the plain environment, and other drivers are not touched.
    expect(ownedLaunchEnv('claude', { env: { Anthropic_Profile: 'p' } }, undefined)).toEqual({ Anthropic_Profile: 'p' })
    expect(ownedLaunchEnv('grok', { home, env: { AWS_REGION: 'x' } }, undefined).AWS_REGION).toBe('x')
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

  it.each(['home', 'ancestor'] as const)('sign-out is refused when the %s is a link: no logout runs against the other account', async (where) => {
    const w = world()
    const { otherHome, before, files } = linked(w, where)
    await expect(w.harness.instances.signOut(WORK)).rejects.toThrow(/link/)
    expect(w.spawns.filter((spawned) => spawned.args.includes('logout'))).toEqual([])
    expect(files(otherHome)).toEqual(before)
  })

  it('a folder of Mousse\'s own, outside it, or not there yet is judged by where it really is', () => {
    const root = tempDir('mousse-owned-root')
    const own = join(root, 'harness', 'claude_work', 'home')
    expect(ownedHomeProblem(own, root)).toBeUndefined()
    mkdirSync(own, { recursive: true })
    expect(ownedHomeProblem(own, root)).toBeUndefined()
    expect(ownedHomeProblem(join(tempDir('mousse-elsewhere'), 'home'), root)).toMatch(/outside/)
    expect(ownedHomeProblem(root, root)).toMatch(/outside/)
  })
})

describe('signing out', () => {
  const signedInWorld = (env: Record<string, string> = {}) => {
    const w = world({ stored: (binary) => ({ claude: { driver: 'claude', enabled: true }, [WORK]: privateEntry('Work', binary, { env }) }) })
    writeSignIn(w.homeOf(WORK), 'acct-work')
    return w
  }
  const settings = (w: World) => JSON.parse(readFileSync(join(instanceStateDir(w.profileHome, WORK), 'settings.json'), 'utf8'))

  it('a logout that fails while the account is still signed in is an error the user sees', async () => {
    const w = signedInWorld({ FAKE_LOGOUT: 'fail' })
    expect((await w.harness.instances.recheck(WORK)).auth.state).toBe('signed_in')
    await expect(w.harness.instances.signOut(WORK)).rejects.toThrow(/exited with code 3.*still signed in/)
    // The sign-in is still in the home; the gateway stopped using the account (it fails closed) and says so.
    expect(existsSync(join(w.homeOf(WORK), '.claude.json'))).toBe(true)
    const after = await w.harness.instances.recheck(WORK)
    expect(after.auth).toMatchObject({ state: 'signed_out', message: expect.stringContaining('Signed out in Mousse') })
  })

  it('a logout that says it worked while the account still reads signed in is an error too', async () => {
    const w = signedInWorld({ FAKE_LOGOUT: 'noop' })
    await w.harness.instances.recheck(WORK)
    await expect(w.harness.instances.signOut(WORK)).rejects.toThrow(/still reads signed in/)
    expect(existsSync(join(w.homeOf(WORK), '.claude.json'))).toBe(true)
  })

  it('a missing executable is an error the user sees, not a quiet sign-out', async () => {
    const w = world({ stored: () => ({ claude: { driver: 'claude', enabled: true }, [WORK]: privateEntry('Work', join(tempDir('mousse-nothing'), 'claude.exe')) }) })
    writeSignIn(w.homeOf(WORK), 'acct-work')
    await expect(w.harness.instances.signOut(WORK)).rejects.toThrow(/not found/)
    expect(existsSync(join(w.homeOf(WORK), '.claude.json'))).toBe(true)
  })

  it('a non-zero exit from an account that was already signed out is a sign-out', async () => {
    const w = world()
    expect((await w.harness.instances.recheck(WORK)).auth.state).toBe('signed_out')
    // The CLI exits 1: there is nothing to log out of, and the status check confirms it.
    const done = await w.harness.instances.signOut(WORK)
    expect(done.auth.state).toBe('signed_out')
    expect(w.spawns.some((spawned) => spawned.args.slice(-2).join(' ') === 'auth logout')).toBe(true)
    expect(settings(w).cliDisconnected).toBe(true)
  })
})

describe('the sign-in dialog', () => {
  it('offers the paste field again when Claude refuses a code', async () => {
    const w = world()
    await w.harness.instances.recheck(WORK)
    const signIn = await startSignIn(w, WORK)
    const terminal = await signIn.terminal()
    terminal.print(`${LOGIN_OUTPUT}Paste code here if prompted > `)
    // The first field comes before the link; one offered after it is the link shown again with the field under it.
    const fields = () => signIn.prompts().filter((prompt) => prompt.type === 'input' || (prompt.type === 'auth_url' && prompt.pasteMessage !== undefined))
    await vi.waitFor(() => expect(fields()).toHaveLength(1))
    await w.harness.instances.respondSignIn(signIn.started.operationId, { promptId: fields()[0]!.promptId, kind: 'input', value: 'half-a-code' })
    await vi.waitFor(() => expect(terminal.written).toEqual(['half-a-code\r']))
    terminal.print('\r\nInvalid code. Please make sure the full code was copied.\r\nPaste code here if prompted > ')
    await vi.waitFor(() => expect(fields()).toHaveLength(2))
    expect(fields()[1]).toMatchObject({ type: 'auth_url', acceptsRedirectPaste: true, pasteMessage: expect.stringContaining('did not accept') })
    // The same refusal printed again in the same output does not add a field; a second one does.
    await w.harness.instances.respondSignIn(signIn.started.operationId, { promptId: fields()[1]!.promptId, kind: 'input', value: 'the-whole-code' })
    await vi.waitFor(() => expect(terminal.written).toEqual(['half-a-code\r', 'the-whole-code\r']))
    terminal.exit(0, 'acct-work')
    expect((await signIn.settled()).phase).toBe('completed')
  })

  it('shows the sign-in link and not an earlier notice that has a link in it', async () => {
    const w = world()
    await w.harness.instances.recheck(WORK)
    const signIn = await startSignIn(w, WORK)
    const terminal = await signIn.terminal()
    terminal.print('A new version is available: https://docs.example.test/install\r\n')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(signIn.prompts()).toEqual([])
    terminal.print(LOGIN_OUTPUT)
    await vi.waitFor(() => expect(signIn.prompts().some((prompt) => prompt.type === 'auth_url')).toBe(true))
    const links = signIn.prompts().flatMap((prompt) => (prompt.type === 'auth_url' ? [prompt.url] : []))
    expect(links).toEqual(['https://claude.ai/oauth/authorize?code=true&client_id=fake-client&state=fake-state'])
    terminal.exit(1)
    await signIn.settled()
  })

  it('a cancel after Claude accepted the sign-in lets it finish its files, then takes the account up', async () => {
    const w = world()
    await w.harness.instances.recheck(WORK)
    const signIn = await startSignIn(w, WORK)
    const terminal = await signIn.terminal()
    terminal.print(`${LOGIN_OUTPUT}Login successful.\r\n`)
    await vi.waitFor(() => expect(signIn.prompts().length).toBeGreaterThan(0))
    await w.harness.instances.respondSignIn(signIn.started.operationId, { kind: 'cancel' })
    // The command is not killed mid-write; it ends by itself.
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(terminal.kills).toBe(0)
    terminal.exit(0, 'acct-work')
    expect((await signIn.settled()).phase).toBe('cancelled')
    // Nothing half done: the home is signed in and Mousse says so.
    await vi.waitFor(async () => expect((await w.harness.instances.recheck(WORK)).auth.state).toBe('signed_in'))
  })
})

describe('account fingerprint', () => {
  it('is the same for one account in any home, differs per profile, and adds nothing to the state file', () => {
    const profileA = tempDir('mousse-fp-a')
    const profileB = tempDir('mousse-fp-b')
    const a = new InstanceCounterStore(profileA)
    const b = new InstanceCounterStore(profileB)
    // A fresh profile has no salt yet: the fingerprint creates it, never hashing with `undefined`.
    const fingerprint = a.accountFingerprint('subject-1')
    expect(fingerprint).toMatch(/^[0-9a-f]{32}$/)
    expect(a.accountFingerprint('subject-1')).toBe(fingerprint)
    expect(a.accountFingerprint('subject-2')).not.toBe(fingerprint)
    expect(b.accountFingerprint('subject-1')).not.toBe(fingerprint)
    // The identity (with the home) still differs per home, and is unchanged by the shared salt.
    expect(a.accountIdentity('private:claude:work', 'subject-1')).not.toBe(a.accountIdentity('private:claude:home', 'subject-1'))
    expect(new InstanceCounterStore(profileA).accountIdentity('private:claude:work', 'subject-1')).toBe(a.accountIdentity('private:claude:work', 'subject-1'))
    const state = JSON.parse(readFileSync(join(profileA, 'harness', 'state.json'), 'utf8'))
    expect(Object.keys(state).sort()).toEqual(['instances', 'salt', 'version'])
    expect(state.version).toBe(1)
  })
})

describe('terminal output', () => {
  it('finds the link behind terminal codes, and the paste prompt', () => {
    const transcript = '\x1b[2J\x1b[1mSign in\x1b[0m\r\n\x1b]8;;https://example.test\x07visit \x1b[4mhttps://claude.ai/oauth/authorize?code=true&state=s\x1b[0m.\r\nPaste code here if prompted > '
    expect(signInPrompts(transcript)).toEqual({ url: 'https://claude.ai/oauth/authorize?code=true&state=s', pastePrompt: true })
    expect(signInPrompts('Opening browser')).toEqual({})
    expect(signInPrompts('Paste Code Here if prompted').pastePrompt).toBe(true)
    // The device flows keep working.
    expect(signInPrompts('Open https://accounts.example.test/device and enter code ABCD-EFGH')).toEqual({ url: 'https://accounts.example.test/device', userCode: 'ABCD-EFGH' })
  })

  it('types into the terminal only while it runs', async () => {
    const terminal = terminalFactory()
    const run = runInPty('claude', ['auth', 'login'], { env: {}, spawn: terminal.spawn })
    run.write('one\r')
    terminal.terminals[0]!.exit(0)
    await run.done
    run.write('two\r')
    expect(terminal.terminals[0]!.written).toEqual(['one\r'])
  })

  it('redacts pasted values and link codes from a message', () => {
    const message = 'spawn failed: https://claude.ai/oauth/authorize?code=abc123&state=st9 after pasting pasted-code#st9; user_code=ABCD-EFGH'
    const redacted = redactSignIn(message, ['pasted-code#st9'])
    expect(redacted).not.toContain('abc123')
    expect(redacted).not.toContain('st9')
    expect(redacted).not.toContain('pasted-code')
    expect(redacted).not.toContain('ABCD-EFGH')
    expect(redacted).toContain('spawn failed')
  })

  it('a failure that carries a link or a code is shown without them', async () => {
    // A terminal that cannot start, whose error repeats the link it was given.
    const failing: PtySpawn = () => {
      throw new Error('cannot use the terminal: https://claude.ai/oauth/authorize?code=leaked-code&state=leaked-state')
    }
    const profileHome = tempDir('mousse-claude-fail')
    const binary = fakeClaude()
    const questions = new UserQuestionService()
    const driver = claudeCodeDriver({
      pty: { available: () => true, spawn: failing },
      createService: (context, options) => new ClaudeSubscriptionProviderService(context.profileHome, questions, { ...options, runAuth: async () => JSON.stringify({ loggedIn: false }) })
    })
    const runtime = driver.create({
      instanceId: WORK,
      builtIn: false,
      config: driver.decodeConfig({ home: 'private', binaryPath: binary }),
      env: instanceEnv({ instanceId: WORK, driver: 'claude', configRevision: 0, home: join(profileHome, 'home'), searchPath: [] }),
      profileHome,
      installationHome: profileHome,
      stateDir: profileHome,
      questions,
      findBinary: () => binary,
      changed: () => {}
    })
    stops.push(() => runtime.stop())
    const result = await runtime.signIn!(new LoginSession('op'), process.cwd())
    expect(result.success).toBe(false)
    expect(result.error).toContain('cannot use the terminal')
    expect(result.error).not.toContain('leaked-code')
    expect(result.error).not.toContain('leaked-state')
  })
})
