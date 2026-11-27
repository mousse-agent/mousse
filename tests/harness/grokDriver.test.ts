/**
 * The Grok driver (agent CLIs plan §5): every process runs `--permission-mode default agent
 * --no-leader stdio` whatever the home's config says, only the session-only "always" option is
 * offered, a private home never inherits another sign-in, and a device sign-in that finishes after
 * a cancel changes nothing.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PermissionOption } from '@agentclientprotocol/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { classifyGrokOption, GROK_PERMISSION_MODE, grokArgs } from '../../src/mms/harness/acp/presets/grok'
import type { DriverContext, DriverRuntime } from '../../src/mms/harness/driver'
import type { AgentInstalls } from '../../src/mms/harness/agents/install'
import { GROK_AGENT_ID, GROK_HELD_CHECK_DELAY_MS, GROK_HELD_RETRY_MS, grokDriver, grokPackageSpec, type GrokDriverOptions } from '../../src/mms/harness/drivers/grok'
import { fingerprintOf } from '../../src/mms/harness/status'
import { GROK_HELD_CONFIG } from '../../src/mms/harness/grok/held'
import { GROK_HELD_CHECK_VERSION, type GrokHeldRecord } from '../../src/mms/harness/grok/heldEvidence'
import { instanceEnv } from '../../src/mms/harness/env'
import type { PtyProcess, PtySpawn } from '../../src/mms/harness/pty'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { LoginSession } from '../../src/mms/providers/LoginSession'

const spawned = vi.hoisted(() => [] as Array<{ purpose: string; command: string; args: string[]; env: NodeJS.ProcessEnv }>)
vi.mock('../../src/mms/harness/spawn', async (original) => ({
  ...(await original<typeof import('../../src/mms/harness/spawn')>()),
  // Records the launch and stops it there: no Grok runs in these tests.
  spawnHarness: (env: { env: NodeJS.ProcessEnv }, purpose: string, command: string, args: string[]) => {
    spawned.push({ purpose, command, args, env: env.env })
    throw new Error('not started in tests')
  }
}))

const dirs: string[] = []
const runtimes: DriverRuntime[] = []
beforeEach(() => {
  spawned.length = 0
})
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const PINNED = ['--permission-mode', 'default', 'agent', '--no-leader', 'stdio']

function setup(options: { home?: 'private' | 'default'; base?: NodeJS.ProcessEnv; pty?: PtySpawn; agents?: AgentInstalls; binaryPath?: string | null; findBinary?: string; driver?: Partial<GrokDriverOptions> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mousse-grok-driver-'))
  dirs.push(root)
  const stateDir = join(root, 'state')
  const home = join(stateDir, 'home')
  const userHome = join(root, 'user-grok')
  mkdirSync(home, { recursive: true })
  mkdirSync(userHome, { recursive: true })
  const isPrivate = options.home !== 'default'
  const env = instanceEnv({
    instanceId: 'grok:work',
    driver: 'grok',
    configRevision: 0,
    ...(isPrivate ? { home } : {}),
    searchPath: [],
    base: { PATH: process.env.PATH, ...(isPrivate ? {} : { GROK_HOME: userHome }), ...options.base }
  })
  const context: DriverContext = {
    instanceId: 'grok:work',
    builtIn: false,
    config: { home: isPrivate ? 'private' : 'default', ...(options.binaryPath === null ? {} : { binaryPath: options.binaryPath ?? process.execPath }) },
    env,
    profileHome: root,
    installationHome: root,
    stateDir,
    questions: new UserQuestionService(),
    findBinary: () => options.findBinary,
    changed: () => {}
  }
  const driver = grokDriver({
    ...options.driver,
    ...(options.agents ? { agents: options.agents } : {}),
    systemDir: join(root, 'system'),
    pty: { available: () => Boolean(options.pty), ...(options.pty ? { spawn: options.pty } : {}) }
  })
  const runtime = driver.create(context)
  runtimes.push(runtime)
  return { runtime, driver, home: isPrivate ? home : userHome, stateDir, root, context }
}

async function turn(runtime: DriverRuntime, cwd: string) {
  await runtime.adapter.startTurn(
    { threadId: 't', instanceId: 'grok:work', llmProvider: '', model: 'default', mode: 'agent', prompt: 'hi', cwd, nativeHistory: '', signal: new AbortController().signal } as never,
    { text: () => {}, thinking: () => {}, tool: () => {}, progress: () => {}, providerRef: () => {}, steerAccepted: () => {}, usage: () => {} } as never,
    { drainSteer: () => undefined, heartbeat: () => {} } as never,
    { mcp: null, context: { nativeHistoryAfterTurn: (text: string) => text } } as never
  ).catch(() => undefined)
}

describe('the Grok command line', () => {
  it('pins the default permission mode for every approvals policy', () => {
    expect(Object.values(GROK_PERMISSION_MODE)).toEqual(['default', 'default', 'default'])
    for (const approvals of ['ask', 'grants', 'never'] as const) expect(grokArgs(approvals)).toEqual(PINNED)
  })

  it('starts the check, the model refresh and a turn with the same pinned arguments', async () => {
    const { runtime, root } = setup()
    await runtime.handshake!(new AbortController().signal).catch(() => undefined)
    await runtime.refreshModels!(root).catch(() => undefined)
    await turn(runtime, root)
    expect(spawned.map((entry) => entry.purpose)).toEqual(['acp-handshake', 'acp-models', 'acp-turn'])
    for (const entry of spawned) {
      expect(entry.command).toBe(process.execPath)
      expect(entry.args).toEqual(PINNED)
    }
  })

  it('still pins the mode when the home config sets always-approve (the command line wins over config.toml)', async () => {
    const { runtime, home, root } = setup({ home: 'default' })
    writeFileSync(join(home, 'config.toml'), '[cli]\npermission_mode = "always-approve"\n')
    await turn(runtime, root)
    expect(spawned[0]!.args).toEqual(PINNED)
    expect(spawned[0]!.args).not.toContain('--always-approve')
  })

  it('offers only the session-only "always" option; every project-wide allow or deny rule is hidden', () => {
    const option = (optionId: string, kind: PermissionOption['kind'], name: string): PermissionOption => ({ optionId, kind, name })
    const shown = [
      option('allow-once', 'allow_once', 'Yes'),
      option('allow-edits-session', 'allow_always', 'Yes, allow all edits during this session'),
      option('always-allow', 'allow_always', "Yes, and don't ask again for bash commands"),
      option('reject-once', 'reject_once', 'No'),
      option('reject-always', 'reject_always', "No, and don't ask again for this command")
    ].map(classifyGrokOption)
    expect(shown).toEqual([
      { optionId: 'allow-once', kind: 'allow_once', label: 'Yes', scope: 'once' },
      { optionId: 'allow-edits-session', kind: 'allow_always', label: 'Allow edits for this session', scope: 'session' },
      null,
      { optionId: 'reject-once', kind: 'reject_once', label: 'No', scope: 'once' },
      null
    ])
  })
})

describe('the Grok environment', () => {
  it('in a private home drops every inherited sign-in, signs in from its home, and turns the updater off for checks', async () => {
    const { runtime, home, root, stateDir } = setup({ base: { XAI_API_KEY: 'ambient', GROK_AUTH_PROVIDER_COMMAND: 'corp', GROK_MODELS_BASE_URL: 'https://x', GROK_LOCAL_AUTH: '1', GROK_CLI_CHAT_PROXY_BASE_URL: 'https://y' } })
    await runtime.handshake!(new AbortController().signal).catch(() => undefined)
    await turn(runtime, root)
    const [check, chat] = spawned
    expect(check!.env).toMatchObject({ GROK_HOME: join(stateDir, 'held-home'), GROK_AUTH_PATH: join(home, 'auth.json'), GROK_DISABLE_AUTOUPDATER: '1', GROK_OAUTH2_REFERRER: 'mousse' })
    for (const name of ['XAI_API_KEY', 'GROK_AUTH_PROVIDER_COMMAND', 'GROK_MODELS_BASE_URL', 'GROK_LOCAL_AUTH', 'GROK_CLI_CHAT_PROXY_BASE_URL']) {
      expect(check!.env[name]).toBeUndefined()
      expect(chat!.env[name]).toBeUndefined()
    }
    // A Mousse-owned home never updates Grok behind the user's back.
    expect(chat!.env.GROK_DISABLE_AUTOUPDATER).toBe('1')
  })

  it('runs the user’s own home exactly as the user set it up', async () => {
    const { runtime, root } = setup({ home: 'default', base: { GROK_DISABLE_AUTOUPDATER: '0', GROK_OAUTH2_REFERRER: 'shell' } })
    await runtime.handshake!(new AbortController().signal).catch(() => undefined)
    await turn(runtime, root)
    expect(spawned).toHaveLength(2)
    // The user's own variables stay, but a held process never updates Grok: the executable its check read stays the one that runs.
    for (const entry of spawned) expect(entry.env).toMatchObject({ GROK_DISABLE_AUTOUPDATER: '1', GROK_OAUTH2_REFERRER: 'shell' })
    const plain = setup({ home: 'default' })
    spawned.length = 0
    await turn(plain.runtime, plain.root)
    expect(spawned[0]!.env.GROK_OAUTH2_REFERRER).toBeUndefined()
  })

  it('runs with the key Mousse keeps, which wins over an inherited one', async () => {
    const { runtime, root, stateDir } = setup({ home: 'default', base: { XAI_API_KEY: 'ambient' } })
    expect(await runtime.auth({ force: false })).toMatchObject({ state: 'signed_in', methodLabel: 'API key' })
    const ambient = await runtime.identity!(new AbortController().signal)
    await runtime.adoptApiKey!('xai-own')
    expect(await runtime.identity!(new AbortController().signal)).not.toBe(ambient)
    await turn(runtime, root)
    expect(spawned[0]!.env.XAI_API_KEY).toBe('xai-own')
    // The key is kept in the vault, never in the state file.
    for (const file of ['acp.json', 'secrets.json']) {
      const path = join(stateDir, file)
      if (file === 'acp.json') expect(existsSync(path) ? readFileSync(path, 'utf8') : '').not.toContain('xai-own')
      else expect(existsSync(path)).toBe(true)
    }
  })

  it('reads an override as an unknown account, with no subject to resume by', async () => {
    const { runtime } = setup({ home: 'default', base: { GROK_AUTH_PROVIDER_COMMAND: 'corp-token' } })
    expect(await runtime.auth({ force: false })).toMatchObject({ state: 'unknown' })
    expect(await runtime.identity!(new AbortController().signal)).toBeUndefined()
  })
})

describe('Grok device sign-in', () => {
  function fakePty(exit: { code: number; afterCancel?: boolean }, output = 'Open https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH and enter code ABCD-EFGH\n') {
    const runs: Array<{ args: string[]; env: NodeJS.ProcessEnv; finish: () => void }> = []
    const spawn: PtySpawn = (_command, args, options) => {
      let onExit: ((event: { exitCode: number }) => void) | undefined
      let onData: ((data: string) => void) | undefined
      const finish = () => {
        // The command writes its sign-in where it was told to, then exits.
        const target = options.env.GROK_HOME
        if (target && exit.code === 0) writeFileSync(join(target, 'auth.json'), JSON.stringify({ 'https://auth.x.ai::c': { user_id: 'late-user', expires_at: '2099-01-01T00:00:00Z' } }))
        onExit?.({ exitCode: exit.code })
      }
      runs.push({ args, env: options.env, finish })
      const terminal: PtyProcess = {
        pid: 0,
        onData: (listener) => { onData = listener; setTimeout(() => onData?.(output), 0); return { dispose: () => {} } },
        onExit: (listener) => { onExit = listener; if (!exit.afterCancel) setTimeout(finish, 5); return { dispose: () => {} } },
        kill: () => {}
      }
      return terminal
    }
    return { spawn, runs }
  }

  it('signs a private home in through a staging home, shows the device code, and keeps the account', async () => {
    const pty = fakePty({ code: 0 })
    const { runtime, home } = setup({ pty: pty.spawn })
    const session = new LoginSession('login-1')
    const events: Array<{ type: string }> = []
    session.on('event', (event: { type: string }) => events.push(event))
    expect(await runtime.signIn!(session, '/tmp', 'account')).toMatchObject({ success: true })
    expect(pty.runs[0]!.args).toEqual(['login', '--device-auth'])
    expect(pty.runs[0]!.env.GROK_HOME).not.toBe(home)
    expect(events).toContainEqual(expect.objectContaining({ type: 'device_code', userCode: 'ABCD-EFGH' }))
    expect(JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8'))).toHaveProperty(['https://auth.x.ai::c', 'user_id'], 'late-user')
    // Copied in one step: nothing half-written or temporary is left beside it.
    expect(readdirSync(home).filter((name) => name.includes('auth'))).toEqual(['auth.json'])
    expect(await runtime.identity!(new AbortController().signal)).toBe('late-user')
  })

  it('changes nothing when the sign-in succeeds after a cancel', async () => {
    const pty = fakePty({ code: 0, afterCancel: true })
    const { runtime, home } = setup({ pty: pty.spawn })
    const session = new LoginSession('login-2')
    const result = runtime.signIn!(session, '/tmp', 'account')
    await vi.waitFor(() => expect(pty.runs).toHaveLength(1))
    session.abort.abort()
    pty.runs[0]!.finish()
    expect(await result).toMatchObject({ success: false, error: 'Login cancelled' })
    expect(existsSync(join(home, 'auth.json'))).toBe(false)
    expect(await runtime.auth({ force: false })).toMatchObject({ state: 'signed_out' })
  })
})

describe('the managed Grok package', () => {
  it('names this computer’s package and the files it must hold', () => {
    expect(grokPackageSpec('1.0.70', 'win32', 'x64')).toMatchObject({ name: '@xai-official/grok-win32-x64', expand: { 'bin/grok.exe.br': 'bin/grok.exe' }, required: ['bin/grok.exe'], cmd: 'bin/grok.exe' })
    expect(grokPackageSpec('1.0.70', 'linux', 'arm64')).toMatchObject({ name: '@xai-official/grok-linux-arm64', required: ['bin/grok'] })
    expect(() => grokPackageSpec('1.0.70', 'freebsd', 'x64')).toThrow(/no Grok/)
    expect(() => grokPackageSpec('2.0.0', 'linux', 'x64')).toThrow(/does not know the files/)
  })
})

describe('a managed Grok copy', () => {
  /** A shared install of 1.0.70 that `holder` installed; `state.changed` says which file no longer matches. */
  function installs(holder: string, state: { changed?: string } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'mousse-grok-managed-'))
    dirs.push(root)
    const program = join(root, 'dist', 'bin', 'grok')
    const installed = { root, hash: 'h1', receipt: { version: '1.0.70', bytes: 1, checksum: 'registry', launch: { cmd: 'bin/grok', args: [], env: {} } } }
    const fake = {
      reference: (agentId: string, instanceId: string) => (agentId === GROK_AGENT_ID && instanceId === holder ? { version: '1.0.70', platform: 'linux-x86_64' } : undefined),
      packageSource: (spec: { agentId: string; version: string }) => ({ kind: 'registry', agentId: spec.agentId, version: spec.version, distribution: 'binary' }),
      installed: () => installed,
      launch: () => ({ command: program, args: [], env: {}, path: program }),
      changed: async () => state.changed,
      track: () => () => {}
    }
    return { agents: fake as unknown as AgentInstalls, program }
  }

  const SIGNED_IN = JSON.stringify({ auth: { bindingHash: 'x', methodId: 'grok.com', authenticated: true }, authMethods: [{ id: 'grok.com', name: 'Grok' }] })

  it('runs only for the entry with its own home that installed it; the user’s own home runs its own grok', async () => {
    const shared = installs('grok:work')
    const holder = setup({ agents: shared.agents, binaryPath: null, findBinary: process.execPath })
    await holder.runtime.handshake!(new AbortController().signal).catch(() => undefined)
    expect(spawned[0]!.command).toBe(shared.program)
    expect(holder.runtime.managed!()).toMatchObject({ version: '1.0.70' })
    spawned.length = 0
    const userHome = setup({ home: 'default', agents: shared.agents, binaryPath: null, findBinary: process.execPath })
    await userHome.runtime.handshake!(new AbortController().signal).catch(() => undefined)
    expect(spawned[0]!.command).toBe(process.execPath)
    expect(userHome.runtime.managed!()).toBeUndefined()
    spawned.length = 0
    const otherEntry = setup({ agents: installs('grok:someone-else').agents, binaryPath: null, findBinary: process.execPath })
    await otherEntry.runtime.handshake!(new AbortController().signal).catch(() => undefined)
    expect(spawned[0]!.command).toBe(process.execPath)
  })

  it('checks the files before every launch: device sign-in, browser sign-in and sign-out', async () => {
    const state: { changed?: string } = { changed: 'bin/grok changed' }
    const shared = installs('grok:work', state)
    let ptyStarts = 0
    const pty: PtySpawn = () => {
      ptyStarts += 1
      throw new Error('no terminal in tests')
    }
    const withTerminal = setup({ agents: shared.agents, binaryPath: null, pty })
    expect(await withTerminal.runtime.signIn!(new LoginSession('l1'), '/tmp', 'account')).toMatchObject({ success: false, error: expect.stringMatching(/files changed/) })
    expect(ptyStarts).toBe(0)
    const noTerminal = setup({ agents: shared.agents, binaryPath: null })
    expect(await noTerminal.runtime.signIn!(new LoginSession('l2'), '/tmp', 'account')).toMatchObject({ success: false, error: expect.stringMatching(/files changed/) })
    expect(spawned).toEqual([])
    // A sign-out that asks the private home's Grok to sign out checks first too.
    writeFileSync(join(noTerminal.stateDir, 'acp.json'), SIGNED_IN)
    const changedFiles = grokDriver({ agents: shared.agents }).create(noTerminal.context)
    runtimes.push(changedFiles)
    await changedFiles.signOut!()
    expect(spawned).toEqual([])
    state.changed = undefined
    writeFileSync(join(noTerminal.stateDir, 'acp.json'), SIGNED_IN)
    const matching = grokDriver({ agents: shared.agents }).create(noTerminal.context)
    runtimes.push(matching)
    await matching.signOut!()
    expect(spawned.map((entry) => [entry.purpose, entry.command])).toEqual([['acp-sign_out', shared.program]])
  })

  it('never asks Grok to sign the user’s own home out', async () => {
    const userHome = setup({ home: 'default' })
    writeFileSync(join(userHome.stateDir, 'acp.json'), SIGNED_IN)
    const runtime = grokDriver({}).create(userHome.context)
    runtimes.push(runtime)
    await runtime.signOut!()
    expect(spawned).toEqual([])
  })
})

describe('the held launch', () => {
  const record = (patch: Partial<GrokHeldRecord> = {}): GrokHeldRecord => ({
    cliVersion: '9.9.9', platform: 'linux', turns: true, titles: true, tools: ['read_file'], checkVersion: GROK_HELD_CHECK_VERSION, recordedAt: '2026-11-27T00:00:00Z', ...patch
  })
  const held = (patch: Partial<GrokDriverOptions> = {}) => ({ driver: { platform: 'linux' as const, shipped: [], ...patch } })

  it('runs turns, listings and checks of the user’s own home on the held home, signing in from the user’s auth.json', async () => {
    const { runtime, home, root, stateDir } = setup({ home: 'default' })
    await runtime.handshake!(new AbortController().signal).catch(() => undefined)
    await runtime.refreshModels!(root).catch(() => undefined)
    await turn(runtime, root)
    expect(spawned).toHaveLength(3)
    for (const entry of spawned) {
      expect(entry.env).toMatchObject({ GROK_HOME: join(stateDir, 'held-home'), GROK_AUTH_PATH: join(home, 'auth.json'), GROK_WORKTREE_INHERITS_MAIN_APPROVALS: 'false' })
    }
    expect(readFileSync(join(stateDir, 'held-home', 'config.toml'), 'utf8')).toBe(GROK_HELD_CONFIG)
    // The user's own home holds no copy of anything.
    expect(readdirSync(home)).toEqual([])
  })

  it('runs on the user’s home when Mousse cannot tell the sign-in, and says why it holds nothing then', async () => {
    const { runtime, driver, root, home } = setup({ home: 'default', base: { GROK_AUTH_PROVIDER_COMMAND: 'corp-token' }, ...held({ shipped: [record()] }) })
    await turn(runtime, root)
    expect(spawned[0]!.env.GROK_HOME).toBe(home)
    expect(driver.caps({}, '9.9.9', undefined, 'grok:work').toolControl).toBe('uncontrolled')
    expect(driver.toolControlReason!({}, '9.9.9', 'grok:work')).toMatch(/cannot tell which account/)
  })

  // Rows: what is known about the running version, and what the entry claims.
  const rows: Array<{ name: string; version: string | undefined; shipped: GrokHeldRecord[]; local?: GrokHeldRecord[]; turns: boolean; titles: boolean; reason?: RegExp }> = [
    { name: 'a shipped record for this version', version: '9.9.9', shipped: [record()], turns: true, titles: true },
    { name: 'a local record for this version', version: '9.9.9', shipped: [], local: [record()], turns: true, titles: true },
    { name: 'no record yet', version: '9.9.9', shipped: [], turns: false, titles: false, reason: /not yet checked that Grok 9\.9\.9/ },
    { name: 'no version read', version: undefined, shipped: [record()], turns: false, titles: false, reason: /not read which Grok version/ },
    { name: 'a record for another platform', version: '9.9.9', shipped: [record({ platform: 'darwin' })], turns: false, titles: false, reason: /not yet checked/ },
    { name: 'a record of an older check', version: '9.9.9', shipped: [], local: [record({ checkVersion: GROK_HELD_CHECK_VERSION - 1 })], turns: false, titles: false, reason: /not yet checked/ },
    { name: 'a shipped record of an older check', version: '9.9.9', shipped: [record({ checkVersion: GROK_HELD_CHECK_VERSION - 1 })], turns: false, titles: false, reason: /not yet checked/ },
    { name: 'a version whose turns did not hold', version: '9.9.9', shipped: [record({ turns: false, reason: 'Grok ran read without asking Mousse first.' })], turns: false, titles: true, reason: /Grok ran read without asking/ },
    { name: 'a version whose one-shots did not hold', version: '9.9.9', shipped: [record({ titles: false, reason: 'Grok offered tools in a request that runs none.' })], turns: true, titles: false, reason: /offered tools/ }
  ]
  for (const row of rows) {
    it(`claims what is proven: ${row.name}`, () => {
      const { driver, stateDir } = setup(held({ shipped: row.shipped }))
      if (row.local) writeFileSync(join(stateDir, 'grok-held.json'), JSON.stringify({ version: 1, records: row.local }))
      expect(driver.caps({}, row.version, undefined, 'grok:work').toolControl).toBe(row.turns ? 'approval_only' : 'uncontrolled')
      const turnsWhy = driver.toolControlReason!({}, row.version, 'grok:work')
      const titlesWhy = driver.oneShotRefusal!({}, row.version, 'grok:work')
      expect(turnsWhy === undefined).toBe(row.turns)
      expect(titlesWhy === undefined).toBe(row.titles)
      if (row.reason) expect([turnsWhy, titlesWhy].filter(Boolean).join(' ')).toMatch(row.reason)
    })
  }

  it('checks a version it has no record for once, in the background after a probe, and keeps what the check proved', async () => {
    let finish: (value: GrokHeldRecord | undefined) => void = () => {}
    const heldCheck = vi.fn(() => new Promise<GrokHeldRecord | undefined>((resolve) => { finish = resolve }))
    const changed = vi.fn()
    const { runtime, driver, context } = setup(held({ heldCheck }))
    context.changed = changed
    runtime.probed!('9.9.9', { soon: true })
    // Returns at once: the check runs on, and a second probe while it runs starts nothing.
    runtime.probed!('9.9.9', { soon: true })
    await vi.waitFor(() => expect(heldCheck).toHaveBeenCalledTimes(1))
    expect(heldCheck.mock.calls[0]![0]).toMatchObject({ command: process.execPath, cliVersion: '9.9.9' })
    expect(driver.caps({}, '9.9.9', undefined, 'grok:work').toolControl).toBe('uncontrolled')
    finish(record())
    await vi.waitFor(() => expect(changed).toHaveBeenCalled())
    expect(driver.caps({}, '9.9.9', undefined, 'grok:work').toolControl).toBe('approval_only')
    runtime.probed!('9.9.9', { soon: true })
    expect(heldCheck).toHaveBeenCalledTimes(1)
  })

  it('keeps the last record when a check cannot conclude, and tries that version again only after a while', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const heldCheck = vi.fn(async () => undefined)
      const { runtime, driver, stateDir } = setup(held({ heldCheck }))
      writeFileSync(join(stateDir, 'grok-held.json'), JSON.stringify({ version: 1, records: [record({ cliVersion: '9.9.8' })] }))
      runtime.probed!('9.9.9', { soon: true })
      await vi.waitFor(() => expect(heldCheck).toHaveBeenCalledTimes(1))
      await new Promise((resolve) => setImmediate(resolve))
      runtime.probed!('9.9.9', { soon: true })
      expect(heldCheck).toHaveBeenCalledTimes(1)
      // The record of the version it last proved is untouched.
      expect(driver.caps({}, '9.9.8', undefined, 'grok:work').toolControl).toBe('approval_only')
      vi.setSystemTime(Date.now() + GROK_HELD_RETRY_MS + 1)
      runtime.probed!('9.9.9', { soon: true })
      await vi.waitFor(() => expect(heldCheck).toHaveBeenCalledTimes(2))
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits before a check no person asked for, and drops it on Stop', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const heldCheck = vi.fn(async () => record())
      const first = setup(held({ heldCheck }))
      first.runtime.probed!('9.9.9', { soon: false })
      await vi.advanceTimersByTimeAsync(GROK_HELD_CHECK_DELAY_MS - 1)
      expect(heldCheck).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(heldCheck).toHaveBeenCalledTimes(1)
      const second = setup(held({ heldCheck }))
      second.runtime.probed!('9.9.9', { soon: false })
      second.runtime.stop()
      await vi.advanceTimersByTimeAsync(GROK_HELD_CHECK_DELAY_MS * 2)
      // A check asked for after Stop starts nothing either.
      second.runtime.probed!('9.9.9', { soon: true })
      expect(heldCheck).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses the held launch on an organisation policy, naming the file, and starts no check', async () => {
    const heldCheck = vi.fn(async () => record())
    const { runtime, driver, root } = setup(held({ heldCheck, shipped: [record()] }))
    mkdirSync(join(root, 'system'), { recursive: true })
    writeFileSync(join(root, 'system', 'requirements.toml'), '[hooks]\n')
    await new Promise((resolve) => setTimeout(resolve, 2_100))
    expect(driver.caps({}, '9.9.9', undefined, 'grok:work').toolControl).toBe('uncontrolled')
    expect(driver.toolControlReason!({}, '9.9.9', 'grok:work')).toContain(join(root, 'system', 'requirements.toml'))
    expect(driver.oneShotRefusal!({}, '9.9.9', 'grok:work')).toContain('requirements.toml')
    runtime.probed!('9.9.8', { soon: true })
    expect(heldCheck).not.toHaveBeenCalled()
  })

  it('starts a turn or a title only on the executable its check read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-grok-binary-'))
    dirs.push(root)
    const binary = join(root, process.platform === 'win32' ? 'grok.exe' : 'grok')
    writeFileSync(binary, 'grok 9.9.9', { mode: 0o755 })
    const { runtime, stateDir } = setup({ home: 'default', binaryPath: binary, base: { XAI_API_KEY: 'xai-test' }, ...held({ shipped: [record()] }) })
    runtime.probed!('9.9.9', { fingerprint: fingerprintOf(binary)!, soon: true })
    await turn(runtime, root)
    expect(spawned).toHaveLength(1)
    // A self-update writes another program at the same path.
    writeFileSync(binary, 'grok 9.9.10, replaced')
    spawned.length = 0
    const refused = await runtime.adapter.startTurn(
      { threadId: 't2', instanceId: 'grok:work', llmProvider: '', model: 'default', mode: 'agent', prompt: 'hi', cwd: root, nativeHistory: '', signal: new AbortController().signal } as never,
      { text: () => {}, thinking: () => {}, tool: () => {}, progress: () => {}, providerRef: () => {}, steerAccepted: () => {}, usage: () => {} } as never,
      { drainSteer: () => undefined, heartbeat: () => {} } as never,
      { mcp: null, context: { nativeHistoryAfterTurn: (text: string) => text } } as never
    ).then(() => undefined, (error: unknown) => error)
    expect(refused).toMatchObject({ code: 'binding_stale' })
    await expect(runtime.oneShot!({ model: 'default', system: 's', prompt: 'p', onActivity: () => {} } as never, new AbortController().signal)).rejects.toMatchObject({ code: 'binding_stale' })
    expect(spawned).toEqual([])
    // Nothing was written for the refused title either.
    expect(existsSync(join(stateDir, 'one-shot'))).toBe(false)
  })

  it('forgets sessions saved on another home, so the next turn hands its history to a new session', () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-grok-sessions-'))
    dirs.push(root)
    const stateDir = join(root, 'state')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'acp.json'), JSON.stringify({ sessions: { t: { sessionId: 'native-1', cwd: root, instanceId: 'grok:work' } } }))
    const context: DriverContext = {
      instanceId: 'grok:work', builtIn: false, config: { home: 'private', binaryPath: process.execPath },
      env: instanceEnv({ instanceId: 'grok:work', driver: 'grok', configRevision: 0, home: join(stateDir, 'home'), searchPath: [], base: { PATH: process.env.PATH } }),
      profileHome: root, installationHome: root, stateDir, questions: new UserQuestionService(), findBinary: () => undefined, changed: () => {}
    }
    runtimes.push(grokDriver({ systemDir: join(root, 'system') }).create(context))
    const saved = JSON.parse(readFileSync(join(stateDir, 'acp.json'), 'utf8')) as { sessions?: Record<string, unknown>; sessionsHome?: string }
    expect(saved.sessions).toEqual({})
    expect(saved.sessionsHome).toBe(join(stateDir, 'held-home'))
  })
})
