/**
 * Skills for runtimes with their own loop (PR 2 §2): `list_skills` and `load_skill` over MCP, an
 * explicit `/skill` loaded into the turn preamble, and resumed vendor sessions that keep getting it.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SkillsRegistry } from '../../src/mms/integrations/skills/SkillsRegistry'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { AntigravityProviderService } from '../../src/mms/harness/acp/presets/antigravity/AntigravityProviderService'
import { antigravityAdapter } from '../../src/mms/harness/drivers/antigravity'
import { CodexAdapter } from '../../src/mms/harness/drivers/codex/adapter'
import { createCodexProviderService, type CodexProviderService } from '../../src/mms/harness/vendors/codex/CodexProviderService'
import type { AdapterHost, TurnInput, TurnSink } from '../../src/mms/harness/adapter'
import { turnPreamble } from '../../src/mms/run/mcp/appTools/assemble'
import { McpCredentials } from '../../src/mms/run/mcp/McpCredentials'
import { MousseMcpServer } from '../../src/mms/run/mcp/MousseMcpServer'
import { CODEX_APP_SERVER_BOUNDARY, replayCodexAppServer } from '../../src/mms/run/testkit/codexAppServerReplay'
import { parseTranscript, ReplayTransport, type TranscriptFrame } from '../../src/mms/run/testkit/ReplayTransport'
import type { SkillDescriptor } from '../../src/shared/integrations'
import { appToolRegistry, appTurn, fakeAppToolHost } from './appToolsFixture'
import { callTool, VendorAdapter, vendorDaemon, type ToolCallResult, type VendorDaemon } from './appToolVendorFixture'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

const skill = (name: string, extra: Partial<SkillDescriptor> = {}): SkillDescriptor => ({
  id: name,
  installationId: `inst-${name}`,
  name,
  description: `The ${name} skill`,
  rootPath: `/skills/${name}`,
  skillPath: `/skills/${name}/SKILL.md`,
  scope: 'global',
  source: 'mousse-profile',
  managed: true,
  ...extra
})

const REVIEW = skill('review')
const GATED = skill('deploy', { 'disable-model-invocation': true })
const BODY: Record<string, string> = { review: '# Review\nRead every changed line.', deploy: '# Deploy\nShip it.' }

/** A skills registry over `skills`, recording the skills read. */
function fakeSkills(skills: SkillDescriptor[]) {
  const reads: string[] = []
  const registry = {
    discover: vi.fn(async () => ({ skills, sources: [], diagnostics: [] })),
    readSkill: vi.fn(async (id: string) => {
      reads.push(id)
      const found = skills.find((entry) => entry.id === id || entry.installationId === id || entry.name === id)
      if (!found) throw new Error(`Skill not found: ${id}`)
      return { skill: found, content: BODY[found.name] }
    })
  }
  return { registry: registry as unknown as SkillsRegistry, reads }
}

describe('list_skills and load_skill over MCP', () => {
  let fx: DelegationFixture | undefined
  let server: MousseMcpServer | undefined
  afterEach(async () => {
    await server?.stop()
    server = undefined
    fx?.dispose()
    fx = undefined
  })

  it('report the turn\'s skills, load an enabled one and refuse one only the user may invoke', async () => {
    fx = delegationFixture()
    const run = await fx.runningRun('thread-a')
    const skills = fakeSkills([REVIEW, GATED])
    const { registry, turns } = appToolRegistry(fx.engine, fakeAppToolHost({ skills: () => skills.registry }).host)
    turns.register(appTurn({ threadId: 'thread-a', runId: run.runId, projectPath: '/work', enabledSkills: [REVIEW, GATED] }))
    server = new MousseMcpServer({ credentials: new McpCredentials(fx.store), registry })
    await server.start()
    const mcp = server.bearerForTurn({ threadId: 'thread-a', instanceId: 'codex', runId: run.runId, modeCeiling: 'default', binding: 'drained_turn', generation: 'g' })!

    const listed = await callTool(mcp, 'list_skills')
    expect(listed.error).toBeUndefined()
    expect(JSON.parse(listed.text!)).toEqual([
      expect.objectContaining({ id: 'review', name: 'review', modelInvocationDisabled: false }),
      expect.objectContaining({ id: 'deploy', name: 'deploy', modelInvocationDisabled: true })
    ])

    const loaded = await callTool(mcp, 'load_skill', { skill: 'review' })
    expect(loaded).toMatchObject({ isError: undefined, text: BODY.review })
    // Read by installation id, in the turn's project.
    expect(skills.registry.readSkill).toHaveBeenCalledWith('inst-review', { projectPath: '/work' })

    const refused = await callTool(mcp, 'load_skill', { skill: 'deploy' })
    expect(refused.error).toBeUndefined()
    expect(refused).toMatchObject({ isError: true, text: 'Skill deploy can only be loaded by explicit user invocation.' })
    const unknown = await callTool(mcp, 'load_skill', { skill: 'nope' })
    expect(unknown).toMatchObject({ isError: true, text: 'Skill not found: nope' })
    expect(skills.reads).toEqual(['inst-review'])
  })

  it('are not listed when the host has no skills registry', async () => {
    fx = delegationFixture()
    await fx.runningRun('thread-a')
    const { registry } = appToolRegistry(fx.engine, fakeAppToolHost().host)
    const names = registry.listForThread('thread-a').map((tool) => tool.name)
    expect(names).not.toContain('list_skills')
    expect(names).not.toContain('load_skill')
  })
})

describe('an explicit /skill in a vendor turn', () => {
  let d: VendorDaemon | undefined
  afterEach(async () => {
    await d?.dispose()
    d = undefined
  })

  it('loads the skill into the turn preamble on every turn that names it, and list_skills reports it', async () => {
    const skills = fakeSkills([REVIEW, GATED])
    let listed: ToolCallResult | undefined
    const vendor = new VendorAdapter(async ({ mcp }) => {
      listed ??= await callTool(mcp!, 'list_skills')
      return 'Reviewed.'
    })
    d = await vendorDaemon([vendor])
    ;(d.orch as any).skillsRegistry = skills.registry
    d.settings().integrations.skills.enabledSkills = ['inst-review', 'inst-deploy']

    await d.send('/review the run engine')
    await d.send('/review the adapters too')
    await d.send('Thanks, that is all')
    const section = `## Loaded Skill Instructions\n### review\n${BODY.review}`
    expect(vendor.bridges[0].turnPreamble).toContain(section)
    expect(vendor.bridges[1].turnPreamble).toContain(section)
    expect(vendor.bridges[2].turnPreamble).not.toContain('## Loaded Skill Instructions')
    // The prompt itself is the user's text; the skill travels in the preamble.
    expect(vendor.inputs[1].prompt).toBe('/review the adapters too')
    expect(JSON.parse(listed!.text!).map((entry: { name: string }) => entry.name)).toEqual(['review', 'deploy'])
  }, 30_000)
})

// ----- Codex: a loaded (continued) thread ------------------------------------------------------

const T = 'thr-1'
const out = (frame: unknown): TranscriptFrame => ({ dir: 'out', frame })
const inn = (frame: unknown): TranscriptFrame => ({ dir: 'in', frame })
const note = (method: string, params: unknown): TranscriptFrame => inn({ method, params })
const text = (value: string) => [{ type: 'text', text: value, text_elements: [] }]
// Ask before acting (the default thread mode): every command and patch asks, in the read-only sandbox.
const SUPERVISED = { type: 'readOnly', networkAccess: false }
const NIL_THREAD = '00000000-0000-0000-0000-000000000000'

function handshake(): TranscriptFrame[] {
  return [
    out({ id: 1, method: 'initialize', params: { clientInfo: { name: 'mousse', title: 'Mousse', version: '0.1.1' }, capabilities: { experimentalApi: true, requestAttestation: false } } }),
    inn({ id: 1, result: { userAgent: 'replay', codexHome: '/home/replay/.codex', platformFamily: 'unix', platformOs: 'macos' } }),
    out({ method: 'initialized' }),
    out({ id: 2, method: 'account/read', params: { refreshToken: false } }),
    inn({ id: 2, result: { account: { type: 'chatgpt', email: null, planType: 'plus' }, requiresOpenaiAuth: true } }),
    out({ id: 3, method: 'thread/list', params: { parentThreadId: NIL_THREAD, ancestorThreadId: NIL_THREAD, limit: 1 } }),
    inn({ id: 3, result: { data: [], nextCursor: null } })
  ]
}

const threadParams = (extra: Record<string, unknown> = {}) => ({
  approvalPolicy: 'untrusted',
  sandbox: 'read-only',
  model: 'gpt-x',
  modelProvider: 'openai',
  config: { model_provider: 'openai' },
  ...extra
})

/** One turn on `T`: its `turn/start` with exactly `prompt`, a reply and completion. */
function codexTurn(id: number, prompt: string, turn: string, reply: string): TranscriptFrame[] {
  return [
    out({ id, method: 'turn/start', params: { summary: 'auto', threadId: T, input: text(prompt), approvalPolicy: 'untrusted', sandboxPolicy: SUPERVISED, model: 'gpt-x' } }),
    inn({ id, result: { turn: { id: turn, status: 'inProgress', error: null, items: [] } } }),
    note('turn/started', { threadId: T, turn: { id: turn, status: 'inProgress', error: null } }),
    note('item/completed', { threadId: T, turnId: turn, item: { type: 'agentMessage', id: `msg-${turn}`, text: reply } }),
    note('turn/completed', { threadId: T, turn: { id: turn, status: 'completed', error: null } })
  ]
}

function transport(frames: TranscriptFrame[]): ReplayTransport {
  const header = { kind: 'transcript', adapter: 'codex', scenario: 'skills', boundary: CODEX_APP_SERVER_BOUNDARY, recordedAt: 'hand-authored', version: 1 }
  return new ReplayTransport(parseTranscript([header, ...frames].map((line) => JSON.stringify(line)).join('\n')), { stallMs: 2_000 })
}

const sink = (): TurnSink => new Proxy({} as TurnSink, { get: () => () => undefined })
const control = { drainSteer: () => undefined, heartbeat: () => undefined }

/** A host whose bridge carries `preamble` and `instructions`, with no MCP attachment. */
function bridged(preamble: string, instructions: string, mcp: { url: string; token: string } | null = null): AdapterHost {
  return {
    tools: {},
    bridge: { mcp, turnToken: 'turn-1', sessionInstructions: instructions, turnPreamble: preamble, userMcp: 'native' },
    context: { recoverOverflow: () => null, prepareNativeContext: () => null, nativeHistoryAfterTurn: (reply) => `history+${reply}` }
  }
}

describe('resumed runtimes keep getting the turn preamble', () => {
  const homes: string[] = []
  const services: Array<{ stop(): unknown }> = []
  afterEach(async () => {
    for (const service of services.splice(0)) await service.stop()
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })
  const tempHome = (prefix: string): string => {
    const home = mkdtempSync(join(tmpdir(), prefix))
    homes.push(home)
    return home
  }
  const preamble = turnPreamble({ loadedSkills: [{ name: 'review', content: BODY.review }] })

  it('Codex sends the preamble on a continued loaded thread, and changed developer instructions in that turn\'s prompt', async () => {
    const home = tempHome('mousse-app-skills-codex-')
    const work = join(home, 'work')
    mkdirSync(work)
    const binary = join(home, 'codex')
    writeFileSync(binary, '#!/bin/sh\nexit 0\n')
    chmodSync(binary, 0o755)
    mkdirSync(join(home, 'providers', 'codex'), { recursive: true })
    writeFileSync(join(home, 'providers', 'codex', 'settings.json'), JSON.stringify({ binaryPath: binary, models: [{ id: 'gpt-x', label: 'GPT X' }] }))
    const current = `${preamble}\n\nCurrent request:\n`
    const replay = transport([
      ...handshake(),
      out({ id: 4, method: 'thread/start', params: threadParams({ developerInstructions: 'GUIDE' }) }),
      inn({ id: 4, result: { thread: { id: T }, model: 'gpt-x', modelProvider: 'openai', cwd: '/w' } }),
      ...codexTurn(5, `${current}/review the engine`, 'turn-1', 'one'),
      // The thread is still loaded: no resume, the same thread continues and the preamble is sent again.
      ...codexTurn(6, `${current}/review the adapters`, 'turn-2', 'two'),
      // New session text for a loaded thread: it cannot change the thread's developer instructions, so it goes into the prompt.
      ...codexTurn(7, `<mousse_session_instructions>\nGUIDE 2\n</mousse_session_instructions>\n\n${current}/review once more`, 'turn-3', 'three'),
      // Unchanged since: not repeated.
      ...codexTurn(8, `${current}/review the last one`, 'turn-4', 'four')
    ])
    const questions = new UserQuestionService()
    const codex: CodexProviderService = createCodexProviderService(home, questions, { launch: replayCodexAppServer(replay) }, { launch: () => ({ binaryPath: binary }) })
    services.push(codex, { stop: () => questions.shutdown() })
    const adapter = new CodexAdapter(() => codex)
    const input = (prompt: string, nativeHistory?: string): TurnInput => ({
      runId: 'run-1', attemptId: 'attempt-1', threadId: 'thread-1', cwd: work, instanceId: 'codex', model: 'gpt-x', llmProvider: 'codex',
      modelPinned: true, mode: 'agent', permissionMode: 'ask', prompt, messages: [], signal: new AbortController().signal, ...(nativeHistory ? { nativeHistory } : {})
    })
    expect((await adapter.startTurn(input('/review the engine'), sink(), control, bridged(preamble, 'GUIDE'))).text).toBe('one')
    expect((await adapter.startTurn(input('/review the adapters', 'history+one'), sink(), control, bridged(preamble, 'GUIDE'))).text).toBe('two')
    expect((await adapter.startTurn(input('/review once more', 'history+two'), sink(), control, bridged(preamble, 'GUIDE 2'))).text).toBe('three')
    expect((await adapter.startTurn(input('/review the last one', 'history+three'), sink(), control, bridged(preamble, 'GUIDE 2'))).text).toBe('four')
    replay.assertDone()
  })

  it('an ACP session resumed for turn 2 gets the preamble in its prompt', async () => {
    const sent: Array<{ method: string; params: Record<string, unknown> }> = []
    const home = tempHome('mousse-app-skills-acp-')
    const workspace = join(home, 'workspace')
    mkdirSync(workspace)
    const questions = new UserQuestionService()
    const launch = vi.fn(function () {
      const abort = new AbortController()
      return {
        child: { exitCode: 0, signalCode: null, kill: () => true },
        connection: {
          signal: abort.signal,
          close: () => abort.abort(new Error('closed')),
          agent: {
            request: async (method: string, params: Record<string, unknown>) => {
              sent.push({ method, params })
              if (method === 'initialize') return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { mcpCapabilities: { http: true } } }
              if (method === 'session/new' || method === 'session/resume')
                return { sessionId: 'acp-session', configOptions: [{ id: 'model', name: 'Model', type: 'select', currentValue: 'm1', options: [{ value: 'm1', name: 'M1' }] }] }
              if (method === 'session/prompt') return { stopReason: 'end_turn' }
              return {}
            },
            notify: async () => undefined
          }
        }
      }
    })
    const antigravity = new AntigravityProviderService(home, home, questions, undefined, { connect: launch as never })
    services.push(antigravity, { stop: () => questions.shutdown() })
    Object.assign(antigravity as unknown as Record<string, unknown>, { configured: () => true })
    const adapter = antigravityAdapter(() => antigravity)
    const input = (prompt: string, nativeHistory?: string): TurnInput => ({
      runId: 'run-1', attemptId: 'a-1', threadId: 'thread-1', cwd: workspace, instanceId: 'antigravity', model: 'm1', llmProvider: 'antigravity',
      modelPinned: true, mode: 'agent', prompt, messages: [], signal: new AbortController().signal, ...(nativeHistory ? { nativeHistory } : {})
    })
    const mcp = (token: string) => ({ url: 'http://127.0.0.1:4567/mcp', token })
    await adapter.startTurn(input('review the engine'), sink(), control, bridged(preamble, 'GUIDE', mcp('tok-1')))
    // A new bearer reopens the session: the process restarts and resumes the saved ACP session.
    await adapter.startTurn(input('review the adapters', 'history+'), sink(), control, bridged(preamble, 'GUIDE', mcp('tok-2')))
    expect(launch).toHaveBeenCalledTimes(2)
    expect(sent.filter((frame) => frame.method === 'session/new' || frame.method === 'session/resume').map((frame) => frame.method))
      .toEqual(['session/new', 'session/resume'])
    const prompts = sent.filter((frame) => frame.method === 'session/prompt').map((frame) => (frame.params.prompt as Array<{ text: string }>)[0].text)
    expect(prompts).toEqual([
      `<mousse_orchestration_instructions>\nGUIDE\n</mousse_orchestration_instructions>\n\n${preamble}\n\nCurrent request:\nreview the engine`,
      `${preamble}\n\nCurrent request:\nreview the adapters`
    ])
  })
})
