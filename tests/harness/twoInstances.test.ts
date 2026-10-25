import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { claudeCodeDriver } from '../../src/mms/harness/drivers/claudeCode'
import { piLegacyDriver } from '../../src/mms/harness/drivers/piLegacy'
import { createHarnessGateway, type TurnSpec } from '../../src/mms/harness/gateway'
import { instanceStateDir } from '../../src/mms/harness/instances'
import { instanceEnv } from '../../src/mms/harness/env'
import { observeHarnessSpawns, type HarnessSpawn } from '../../src/mms/harness/spawn'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { ClaudeSubscriptionProviderService } from '../../src/mms/providers/claudeSubscription/ClaudeSubscriptionProviderService'
import { claudeLoadsSkill } from '../../src/mms/providers/claudeSubscription/integrations'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'

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
      expect(after.auth).toMatchObject({ state: 'signed_in', account: { id: 'org-claude:work' }, canSignOut: true })
      const own = await harness.instances.recheck('claude')
      expect(own.auth).toMatchObject({ state: 'signed_in', canSignOut: false })
      expect(own.config?.home).toBe('default')

      // A turn on each instance.
      for (const instanceId of ['claude:work', 'claude']) {
        const resolved = harness.resolveStored({ instanceId, llmProvider: '', model: 'sonnet' }, { purpose: 'turn' })
        const spec = turnSpec(instanceId, harness.bind(resolved, { mode: 'agent' }), tempDir('mousse-cwd-'))
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
