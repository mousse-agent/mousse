import { describe, expect, it } from 'vitest'
import type { StreamingLlmToolEvent } from '../../src/mms/harness/turnEvents'
import type { AppToolTurn } from '../../src/mms/run/mcp/appTools/types'
import {
  attributeCall,
  callMetaIds,
  delegableTurn,
  hostingTurn,
  NativeHelperRouter,
  nativeMirrorThreadId,
  nativeSessionEpoch
} from '../../src/mms/run/nativeHelpers'
import { NativeMirrorThreads, type NativeMirrorHost } from '../../src/mms/orchestrator/nativeMirrorThreads'
import type { Thread, ThreadNativeHelper } from '../../src/shared/types'

/** A tool event as the turn sink gets it (`runtimeToolEvent` puts the tool name in `activity`). */
const ev = (phase: StreamingLlmToolEvent['phase'], callId: string, extra: Partial<StreamingLlmToolEvent> = {}): StreamingLlmToolEvent => ({
  kind: 'mcp_tool_call',
  phase,
  callId,
  title: 'x',
  summary: 'x',
  details: [],
  ...extra
})

// Codex: a helper's row (`helperStart`/`helperEnd` in codexActivity) and the helper's own calls under it.
const codexStart = (threadId: string, episode = '', summary?: string) =>
  ev('start', `helper:${threadId}${episode}`, { activity: { toolName: 'Agent', kind: 'subagent', nativeId: threadId, description: 'Check the tests', ...(summary ? { summary } : {}) } as never })
const codexEnd = (threadId: string, activity: Record<string, unknown>, episode = '') => ev('complete', `helper:${threadId}${episode}`, { activity: { toolName: 'Agent', ...activity } as never })

// Claude Code: the Agent call starts once from the stream and again once its arguments are in.
const agentStart = (id: string, activity: Record<string, unknown> = {}, parentCallId?: string) =>
  ev('start', id, { activity: { toolName: 'Agent', kind: 'subagent', ...activity } as never, ...(parentCallId ? { parentCallId } : {}) })

describe('mirror thread ids', () => {
  const base = { hostThreadId: 'host-1', instanceId: 'codex-main', sessionEpoch: 'codex:home:1', agentId: 'thr_abc-1' }

  it('end in the runtime agent id and are fixed by host, instance and session', () => {
    const id = nativeMirrorThreadId(base)!
    expect(id).toMatch(/^native-[0-9a-f]{12}-thr_abc-1$/)
    expect(nativeMirrorThreadId(base)).toBe(id)
    expect(nativeMirrorThreadId({ ...base, sessionEpoch: 'codex:home:2' })).not.toBe(id)
    expect(nativeMirrorThreadId({ ...base, instanceId: 'codex-other' })).not.toBe(id)
    expect(nativeMirrorThreadId({ ...base, hostThreadId: 'host-2' })).not.toBe(id)
  })

  it('are not made for an agent id that cannot end a thread id', () => {
    for (const agentId of ['', '../up', 'a b', 'x'.repeat(129)]) expect(nativeMirrorThreadId({ ...base, agentId })).toBeUndefined()
  })

  it('take a new session from a new driver, home or account', () => {
    expect(nativeSessionEpoch({ driver: 'codex', homeId: 'h', accountGeneration: 3 })).toBe('codex:h:3')
  })
})

describe('routing a Codex run\'s tool events', () => {
  it('a helper row opens a helper, its calls go to its own log, and its end says how it ended', () => {
    const router = new NativeHelperRouter('codex')
    expect(router.route(ev('start', 'own-1'))).toEqual({ kind: 'host' })
    expect(router.route(codexStart('t1'))).toEqual({ kind: 'start', agentId: 't1', description: 'Check the tests' })
    const call = router.route(ev('start', 'c1', { parentCallId: 'helper:t1' }))
    // Directly under the helper's row: a top-level call in the helper's own log.
    expect(call).toMatchObject({ kind: 'call', agentId: 't1' })
    expect((call as { event: StreamingLlmToolEvent }).event.parentCallId).toBeUndefined()
    // Deeper calls keep their parent, which is in the helper's log too.
    expect(router.route(ev('start', 'c2', { parentCallId: 'c1' }))).toMatchObject({ kind: 'call', agentId: 't1', event: { parentCallId: 'c1' } })
    expect(router.route(ev('complete', 'c1'))).toMatchObject({ kind: 'call', agentId: 't1' })
    expect(router.openHelpers()).toEqual(['t1'])
    expect(router.route(codexEnd('t1', { status: 'done' }))).toEqual({ kind: 'end', agentId: 't1', state: 'done' })
    expect(router.openHelpers()).toEqual([])
    expect(router.ownerOf('own-1')).toBe('host')
    expect(router.ownerOf('c2')).toEqual({ agentId: 't1' })
  })

  it('reads a stop as stopped, a failure as failed, and any other close as unknown, never done', () => {
    const states = [
      [{ status: 'interrupted', interruptedBy: 'stop' }, 'stopped'],
      [{ status: 'failed' }, 'failed'],
      [{ status: 'interrupted', interruptedBy: 'lost' }, 'unknown']
    ] as const
    for (const [activity, state] of states) {
      const router = new NativeHelperRouter('codex')
      router.route(codexStart('t1'))
      expect(router.route(codexEnd('t1', activity))).toMatchObject({ kind: 'end', state })
    }
  })

  it('more work for a helper is a new episode of the same helper; a Mousse subagent call is never a helper', () => {
    const router = new NativeHelperRouter('codex')
    router.route(codexStart('t1'))
    router.route(codexEnd('t1', { status: 'done' }))
    expect(router.route(codexStart('t1', '#2', 'More work'))).toMatchObject({ kind: 'start', agentId: 't1' })
    expect(router.route(ev('start', 'mcp-1', { activity: { kind: 'subagent', toolName: 'mcp__mousse__delegate_task' } as never }))).toEqual({ kind: 'host' })
  })

  it('a run that ends with a helper open leaves it to be marked unknown', () => {
    const router = new NativeHelperRouter('codex')
    router.route(codexStart('t1'))
    expect(router.endRun()).toEqual(['t1'])
    expect(router.openHelpers()).toEqual([])
  })
})

describe('routing a Claude Code run\'s tool events', () => {
  it('the second start of an Agent call describes the helper, its frames are its calls, and its result names the id to write to', () => {
    const router = new NativeHelperRouter('claude')
    expect(router.route(agentStart('toolu_A'))).toEqual({ kind: 'start', agentId: 'toolu_A' })
    expect(router.route(agentStart('toolu_A', { description: 'Review the diff', agentType: 'reviewer' }))).toEqual({
      kind: 'describe', agentId: 'toolu_A', description: 'Review the diff', agentType: 'reviewer'
    })
    expect(router.route(ev('start', 'toolu_B', { parentCallId: 'toolu_A', activity: { toolName: 'Read' } as never }))).toMatchObject({ kind: 'call', agentId: 'toolu_A' })
    expect(router.route(ev('complete', 'toolu_A', { activity: { kind: 'subagent', nativeId: 'agent-7', status: 'done', summary: 'All good' } as never }))).toEqual({
      kind: 'end', agentId: 'toolu_A', state: 'done', summary: 'All good', sendTo: 'agent-7'
    })
  })

  it('a background launch keeps the helper open; Mousse\'s own delegate tool is not a helper', () => {
    const router = new NativeHelperRouter('claude')
    router.route(agentStart('toolu_A', { background: true }))
    expect(router.route(ev('complete', 'toolu_A', { activity: { kind: 'subagent', background: true, nativeId: 'agent-7' } as never }))).toEqual({ kind: 'host' })
    expect(router.openHelpers()).toEqual(['toolu_A'])
    expect(router.route(ev('start', 'toolu_M', { activity: { kind: 'subagent', toolName: 'mcp__mousse__delegate_task' } as never }))).toEqual({ kind: 'host' })
  })

  it('a helper a helper starts is its own helper, under the outer one, and a call in the outer one\'s log', () => {
    const router = new NativeHelperRouter('claude')
    router.route(agentStart('toolu_A'))
    expect(router.route(agentStart('toolu_N', {}, 'toolu_A'))).toEqual({ kind: 'start', agentId: 'toolu_N', parentAgentId: 'toolu_A' })
    expect(router.route(ev('start', 'toolu_X', { parentCallId: 'toolu_N' }))).toMatchObject({ kind: 'call', agentId: 'toolu_N' })
  })
})

describe('who made a Mousse tool call', () => {
  it('reads Claude Code\'s tool-use id and Codex\'s turn metadata, as an object or a JSON string', () => {
    expect(callMetaIds({ 'claudecode/toolUseId': 'toolu_1' })).toEqual({ toolUseId: 'toolu_1' })
    expect(callMetaIds({ 'x-codex-turn-metadata': { threadId: 't1' } })).toEqual({ codexThreadId: 't1' })
    expect(callMetaIds({ 'x-codex-turn-metadata': JSON.stringify({ thread_id: 't1' }) })).toEqual({ codexThreadId: 't1' })
    expect(callMetaIds({ 'x-codex-turn-metadata': '{not json' })).toEqual({})
    expect(callMetaIds(undefined)).toEqual({})
  })

  it('a thread with no helper: every call is the run\'s', async () => {
    expect(await attributeCall(undefined, {})).toEqual({ kind: 'host' })
    expect(await attributeCall(new NativeHelperRouter('claude'), { toolUseId: 'toolu_x' }, 5)).toEqual({ kind: 'host' })
  })

  it('Claude Code: the run\'s own call is the run\'s, a helper\'s is the helper\'s, and one the stream never reports is unattributed', async () => {
    const router = new NativeHelperRouter('claude')
    router.route(agentStart('toolu_A'))
    router.route(ev('start', 'toolu_own'))
    router.route(ev('start', 'toolu_h', { parentCallId: 'toolu_A' }))
    expect(await attributeCall(router, { toolUseId: 'toolu_own' }, 5)).toEqual({ kind: 'host' })
    expect(await attributeCall(router, { toolUseId: 'toolu_h' }, 5)).toEqual({ kind: 'helper', agentId: 'toolu_A' })
    expect(await attributeCall(router, { toolUseId: 'toolu_never' }, 5)).toEqual({ kind: 'unattributed' })
    expect(await attributeCall(router, {}, 5)).toEqual({ kind: 'unattributed' })
  })

  it('Claude Code: a call that reaches Mousse before the stream reports it waits for the stream', async () => {
    const router = new NativeHelperRouter('claude')
    router.route(agentStart('toolu_A'))
    const pending = attributeCall(router, { toolUseId: 'toolu_late' }, 1000)
    router.route(ev('start', 'toolu_late', { parentCallId: 'toolu_A' }))
    expect(await pending).toEqual({ kind: 'helper', agentId: 'toolu_A' })
  })

  it('Codex: a thread id naming a helper ties the call to it; any other id only counts while no helper is open', async () => {
    const router = new NativeHelperRouter('codex')
    router.route(codexStart('t1'))
    expect(await attributeCall(router, { codexThreadId: 't1' })).toEqual({ kind: 'helper', agentId: 't1' })
    // The run's own Codex thread is not known here, so an id that names no helper proves nothing.
    expect(await attributeCall(router, { codexThreadId: 'parent' })).toEqual({ kind: 'unattributed' })
    // A Claude Code id on a Codex run is not read.
    expect(await attributeCall(router, { toolUseId: 'helper:t1' })).toEqual({ kind: 'unattributed' })
    router.route(codexEnd('t1', { status: 'done' }))
    expect(await attributeCall(router, {})).toEqual({ kind: 'host' })
  })
})

describe('the authority a helper\'s call holds', () => {
  it('is the run\'s delegable authority: a subagent\'s turn without the run\'s applets, the same view each time', () => {
    const live = { threadId: 'host-1', runId: 'r1', onPublishApplet: () => undefined } as unknown as AppToolTurn
    const view = delegableTurn(live)
    expect(view.subagent).toBe(true)
    expect(view.threadId).toBe('host-1')
    expect('onPublishApplet' in view).toBe(false)
    expect(delegableTurn(live)).toBe(view)
    expect(hostingTurn(view)).toBe(live)
    expect(hostingTurn(live)).toBe(live)
  })
})

describe('mirror threads', () => {
  const HOST: Thread = { id: 'host-1', name: 'Fix login', projectId: 'p1', createdAt: '', updatedAt: '', messages: [] } as unknown as Thread
  const run = { hostThreadId: 'host-1', runId: 'run-1', instanceId: 'codex-main', sessionEpoch: 'codex:h:1', driver: 'codex' }

  const fakeHost = () => {
    const threads = new Map<string, Thread>([[HOST.id, HOST]])
    const log: Array<[string, string, unknown]> = []
    const host: NativeMirrorHost = {
      thread: (id) => threads.get(id),
      createMirror: ({ id, name, lineage, owner, native }) => {
        if (threads.has(id)) throw new Error('taken')
        threads.set(id, { id, name, projectId: 'p1', lineage, ownerThreadId: owner, native } as unknown as Thread)
      },
      updateNative: (id, native) => { threads.set(id, { ...threads.get(id)!, native }) },
      rename: (id, name) => { threads.set(id, { ...threads.get(id)!, name }) },
      writeTool: (id, event) => log.push([id, 'tool', event.callId]),
      writeNote: (id, text) => log.push([id, 'note', text]),
      closeOpenCalls: (id) => log.push([id, 'close', null])
    }
    return { threads, log, mirrors: new NativeMirrorThreads(host) }
  }
  const nativeOf = (threads: Map<string, Thread>, id: string) => threads.get(id)!.native as ThreadNativeHelper

  it('a Codex helper gets a native thread under the host, its calls land there, and its end sets its state', () => {
    const { threads, log, mirrors } = fakeHost()
    const mirrored = mirrors.beginRun(run)!
    mirrored.tool(ev('start', 'own-1'))
    mirrored.tool(codexStart('t1'))
    const id = nativeMirrorThreadId({ ...run, agentId: 't1' })!
    expect(threads.get(id)).toMatchObject({
      name: 'Check the tests',
      ownerThreadId: 'host-1',
      lineage: { parentThreadId: 'host-1', rootThreadId: 'host-1', relationship: 'native' },
      native: { runtime: 'codex', instanceId: 'codex-main', sessionEpoch: 'codex:h:1', agentId: 't1', hostRunId: 'run-1', state: 'running' }
    })
    mirrored.tool(ev('start', 'c1', { parentCallId: 'helper:t1' }))
    mirrored.tool(codexEnd('t1', { status: 'interrupted', interruptedBy: 'stop' }))
    expect(nativeOf(threads, id).state).toBe('stopped')
    // Only the helper's own call and its notes: the host's call never reaches the mirror.
    expect(log.map(([thread, kind, value]) => [thread === id, kind, kind === 'note' ? String(value).split('\n')[0] : value])).toEqual([
      [true, 'note', 'Codex started this helper in "Fix login".'],
      [true, 'tool', 'c1'],
      [true, 'close', null],
      [true, 'note', 'The helper was stopped.']
    ])
  })

  it('a run that ends with the helper open leaves it unknown; more work later reopens the same thread', () => {
    const { threads, mirrors } = fakeHost()
    const first = mirrors.beginRun(run)!
    first.tool(codexStart('t1'))
    first.end()
    const id = nativeMirrorThreadId({ ...run, agentId: 't1' })!
    expect(nativeOf(threads, id).state).toBe('unknown')
    const second = mirrors.beginRun({ ...run, runId: 'run-2' })!
    second.tool(codexStart('t1', '#2', 'More work'))
    expect(nativeOf(threads, id)).toMatchObject({ state: 'running', hostRunId: 'run-2' })
    expect(nativeOf(threads, id).partial).toBeUndefined()
  })

  it('a helper first seen on more work says its log starts there', () => {
    const { threads, log, mirrors } = fakeHost()
    mirrors.beginRun(run)!.tool(codexStart('t9', '#3', 'More work'))
    const id = nativeMirrorThreadId({ ...run, agentId: 't9' })!
    expect(nativeOf(threads, id).partial).toBe(true)
    expect(String(log[0]![2])).toContain('Its earlier work was not followed')
  })

  it('Claude Code: the helper is named once its arguments are in, and a nested helper sits under its parent mirror', async () => {
    const { threads, mirrors } = fakeHost()
    const mirrored = mirrors.beginRun({ ...run, driver: 'claude', instanceId: 'claude-main', sessionEpoch: 'claude:h:1' })!
    const claudeRun = { ...run, instanceId: 'claude-main', sessionEpoch: 'claude:h:1' }
    mirrored.tool(agentStart('toolu_A'))
    const outer = nativeMirrorThreadId({ ...claudeRun, agentId: 'toolu_A' })!
    expect(threads.get(outer)!.name).toBe('Helper')
    mirrored.tool(agentStart('toolu_A', { description: 'Review the diff' }))
    expect(threads.get(outer)!.name).toBe('Review the diff')
    mirrored.tool(agentStart('toolu_N', { description: 'Read one file' }, 'toolu_A'))
    const inner = nativeMirrorThreadId({ ...claudeRun, agentId: 'toolu_N' })!
    expect(threads.get(inner)).toMatchObject({ ownerThreadId: outer, lineage: { parentThreadId: outer, rootThreadId: 'host-1', relationship: 'native' } })
    // A call the helper made is attributed to it, and to its mirror.
    mirrored.tool(ev('start', 'toolu_X', { parentCallId: 'toolu_A' }))
    expect(await mirrors.attribute('host-1', { 'claudecode/toolUseId': 'toolu_X' })).toEqual({ kind: 'helper', agentId: 'toolu_A', mirrorThreadId: outer })
  })

  it('a driver whose helpers are not mirrored is not followed', () => {
    expect(fakeHost().mirrors.beginRun({ ...run, driver: 'acp' })).toBeUndefined()
  })
})
