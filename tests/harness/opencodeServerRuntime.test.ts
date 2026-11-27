/**
 * OpenCode turns and one-shots on its server API, through the driver's runtime (the adapter the gateway calls), against
 * a hand-authored server (`fakeOpencodeServer.ts`): which rules each session gets in each mode, how an OpenCode ask
 * becomes a Mousse approval and how it is answered, what refuses an asking turn, resuming a thread's session (one saved
 * over ACP included), Stop, and the one-shot's single tool-free request. What the real OpenCode 2.0.20 does with these
 * calls is checked in `tests/live/opencodeServer.test.ts`.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClassifiedOption, PermissionPrompter } from '../../src/mms/harness/acp/permissions'
import type { DriverRuntime } from '../../src/mms/harness/driver'
import { opencodeDriver } from '../../src/mms/harness/drivers/opencode'
import { OpencodeServer } from '../../src/mms/harness/opencode/server'
import { instanceEnv } from '../../src/mms/harness/env'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { supportedPermissionModes, type PermissionMode } from '../../src/shared/permissionMode'
import { fakeOpencodeServer, type FakeOpencode } from './fakeOpencodeServer'

const dirs: string[] = []
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

async function setup(options: { stateFiles?: Record<string, unknown> } = {}) {
  const fake = await fakeOpencodeServer()
  const root = tempDir('mousse-opencode-server-')
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  const binaryPath = join(bin, process.platform === 'win32' ? 'opencode.exe' : 'opencode')
  writeFileSync(binaryPath, '#!/bin/sh\n', { mode: 0o755 })
  const stateDir = join(root, 'state')
  mkdirSync(stateDir, { recursive: true })
  for (const [name, value] of Object.entries(options.stateFiles ?? {})) writeFileSync(join(stateDir, name), JSON.stringify(value))
  const project = join(root, 'project')
  mkdirSync(project, { recursive: true })
  const driver = opencodeDriver({ startServer: (launch, signal) => fake.start(launch, signal), interruptWaitMs: 2_000 })
  const runtime = driver.create({
    instanceId: 'opencode:opencode',
    builtIn: false,
    config: driver.decodeConfig({ binaryPath }),
    env: instanceEnv({ instanceId: 'opencode:opencode', driver: 'opencode', configRevision: 0, searchPath: [], base: { PATH: '' } }),
    profileHome: stateDir,
    installationHome: stateDir,
    stateDir,
    questions: new UserQuestionService(),
    findBinary: () => undefined,
    changed: () => {},
    signedOut: () => false,
    saveLaunch: async () => {}
  })
  cleanups.push(async () => { await runtime.stop(); await fake.close() })
  return { fake, runtime, project, stateDir, driver }
}

/** A prompter that answers every approval with `pick` and records what it was asked. */
function prompter(pick: 'once' | 'reject') {
  const asked: Array<{ title: string; options: ClassifiedOption[]; approval: unknown }> = []
  const value: PermissionPrompter = {
    choose: async (request) => {
      asked.push({ title: request.title, options: request.options, approval: request.approval })
      return pick
    }
  }
  return { asked, value }
}

interface TurnOptions {
  mode?: PermissionMode
  prompter?: PermissionPrompter
  history?: string
  threadId?: string
  signal?: AbortSignal
}

/** One turn through the adapter, as the gateway runs it. */
async function turn(runtime: DriverRuntime, project: string, options: TurnOptions = {}) {
  const tools: Array<{ phase: string; callId?: string; title: string }> = []
  let committed: string | undefined
  const result = await runtime.adapter.startTurn(
    {
      runId: 'r', attemptId: 'a', threadId: options.threadId ?? 't1', instanceId: 'opencode:opencode', llmProvider: '',
      model: 'anthropic/claude-haiku-5-5', modelPinned: true, mode: 'agent', permissionMode: options.mode ?? 'ask',
      prompt: 'fix it', messages: [], cwd: project, nativeHistory: options.history ?? '', signal: options.signal ?? new AbortController().signal
    } as never,
    { text: () => {}, thinking: () => {}, tool: (event: { phase: string; callId?: string; title: string }) => tools.push(event), progress: () => {}, providerRef: () => {}, steerAccepted: () => {}, usage: () => {}, providerMetrics: () => {}, status: () => {}, providerTurn: () => {}, toolAwaiting: () => {} } as never,
    { drainSteer: () => undefined, heartbeat: () => {} } as never,
    {
      tools: {},
      ...(options.prompter ? { bridge: { mcp: null, turnToken: 't', sessionInstructions: '', turnPreamble: '', userMcp: 'native', permission: options.prompter } } : {}),
      context: { nativeHistoryAfterTurn: (text: string) => { committed = `${options.history ?? ''}|${text}`; return committed } }
    } as never
  )
  return { result, tools, committed }
}

/** A run that asks about `action` for a tool call, then finishes once answered. */
function asksAbout(fake: FakeOpencode, action: string) {
  const replies: Array<{ requestId: string; body: Record<string, unknown> }> = []
  fake.onPrompt = (session) => {
    fake.emit('session.execution.started', { sessionID: session.id })
    fake.emit('session.tool.input.started', { sessionID: session.id, assistantMessageID: 'm', id: 'call_1', name: action === 'edit' ? 'write' : action })
    fake.emit('session.tool.called', { sessionID: session.id, assistantMessageID: 'm', id: 'call_1', input: { path: 'marker.txt' }, executed: false })
    fake.emit('permission.asked', { id: 'per_1', sessionID: session.id, action, resources: ['marker.txt'], source: { type: 'tool', messageID: 'm', id: 'call_1' } })
  }
  fake.onReply = (session, requestId, body) => {
    replies.push({ requestId, body })
    if (body.decision === 'once') fake.emit('session.tool.success', { sessionID: session.id, assistantMessageID: 'm', id: 'call_1', content: [{ type: 'text', text: 'wrote' }], executed: true })
    else fake.emit('session.tool.failed', { sessionID: session.id, assistantMessageID: 'm', id: 'call_1', error: { type: 'permission.rejected', message: 'rejected' }, executed: false })
    fake.reply(session.id, 'done')
  }
  return replies
}

describe('OpenCode on its server API', () => {
  it('holds every mode but Auto (no auto mode of its own): Ask, Auto-accept edits and Full access are offered', ({ expect }) => {
    const caps = opencodeDriver().caps({ home: 'default' })
    expect(caps.toolControl).toBe('approval_only')
    expect(supportedPermissionModes(caps)).toEqual(['ask', 'accept_edits', 'full'])
    expect(opencodeDriver().oneShotRoute).toBeDefined()
  })

  it.each([
    ['ask', 'edit', 'once', true],
    ['ask', 'edit', 'reject', true],
    ['accept_edits', 'edit', 'once', false],
    ['accept_edits', 'webfetch', 'once', true],
    ['full', 'webfetch', 'once', false]
  ] as const)('in %s, a %s ask is answered %s (person asked: %s), before the tool runs', async (mode, action, pick, personAsked) => {
    const { fake, runtime, project } = await setup()
    const replies = asksAbout(fake, action)
    const person = prompter(pick)
    const { result, tools } = await turn(runtime, project, { mode, prompter: person.value })
    expect(result.text).toBe('done')
    expect(person.asked.length).toBe(personAsked ? 1 : 0)
    if (personAsked) expect(person.asked[0]!.options.map((option) => option.kind)).toEqual(['allow_once', 'reject_once'])
    // Answered once, and never "always", which OpenCode would save for the whole project.
    expect(replies).toEqual([{ requestId: 'per_1', body: expect.objectContaining({ decision: pick }) }])
    expect(tools.filter((event) => event.phase === 'complete').map((event) => event.callId)).toEqual(['call_1'])
  })

  it('a turn nobody may be asked in (approvals never) rejects every ask', async () => {
    const { fake, runtime, project } = await setup()
    const replies = asksAbout(fake, 'edit')
    await turn(runtime, project, { mode: 'ask', prompter: { approvals: 'never', choose: async () => 'once' } })
    expect(replies.map((reply) => reply.body.decision)).toEqual(['reject'])
  })

  it('a failure while asking counts as a reject', async () => {
    const { fake, runtime, project } = await setup()
    const replies = asksAbout(fake, 'edit')
    await turn(runtime, project, { mode: 'ask', prompter: { choose: async () => { throw new Error('the question service failed') } } })
    expect(replies.map((reply) => reply.body.decision)).toEqual(['reject'])
  })

  it('an allow OpenCode does not take is sent again as a reject, and the turn goes on', async () => {
    const { fake, runtime, project } = await setup()
    const replies = asksAbout(fake, 'edit')
    fake.replyFails = (decision) => decision === 'once'
    const { result } = await turn(runtime, project, { mode: 'ask', prompter: prompter('once').value })
    expect(result.text).toBe('done')
    expect(fake.calls.filter((call) => call.path.endsWith('/reply')).map((call) => call.body?.decision)).toEqual(['once', 'reject'])
    expect(replies.map((reply) => reply.body.decision)).toEqual(['reject'])
  })

  it.each(['once', 'reject'] as const)('when OpenCode cannot be told the answer (%s) at all, its run is interrupted and the turn fails instead of waiting', async (pick) => {
    const { fake, runtime, project } = await setup()
    asksAbout(fake, 'edit')
    fake.replyFails = () => true
    // The fake ends the run only when an answer arrives: only the failed answer can end this turn.
    await expect(turn(runtime, project, { mode: 'ask', prompter: prompter(pick).value })).rejects.toThrow(/could not answer its permission request/)
    await vi.waitFor(() => expect(fake.calls.some((call) => call.path.endsWith('/interrupt'))).toBe(true))
  })

  it('an error while choosing, with a reject OpenCode cannot take either, fails the turn instead of waiting', async () => {
    const { fake, runtime, project } = await setup()
    asksAbout(fake, 'edit')
    fake.replyFails = () => true
    await expect(turn(runtime, project, { mode: 'ask', prompter: { choose: async () => { throw new Error('the question service failed') } } })).rejects.toThrow(/could not answer its permission request/)
  })

  it.each([
    ['ask', 'ask', true],
    ['accept_edits', 'ask', true],
    ['full', 'allow', false]
  ] as const)('a session in %s starts from “%s everything”; the shell is offered: %s', async (mode, effect, shell) => {
    const { fake, runtime, project } = await setup()
    await turn(runtime, project, { mode })
    const [session] = fake.sessions.values()
    const rules = session!.permissions as Array<{ action: string; resource: string; effect: string }>
    expect(rules[0]).toEqual({ action: '*', resource: '*', effect })
    const shellRule = rules.findLast((rule) => rule.action === 'shell' || rule.action === '*')
    expect(shellRule!.effect !== 'deny').toBe(!shell)
    // Another thread's Mousse server is never usable, whatever the mode.
    expect(rules.findLast((rule) => rule.action === 'mousse_*' || rule.action === '*')).toMatchObject({ action: 'mousse_*', effect: 'deny' })
    expect(session!.body.model).toEqual({ providerID: 'anthropic', id: 'claude-haiku-5-5' })
  })

  it('a plugin of the user’s refuses a turn that must ask, before any session or prompt; Full access still runs', async () => {
    const { fake, runtime, project } = await setup()
    fake.plugins = [...fake.plugins, { id: 'my-plugin', source: { type: 'package', target: 'my-plugin' } }]
    await expect(turn(runtime, project, { mode: 'ask' })).rejects.toMatchObject({ code: 'permission_mode_unenforceable', message: expect.stringMatching(/loads plugins \(my-plugin\)/) })
    expect(fake.calls.filter((call) => call.method === 'POST')).toEqual([])
    const { result } = await turn(runtime, project, { mode: 'full' })
    expect(result.text).toBe('ok')
  })

  it('a server still loading its plugins (it lists none yet) is asked again, so a plugin of the user’s is not missed', async () => {
    const { fake, runtime, project } = await setup()
    fake.pluginsLoadingFor = 3
    fake.plugins = [...fake.plugins, { id: 'my-plugin', source: { type: 'local', path: '/plugins/my-plugin' } }]
    await expect(turn(runtime, project, { mode: 'ask' })).rejects.toMatchObject({ code: 'permission_mode_unenforceable' })
    expect(fake.calls.filter((call) => call.path === '/api/plugin').length).toBe(4)
  })

  it('a saved “always” grant in the session’s project refuses a turn that must ask before its prompt, and the new session goes; one in another project does not', async () => {
    const { fake, runtime, project } = await setup()
    fake.saved = [{ id: 'psv_1', projectID: 'prj_fake', action: 'shell', resource: 'npm *' }]
    await expect(turn(runtime, project, { mode: 'accept_edits' })).rejects.toMatchObject({ code: 'permission_mode_unenforceable', message: expect.stringMatching(/saved "always" permissions for this project \(shell\)/) })
    expect(fake.calls.some((call) => call.path.endsWith('/prompt'))).toBe(false)
    expect([...fake.sessions.values()].every((session) => session.deleted)).toBe(true)
    fake.saved = [{ id: 'psv_2', projectID: 'prj_other', action: 'shell', resource: '*' }]
    const { result } = await turn(runtime, project, { mode: 'ask' })
    expect(result.text).toBe('ok')
  })

  it('resumes the thread’s session while its history matches, with the new mode’s rules; a changed history starts a new one', async () => {
    const { fake, runtime, project } = await setup()
    const first = await turn(runtime, project, { mode: 'full' })
    await turn(runtime, project, { mode: 'ask', history: first.committed })
    expect(fake.sessions.size).toBe(1)
    const [session] = fake.sessions.values()
    expect((session!.permissions as Array<{ effect: string }>)[0]!.effect).toBe('ask')
    // The first turn handed no history; the resumed one sends only its request.
    const prompts = fake.calls.filter((call) => call.path.endsWith('/prompt')).map((call) => String(call.body?.text))
    expect(prompts[1]).not.toMatch(/Previous conversation/)
    await turn(runtime, project, { mode: 'ask', history: 'something else' })
    expect(fake.sessions.size).toBe(2)
    expect(String(fake.calls.filter((call) => call.path.endsWith('/prompt')).at(-1)!.body?.text)).toMatch(/Previous conversation[\s\S]*something else/)
  })

  it('resumes a session the entry saved while it ran OpenCode over ACP', async () => {
    const history = 'earlier'
    const { createHash } = await import('node:crypto')
    const fixture = await setup()
    const project = fixture.project
    await fixture.runtime.stop()
    await fixture.fake.close()
    const { fake, runtime } = await setup({
      stateFiles: { 'acp.json': { sessions: { t1: { sessionId: 'ses_from_acp', cwd: project, historyKey: createHash('sha256').update(history).digest('hex'), instanceId: 'opencode:opencode' } } } }
    })
    fake.sessions.set('ses_from_acp', { id: 'ses_from_acp', body: {}, permissions: undefined })
    await turn(runtime, project, { mode: 'ask', history })
    expect(fake.calls.some((call) => call.method === 'POST' && call.path === '/api/session')).toBe(false)
    expect(fake.calls.some((call) => call.path === '/api/session/ses_from_acp/prompt')).toBe(true)
    // Its rules are this mode's, whatever ACP left on it.
    expect((fake.sessions.get('ses_from_acp')!.permissions as Array<{ effect: string }>)[0]!.effect).toBe('ask')
  })

  it('Stop interrupts the run on the server and ends the turn', async () => {
    const { fake, runtime, project } = await setup()
    const stop = new AbortController()
    fake.onPrompt = (session) => {
      fake.emit('session.execution.started', { sessionID: session.id })
      fake.emit('session.text.delta', { sessionID: session.id, assistantMessageID: 'm', ordinal: 0, delta: 'work' })
      setTimeout(() => stop.abort(), 20)
    }
    const { result } = await turn(runtime, project, { mode: 'full', signal: stop.signal })
    expect(result.aborted).toBe(true)
    expect(fake.calls.some((call) => call.path.endsWith('/interrupt'))).toBe(true)
  })

  it('a usage limit reads as one', async () => {
    const { fake, runtime, project } = await setup()
    fake.onPrompt = (session) => fake.emit('session.execution.failed', { sessionID: session.id, error: { type: 'provider.rate-limit', message: 'Too many requests', status: 429 } })
    await expect(turn(runtime, project, { mode: 'full' })).rejects.toMatchObject({ code: 'rate_limited' })
  })
})

describe('the server', () => {
  it('a turn stopped before the server is ready does not leave it running: it closes once idle', async () => {
    const fake = await fakeOpencodeServer()
    let ready: () => void = () => {}
    let closed = false
    const server = new OpencodeServer({
      label: 'OpenCode',
      env: () => instanceEnv({ instanceId: 'opencode:opencode', driver: 'opencode', configRevision: 0, searchPath: [], base: { PATH: '' } }),
      launch: () => ({ command: 'opencode', args: [], env: {}, cwd: '.' }),
      // Ready only when the test says so.
      start: async (launch, signal) => {
        await new Promise<void>((resolve) => { ready = resolve })
        const started = await fake.start(launch, signal)
        return { ...started, close: () => { closed = true; started.close() } }
      },
      idleMs: 50,
      onEvent: () => {}
    })
    cleanups.push(async () => { server.stop(); await fake.close() })
    const release = server.hold()
    const stop = new AbortController()
    const waiting = server.client(stop.signal)
    stop.abort(new Error('stopped'))
    await expect(waiting).rejects.toThrow('stopped')
    release()
    ready()
    await vi.waitFor(() => expect(server.running()).toBe(true))
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 2_000 })
    expect(server.running()).toBe(false)
  })
})

describe('OpenCode one-shots', () => {
  const spec = (model: string) => ({ model, system: 'You name chats.', prompt: 'fix the login bug', onActivity: () => {} })

  it('one prompt in a scratch session that denies every tool; the session and its folder are gone afterwards', async () => {
    const { fake, runtime, stateDir } = await setup()
    fake.onPrompt = (session) => fake.reply(session.id, 'Fix login bug')
    expect(await runtime.oneShot!(spec('anthropic/claude-haiku-5-5'), new AbortController().signal)).toEqual({ text: 'Fix login bug' })
    const [session] = fake.sessions.values()
    expect(session!.permissions).toEqual([{ action: '*', resource: '*', effect: 'deny' }])
    // A title of its own, so OpenCode makes no title request of its own.
    expect(session!.body.title).toBeTruthy()
    expect(session!.deleted).toBe(true)
    expect(String(fake.calls.find((call) => call.path.endsWith('/prompt'))!.body?.text)).toBe('You name chats.\n\nfix the login bug')
    expect(existsSync(join(stateDir, 'one-shot')) ? readdirSync(join(stateDir, 'one-shot')) : []).toEqual([])
  })

  it('OpenCode’s own free models may read (they refuse a request with no tools), and nothing else', async () => {
    const { fake, runtime } = await setup()
    fake.onPrompt = (session) => fake.reply(session.id, 'Title')
    await runtime.oneShot!(spec('opencode/big-pickle'), new AbortController().signal)
    const [session] = fake.sessions.values()
    expect(session!.permissions).toEqual([{ action: '*', resource: '*', effect: 'deny' }, { action: 'read', resource: '*', effect: 'allow' }])
  })

  it('a read in a free model one-shot runs, in its empty scratch folder; any other tool ends the request', async () => {
    const { fake, runtime } = await setup()
    fake.onPrompt = (session) => {
      fake.emit('session.tool.input.started', { sessionID: session.id, assistantMessageID: 'm', id: 'r1', name: 'read' })
      fake.emit('session.tool.called', { sessionID: session.id, assistantMessageID: 'm', id: 'r1', name: 'read', input: { path: 'x' } })
      fake.reply(session.id, 'Title')
    }
    expect(await runtime.oneShot!(spec('opencode/big-pickle'), new AbortController().signal)).toEqual({ text: 'Title' })
    const first = [...fake.sessions.values()][0]!
    expect((first.body.location as { directory: string }).directory).toMatch(/one-shot/)
    fake.onPrompt = (session) => fake.emit('session.tool.input.started', { sessionID: session.id, assistantMessageID: 'm', id: 'w1', name: 'write' })
    await expect(runtime.oneShot!(spec('opencode/big-pickle'), new AbortController().signal)).rejects.toMatchObject({ code: 'policy_unenforceable' })
  })

  it('an ask in a one-shot that OpenCode cannot be told to refuse ends the request', async () => {
    const { fake, runtime } = await setup()
    fake.replyFails = () => true
    fake.onPrompt = (session) => fake.emit('permission.asked', { id: 'per_9', sessionID: session.id, action: 'read', resources: ['x'] })
    await expect(runtime.oneShot!(spec('opencode/big-pickle'), new AbortController().signal)).rejects.toMatchObject({ code: 'policy_unenforceable' })
  })

  it.each([
    ['a tool call', (fake: FakeOpencode, id: string) => fake.emit('session.tool.input.started', { sessionID: id, assistantMessageID: 'm', id: 'c', name: 'shell' }), { code: 'policy_unenforceable' }],
    ['a retry OpenCode schedules', (fake: FakeOpencode, id: string) => fake.emit('session.retry.scheduled', { sessionID: id, assistantMessageID: 'm', attempt: 1, at: Date.now() + 2_000, error: { type: 'provider.rate-limit', message: 'slow down' } }), { code: 'rate_limited' }]
  ])('%s ends the request at once: one model request, nothing run', async (_name, happen, error) => {
    const { fake, runtime } = await setup()
    fake.onPrompt = (session) => happen(fake, session.id)
    await expect(runtime.oneShot!(spec('anthropic/claude-haiku-5-5'), new AbortController().signal)).rejects.toMatchObject(error)
    expect(fake.calls.some((call) => call.path.endsWith('/interrupt'))).toBe(true)
    expect([...fake.sessions.values()][0]!.deleted).toBe(true)
  })
})
