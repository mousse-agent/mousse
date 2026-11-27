/**
 * Grok's held launch, on Mousse's side (`grok/held.ts`, `grok/oneShot.ts`, the preset's `allowsUnasked`, the gateway's
 * one-shot gate). What the real Grok does with the held home is proven by `tests/live/grokHeldCheck.test.ts`; the ACP
 * agent here is hand-authored and proves only Mousse's answers.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { methods, PROTOCOL_VERSION, type AgentApp, type RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GROK_CAPS, GROK_PRESET, grokAllowsUnasked, grokCaps } from '../../src/mms/harness/acp/presets/grok'
import { AcpSessions } from '../../src/mms/harness/acp/session'
import { GROK_HELD_CONFIG, ensureGrokHeldHome, grokHeldEnv } from '../../src/mms/harness/grok/held'
import { grokOneShotResult } from '../../src/mms/harness/grok/oneShot'
import { ProviderInstanceService } from '../../src/mms/harness/instanceMap'
import type { Harness } from '../../src/mms/harness/gateway'
import type { ProviderAdapter } from '../../src/mms/harness/adapter'
import { CODEX_CAPABILITIES } from '../../src/mms/harness/drivers/codex/adapter'
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
    mkdirSync(join(root, 'outside'))
    writeFileSync(join(root, 'outside', 'secret.txt'), 'x')
    return { root, cwd }
  }

  it('allows a read, a listing or a search inside the folder, and the plan list; asks for everything else', () => {
    const { root, cwd } = folder()
    let linked = false
    try {
      symlinkSync(join(root, 'outside'), join(cwd, 'link'), 'junction')
      linked = true
    } catch {
      // No links on this file system: the link row is skipped.
    }
    const rows: Array<[string, RequestPermissionRequest, boolean]> = [
      ['a file read inside', ask({ variant: 'ReadFile', target_file: join(cwd, 'src', 'a.ts') }), true],
      ['a relative read inside', ask({ variant: 'ReadFile', target_file: 'src/a.ts' }), true],
      ['a listing of the folder', ask({ variant: 'ListDir', target_directory: cwd }, 'other'), true],
      ['a search with no path', ask({ variant: 'Grep', pattern: 'x', path: null }, 'search'), true],
      ['a search inside', ask({ variant: 'Grep', pattern: 'x', path: join(cwd, 'src') }, 'search'), true],
      ['the plan list', ask({ variant: 'TodoWrite', todos: [] }, 'think'), true],
      ['a read outside', ask({ variant: 'ReadFile', target_file: join(root, 'outside', 'secret.txt') }), false],
      ['a read climbing out', ask({ variant: 'ReadFile', target_file: join(cwd, '..', 'outside', 'secret.txt') }), false],
      ['a search outside', ask({ variant: 'Grep', pattern: 'x', path: join(root, 'outside') }, 'search'), false],
      ['a shell command', ask({ variant: 'Bash', command: 'cat src/a.ts' }, 'execute'), false],
      ['an edit', ask({ variant: 'SearchReplace', file_path: join(cwd, 'src', 'a.ts') }, 'edit'), false],
      ['a subagent', ask({ variant: 'Task', prompt: 'read' }, 'other'), false],
      ['an unknown tool', ask({ tool_name: 'srv__x' }, 'other'), false],
      ...(linked ? [['a read through a link that leaves the folder', ask({ variant: 'ReadFile', target_file: join(cwd, 'link', 'secret.txt') }), false] as [string, RequestPermissionRequest, boolean]] : [])
    ]
    for (const [name, request, allowed] of rows) expect([name, grokAllowsUnasked(request, cwd)]).toEqual([name, allowed])
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
})

describe('reading a headless one-shot', () => {
  const run = (stdout: unknown, code = 0, stderr = '') => ({ code, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr })
  it('takes the text of a finished answer', () => {
    expect(grokOneShotResult('Grok', run({ text: 'Login bug fix', stopReason: 'end_turn', sessionId: 's' }))).toBe('Login bug fix')
  })
  // Rows: what Grok printed, and the error Mousse reports.
  const failures: Array<[string, ReturnType<typeof run>, string]> = [
    ['a tool call the turn limit stopped', run({ text: '', stopReason: 'max_turn_requests' }, 1, 'Error: max turns reached'), 'one_shot_tool_refused'],
    ['a rate limit', run({ type: 'error', message: 'stub 429' }, 1), 'rate_limited'],
    ['a refused sign-in', run({ type: 'error', message: 'Unauthorized (401) from https://api.x.ai' }, 1), 'signed_out'],
    ['an unavailable service', run({ type: 'error', message: 'API error (status 503 Service Unavailable)' }, 1), 'service_unavailable'],
    ['output that is not JSON', run('panic: something', 101, 'thread main panicked'), 'protocol'],
    ['an answer with a failing exit', run({ text: 'half', stopReason: 'end_turn' }, 1), 'protocol']
  ]
  for (const [name, output, code] of failures) {
    it(`reports ${name} as ${code}`, () => {
      expect(() => grokOneShotResult('Grok', output)).toThrow(expect.objectContaining({ code }) as never)
    })
  }
})

describe('the gateway’s one-shot gate for a driver that proves its own route', () => {
  const agent: ProviderAdapter = { driver: 'grok', capabilities: { ...CODEX_CAPABILITIES }, configured: () => true, startTurn: async () => { throw new Error('unused') }, interrupt: async () => 'not_active' }
  function setup(refusal: string | undefined) {
    const oneShot = vi.fn(async () => ({ text: 'A title' }))
    const base = adapterDriver(agent, { runtime: { oneShot } })
    // Turns are not held (uncontrolled); one-shots are, or not, by `oneShotRefusal`.
    const driver = { ...base, caps: () => grokCaps(false), oneShot: true, oneShotRefusal: () => refusal, toolControlReason: () => 'Grok 9.9.9 is not checked yet.' }
    let stored: unknown = { grok: { driver: 'grok', enabled: true } }
    const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
    const harness: Harness = testHarness({ drivers: [driver], instances, profileHome: tempDir('mousse-grok-gate-') })
    stops.push(() => harness.stop())
    const request = { selection: { instanceId: 'grok', llmProvider: 'grok', model: 'grok-4.6' }, purpose: 'title', system: 'You name chats.', prompt: 'fix the login bug', maxChars: 80 } as const
    return { harness, oneShot, request }
  }

  it('runs a proven one-shot although turns are Full access only, and offers the entry for titles', async () => {
    const s = setup(undefined)
    expect(s.harness.canOneShot('grok')).toBe(true)
    await expect(s.harness.oneShot(s.request)).resolves.toEqual({ text: 'A title' })
    expect(s.oneShot).toHaveBeenCalledTimes(1)
  })

  it('refuses an unproven one-shot with its reason, sends nothing, and leaves the entry out of the title pickers', async () => {
    const s = setup('Mousse has not yet checked Grok 9.9.9.')
    expect(s.harness.canOneShot('grok')).toBe(false)
    await expect(s.harness.oneShot(s.request)).rejects.toMatchObject({ code: 'unsupported', message: expect.stringContaining('Mousse has not yet checked Grok 9.9.9.') })
    expect(s.oneShot).not.toHaveBeenCalled()
  })

  it('names the cause when a purpose needs turns the entry cannot hold', async () => {
    const s = setup(undefined)
    await expect(s.harness.oneShot({ ...s.request, purpose: 'delegation' as never })).rejects.toMatchObject({ code: 'policy_unenforceable', message: expect.stringContaining('Grok 9.9.9 is not checked yet.') })
  })
})

describe('Grok caps', () => {
  it('asks before every tool only where the held launch is proven', () => {
    expect(grokCaps(true)).toBe(GROK_CAPS)
    expect(grokCaps(true).toolControl).toBe('approval_only')
    expect(grokCaps(false).toolControl).toBe('uncontrolled')
  })
})
