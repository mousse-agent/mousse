/**
 * Antigravity runs Mousse's single requests (thread titles, drafts) on `acp:antigravity`: a fresh agent process and
 * session of its own in a place's empty `work` folder, no MCP server, the system text and prompt as one prompt, every
 * tool refused, one attempt, and the process ended afterwards; its settings folder and session files are the place's
 * typed leftovers. The agent is a hand-authored ACP stand-in at the connection boundary (`connect`); it
 * proves Mousse's side only.
 *
 * Inputs the agent may send during the prompt: text (answer), too much text, a `tool_call` update before any text,
 * a permission request, a client file read, a terminal request, an unknown extension request, a question, a file
 * left in its folder, an empty folder left there, a cancelled stop reason, nothing until Stop, nothing until the
 * deadline, "authentication required". While it ends: a tool report, or no end at all. Session files: this
 * request's, another session's, this session's naming another folder, one that cannot be removed. Leftovers: a live
 * request's, a recorded running process's, an ended one's.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { methods, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AntigravityProviderService } from '../src/mms/harness/acp/presets/antigravity/AntigravityProviderService'
import { ANTIGRAVITY_LEFTOVER_RULES, sweepLegacyAntigravityOneShots } from '../src/mms/harness/acp/presets/antigravity/oneShotGuards'
import { placesFs, sweepPlaces } from '../src/mms/harness/oneShot/places'
import { ONE_SHOT_DEADLINE_MS, ONE_SHOT_INSTRUCTION, ONE_SHOT_OUTPUT_CAP } from '../src/mms/harness/acp/session'
import type { AcpClientHandlers, AcpLaunchRequest } from '../src/mms/harness/acp/connection'
import { antigravityDriver } from '../src/mms/harness/drivers/antigravity'
import { ProviderInstanceService } from '../src/mms/harness/instanceMap'
import type { Harness } from '../src/mms/harness/gateway'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'
import { testHarness } from '../src/mms/run/testkit/harness'
import { extractLimitFromError } from '../src/mms/models/usageLimits'
import { classifyOneShotFailure } from '../src/mms/harness/oneShot/runner'

const homes: string[] = []
const services: AntigravityProviderService[] = []
const harnesses: Harness[] = []
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.stop()
  for (const service of services.splice(0)) service.stop()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  vi.restoreAllMocks()
})

type Agent = { handlers: AcpClientHandlers; update(update: unknown): void; aborted: AbortSignal; cwd: string; sessionId: string }
/** What the agent's own requests were answered, in order. */
const answers: unknown[] = []
afterEach(() => { answers.length = 0 })
type Script = (agent: Agent) => Promise<unknown>

type Process = { requests: Array<[string, Record<string, unknown>]>; close: ReturnType<typeof vi.fn>; launched: AcpLaunchRequest; update(update: unknown): void; exit(): void }

/**
 * An Antigravity service whose agent processes are scripted: `prompt` answers each `session/prompt`. Ending a process
 * (kill or close) reports its exit, unless `onKill` says otherwise: it runs first, and `'stays'` keeps it running.
 */
function fixture(prompt: Script, options: { onKill?: (process: Process) => void | 'stays'; entry?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'mousse-agy-one-shot-'))
  homes.push(home)
  const processes: Process[] = []
  const questions = new UserQuestionService()
  const entry = options.entry ? { instanceId: 'antigravity_work', stateDir: join(home, 'entry'), home: join(home, 'entry', 'home') } : undefined
  const service = new AntigravityProviderService(home, home, questions, undefined, {
    ...(entry ? { entry } : {}),
    connect: (launched) => {
      const abort = new AbortController()
      const requests: Array<[string, Record<string, unknown>]> = []
      let exited = false
      const exit = () => {
        if (exited) return
        exited = true
        abort.abort(new Error('ACP closed'))
        launched.onExit?.()
      }
      const kill = vi.fn(() => {
        if (options.onKill?.(process) === 'stays') return
        exit()
      })
      // Closing ends the process, which then reports its exit (`AcpLaunchRequest.onExit`).
      const close = vi.fn(() => {
        if (abort.signal.aborted) return
        kill()
      })
      const active = {
        child: { pid: undefined, exitCode: null, signalCode: null, kill },
        connection: {
          signal: abort.signal,
          close,
          agent: {
            request: vi.fn(async (method: string, params: Record<string, unknown>) => {
              requests.push([method, params])
              abort.signal.throwIfAborted()
              if (method === methods.agent.initialize) return { protocolVersion: PROTOCOL_VERSION }
              if (method === methods.agent.session.new) return {
                sessionId: `session-${processes.length}`,
                configOptions: [{ id: 'model', type: 'select', options: [{ value: 'account-model', name: 'Account Model' }] }]
              }
              if (method === methods.agent.session.prompt) {
                const agent: Agent = { handlers: launched.handlers, update: (update) => active.onUpdate?.(update), aborted: abort.signal, cwd: launched.cwd!, sessionId: String(params.sessionId) }
                // The connection closing rejects the request, as the SDK does.
                const closed = new Promise((_resolve, reject) => abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true }))
                return await Promise.race([closed, prompt(agent)])
              }
              return {}
            }),
            notify: vi.fn(async () => undefined)
          }
        },
        onUpdate: undefined as ((update: unknown) => void) | undefined
      }
      const process: Process = { requests, close, launched, update: (update) => active.onUpdate?.(update), exit }
      processes.push(process)
      return active as never
    }
  })
  services.push(service)
  vi.spyOn(service, 'configured').mockReturnValue(true)
  vi.spyOn(service, 'models').mockReturnValue([{ id: 'account-model', label: 'Account Model' }])
  // The store the model check reads (`AcpSessions.selectModel`).
  ;(service as unknown as { settings: { models: unknown[] } }).settings.models = [{ id: 'account-model', label: 'Account Model' }]
  const spec = (patch: Partial<{ model: string; system: string; prompt: string; onActivity: () => void }> = {}) => ({
    model: 'account-model', system: 'You name chats.', prompt: 'User request: fix the login bug', onActivity: vi.fn(), ...patch
  })
  /** The request on the route's transport, as the runner sends it (`acp:antigravity`). */
  const ask = async (request: ReturnType<typeof spec>, signal: AbortSignal) => ({
    text: await service.oneShotTransport({ model: request.model }).send({ model: request.model, system: request.system, prompt: request.prompt },
      { activity: request.onActivity, text: () => {}, tool: () => {}, launching: () => {}, sending: () => {} }, signal)
  })
  const stateDir = entry?.stateDir ?? join(home, 'providers', 'antigravity')
  // Single requests run in places under the profile (`oneShot/places.ts`).
  const oneShotDir = join(home, 'one-shot')
  const ledgerDir = join(home, 'one-shot-ledger')
  const geminiHome = join(entry?.home ?? stateDir, 'gemini-home')
  const homesDir = join(entry?.home ?? stateDir, 'one-shot-homes')
  /** The service runs `agy` (its session files are then removed afterwards). */
  const onAgy = () => vi.spyOn(service as unknown as { runtime(): unknown }, 'runtime').mockReturnValue({ kind: 'native', binary: join(home, 'agy.exe'), source: 'manual' })
  /** Every file a single request left: places, their records, settings folders. */
  const leftovers = () => [oneShotDir, ledgerDir].flatMap((dir) => existsSync(dir) ? readdirSync(dir) : [])
    .concat(existsSync(join(geminiHome, 'antigravity-acp')) ? readdirSync(join(geminiHome, 'antigravity-acp')).filter((name) => name.startsWith('one-shot-')) : [])
  return { home, service, processes, spec, ask, questions, stateDir, oneShotDir, ledgerDir, homesDir, geminiHome, onAgy, leftovers }
}

const text = (value: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } })

describe('Antigravity one-shot', () => {
  it('answers with the agent text from a session of its own in an empty folder, with no MCP server, and ends the process', async () => {
    const s = fixture(async (agent) => {
      agent.update(text('Fix the '))
      agent.update(text('login bug'))
      return { stopReason: 'end_turn' }
    })
    const spec = s.spec()
    const result = await s.ask(spec, new AbortController().signal)
    expect(result).toEqual({ text: 'Fix the login bug' })
    expect(s.processes).toHaveLength(1)
    const [process] = s.processes
    expect(process.launched.purpose).toBe('one_shot')
    const opened = process.requests.find(([method]) => method === methods.agent.session.new)![1]
    expect(opened.mcpServers).toEqual([])
    // The place's `work` folder.
    expect(String(opened.cwd).startsWith(s.oneShotDir)).toBe(true)
    expect(String(opened.cwd).endsWith('work')).toBe(true)
    // The process starts in the same folder.
    expect(process.launched.cwd).toBe(opened.cwd)
    // The folder, its home and its settings folder are gone afterwards.
    expect(s.leftovers()).toEqual([])
    expect(process.requests).toContainEqual([methods.agent.session.setConfigOption, expect.objectContaining({ configId: 'model', value: 'account-model' })])
    const sent = process.requests.find(([method]) => method === methods.agent.session.prompt)![1].prompt as Array<{ type: string; text: string }>
    expect(sent).toEqual([{ type: 'text', text: `${ONE_SHOT_INSTRUCTION}\n\nYou name chats.\n\nUser request: fix the login bug` }])
    expect(spec.onActivity).toHaveBeenCalled()
    expect(process.close).toHaveBeenCalled()
  })

  it.each([
    ['a tool call update before any text', async (agent: Agent) => {
      agent.update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read file', name: 'view_file' })
      agent.update(text('after the tool'))
      return await new Promise(() => {})
    }],
    ['a permission request', async (agent: Agent) => {
      answers.push(await agent.handlers.requestPermission({ sessionId: 's', toolCall: { toolCallId: 't1', title: 'Run command' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] } as never))
      return await new Promise(() => {})
    }],
    ['a client file read', async (agent: Agent) => {
      answers.push(await agent.handlers.readTextFile!({ sessionId: 's', path: '/etc/hosts' } as never).catch((error: Error) => `refused: ${error.message}`))
      return await new Promise(() => {})
    }],
    ['a terminal request', async (agent: Agent) => {
      answers.push(await agent.handlers.refuseRequest!(methods.client.terminal.create).catch((error: Error) => `refused: ${error.message}`))
      return await new Promise(() => {})
    }],
    ['an unknown extension request', async (agent: Agent) => {
      answers.push(await agent.handlers.refuseRequest!('_google/run_workflow').catch((error: Error) => `refused: ${error.message}`))
      return await new Promise(() => {})
    }],
    ['a question', async (agent: Agent) => {
      answers.push(await agent.handlers.createElicitation!({ sessionId: 's', mode: 'form', message: 'Which file?', requestedSchema: { type: 'object', properties: {} } } as never))
      return await new Promise(() => {})
    }]
  ])('ends the request as refused on %s, asks nobody, and ends the process', async (_name, script) => {
    const s = fixture(script)
    const asked = vi.spyOn(s.questions, 'requestAnswers')
    await expect(s.ask(s.spec(), new AbortController().signal)).rejects.toMatchObject({ code: 'one_shot_tool_refused' })
    expect(asked).not.toHaveBeenCalled()
    // A permission is answered cancelled, a question declined, every other request fails: nothing is allowed.
    for (const answer of answers) expect(answer).toSatisfy((value) => typeof value === 'string' ? value.startsWith('refused:')
      : 'action' in (value as object) ? (value as { action: string }).action === 'decline'
        : (value as { outcome: { outcome: string } }).outcome.outcome === 'cancelled')
    expect(s.processes[0].close).toHaveBeenCalled()
    expect(s.leftovers()).toEqual([])
  })

  it('a file the agent leaves in its folder fails the request once the process has ended; empty folders do not', async () => {
    const wrote = fixture(async (agent) => {
      writeFileSync(join(agent.cwd, 'notes.md'), 'hello')
      agent.update(text('Login bug'))
      return { stopReason: 'end_turn' }
    })
    await expect(wrote.ask(wrote.spec(), new AbortController().signal)).rejects.toMatchObject({ code: 'one_shot_tool_refused', message: expect.stringContaining('notes.md') })
    expect(wrote.leftovers()).toEqual([])
    const folders = fixture(async (agent) => {
      mkdirSync(join(agent.cwd, '.agents', 'workflows'), { recursive: true })
      agent.update(text('Login bug'))
      return { stopReason: 'end_turn' }
    })
    await expect(folders.ask(folders.spec(), new AbortController().signal)).resolves.toEqual({ text: 'Login bug' })
    // What agy keeps in the place's own gemini dir and temporary folder is its own, not a write in the request's folder.
    const own = fixture(async (agent) => {
      for (const folder of ['home', 'tmp']) {
        mkdirSync(join(agent.cwd, '..', folder), { recursive: true })
        writeFileSync(join(agent.cwd, '..', folder, 'agy.log'), 'started')
      }
      agent.update(text('Login bug'))
      return { stopReason: 'end_turn' }
    })
    await expect(own.ask(own.spec(), new AbortController().signal)).resolves.toEqual({ text: 'Login bug' })
    expect(own.leftovers()).toEqual([])
  })

  it("runs whatever hooks and MCP servers the home's config sets, or however malformed it is (its launch reads an empty home)", async () => {
    const s = fixture(async (agent) => {
      agent.update(text('Login bug'))
      return { stopReason: 'end_turn' }
    })
    mkdirSync(join(s.geminiHome, 'config'), { recursive: true })
    writeFileSync(join(s.geminiHome, 'config', 'hooks.json'), '{"probe":{"SessionStart":[{"type":"command","command":"curl example.com"}]}}')
    writeFileSync(join(s.geminiHome, 'config', 'mcp_config.json'), '{"mcpServers":')
    await expect(s.ask(s.spec(), new AbortController().signal)).resolves.toEqual({ text: 'Login bug' })
  })

  it('an answer longer than the cap ends the request and the process', async () => {
    const s = fixture(async (agent) => {
      agent.update(text('x'.repeat(ONE_SHOT_OUTPUT_CAP)))
      agent.update(text('y'))
      return await new Promise(() => {})
    })
    await expect(s.ask(s.spec(), new AbortController().signal)).rejects.toMatchObject({ code: 'protocol' })
    expect(s.processes[0].close).toHaveBeenCalled()
  })

  it('an agent that keeps the request open past the deadline is stopped, even while it still sends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const s = fixture(async (agent) => {
        agent.update(text('still thinking'))
        return await new Promise(() => {})
      })
      const run = s.ask(s.spec(), new AbortController().signal)
      const settled = expect(run).rejects.toMatchObject({ code: 'timeout' })
      await vi.waitFor(() => expect(s.processes[0]?.requests.some(([method]) => method === methods.agent.session.prompt)).toBe(true))
      await vi.advanceTimersByTimeAsync(ONE_SHOT_DEADLINE_MS)
      await settled
      expect(s.processes[0].close).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("removes the files of the session it opened, and only those, once they name this request's folder", async () => {
    const appData = join('antigravity-acp')
    const s = fixture(async (agent) => {
      const base = join(s.geminiHome, appData)
      for (const dir of ['conversations', join('brain', agent.sessionId), join('brain', 'other-session'), 'annotations']) mkdirSync(join(base, dir), { recursive: true })
      // agy's saved conversation names its workspace.
      writeFileSync(join(base, 'conversations', `${agent.sessionId}.db`), `workspace file:///${agent.cwd.replaceAll('\\', '/')}`)
      writeFileSync(join(base, 'annotations', `${agent.sessionId}.pbtxt`), '')
      writeFileSync(join(base, 'conversations', 'other-session.db'), `workspace file:///${agent.cwd.replaceAll('\\', '/')}`)
      agent.update(text('Login bug'))
      return { stopReason: 'end_turn' }
    })
    s.onAgy()
    await expect(s.ask(s.spec(), new AbortController().signal)).resolves.toEqual({ text: 'Login bug' })
    const base = join(s.geminiHome, appData)
    expect(readdirSync(join(base, 'conversations'))).toEqual(['other-session.db'])
    expect(readdirSync(join(base, 'brain'))).toEqual(['other-session'])
    expect(readdirSync(join(base, 'annotations'))).toEqual([])
  })

  it('keeps the files of its session when its saved conversation names another folder', async () => {
    const s = fixture(async (agent) => {
      const conversations = join(s.geminiHome, 'antigravity-acp', 'conversations')
      mkdirSync(conversations, { recursive: true })
      writeFileSync(join(conversations, `${agent.sessionId}.db`), 'workspace file:///somewhere/else')
      agent.update(text('Login bug'))
      return { stopReason: 'end_turn' }
    })
    s.onAgy()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await expect(s.ask(s.spec(), new AbortController().signal)).resolves.toEqual({ text: 'Login bug' })
    expect(readdirSync(join(s.geminiHome, 'antigravity-acp', 'conversations'))).toEqual(['session-1.db'])
  })

  it('Stop aborts a prompt the agent never answers, and ends the process', async () => {
    const s = fixture(async () => await new Promise(() => {}))
    const stop = new AbortController()
    const pending = s.ask(s.spec(), stop.signal)
    await vi.waitFor(() => expect(s.processes[0]?.requests.some(([method]) => method === methods.agent.session.prompt)).toBe(true))
    stop.abort()
    await expect(pending).rejects.toBeDefined()
    expect(s.processes[0].close).toHaveBeenCalled()
    expect(s.processes).toHaveLength(1)
  })

  it('a prompt the agent ends cancelled is a failure, not an empty title, and is not tried again', async () => {
    const s = fixture(async (agent) => {
      agent.update(text('partial'))
      return { stopReason: 'cancelled' }
    })
    await expect(s.ask(s.spec(), new AbortController().signal)).rejects.toBeDefined()
    expect(s.processes).toHaveLength(1)
  })

  it("agy's quota notice sent as the reply is a usage limit until the time it names, not a title", async () => {
    // The reply agy 1.5.13 sent for a model whose quota was used up (seen live, November 2026).
    const s = fixture(async (agent) => {
      agent.update(text('\n⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h28m19s.\n'))
      return { stopReason: 'end_turn' }
    })
    const failed = await s.ask(s.spec(), new AbortController().signal).catch((error: unknown) => error)
    // The model's own limit (its other models still run), until the reset the notice names.
    const limit = extractLimitFromError(failed)
    expect(limit).toMatchObject({ scope: 'model' })
    expect(Date.parse(limit!.until) - Date.now()).toBeGreaterThan(2 * 60 * 60_000)
    expect(classifyOneShotFailure(failed)).toBe('rate_limited')
  })

  it('a stop before it starts launches nothing', async () => {
    const s = fixture(async () => ({ stopReason: 'end_turn' }))
    const stop = new AbortController()
    stop.abort()
    await expect(s.ask(s.spec(), stop.signal)).rejects.toBeDefined()
    expect(s.processes).toHaveLength(0)
    expect(existsSync(s.oneShotDir)).toBe(false)
  })

  it('a tool the agent reports while it ends, after its answer, still refuses the request', async () => {
    const s = fixture(async (agent) => {
      agent.update(text('Login bug'))
      return { stopReason: 'end_turn' }
    }, { onKill: (process) => process.update({ sessionUpdate: 'tool_call', toolCallId: 't9', title: 'Write file' }) })
    await expect(s.ask(s.spec(), new AbortController().signal)).rejects.toMatchObject({ code: 'one_shot_tool_refused', message: expect.stringContaining('Write file') })
  })

  it('the places sweep removes what an older version left in the entry\'s folders, and skips one whose recorded process still runs', async () => {
    const s = fixture(async () => ({ stopReason: 'end_turn' }))
    const old = (Date.now() - 2 * 60 * 60_000) / 1000
    const leave = (id: string, record: object | undefined) => {
      for (const dir of [join(s.stateDir, 'one-shot', id), join(s.homesDir, id), join(s.geminiHome, 'antigravity-acp', `one-shot-${id}`)]) {
        mkdirSync(dir, { recursive: true })
        if (record && dir.startsWith(s.homesDir)) writeFileSync(join(dir, 'mousse-one-shot.json'), JSON.stringify(record))
        utimesSync(dir, old, old)
      }
    }
    const running = '00000000-0000-4000-8000-000000000001'
    const ended = '00000000-0000-4000-8000-000000000002'
    const unrecorded = '00000000-0000-4000-8000-000000000003'
    leave(running, { pid: process.pid })
    leave(ended, { pid: 2 ** 22 + 7 })
    leave(unrecorded, undefined)
    // A young one of an older version is kept too.
    const young = '00000000-0000-4000-8000-000000000004'
    mkdirSync(join(s.stateDir, 'one-shot', young), { recursive: true })
    sweepLegacyAntigravityOneShots(s.home)
    expect(readdirSync(join(s.stateDir, 'one-shot')).sort()).toEqual([running, young])
    expect(readdirSync(s.homesDir)).toEqual([running])
    expect(readdirSync(join(s.geminiHome, 'antigravity-acp'))).toEqual([`one-shot-${running}`])
  })

  it('a session file it cannot remove keeps the place and its record, and the places sweep removes them once it can', async () => {
    const s = fixture(async (agent) => {
      const conversations = join(s.geminiHome, 'antigravity-acp', 'conversations')
      mkdirSync(conversations, { recursive: true })
      writeFileSync(join(conversations, `${agent.sessionId}.db`), `workspace file:///${agent.cwd.replaceAll('\\', '/')}`)
      writeFileSync(join(conversations, `${agent.sessionId}.db-wal`), '')
      agent.update(text('Login bug'))
      return { stopReason: 'end_turn' }
    })
    s.onAgy()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const unlink = placesFs.unlink
    let locked = true
    vi.spyOn(placesFs, 'unlink').mockImplementation((path) => {
      if (locked && path.endsWith('.db-wal')) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      unlink(path)
    })
    await expect(s.ask(s.spec(), new AbortController().signal)).resolves.toEqual({ text: 'Login bug' })
    const conversations = join(s.geminiHome, 'antigravity-acp', 'conversations')
    // The conversation that proves the files are the place's goes last, so it is still there to prove them next time.
    expect(readdirSync(conversations).sort()).toEqual(['session-1.db', 'session-1.db-wal'])
    expect(readdirSync(s.ledgerDir)).toHaveLength(1)
    locked = false
    const report = await sweepPlaces(s.home, ANTIGRAVITY_LEFTOVER_RULES)
    expect(report.removed).toHaveLength(1)
    expect(readdirSync(conversations)).toEqual([])
    expect(s.leftovers()).toEqual([])
  })

  it("an added entry's request answered \"authentication required\" fails without signing the entry out", async () => {
    const s = fixture(async () => { throw new RequestError(-32000, 'Authentication required') }, { entry: true })
    const signedOut = vi.spyOn(s.service as unknown as { markSignedOut(): void }, 'markSignedOut')
    await expect(s.ask(s.spec(), new AbortController().signal)).rejects.toMatchObject({ code: 'signed_out' })
    expect(signedOut).not.toHaveBeenCalled()
  })
})

describe('gateway one-shot on Antigravity', () => {
  it('lists Antigravity best-effort for thread titles and runs a title request through its driver in a place', async () => {
    const s = fixture(async (agent) => {
      agent.update(text('Login bug'))
      return { stopReason: 'end_turn' }
    })
    vi.spyOn(s.service, 'signedIn').mockReturnValue(true)
    let stored: unknown = { antigravity: { driver: 'antigravity', enabled: true } }
    const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
    const harness = testHarness({ drivers: [antigravityDriver({ builtIn: () => s.service })], instances, profileHome: homes[0] })
    harnesses.push(harness)
    const listed = (await harness.llmProviders({ kind: 'device' })).find((provider) => provider.instanceId === 'antigravity')
    expect(listed?.oneShot).toBe(true)
    // On `acpOneShot` with its own launch, labelled best-effort as any ACP agent.
    expect(listed?.models.find((model) => model.id === 'account-model')?.title).toMatchObject({ state: 'best_effort', route: 'acp:antigravity' })
    const answer = await harness.oneShot({
      selection: { instanceId: 'antigravity', llmProvider: 'antigravity', model: 'account-model' },
      purpose: 'title',
      system: 'You name chats.',
      prompt: 'User request: fix the login bug',
      maxChars: 80
    })
    expect(answer).toEqual({ text: 'Login bug' })
    expect(s.processes).toHaveLength(1)
    // In a place of its own, removed afterwards.
    expect(String(s.processes[0]!.launched.cwd)).toMatch(/[\\/]one-shot[\\/][0-9a-f-]{36}[\\/]work$/)
    expect(s.leftovers()).toEqual([])
  })
})
