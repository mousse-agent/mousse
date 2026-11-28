/**
 * Grok's held launch, on Mousse's side (`grok/held.ts`, the preset's `allowsUnasked`, the gateway's one-shot gate). What the real Grok does with the held home is proven by `tests/live/grokHeldCheck.test.ts`; the ACP
 * agent here is hand-authored and proves only Mousse's answers.
 */
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { methods, PROTOCOL_VERSION, type AgentApp, type RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GROK_CAPS, GROK_PRESET, grokAllowsUnasked, grokCaps } from '../../src/mms/harness/acp/presets/grok'
import { AcpSessions } from '../../src/mms/harness/acp/session'
import { confinedRead, confinedSearch, linkFreeTree } from '../../src/mms/harness/acp/confinedRead'
import { GROK_HELD_CONFIG, GROK_HELD_SWITCHES, ensureGrokHeldHome, grokHeldEnv, grokHeldPolicyProblem } from '../../src/mms/harness/grok/held'
import { runGrokHeldCheck } from '../../src/mms/harness/grok/heldCheck'
import { ProviderInstanceService } from '../../src/mms/harness/instanceMap'
import { MODEL_REFRESH_STARTUP_DELAY_MS, type Harness, type TurnSpec } from '../../src/mms/harness/gateway'
import type { ProviderAdapter, TurnInput } from '../../src/mms/harness/adapter'
import { CODEX_CAPABILITIES } from '../../src/mms/harness/drivers/codex/adapter'
import { GROK_DIRECT_FACTS } from '../../src/mms/harness/oneShot/routes'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'
import { inProcessAgent } from '../../src/mms/run/testkit/acpAgent'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { readFileSync } from 'node:fs'

const dirs: string[] = []
const stops: Array<() => void> = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

describe('the held environment', () => {
  // Rows: where the sign-in lives, and what the entry's own environment sets.
  const rows: Array<{ name: string; env: NodeJS.ProcessEnv; platform: NodeJS.Platform; auth: string }> = [
    { name: 'a private home: its own auth.json', env: { GROK_HOME: '/state/home', XAI_API_KEY: 'k' }, platform: 'linux', auth: join('/state/home', 'auth.json') },
    { name: 'an auth file the entry names itself', env: { GROK_HOME: '/state/home', GROK_AUTH_PATH: '/elsewhere/auth.json' }, platform: 'linux', auth: '/elsewhere/auth.json' },
    { name: 'Windows: variable names in any case', env: { grok_home: 'C:\\state\\home', Grok_Config: '{"features":{}}', grok_config_path: 'C:\\x.toml' }, platform: 'win32', auth: join('C:\\state\\home', 'auth.json') }
  ]
  for (const row of rows) {
    it(`runs on the held home and signs in from the entry's own: ${row.name}`, () => {
      const env = grokHeldEnv(row.env, '/state/held-home', row.platform)
      const names = Object.keys(env).map((name) => name.toUpperCase())
      expect(env.GROK_HOME).toBe('/state/held-home')
      expect(env.GROK_AUTH_PATH).toBe(row.auth)
      expect(env.GROK_WORKTREE_INHERITS_MAIN_APPROVALS).toBe('false')
      // An overlay could set config around the held home; it never goes in, and no second spelling of a variable stays.
      expect(names.filter((name) => name === 'GROK_CONFIG' || name === 'GROK_CONFIG_PATH')).toEqual([])
      expect(names.filter((name) => name === 'GROK_HOME')).toHaveLength(1)
      if (row.env.XAI_API_KEY) expect(env.XAI_API_KEY).toBe(row.env.XAI_API_KEY)
      // Every startup source Grok reads from other agents' setups is off, whatever the entry set.
      for (const [name, value] of Object.entries(GROK_HELD_SWITCHES)) expect([name, env[name]]).toEqual([name, value])
    })
  }

  it('turns the startup sources off even when the entry turned them on', () => {
    const env = grokHeldEnv({ GROK_CLAUDE_HOOKS_ENABLED: '1', grok_claude_mcps_enabled: 'true', GROK_CURSOR_HOOKS_ENABLED: '1' }, '/state/held-home', 'win32')
    const set = Object.entries(env).filter(([name]) => /HOOKS|MCPS/i.test(name))
    expect(set.every(([, value]) => value === '0')).toBe(true)
    expect(set.map(([name]) => name.toUpperCase()).filter((name) => name === 'GROK_CLAUDE_MCPS_ENABLED')).toHaveLength(1)
  })

  it('keeps no folder trust, hook or plugin in the held home', () => {
    const home = join(tempDir('mousse-grok-held-'), 'held-home')
    mkdirSync(join(home, 'hooks'), { recursive: true })
    mkdirSync(join(home, 'installed-plugins', 'some-plugin'), { recursive: true })
    writeFileSync(join(home, 'installed-plugins', 'registry.lock'), '')
    writeFileSync(join(home, 'trusted_folders.toml'), "[folders.'/repo']\ntrusted = true\n")
    ensureGrokHeldHome(home)
    expect(['trusted_folders.toml', 'hooks', join('installed-plugins', 'some-plugin')].filter((name) => existsSync(join(home, name)))).toEqual([])
  })

  // Rows: where an organisation policy file sits; each one refuses the held launch and names the file.
  const policies: Array<{ name: string; where: 'system' | 'held'; file: string }> = [
    { name: 'requirements in the system folder', where: 'system', file: 'requirements.toml' },
    { name: 'managed config in the system folder', where: 'system', file: 'managed_config.toml' },
    { name: 'a fetched policy in the held home', where: 'held', file: 'requirements.toml' }
  ]
  for (const row of policies) {
    it(`refuses the held launch, naming the file: ${row.name}`, () => {
      const root = tempDir('mousse-grok-policy-')
      const systemDir = join(root, 'system')
      const heldHome = join(root, 'held-home')
      mkdirSync(systemDir)
      mkdirSync(heldHome)
      expect(grokHeldPolicyProblem(heldHome, { systemDir })).toBeUndefined()
      const path = join(row.where === 'system' ? systemDir : heldHome, row.file)
      writeFileSync(path, '[hooks]\n')
      expect(grokHeldPolicyProblem(heldHome, { systemDir })).toContain(path)
    })
  }

  it('puts Mousse’s config back when the held home’s config.toml was changed', () => {
    const home = join(tempDir('mousse-grok-held-'), 'held-home')
    ensureGrokHeldHome(home)
    writeFileSync(join(home, 'config.toml'), '[permission]\nallow = ["*"]\n')
    ensureGrokHeldHome(home)
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(GROK_HELD_CONFIG)
  })
})

describe('reads Mousse allows unasked on the held launch', () => {
  const ask = (rawInput: Record<string, unknown>, kind = 'read'): RequestPermissionRequest => ({
    sessionId: 's',
    toolCall: { toolCallId: 't', title: 'x', kind: kind as never, rawInput },
    options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }]
  })
  const folder = () => {
    const root = tempDir('mousse-grok-reads-')
    const cwd = join(root, 'repo')
    mkdirSync(join(cwd, 'src'), { recursive: true })
    writeFileSync(join(cwd, 'src', 'a.ts'), 'x')
    mkdirSync(join(root, 'outside'))
    writeFileSync(join(root, 'outside', 'secret.txt'), 'x')
    return { root, cwd }
  }
  /** A folder link (a junction on Windows, which needs no rights there); false where the file system has none. */
  const link = (target: string, at: string): boolean => {
    try {
      symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir')
      return true
    } catch {
      return false
    }
  }

  it('allows a read, a listing or a search inside the folder, and the plan list; asks for everything else', () => {
    const { root, cwd } = folder()
    const linked = link(join(root, 'outside'), join(cwd, 'link'))
    // A case variant of the folder names the same folder where the file system ignores case, else none at all.
    const variant = join(cwd.slice(0, -4) + 'REPO', 'src', 'a.ts')
    const rows: Array<[string, RequestPermissionRequest, boolean]> = [
      ['a file read inside', ask({ variant: 'ReadFile', target_file: join(cwd, 'src', 'a.ts') }), true],
      ['a relative read inside', ask({ variant: 'ReadFile', target_file: 'src/a.ts' }), true],
      ['a listing of the folder', ask({ variant: 'ListDir', target_directory: cwd }, 'other'), true],
      // A search of the whole folder walks it: with the link below (when this file system has links) it asks.
      ['a search with no path', ask({ variant: 'Grep', pattern: 'x', path: null }, 'search'), !linked],
      ['a search inside', ask({ variant: 'Grep', pattern: 'x', path: join(cwd, 'src') }, 'search'), true],
      ['the plan list', ask({ variant: 'TodoWrite', todos: [] }, 'think'), true],
      ['a read outside', ask({ variant: 'ReadFile', target_file: join(root, 'outside', 'secret.txt') }), false],
      ['a read climbing out', ask({ variant: 'ReadFile', target_file: join(cwd, '..', 'outside', 'secret.txt') }), false],
      ['a relative read climbing out', ask({ variant: 'ReadFile', target_file: '../outside/secret.txt' }), false],
      ['a read climbing out and back in', ask({ variant: 'ReadFile', target_file: '../repo/src/a.ts' }), true],
      ['a read of a file that is not there', ask({ variant: 'ReadFile', target_file: 'src/missing.ts' }), false],
      ['a case variant of the folder', ask({ variant: 'ReadFile', target_file: variant }), existsSync(variant)],
      ['a search outside', ask({ variant: 'Grep', pattern: 'x', path: join(root, 'outside') }, 'search'), false],
      ['a shell command', ask({ variant: 'Bash', command: 'cat src/a.ts' }, 'execute'), false],
      ['an edit', ask({ variant: 'SearchReplace', file_path: join(cwd, 'src', 'a.ts') }, 'edit'), false],
      ['a subagent', ask({ variant: 'Task', prompt: 'read' }, 'other'), false],
      ['an unknown tool', ask({ tool_name: 'srv__x' }, 'other'), false],
      ...(linked ? [
        ['a read through a link that leaves the folder', ask({ variant: 'ReadFile', target_file: join(cwd, 'link', 'secret.txt') }), false],
        ['a listing of the link', ask({ variant: 'ListDir', target_directory: 'link' }, 'other'), false],
        ['a search of the link', ask({ variant: 'Grep', pattern: 'x', path: 'link' }, 'search'), false],
        ['a search of a folder with no link under it', ask({ variant: 'Grep', pattern: 'x', path: 'src' }, 'search'), true]
      ] as Array<[string, RequestPermissionRequest, boolean]> : [])
    ]
    for (const [name, request, allowed] of rows) expect([name, grokAllowsUnasked(request, cwd)]).toEqual([name, allowed])
  })

  // Windows forms that leave the folder's drive or root without a `..`: refused before anything is read.
  const windowsForms: Array<[string, string]> = [
    ['drive-relative', 'J:src\\a.ts'],
    ['another drive', 'C:\\repo\\src\\a.ts'],
    ['root-relative', '\\repo\\src\\a.ts'],
    ['UNC', '\\\\server\\share\\a.ts'],
    ['device', '\\\\?\\J:\\repo\\src\\a.ts']
  ]
  for (const [name, target] of windowsForms) {
    it(`asks for a Windows ${name} path`, () => {
      expect(confinedRead('J:\\repo', target, 'win32')).toBe(false)
      expect(confinedSearch('J:\\repo', target, 'win32')).toBe(false)
    })
  }

  it('reads the path again on every request: a folder swapped for a link after an answer asks', () => {
    const { root, cwd } = folder()
    expect(grokAllowsUnasked(ask({ variant: 'ReadFile', target_file: 'src/a.ts' }), cwd)).toBe(true)
    mkdirSync(join(root, 'outside', 'src'))
    writeFileSync(join(root, 'outside', 'src', 'a.ts'), 'x')
    renameSync(join(cwd, 'src'), join(cwd, 'src-old'))
    if (!link(join(root, 'outside', 'src'), join(cwd, 'src'))) return
    expect(grokAllowsUnasked(ask({ variant: 'ReadFile', target_file: 'src/a.ts' }), cwd)).toBe(false)
  })

  it('asks for a search over a tree too large to walk', () => {
    const { cwd } = folder()
    expect(linkFreeTree(cwd)).toBe(true)
    expect(linkFreeTree(cwd, 1)).toBe(false)
  })

  it('a turn in Ask mode answers an in-folder read itself and asks the person about one outside', async () => {
    const { root, cwd } = folder()
    const answers: unknown[] = []
    const agent = inProcessAgent((app: AgentApp) => {
      app
        .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] }))
        .onRequest(methods.agent.session.new, () => ({ sessionId: 'g1' }))
        .onRequest(methods.agent.session.prompt, async (c) => {
          const request = (target: string) => c.client.request(methods.client.session.requestPermission, {
            sessionId: c.params.sessionId,
            toolCall: { toolCallId: target, title: `Read ${target}`, kind: 'read', rawInput: { variant: 'ReadFile', target_file: target } },
            options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }]
          } as never)
          answers.push(await request(join(cwd, 'src', 'a.ts')))
          answers.push(await request(join(root, 'outside', 'secret.txt')))
          return { stopReason: 'end_turn' }
        })
    })
    const questions = new UserQuestionService()
    const sessions = new AcpSessions({
      label: 'Grok', defaultInstanceId: 'grok:work', questions, connect: agent.connect, quirks: {},
      classifyOption: GROK_PRESET.classifyOption!, allowsUnasked: GROK_PRESET.allowsUnasked!,
      store: { saved: () => undefined, setSaved: () => {}, models: () => [], setModels: () => {} },
      launchGeneration: () => 0, signInGeneration: () => 0, markSignedOut: vi.fn(), signInRequiredMessage: 'Sign in first'
    })
    stops.push(() => sessions.stop())
    // The person rejects whatever they are asked.
    const asked: string[] = []
    const answer = setInterval(() => {
      for (const pending of questions.listPendingForThread('t')) {
        asked.push(pending.questions[0]!.prompt)
        questions.submitAnswers(pending.requestId, { permission: 'reject-once' }, { kind: 'user' })
      }
    }, 5)
    stops.push(() => clearInterval(answer))
    await sessions.chat({ threadId: 't', cwd, model: 'default', prompt: 'read both', onText: vi.fn(), permissionMode: 'ask' } as never)
    expect(answers).toEqual([{ outcome: { outcome: 'selected', optionId: 'allow-once' } }, { outcome: { outcome: 'selected', optionId: 'reject-once' } }])
    expect(asked).toEqual([`Read ${join(root, 'outside', 'secret.txt')}`])
  })

  it('a run that refuses approvals refuses an in-folder read too, asking no one', async () => {
    const { cwd } = folder()
    const answers: unknown[] = []
    const agent = inProcessAgent((app: AgentApp) => {
      app
        .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] }))
        .onRequest(methods.agent.session.new, () => ({ sessionId: 'g1' }))
        .onRequest(methods.agent.session.prompt, async (c) => {
          answers.push(await c.client.request(methods.client.session.requestPermission, {
            sessionId: c.params.sessionId,
            toolCall: { toolCallId: 'r', title: 'Read a.ts', kind: 'read', rawInput: { variant: 'ReadFile', target_file: join(cwd, 'src', 'a.ts') } },
            options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }]
          } as never))
          return { stopReason: 'end_turn' }
        })
    })
    const sessions = new AcpSessions({
      label: 'Grok', defaultInstanceId: 'grok:work', questions: new UserQuestionService(), connect: agent.connect, quirks: {},
      classifyOption: GROK_PRESET.classifyOption!, allowsUnasked: GROK_PRESET.allowsUnasked!,
      store: { saved: () => undefined, setSaved: () => {}, models: () => [], setModels: () => {} },
      launchGeneration: () => 0, signInGeneration: () => 0, markSignedOut: vi.fn(), signInRequiredMessage: 'Sign in first'
    })
    stops.push(() => sessions.stop())
    const choose = vi.fn()
    await sessions.chat({ threadId: 't', cwd, model: 'default', prompt: 'read', onText: vi.fn(), permissionMode: 'ask', prompter: { approvals: 'never', choose } } as never)
    expect(answers).toHaveLength(1)
    expect(answers[0]).not.toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
    expect(choose).not.toHaveBeenCalled()
  })
})

describe('the held check after a Stop', () => {
  it('starts no process when it is stopped before it starts', async () => {
    const root = tempDir('mousse-grok-stopped-')
    const marker = join(root, 'started')
    const controller = new AbortController()
    controller.abort()
    const log = vi.fn()
    const record = await runGrokHeldCheck({
      command: process.execPath,
      args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      cliVersion: '9.9.9',
      log
    }, controller.signal)
    expect(record).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(existsSync(marker)).toBe(false)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('stopped'))
  })
})

describe('the gateway’s one-shot gate for a driver that proves its own route', () => {
  const agent: ProviderAdapter = { driver: 'grok', capabilities: { ...CODEX_CAPABILITIES }, configured: () => true, startTurn: async () => { throw new Error('unused') }, interrupt: async () => 'not_active' }
  function setup(refusal: string | undefined) {
    const oneShot = vi.fn(async () => 'A title')
    const base = adapterDriver(agent, { runtime: { oneShotTransport: () => ({ send: oneShot }) } })
    // Turns are not held (uncontrolled); one-shots are, or not, by its route (`oneShotRoute`).
    const driver = { ...base, caps: () => grokCaps(false), oneShotRoute: () => (refusal ? { refused: refusal } : { route: { id: 'grok:direct' as const, facts: GROK_DIRECT_FACTS } }), toolControlReason: () => 'Grok 9.9.9 is not checked yet.' }
    let stored: unknown = { grok: { driver: 'grok', enabled: true } }
    const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
    const harness: Harness = testHarness({ drivers: [driver], instances, profileHome: tempDir('mousse-grok-gate-') })
    stops.push(() => harness.stop())
    const request = { selection: { instanceId: 'grok', llmProvider: 'grok', model: 'grok-4.6' }, purpose: 'title', system: 'You name chats.', prompt: 'fix the login bug', maxChars: 80 } as const
    return { harness, oneShot, request }
  }

  it('runs a proven one-shot although turns are Full access only, and offers the entry for titles', async () => {
    const s = setup(undefined)
    expect(s.harness.admitsOneShot('grok', 'grok-4.6')).toBe(true)
    await expect(s.harness.oneShot(s.request)).resolves.toEqual({ text: 'A title' })
    expect(s.oneShot).toHaveBeenCalledTimes(1)
  })

  it('refuses an unproven one-shot with its reason, sends nothing, and leaves the entry out of the title pickers', async () => {
    const s = setup('Mousse has not yet checked Grok 9.9.9.')
    expect(s.harness.admitsOneShot('grok', 'grok-4.6')).toBe(false)
    await expect(s.harness.oneShot(s.request)).rejects.toMatchObject({ code: 'unsupported', message: expect.stringContaining('Mousse has not yet checked Grok 9.9.9.') })
    expect(s.oneShot).not.toHaveBeenCalled()
  })

  it('names the cause when a purpose needs turns the entry cannot hold', async () => {
    const s = setup(undefined)
    await expect(s.harness.oneShot({ ...s.request, purpose: 'delegation' as never })).rejects.toMatchObject({ code: 'policy_unenforceable', message: expect.stringContaining('Grok 9.9.9 is not checked yet.') })
  })
})

describe('the gateway and a driver whose caps are proven per executable', () => {
  const agent: ProviderAdapter = {
    driver: 'grok', capabilities: { ...CODEX_CAPABILITIES }, configured: () => true,
    startTurn: async (input, sink) => {
      const providerRef = { provider: input.llmProvider, instanceId: input.instanceId, model: input.model }
      sink.providerRef(providerRef)
      return { text: 'ok', aborted: false, modelName: input.model, totalResponseTimeMs: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextSignature: 's', nativeMessages: [], providerRef }
    },
    interrupt: async () => 'not_active'
  }
  function setup(options: { bound: boolean }) {
    const home = tempDir('mousse-grok-bound-')
    const binary = join(home, 'grok.exe')
    writeFileSync(binary, 'grok 9.9.9', { mode: 0o755 })
    const probed = vi.fn()
    const refreshModels = vi.fn(async () => {})
    const base = adapterDriver(agent, { runtime: { probed, refreshModels, auth: async () => ({ state: 'signed_in' }) } })
    const driver = { ...base, caps: () => grokCaps(true), versionArgs: () => null, ...(options.bound ? { binaryBoundCaps: true } : {}) }
    let stored: unknown = { grok: { driver: 'grok', enabled: true, config: { binaryPath: binary } } }
    const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
    const harness: Harness = testHarness({ drivers: [driver], instances, profileHome: home })
    stops.push(() => harness.stop())
    const spec = (binding: TurnSpec['binding']): TurnSpec => ({
      binding,
      input: { threadId: 't', instanceId: 'grok', llmProvider: 'grok', model: 'm', mode: 'agent', prompt: 'hi', signal: new AbortController().signal } as unknown as TurnInput,
      sink: { providerRef: () => {} } as unknown as TurnSpec['sink'],
      control: {} as TurnSpec['control'],
      host: {} as TurnSpec['host']
    })
    const bind = () => harness.bind(harness.resolveStored({ instanceId: 'grok', llmProvider: 'grok', model: 'm' }, { purpose: 'turn' }), { mode: 'agent' })
    return { harness, binary, probed, refreshModels, spec, bind }
  }

  // Rows: whether the driver binds its caps to the executable, and whether a replaced one is refused.
  for (const bound of [true, false]) {
    it(`${bound ? 'refuses' : 'does not stat again for'} a turn on an executable replaced since its check (binaryBoundCaps: ${bound})`, async () => {
      const s = setup({ bound })
      await s.harness.instances.recheck('grok')
      await expect(s.harness.startTurn(s.spec(await s.bind())).result).resolves.toMatchObject({ text: 'ok' })
      writeFileSync(s.binary, 'grok 9.9.10, replaced')
      const started = s.bind().then((binding) => s.harness.startTurn(s.spec(binding)).result)
      if (bound) await expect(started).rejects.toMatchObject({ code: 'binding_stale' })
      else await expect(started).resolves.toMatchObject({ text: 'ok' })
    })
  }

  it('starts no background check from the startup model pass; a check a person asks for starts one at once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    try {
      const s = setup({ bound: true })
      s.harness.startModelRefreshSchedule()
      await vi.advanceTimersByTimeAsync(MODEL_REFRESH_STARTUP_DELAY_MS + 1_000)
      await vi.waitFor(() => expect(s.refreshModels).toHaveBeenCalled())
      expect(s.probed).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('tells the runtime the executable a forced check read, as one a person asked for', async () => {
    const s = setup({ bound: true })
    await s.harness.instances.recheck('grok')
    expect(s.probed).toHaveBeenCalledWith(undefined, { fingerprint: expect.objectContaining({ path: s.binary }), soon: true })
  })
})

describe('Grok caps', () => {
  it('asks before every tool only where the held launch is proven', () => {
    expect(grokCaps(true)).toBe(GROK_CAPS)
    expect(grokCaps(true).toolControl).toBe('approval_only')
    expect(grokCaps(false).toolControl).toBe('uncontrolled')
  })
})
