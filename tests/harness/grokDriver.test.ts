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
import { GROK_AGENT_ID, grokDriver, grokPackageSpec } from '../../src/mms/harness/drivers/grok'
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

function setup(options: { home?: 'private' | 'default'; base?: NodeJS.ProcessEnv; pty?: PtySpawn; agents?: AgentInstalls; binaryPath?: string | null; findBinary?: string } = {}) {
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
  const runtime = grokDriver({
    ...(options.agents ? { agents: options.agents } : {}),
    systemDir: join(root, 'system'),
    pty: { available: () => Boolean(options.pty), ...(options.pty ? { spawn: options.pty } : {}) }
  }).create(context)
  runtimes.push(runtime)
  return { runtime, home: isPrivate ? home : userHome, stateDir, root, context }
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
  it('in a private home drops every inherited sign-in, sets its home, and turns the updater off for checks', async () => {
    const { runtime, home, root } = setup({ base: { XAI_API_KEY: 'ambient', GROK_AUTH_PROVIDER_COMMAND: 'corp', GROK_MODELS_BASE_URL: 'https://x', GROK_LOCAL_AUTH: '1', GROK_CLI_CHAT_PROXY_BASE_URL: 'https://y' } })
    await runtime.handshake!(new AbortController().signal).catch(() => undefined)
    await turn(runtime, root)
    const [check, chat] = spawned
    expect(check!.env).toMatchObject({ GROK_HOME: home, GROK_DISABLE_AUTOUPDATER: '1', GROK_OAUTH2_REFERRER: 'mousse' })
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
    for (const entry of spawned) expect(entry.env).toMatchObject({ GROK_DISABLE_AUTOUPDATER: '0', GROK_OAUTH2_REFERRER: 'shell' })
    const plain = setup({ home: 'default' })
    spawned.length = 0
    await turn(plain.runtime, plain.root)
    expect(spawned[0]!.env.GROK_DISABLE_AUTOUPDATER).toBeUndefined()
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
