import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { instanceEnv } from '../../src/mms/harness/env'
import { PI_RPC_CAPS } from '../../src/mms/harness/drivers/pi'
import { PiRpcEngine } from '../../src/mms/harness/pi/engine'
import type { PiLaunch } from '../../src/mms/harness/pi/launch'
import type { PiProcess } from '../../src/mms/harness/pi/launch'
import type { PiReadyRequest } from '../../src/mms/harness/pi/extension/protocol'
import type { AdapterHost, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/run/adapters/ProviderAdapter'
import { cleanBase, piPackage, scratchDir, startRecorder, testExtension, type RecordedRequest, type Recorder, type Scratch } from './piRpcFixture'

/**
 * The containment evidence suite (PR 2 §4 items 1–9) against the real pinned Pi child, Mousse's
 * extension built from source, an OpenAI-compatible mock and a stand-in Mousse MCP server, all on
 * 127.0.0.1 with fake keys. One engine runs two turns on one warm process:
 *
 * - an allowed turn (a plain reply) in a workspace and a user home that hold a decoy of everything
 *   Pi would load by itself (extensions, skills, prompt templates, themes, context files, project
 *   settings), each with a canary;
 * - a turn whose writer is refused, in which the model asks for `write`, `bash` and a Mousse
 *   mutation tool: the gate denies all three while Pi has them active.
 *
 * Where a property is proven in depth elsewhere the test says so instead of repeating the setup.
 */

const DECOYS = ['EXTENSION', 'SKILL', 'PROMPT', 'THEME', 'AGENTS', 'CLAUDE', 'SETTINGS'].map((name) => `MOUSSE_CANARY_${name}`)
const MOUSSE_TOOL = 'mousse_write_note'

type Step = { text?: string; tool?: { name: string; args: Record<string, unknown> } }

/** Answers each request with the next step as an OpenAI chat-completions stream. */
function script(steps: Step[]) {
  let index = 0
  return (_request: RecordedRequest, res: ServerResponse) => {
    const step = steps[Math.min(index, steps.length - 1)]
    index += 1
    const chunks: unknown[] = []
    if (step.text) chunks.push({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: step.text } }] })
    if (step.tool) chunks.push({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${index}`, type: 'function', function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) } }] } }] })
    chunks.push({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: step.tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`)
  }
}

/** Writes a decoy of everything Pi loads by itself under `root` (a workspace, or `~/.pi/agent`). */
function plantDecoys(root: string, dotPi: string, marker: string): void {
  const extensionDir = join(dotPi, 'extensions')
  mkdirSync(extensionDir, { recursive: true })
  // Loaded, it would leave a marker file (and name its canary to the model through a tool).
  writeFileSync(join(extensionDir, 'decoy.ts'), [
    "import { writeFileSync } from 'node:fs'",
    `export default function () { writeFileSync(${JSON.stringify(marker)}, 'MOUSSE_CANARY_EXTENSION') }`
  ].join('\n'))
  mkdirSync(join(dotPi, 'skills', 'canary'), { recursive: true })
  writeFileSync(join(dotPi, 'skills', 'canary', 'SKILL.md'), '---\nname: canary\ndescription: MOUSSE_CANARY_SKILL\n---\nMOUSSE_CANARY_SKILL\n')
  mkdirSync(join(dotPi, 'prompts'), { recursive: true })
  writeFileSync(join(dotPi, 'prompts', 'canary.md'), '---\ndescription: MOUSSE_CANARY_PROMPT\n---\nMOUSSE_CANARY_PROMPT\n')
  mkdirSync(join(dotPi, 'themes'), { recursive: true })
  writeFileSync(join(dotPi, 'themes', 'canary.json'), JSON.stringify({ name: 'MOUSSE_CANARY_THEME' }))
  writeFileSync(join(dotPi, 'settings.json'), JSON.stringify({ defaultProjectTrust: 'always', packages: ['MOUSSE_CANARY_SETTINGS'], systemPrompt: 'MOUSSE_CANARY_SETTINGS' }))
  writeFileSync(join(root, 'AGENTS.md'), 'MOUSSE_CANARY_AGENTS\n')
  writeFileSync(join(root, 'CLAUDE.md'), 'MOUSSE_CANARY_CLAUDE\n')
}

interface Turn {
  input: TurnInput
  sink: TurnSink
  ctl: TurnControl
  host: AdapterHost
  tools: Array<{ phase?: string; callId?: string; summary?: string; title?: string }>
}

function turn(project: string, mcp: Recorder, overrides: Partial<TurnInput> = {}, refuseWriter = false): Turn {
  const tools: Turn['tools'] = []
  const noop = () => {}
  const input: TurnInput = {
    runId: 'r1', attemptId: 'a1', threadId: 't1', cwd: project, instanceId: 'pi:mock', model: 'mock-model', llmProvider: 'mock',
    modelPinned: true, mode: 'agent' as TurnInput['mode'], prompt: 'Say hello', messages: [], signal: new AbortController().signal, ...overrides
  }
  const sink: TurnSink = {
    text: noop, thinking: noop, tool: (event) => void tools.push(event), nativeMessages: noop, compaction: noop, retry: noop, progress: noop,
    usage: noop, providerRef: noop, steerAccepted: noop, providerMetrics: noop, lineEdits: noop
  }
  const host: AdapterHost = {
    // The parent's writer is refused: every mutation-class call must be denied at the gate.
    tools: refuseWriter ? { toolAccess: { execute: async () => { throw new Error('mousse_writer_refused') } } as never } : {},
    bridge: { mcp: { url: `${mcp.url}/mcp`, token: 'fake-mcp-bearer' }, turnToken: 'turn-token', sessionInstructions: '', turnPreamble: '', userMcp: 'proxy' },
    context: { recoverOverflow: () => null, prepareNativeContext: () => null, nativeHistoryAfterTurn: (text) => `user: Say hello\nassistant: ${text}` }
  }
  return { input, sink, ctl: { drainSteer: () => undefined, heartbeat: noop }, host, tools }
}

describe('Pi containment evidence (real pinned Pi child)', () => {
  let scratch: Scratch
  let recorder: Recorder
  let mcp: Recorder
  let engine: PiRpcEngine
  let project: string
  let home: string
  let userHome: string
  const commands: string[] = []
  const launches: Array<Extract<PiLaunch, { runs: 'yes' }>> = []
  const markers: string[] = []
  let allowed: TurnResult
  let denied: Turn
  let deniedResult: TurnResult
  let denialRequests: RecordedRequest[] = []

  beforeAll(async () => {
    scratch = scratchDir('mousse-pi-containment-')
    recorder = await startRecorder()
    mcp = await startRecorder()
    const extension = await testExtension(scratch.dir)
    const stateDir = join(scratch.dir, 'state')
    home = join(stateDir, 'home')
    userHome = join(scratch.dir, 'user')
    project = join(scratch.dir, 'project')
    mkdirSync(project, { recursive: true })
    mkdirSync(userHome, { recursive: true })
    markers.push(join(scratch.dir, 'project-extension-loaded'), join(scratch.dir, 'user-extension-loaded'))
    plantDecoys(project, join(project, '.pi'), markers[0])
    plantDecoys(join(userHome, '.pi', 'agent'), join(userHome, '.pi', 'agent'), markers[1])
    // As the gateway builds it for a Pi entry: Telemetry Off (the default).
    const env = instanceEnv({ instanceId: 'pi:mock', driver: 'pi', configRevision: 0, home, searchPath: [], base: cleanBase(userHome), enforced: { PI_TELEMETRY: '0' } })
    engine = new PiRpcEngine({
      instanceId: 'pi:mock', provider: 'mock', label: 'Mock', capabilities: PI_RPC_CAPS, env: () => env, stateDir,
      runtime: () => ({ root: piPackage, entry: join(piPackage, 'dist/bundle/rpc-entry.js'), extension }),
      catalog: () => ({
        revision: 1,
        provider: {
          id: 'mock', builtin: false, name: 'Mock',
          models: [{ id: 'mock-model', name: 'Mock model', api: 'openai-completions', provider: 'mock', baseUrl: `${recorder.url}/v1`, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096, compat: { supportsStore: false, supportsDeveloperRole: false } }] as never
        }
      }),
      apiKey: () => 'fake-mock-key',
      mousseTools: () => [{ name: MOUSSE_TOOL, description: 'Writes a note (a Mousse mutation tool).', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, class: 'mutation' }],
      onCommand: (type) => void commands.push(type),
      adjustLaunch: (launch) => (launches.push(launch), launch),
      readyDeadlineMs: 15_000,
      settings: { retry: { enabled: false, maxRetries: 0, baseDelayMs: 10, provider: { maxRetries: 0 } } }
    })

    recorder.respond(script([{ text: 'hello' }]))
    const first = turn(project, mcp)
    allowed = await engine.startTurn(first.input, first.sink, first.ctl, first.host)

    const before = recorder.requests.length
    recorder.respond(script([
      { tool: { name: 'write', args: { path: 'denied.txt', content: 'x' } } },
      { tool: { name: 'bash', args: { command: `node -e "require('fs').writeFileSync('spawned.txt', 'x')"` } } },
      { tool: { name: MOUSSE_TOOL, args: { text: 'x' } } },
      { text: 'refused' }
    ]))
    denied = turn(project, mcp, { runId: 'r2', attemptId: 'a2', nativeHistory: 'user: Say hello\nassistant: hello' }, true)
    deniedResult = await engine.startTurn(denied.input, denied.sink, denied.ctl, denied.host)
    denialRequests = recorder.requests.slice(before)
  }, 120_000)

  afterAll(async () => {
    await engine?.stop()
    await recorder?.close()
    await mcp?.close()
    scratch?.cleanup()
  })

  const warmProcess = (): { process: PiProcess; readyReport: PiReadyRequest } =>
    (engine as unknown as { threads: Map<string, { process: PiProcess; readyReport: PiReadyRequest }> }).threads.get('t1')!

  it('both turns ran on one warm process', () => {
    expect(allowed).toMatchObject({ text: 'hello', aborted: false })
    expect(deniedResult).toMatchObject({ text: 'refused', aborted: false })
    expect(launches).toHaveLength(1)
  })

  it('1. only Mousse’s extension loads', () => {
    const args = launches[0].args
    expect(args).toContain('--no-extensions')
    expect(args.filter((arg) => arg === '-e' || arg === '--extension')).toHaveLength(1)
    expect(args[args.indexOf('-e') + 1]).toBe(join(scratch.dir, 'mousse-extension.mjs'))
    // Neither the workspace's nor the user's own extension ran.
    for (const marker of markers) expect(existsSync(marker), marker).toBe(false)
  })

  it('2. no skills, prompt templates, themes or context files reach the model', () => {
    expect(launches[0].args).toEqual(expect.arrayContaining(['--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files']))
    expect(recorder.requests.length).toBeGreaterThan(0)
    for (const request of recorder.requests) for (const canary of DECOYS) expect(request.body, canary).not.toContain(canary)
  })

  it('3. --no-approve, and the private settings.json never trusts a project', () => {
    expect(launches[0].args).toContain('--no-approve')
    const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) as Record<string, unknown>
    expect(settings.defaultProjectTrust).toBe('never')
    // The workspace's own settings (which asked for trust and a system prompt) were not applied.
    for (const request of recorder.requests) expect(request.body).not.toContain('MOUSSE_CANARY_SETTINGS')
  })

  it('4. the agent dir holds only Mousse-written files (no models.json)', () => {
    const entries = readdirSync(home).sort()
    expect(entries).not.toContain('models.json')
    // `settings.json` (`preparePiHome`) and `auth.json` (the OAuth broker) are Mousse's. The only
    // file Pi writes itself is its remote model catalogue's store, and offline it stays empty: no
    // model enters Pi through the agent dir. Any other file fails this test until it is reviewed.
    expect(entries.filter((entry) => entry !== 'models-store.json')).toEqual(['auth.json', 'settings.json'])
    // The stored API key reaches Pi only in the factory's catalogue answer, never in a file.
    expect(readFileSync(join(home, 'auth.json'), 'utf8')).not.toContain('fake-mock-key')
    if (entries.includes('models-store.json')) expect(JSON.parse(readFileSync(join(home, 'models-store.json'), 'utf8'))).toEqual({})
  })

  it('5. PI_OFFLINE=1', () => {
    expect(launches[0].env.PI_OFFLINE).toBe('1')
    // The launcher's other pins (`piLauncher`: "sets Pi offline in its package dir ...").
    expect(launches[0].env.PI_SKIP_VERSION_CHECK).toBe('1')
    expect(launches[0].env.PI_TELEMETRY).toBe('0')
  })

  it('6. no bash RPC command is sent', () => {
    expect(commands).toContain('prompt')
    expect(commands).not.toContain('bash')
  })

  it('7. default deny: the gate refuses a call Pi has active when Mousse does not allow it', () => {
    // Pi had `write`, `bash` and the Mousse tool active (agent mode); the gate refused each one.
    const completed = denied.tools.filter((event) => event.phase === 'complete')
    expect(completed.map((event) => event.title)).toEqual(['Tool write', 'Tool bash', `Tool ${MOUSSE_TOOL}`])
    for (const event of completed) expect(event.summary, event.title).toBe('The tool returned an error.')
    // Pi asked once per call, then got the final reply: no retry around a denial.
    expect(denialRequests).toHaveLength(4)
    // An unreachable gate blocks: `piExtension` "asks the gate for every call with the attempt token,
    // blocks a denial, and blocks when the gate is down" (the extension's own `tool_call` handler).
  })

  it('8. a denied call changes no file, spawns no process and reaches no MCP handler', () => {
    expect(existsSync(join(project, 'denied.txt'))).toBe(false)
    // The `bash` call would have started `node`, which writes this file.
    expect(existsSync(join(project, 'spawned.txt'))).toBe(false)
    expect(readdirSync(project).sort()).toEqual(['.pi', 'AGENTS.md', 'CLAUDE.md'])
    // The Mousse tool's call never reached the Mousse MCP server: not one connection.
    expect(mcp.connections()).toBe(0)
    // A call of an earlier turn that does reach the server is refused before any handler by the
    // app-tool registry (`_mousse_turn`): `piRpcLifecycle` "the turn handed to the extension carries
    // the registered turn token" and the PR 220 `piMcpBinding` coverage.
  })

  it('9. every available model is guarded', async () => {
    const thread = warmProcess()
    const guarded = new Set(thread.readyReport.guarded)
    const { models } = (await thread.process.client.send({ type: 'get_available_models' })) as unknown as { models: Array<{ provider: string }> }
    expect(models.length).toBeGreaterThan(0)
    for (const provider of new Set(models.map((model) => model.provider))) expect(guarded.has(provider), provider).toBe(true)
    // Across every API and with Anthropic OAuth tokens: `piAnthropicGuardProcess` "guards every
    // available model and refuses an Anthropic OAuth token on every API".
  })
})
