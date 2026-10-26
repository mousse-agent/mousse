import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { claudeCodeDriver, claudeSignInCommand } from '../../src/mms/harness/drivers/claudeCode'
import { spawnCursorHost } from '../../src/mms/harness/cursor/hostClient'
import { cursorDriver } from '../../src/mms/harness/drivers/cursor'
import { piLegacyDriver } from '../../src/mms/harness/drivers/piLegacy'
import { createHarnessGateway, type TurnSpec } from '../../src/mms/harness/gateway'
import { instanceStateDir } from '../../src/mms/harness/instances'
import { instanceEnv } from '../../src/mms/harness/env'
import { observeHarnessSpawns, type HarnessSpawn } from '../../src/mms/harness/spawn'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { ClaudeSubscriptionProviderService } from '../../src/mms/providers/claudeSubscription/ClaudeSubscriptionProviderService'
import { claudeLoadsSkill } from '../../src/mms/providers/claudeSubscription/integrations'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import { FakeCursorHost } from './fakeCursorHost'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** A `claude` whose `--version` prints a version (a node script; an npm-style shim on Windows). */
function fakeClaude(): string {
  const dir = tempDir('mousse-fakeclaude-')
  mkdirSync(join(dir, 'node_modules', 'claude'), { recursive: true })
  const script = join(dir, 'node_modules', 'claude', 'cli.js')
  writeFileSync(join(dir, 'node_modules', 'claude', 'package.json'), JSON.stringify({ name: 'claude' }))
  writeFileSync(script, `#!/usr/bin/env node\nconsole.log('2.1.300 (Claude Code)')\n`)
  if (process.platform === 'win32') {
    const shim = join(dir, 'claude.cmd')
    writeFileSync(shim, `@ECHO off\r\n"%~dp0\\node_modules\\claude\\cli.js" %*\r\n`)
    return shim
  }
  chmodSync(script, 0o755)
  return script
}

type Seen = { instance: string; path: string; claudeHome: string | undefined }

describe('two Claude Code instances', () => {
  it('every spawn path and the skill resolution of an added instance use its own CLAUDE_CONFIG_DIR', async () => {
    const profileHome = tempDir('mousse-two-claude-')
    const binary = fakeClaude()
    const questions = new UserQuestionService()
    const seen: Seen[] = []
    const record = (instance: string, path: string, env: NodeJS.ProcessEnv) => seen.push({ instance, path, claudeHome: env.CLAUDE_CONFIG_DIR })
    let signedIn = false
    const runAuth = (instance: string) => async (_binary: string, args: string[], env: NodeJS.ProcessEnv) => {
      record(instance, `auth ${args.slice(-2).join(' ')}`, env)
      return JSON.stringify({ loggedIn: instance === 'claude' || signedIn, orgId: `org-${instance}` })
    }
    const query = (instance: string) => (input: { options: { env?: NodeJS.ProcessEnv } }) => {
      record(instance, 'turn', input.options.env ?? {})
      throw new Error('replay ends here')
    }
    const builtIn = new ClaudeSubscriptionProviderService(profileHome, questions, {
      findBinary: () => binary,
      runAuth: runAuth('claude'),
      query: query('claude') as never
    })
    const integrationEnvs: Array<() => NodeJS.ProcessEnv> = []
    let stored: unknown = {
      claude: { driver: 'claude', enabled: true },
      'claude:work': { driver: 'claude', enabled: true, config: { home: 'private', displayName: 'Work', binaryPath: binary } }
    }
    const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
    const harness = createHarnessGateway({
      profileHome,
      installationHome: profileHome,
      instanceMap: instances,
      questions,
      shellPath: async () => ({ entries: [], source: 'failed' }),
      drivers: [
        piLegacyDriver({ client: () => ({ chat: async () => { throw new Error('unused') } }) }),
        claudeCodeDriver({
          builtIn: () => builtIn,
          integrations: (env) => {
            integrationEnvs.push(env)
            return { resolve: async () => ({ mcpServers: {}, proxiedServers: {}, env: {}, toolRules: {}, warnings: [] }) }
          },
          createService: (context, options) => new ClaudeSubscriptionProviderService(context.profileHome, questions, {
            ...options,
            runAuth: runAuth(context.instanceId),
            query: query(context.instanceId) as never
          })
        })
      ]
    })
    const spawns: HarnessSpawn[] = []
    const stop = observeHarnessSpawns((spawned) => spawns.push(spawned))
    const privateHome = join(instanceStateDir(profileHome, 'claude:work'), 'home')
    try {
      // Status checks: --version through spawnHarness, sign-in through the service's runner.
      const before = await harness.instances.recheck('claude:work')
      expect(before.auth.state).toBe('signed_out')
      expect(before.nextStep?.command).toContain(privateHome)
      expect(before.nextStep?.command).toContain('claude auth login')
      expect(before.config).toMatchObject({ home: 'private', binaryPath: binary })
      signedIn = true
      const after = await harness.instances.recheck('claude:work')
      expect(after.auth).toMatchObject({ state: 'signed_in', canSignOut: true })
      const own = await harness.instances.recheck('claude')
      expect(own.auth).toMatchObject({ state: 'signed_in', canSignOut: false })
      expect(own.config?.home).toBe('default')

      // A turn on each instance.
      for (const instanceId of ['claude:work', 'claude']) {
        const resolved = harness.resolveStored({ instanceId, llmProvider: '', model: 'sonnet' }, { purpose: 'turn' })
        const spec = turnSpec(instanceId, await harness.bind(resolved, { mode: 'agent' }), tempDir('mousse-cwd-'))
        await harness.startTurn(spec).result.catch(() => undefined)
      }
    } finally {
      stop()
      harness.stop()
      builtIn.stop()
    }

    const work = seen.filter((entry) => entry.instance === 'claude:work')
    const mine = seen.filter((entry) => entry.instance === 'claude')
    expect(work.map((entry) => entry.path)).toEqual(expect.arrayContaining(['auth auth status', 'turn']))
    for (const entry of work) expect(entry.claudeHome, entry.path).toBe(privateHome)
    for (const entry of mine) expect(entry.claudeHome, entry.path).toBe(process.env.CLAUDE_CONFIG_DIR)
    expect(mine.map((entry) => entry.path)).toEqual(expect.arrayContaining(['auth auth status', 'turn']))

    const versionSpawns = spawns.filter((spawned) => spawned.purpose === 'version')
    expect(versionSpawns.find((spawned) => spawned.instanceId === 'claude:work')?.env.CLAUDE_CONFIG_DIR).toBe(privateHome)
    expect(versionSpawns.find((spawned) => spawned.instanceId === 'claude')?.env.CLAUDE_CONFIG_DIR).toBe(process.env.CLAUDE_CONFIG_DIR)

    // Skill resolution follows each instance's environment: the private home does not load ~/.claude/skills.
    const [workEnv, ownEnv] = [integrationEnvs.find((env) => env().CLAUDE_CONFIG_DIR === privateHome), integrationEnvs.find((env) => env().CLAUDE_CONFIG_DIR !== privateHome)]
    expect(workEnv).toBeTruthy()
    expect(claudeLoadsSkill({ source: 'claude-global' }, workEnv!())).toBe(false)
    expect(claudeLoadsSkill({ source: 'claude-global' }, ownEnv!())).toBe(!process.env.CLAUDE_CONFIG_DIR)
  }, 30_000)
})

describe('native resume on a real Claude service', () => {
  it('resumes on the same binding, and a launch-settings change makes the next SDK query start fresh', async () => {
    const profileHome = tempDir('mousse-claude-resume-')
    const binary = fakeClaude()
    const questions = new UserQuestionService()
    const privateHome = join(instanceStateDir(profileHome, 'claude:work'), 'home')
    mkdirSync(privateHome, { recursive: true })
    writeFileSync(join(privateHome, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'user-a', organizationUuid: 'org-1' } }))
    const resumes: Array<string | undefined> = []
    let sessions = 0
    const query = (input: { options: { resume?: string; tools?: unknown[] } }) => {
      // Model discovery (no tools, no prompt) is not a turn.
      if (Array.isArray(input.options.tools) && !input.options.tools.length)
        return Object.assign((async function* () {})(), { close: () => {}, interrupt: async () => {}, supportedModels: async () => [] })
      resumes.push(input.options.resume)
      const sessionId = input.options.resume ?? `session-${++sessions}`
      return Object.assign((async function* () {
        yield { type: 'system', subtype: 'init', session_id: sessionId }
        yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: sessionId }
      })(), { close: () => {}, interrupt: async () => {} })
    }
    let stored: unknown = {
      'claude:work': { driver: 'claude', enabled: true, config: { home: 'private', displayName: 'Work', binaryPath: binary } }
    }
    const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
    const harness = createHarnessGateway({
      profileHome,
      installationHome: profileHome,
      instanceMap: instances,
      questions,
      shellPath: async () => ({ entries: [], source: 'failed' }),
      drivers: [
        claudeCodeDriver({
          createService: (context, options) => new ClaudeSubscriptionProviderService(context.profileHome, questions, {
            ...options,
            runAuth: async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }),
            query: query as never
          })
        })
      ]
    })
    const cwd = tempDir('mousse-cwd-')
    let previous: TurnSpec['binding'] | undefined
    const turn = async () => {
      const resolved = harness.resolveStored({ instanceId: 'claude:work', llmProvider: '', model: 'sonnet' }, { purpose: 'turn' })
      const binding = await harness.bind(resolved, { mode: 'agent' })
      const spec = { ...turnSpec('claude:work', binding, cwd), ...(previous ? { previous } : {}) }
      await harness.startTurn(spec).result
      previous = binding
    }
    try {
      await turn()
      await turn()
      expect(resumes).toEqual([undefined, 'session-1'])
      await harness.instances.configure('claude:work', { env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '4000' } })
      await turn()
      expect(resumes).toEqual([undefined, 'session-1', undefined])
    } finally {
      harness.stop()
    }
  }, 30_000)
})

describe('sign-in command of a private home', () => {
  it('runs in Command Prompt and PowerShell alike on Windows, and quotes the home elsewhere', () => {
    expect(claudeSignInCommand(undefined, 'win32')).toBe('claude auth login')
    expect(claudeSignInCommand('C:\\Users\\me\\Mousse Profiles\\home', 'win32')).toBe('cmd /c "set CLAUDE_CONFIG_DIR=C:\\Users\\me\\Mousse Profiles\\home&& claude auth login"')
    expect(claudeSignInCommand("/home/me/it's/home", 'linux')).toBe("CLAUDE_CONFIG_DIR='/home/me/it'\\''s/home' claude auth login")
  })
})

describe('instance environments', () => {
  it('a private home does not inherit the user credential variables; the default home keeps everything', () => {
    const base = { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'user-token', ANTHROPIC_API_KEY: 'user-key', KEEP: '1' }
    const own = instanceEnv({ instanceId: 'claude', driver: 'claude', configRevision: 0, searchPath: [], base })
    expect(own.env).toEqual(base)
    expect(own.homeId).toBe('default')
    const work = instanceEnv({ instanceId: 'claude:work', driver: 'claude', configRevision: 2, home: '/profiles/p/harness/claude_work/home', searchPath: [], base })
    expect(work.env).toEqual({ PATH: '/bin', KEEP: '1', CLAUDE_CONFIG_DIR: '/profiles/p/harness/claude_work/home' })
    expect(work).toMatchObject({ homeId: 'private:claude:work', configRevision: 2 })
  })
})

describe('two Cursor instances', () => {
  it('each host starts without an ambient key; each instance runs with its own key, store and account', async () => {
    const profileHome = tempDir('mousse-two-cursor-')
    // The host process: its environment never carries the user's CURSOR_API_KEY.
    const script = join(profileHome, 'host.mjs')
    writeFileSync(script, 'process.exit(0)\n')
    const spawned: HarnessSpawn[] = []
    const unobserve = observeHarnessSpawns((entry) => spawned.push(entry))
    try {
      for (const instanceId of ['cursor:a', 'cursor:b']) {
        const env = instanceEnv({ instanceId, driver: 'cursor', configRevision: 0, searchPath: [], base: { PATH: process.env.PATH ?? '', CURSOR_API_KEY: 'user-key' } })
        spawnCursorHost(env, script).kill()
      }
    } finally {
      unobserve()
    }
    expect(spawned.map((entry) => [entry.instanceId, entry.purpose, entry.env.CURSOR_API_KEY, entry.env.ELECTRON_RUN_AS_NODE])).toEqual([
      ['cursor:a', 'cursor-host', undefined, '1'],
      ['cursor:b', 'cursor-host', undefined, '1']
    ])

    const hosts = new Map<string, FakeCursorHost>()
    const hostFor = (instanceId: string) => {
      const host = new FakeCursorHost({
        me: (params) => ({ userId: Number(String(params.apiKey).slice(-1)) }),
        models: () => ({ models: [] }),
        create: () => ({ agentId: `agent-${instanceId}-${hosts.get(instanceId)!.calls('create').length}` }),
        send: (_params, fake) => {
          const runId = `run-${fake.calls('send').length}`
          setTimeout(() => fake.emit({ event: 'run_end', runId, status: 'finished' }), 1)
          return { runId }
        },
        close: () => ({})
      })
      hosts.set(instanceId, host)
      return host
    }
    let stored: unknown = {
      'cursor:a': { driver: 'cursor', enabled: true, config: { displayName: 'A' } },
      'cursor:b': { driver: 'cursor', enabled: true, config: { displayName: 'B' } }
    }
    const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
    const harness = createHarnessGateway({
      profileHome,
      installationHome: profileHome,
      instanceMap: instances,
      questions: new UserQuestionService(),
      shellPath: async () => ({ entries: [], source: 'failed' }),
      drivers: [cursorDriver({ connect: (context) => (hosts.get(context.instanceId) ?? hostFor(context.instanceId)).connect() })]
    })
    try {
      const signIn = async (instanceId: string, key: string) => {
        const done = new Promise<void>((resolve, reject) => {
          const unsubscribe = harness.instances.subscribe((event) => {
            if (event.type !== 'operation' || event.data.instanceId !== instanceId) return
            const data = event.data
            if (data.phase === 'prompt') void harness.instances.respondSignIn(data.operationId, { promptId: data.prompt.promptId, kind: 'input', value: key })
            if (data.phase === 'completed') { unsubscribe(); resolve() }
            if (data.phase === 'failed') { unsubscribe(); reject(new Error(data.error.message)) }
          })
        })
        await harness.instances.signIn(instanceId, 'api_key')
        await done
      }
      await signIn('cursor:a', 'key-1')
      await signIn('cursor:b', 'key-2')
      const turn = async (instanceId: string, previous?: TurnSpec['binding']) => {
        const binding = await harness.bind(harness.resolveStored({ instanceId, llmProvider: '', model: 'default' }, { purpose: 'turn' }), { mode: 'agent' })
        const spec = turnSpec(instanceId, binding, profileHome)
        await harness.startTurn({ ...spec, ...(previous ? { previous } : {}), input: { ...spec.input, model: 'default', llmProvider: '' } }).result
        return binding
      }
      const firstA = await turn('cursor:a')
      await turn('cursor:b')
      expect(hosts.get('cursor:a')!.calls('create').map((call) => call.apiKey)).toEqual(['key-1'])
      expect(hosts.get('cursor:b')!.calls('create').map((call) => call.apiKey)).toEqual(['key-2'])
      // Each instance keeps its agents in its own store.
      expect(hosts.get('cursor:a')!.calls('create')[0]!.storeDir).not.toBe(hosts.get('cursor:b')!.calls('create')[0]!.storeDir)
      expect(firstA.accountId).toBeDefined()

      // Another key on A between two turns: the account moves on and the thread's agent is not reused.
      await signIn('cursor:a', 'key-3')
      const secondA = await turn('cursor:a', firstA)
      expect(secondA.accountGeneration).toBeGreaterThan(firstA.accountGeneration)
      expect(secondA.accountId).not.toBe(firstA.accountId)
      expect(hosts.get('cursor:a')!.calls('create').map((call) => call.apiKey)).toEqual(['key-1', 'key-3'])
      expect(hosts.get('cursor:a')!.calls('resume')).toEqual([])
    } finally {
      harness.stop()
    }
  })
})

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
