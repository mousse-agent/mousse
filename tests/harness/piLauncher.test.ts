import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import type { DriverContext } from '../../src/mms/harness/driver'
import { instanceEnv, type InstanceEnv } from '../../src/mms/harness/env'
import { instanceStateDir } from '../../src/mms/harness/instances'
import { ANTHROPIC_OAUTH_ENV_KEYS, PI_ENV_KEYS, PI_PROVIDER_ENV_KEYS } from '../../src/mms/harness/pi/envKeys'
import { piLaunch, piRuntimePaths, type PiLaunchInput } from '../../src/mms/harness/pi/launch'
import { PiLoopAdapter } from '../../src/mms/run/adapters/pi/PiLoopAdapter'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'

const repoRoot = resolve(__dirname, '..', '..')
const stateDir = resolve(tmpdir(), 'mousse-pi-launch', 'harness', 'pi_openrouter')
const runtime = piRuntimePaths(resolve(tmpdir(), 'mousse-app'))
const nodeHost = { execPath: '/usr/bin/node', versions: { node: '24.20.0' } }
const electronHost = { execPath: 'C:\\Mousse\\Mousse.exe', versions: { node: '24.11.1', electron: '43.2.0' } }

function piEnv(base: NodeJS.ProcessEnv, home: string | null = join(stateDir, 'home')): InstanceEnv {
  return instanceEnv({ instanceId: 'pi:openrouter', driver: 'pi', configRevision: 0, ...(home ? { home } : {}), searchPath: [], base })
}

function launch(input: Partial<PiLaunchInput> & { base?: NodeJS.ProcessEnv } = {}) {
  const { base = {}, ...rest } = input
  const result = piLaunch({
    env: piEnv(base),
    runtime,
    stateDir,
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4.5',
    thinking: 'medium',
    ambient: base,
    host: nodeHost,
    ...rest
  })
  if (result.runs !== 'yes') throw new Error(result.reason)
  return result
}

describe('Pi launcher: command and arguments', () => {
  it('runs the bundled rpc-entry with Mousse\'s flags only (no --mode rpc: the entry adds it)', () => {
    expect(launch()).toMatchObject({
      command: '/usr/bin/node',
      args: [
        runtime.entry,
        '--provider', 'openrouter',
        '--model', 'anthropic/claude-sonnet-4.5',
        '--thinking', 'medium',
        '--session-dir', join(stateDir, 'sessions'),
        '--no-extensions', '-e', runtime.extension,
        '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve'
      ]
    })
    const resumed = launch({ sessionId: '01a1-session' }).args
    expect(resumed.slice(resumed.indexOf('--session-dir'), resumed.indexOf('--no-extensions'))).toEqual(['--session-dir', join(stateDir, 'sessions'), '--session', '01a1-session'])
    expect(launch().args).not.toContain('--mode')
  })

  it('runs Electron as Node inside the app, and plain Node without the flag', () => {
    const electron = launch({ host: electronHost })
    expect(electron.command).toBe(electronHost.execPath)
    expect(electron.env.ELECTRON_RUN_AS_NODE).toBe('1')
    const node = launch({ base: { ELECTRON_RUN_AS_NODE: '1', ELECTRON_ENABLE_LOGGING: '1' } })
    expect(node.command).toBe(nodeHost.execPath)
    expect(Object.keys(node.env).filter((key) => key.startsWith('ELECTRON_'))).toEqual([])
    expect(Object.keys(electron.env).filter((key) => key.startsWith('ELECTRON_'))).toEqual(['ELECTRON_RUN_AS_NODE'])
  })

  it('does not run on a Node older than Pi\'s engines (22.19)', () => {
    const result = piLaunch({ env: piEnv({}), runtime, stateDir, provider: 'openrouter', model: 'm', thinking: 'off', host: { execPath: 'node', versions: { node: '22.18.9' } } })
    expect(result).toMatchObject({ runs: 'no' })
    expect(piLaunch({ env: piEnv({}), runtime, stateDir, provider: 'openrouter', model: 'm', thinking: 'off', host: { execPath: 'node', versions: { node: '22.19.0' } } })).toMatchObject({ runs: 'yes' })
  })

  it('finds the packaged runtime in the unpacked copy beside the asar', () => {
    const app = resolve(tmpdir(), 'Mousse', 'resources', 'app.asar')
    expect(piRuntimePaths(app)).toEqual({
      root: join(`${app}.unpacked`, 'out', 'pi-runtime', 'pi-coding-agent'),
      entry: join(`${app}.unpacked`, 'out', 'pi-runtime', 'pi-coding-agent', 'dist', 'bundle', 'rpc-entry.js'),
      extension: join(`${app}.unpacked`, 'out', 'pi-runtime', 'mousse-extension.mjs')
    })
    expect(() => piRuntimePaths('relative/app')).toThrow()
  })
})

describe('Pi launcher: environment', () => {
  it('points Pi at the instance home once, and refuses an instance without one', () => {
    const env = launch({ base: { PI_CODING_AGENT_DIR: '/home/me/.pi/agent' } }).env
    expect(env.PI_CODING_AGENT_DIR).toBe(join(stateDir, 'home'))
    expect(Object.keys(env).filter((key) => key.toUpperCase() === 'PI_CODING_AGENT_DIR')).toHaveLength(1)
    expect(() => piLaunch({ env: piEnv({}, null), runtime, stateDir, provider: 'openrouter', model: 'm', thinking: 'off', host: nodeHost })).toThrow(/home/)
  })

  it('sets Pi offline in its package dir, and drops Node, Electron, Mousse and the user\'s own Pi settings', () => {
    const env = launch({
      base: { PATH: '/bin', NODE_OPTIONS: '--require evil.js', ELECTRON_NO_ASAR: '1', MOUSSE_PROFILE: 'x', PI_EXPERIMENTAL: '1', pi_telemetry: '1', AWS_PROFILE: 'work', AWS_REGION: 'eu-west-1', GOOGLE_CLOUD_PROJECT: 'p' }
    }).env
    expect(env).toMatchObject({ PATH: '/bin', PI_PACKAGE_DIR: runtime.root, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' })
    for (const key of ['NODE_OPTIONS', 'ELECTRON_NO_ASAR', 'MOUSSE_PROFILE', 'PI_EXPERIMENTAL', 'pi_telemetry']) expect(env, key).not.toHaveProperty(key)
    // Ambient cloud credentials stay (Bedrock, Vertex).
    expect(env).toMatchObject({ AWS_PROFILE: 'work', AWS_REGION: 'eu-west-1', GOOGLE_CLOUD_PROJECT: 'p' })
  })

  it('pins the AWS SDK to one attempt in standard mode, after anything inherited or configured', () => {
    const env = launch({
      base: { AWS_MAX_ATTEMPTS: '5', AWS_RETRY_MODE: 'adaptive', aws_retry_mode: 'legacy', AWS_PROFILE: 'work' },
      extraEnv: { AWS_MAX_ATTEMPTS: '9', Aws_Retry_Mode: 'adaptive' }
    }).env
    expect(Object.entries(env).filter(([key]) => /^aws_(max_attempts|retry_mode)$/i.test(key))).toEqual([['AWS_MAX_ATTEMPTS', '1'], ['AWS_RETRY_MODE', 'standard']])
    expect(env.AWS_PROFILE).toBe('work')
  })

  it('applies the instance\'s own variables after the drops, but never a subscription token or a Pi setting', () => {
    const env = launch({ extraEnv: { MOUSSE_PI_BRIDGE: 'b', CLOUDFLARE_ACCOUNT_ID: 'acct', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-x', PI_OFFLINE: '0' } }).env
    expect(env).toMatchObject({ MOUSSE_PI_BRIDGE: 'b', CLOUDFLARE_ACCOUNT_ID: 'acct', PI_OFFLINE: '1' })
    expect(env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN')
  })
})

describe('Pi launcher: credentials', () => {
  const everyKey = Object.fromEntries(PI_ENV_KEYS.map((name) => [name, `value-of-${name}`]))

  it('inherits no provider key except the instance\'s own', () => {
    const env = launch({ base: { ...everyKey, PATH: '/bin' } }).env
    expect(PI_ENV_KEYS.filter((name) => name in env)).toEqual(['OPENROUTER_API_KEY'])
    expect(env.OPENROUTER_API_KEY).toBe('value-of-OPENROUTER_API_KEY')
  })

  it('gives pi:anthropic its API key only, never an Anthropic OAuth or auth token', () => {
    const env = launch({ base: everyKey, provider: 'anthropic', model: 'claude-sonnet-4-5' }).env
    expect(PI_ENV_KEYS.filter((name) => name in env)).toEqual(['ANTHROPIC_API_KEY'])
    for (const name of ANTHROPIC_OAUTH_ENV_KEYS) expect(env, name).not.toHaveProperty(name)
  })

  it('re-adds a key the user spelled in another case on Windows', () => {
    const env = launch({ base: { openrouter_api_key: 'lower' } }).env
    expect(env.OPENROUTER_API_KEY).toBe('lower')
    expect(Object.keys(env).filter((key) => key.toUpperCase() === 'OPENROUTER_API_KEY')).toEqual(['OPENROUTER_API_KEY'])
  })

  it('lists exactly the keys of the bundled pi-ai env table, plus Claude Code\'s OAuth token', () => {
    const bundle = join(repoRoot, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks')
    const source = readdirSync(bundle).map((name) => readFileSync(join(bundle, name), 'utf8')).find((text) => text.includes('function getApiKeyEnvVars('))
    expect(source, 'getApiKeyEnvVars in the bundle').toBeDefined()
    const body = source!.slice(source!.indexOf('function getApiKeyEnvVars('), source!.indexOf('function findEnvKeys('))
    const constant = (name: string) => new RegExp(`\\b${name}="([A-Z0-9_]+)"`).exec(source!)?.[1]
    const table: Record<string, string[]> = {}
    for (const match of body.matchAll(/provider==="([\w-]+)"\)return\[([^\]]*)\]/g))
      table[match[1]] = match[2].split(',').map((item) => item.startsWith('"') ? JSON.parse(item) : constant(item)!)
    const map = /\{([^{}]*)\}\[provider\]/.exec(body)![1]
    for (const match of map.matchAll(/(?:"([\w-]+)"|([\w]+)):"([A-Z0-9_]+)"/g)) table[match[1] ?? match[2]] = [match[3]]
    expect(Object.keys(table).length).toBeGreaterThan(30)
    expect(table).toEqual(PI_PROVIDER_ENV_KEYS)
    expect([...PI_ENV_KEYS].sort()).toEqual([...new Set([...Object.values(table).flat(), 'CLAUDE_CODE_OAUTH_TOKEN'])].sort())
  })
})

describe('Pi instances: a Mousse-owned home', () => {
  const homes: string[] = []
  afterEach(() => {
    vi.unstubAllEnvs()
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  it('gives a driver with alwaysPrivateHome its state-dir home on a built-in instance, without inherited keys', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'ambient-key')
    vi.stubEnv('ANTHROPIC_OAUTH_TOKEN', 'sk-ant-oat-ambient')
    const profileHome = mkdtempSync(join(tmpdir(), 'mousse-pi-home-'))
    homes.push(profileHome)
    const contexts: DriverContext[] = []
    const base = adapterDriver(new PiLoopAdapter(() => ({ chat: async () => { throw new Error('unused') } })))
    const driver = { ...base, alwaysPrivateHome: true, create: (context: DriverContext) => (contexts.push(context), base.create(context)) }
    const instances = new ProviderInstanceService({
      store: { read: () => ({ instances: undefined }), write: () => {} },
      providerAuth: { credentials: { listProviderIds: () => ['openrouter'] } }
    })
    const harness = testHarness({ drivers: [driver], instances, profileHome })
    const binding = await harness.bind(harness.resolveStored({ instanceId: 'pi:openrouter', llmProvider: '', model: 'm' }, { purpose: 'turn' }), { mode: 'agent' })
    const home = join(instanceStateDir(profileHome, 'pi:openrouter'), 'home')
    expect(binding.homeId).toBe('private:pi:openrouter')
    const context = contexts.find((entry) => entry.instanceId === 'pi:openrouter')!
    expect(context.builtIn).toBe(true)
    expect(context.env.home).toBe(home)
    expect(context.env.env.PI_CODING_AGENT_DIR).toBe(home)
    expect(context.env.env).not.toHaveProperty('OPENROUTER_API_KEY')
    expect(context.env.env).not.toHaveProperty('ANTHROPIC_OAUTH_TOKEN')
    // The launcher takes the instance's own key back from Mousse's environment.
    const launched = piLaunch({ env: context.env, runtime, stateDir: context.stateDir, provider: 'openrouter', model: 'm', thinking: 'off', host: nodeHost })
    expect(launched).toMatchObject({ runs: 'yes', env: { OPENROUTER_API_KEY: 'ambient-key', PI_CODING_AGENT_DIR: home } })
    expect((launched as { env: NodeJS.ProcessEnv }).env).not.toHaveProperty('ANTHROPIC_OAUTH_TOKEN')
  })
})
