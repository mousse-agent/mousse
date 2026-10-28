/**
 * Issue #172: Codex's thread items become typed activity items. The item readers are checked on their
 * own; a hand-authored app-server stream (`run/fixtures/activity/codex.ndjson`, item shapes from the
 * codex-cli 0.162.1 schema) runs through the adapter and a real `TranscriptAssembler`; and a scripted
 * app-server drives the cases a recording cannot: Stop, helpers that settle or never do, large output.
 * Codex has one way to run a turn, so there is no one-shot/live pair to compare.
 */
import { EventEmitter } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'
import type { CodexLaunch, CodexProcess } from '../src/mms/harness/vendors/codex/CodexAppServerClient'
import { CODEX_MODEL_PROVIDER, CodexProviderService, type CodexChatInput } from '../src/mms/harness/vendors/codex/CodexProviderService'
import { codexToolEvent, editedLines, helperNote, planSteps } from '../src/mms/harness/vendors/codex/codexActivity'
import type { ThreadItem } from '../src/mms/harness/vendors/codex/protocol'
import { CodexAdapter } from '../src/mms/harness/drivers/codex/adapter'
import { createCodexProviderService, type CodexProviderService as AdapterService } from '../src/mms/harness/vendors/codex/CodexProviderService'
import type { AdapterHost, TurnControl, TurnInput, TurnSink } from '../src/mms/harness/adapter'
import { CODEX_APP_SERVER_BOUNDARY, replayCodexAppServer } from '../src/mms/run/testkit/codexAppServerReplay'
import { ReplayTransport, parseTranscript } from '../src/mms/run/testkit/ReplayTransport'
import { TranscriptAssembler, type TranscriptStreamState } from '../src/mms/run/transcript/TranscriptAssembler'
import { runtimeToolEvent } from '../src/mms/run/transcript/promptRuntime'
import { ACTIVITY_DIFF_CAP_BYTES, diffSides, ACTIVITY_OUTPUT_CAP_BYTES, type AgentActivityItem, type ProviderToolEvent } from '../src/shared/agentActivity'
import type { ChatMessage } from '../src/shared/types'
import type { StreamingLlmToolEvent } from '../src/mms/harness/turnEvents'

const item = (value: Record<string, unknown>): ThreadItem => value as unknown as ThreadItem
const eventOf = (value: Record<string, unknown>, phase: 'start' | 'complete') => codexToolEvent(item(value), phase)!

// ---------------------------------------------------------------------------------------------
// The item readers
// ---------------------------------------------------------------------------------------------

describe('codexToolEvent: commands', () => {
  const command = { type: 'commandExecution', id: 'c1', command: "bash -lc 'npm test'", cwd: '/w', processId: '77' }

  it('start says what the command is; completion says how it went, and the exit code never decides the status', () => {
    expect(eventOf({ ...command, status: 'inProgress' }, 'start').activity).toEqual({ kind: 'command', command: "bash -lc 'npm test'", cwd: '/w', nativeId: '77' })
    const done = eventOf({ ...command, status: 'completed', aggregatedOutput: 'out\n', exitCode: 1, durationMs: 90 }, 'complete')
    expect(done.activity).toEqual({ kind: 'command', cwd: '/w', nativeId: '77', output: 'out\n', exitCode: 1, durationMs: 90, status: 'done' })
    expect(eventOf({ ...command, status: 'failed', exitCode: 2 }, 'complete').activity).toMatchObject({ status: 'failed', exitCode: 2 })
    expect(eventOf({ ...command, status: 'declined' }, 'complete').activity).toMatchObject({ status: 'failed', summary: 'Declined' })
  })

  it('a completion without output leaves what was streamed alone', () => {
    const activity = eventOf({ ...command, status: 'completed', aggregatedOutput: null, exitCode: 0 }, 'complete').activity!
    expect(activity).not.toHaveProperty('output')
    expect(activity).not.toHaveProperty('command')
  })
})

describe('codexToolEvent: patches', () => {
  const patch = (changes: unknown[], status = 'completed') => ({ type: 'fileChange', id: 'p1', changes, status })

  it('keeps every file with its own diff and counts, and names an added file by its text', () => {
    const event = eventOf(
      patch([
        { path: 'a.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1,2 +1,2 @@\n-old\n+new\n keep\n' },
        { path: 'b.ts', kind: { type: 'add' }, diff: 'one\ntwo\nthree\n' },
        { path: 'c.ts', kind: { type: 'delete' }, diff: 'gone\n' },
        { path: 'd.ts', kind: { type: 'update', move_path: 'e.ts' }, diff: '@@ -1 +1 @@\n-x\n+y\n' }
      ]),
      'complete'
    )
    expect(event.title).toBe('Edit a.ts, b.ts, c.ts and 1 more')
    const { changes } = event.activity as { changes: Array<Record<string, unknown>> }
    expect(changes.map((change) => [change.path, change.change, change.added, change.removed])).toEqual([
      ['a.ts', 'update', 1, 1],
      ['b.ts', 'add', 3, 0],
      ['c.ts', 'delete', 0, 1],
      ['d.ts', 'move', 1, 1]
    ])
    expect(changes[3]).toMatchObject({ movePath: 'e.ts' })
    expect(changes[1]!.diff).toBe('one\ntwo\nthree\n')
    expect(event.activity).toMatchObject({ status: 'done' })
  })

  it('a declined or failed patch is failed', () => {
    expect(eventOf(patch([], 'declined'), 'complete').activity).toMatchObject({ status: 'failed', summary: 'Declined' })
    expect(eventOf(patch([], 'failed'), 'complete').activity).toMatchObject({ status: 'failed' })
  })

  it('holds a huge patch to a per-file and a per-patch bound while the counts stay real', () => {
    const big = (name: string) => ({ path: name, kind: { type: 'update', move_path: null }, diff: `@@ -1,500 +1,500 @@\n${'+added line of text\n'.repeat(3000)}` })
    const files = Array.from({ length: 10 }, (_, index) => big(`f${index}.ts`))
    const { changes } = eventOf(patch(files), 'complete').activity as { changes: Array<{ diff?: string; diffTruncated?: boolean; added?: number }> }
    expect(changes).toHaveLength(10)
    for (const change of changes) {
      expect(Buffer.byteLength(change.diff ?? '')).toBeLessThanOrEqual(ACTIVITY_DIFF_CAP_BYTES)
      expect(change.diffTruncated).toBe(true)
      expect(change.added).toBe(3000)
    }
    expect(changes.reduce((total, change) => total + Buffer.byteLength(change.diff ?? ''), 0)).toBeLessThanOrEqual(4 * ACTIVITY_DIFF_CAP_BYTES)
    expect(changes.slice(4).every((change) => change.diff === undefined)).toBe(true)
  })

  it('lists at most 200 files and says how many it left out', () => {
    const files = Array.from({ length: 250 }, (_, index) => ({ path: `f${index}`, kind: { type: 'add' }, diff: 'x\n' }))
    const activity = eventOf(patch(files), 'start').activity as { changes: unknown[]; summary?: string }
    expect(activity.changes).toHaveLength(200)
    expect(activity.summary).toBe('50 more files not listed')
  })

  it('counts the lines of a patch as the edit counter always did, for an added file by its lines', () => {
    expect(editedLines(item(patch([{ path: 'a', kind: { type: 'update' }, diff: '@@\n-old\n+new\n+more' }])))).toBe(3)
    expect(editedLines(item(patch([{ path: 'a', kind: { type: 'update' }, diff: '--- a\n+++ b\n@@\n-x\n+y' }])))).toBe(2)
    expect(editedLines(item(patch([{ path: 'a', kind: { type: 'add' }, diff: 'one\ntwo\n' }, { path: 'b', kind: { type: 'delete' }, diff: 'x\n' }])))).toBe(3)
    expect(editedLines(item({ type: 'fileChange', id: 'p' }))).toBe(0)
  })

  it('an added or deleted file is counted by its lines whatever its text holds, @@ included', () => {
    const ruby = 'class A\n  @@count = 0\n\n  def x; end\nend\n'
    const text = 'contact: foo@@bar\n\nlast\n'
    const counts = (kind: string, diff: string) => {
      const changes = [{ path: 'f.rb', kind: { type: kind }, diff }]
      const { changes: listed } = eventOf(patch(changes), 'complete').activity as { changes: Array<{ added: number; removed: number; diff?: string }> }
      return { added: listed[0]!.added, removed: listed[0]!.removed, diff: listed[0]!.diff, edited: editedLines(item(patch(changes))) }
    }
    expect(counts('add', ruby)).toMatchObject({ added: 5, removed: 0, diff: ruby, edited: 5 })
    expect(counts('delete', ruby)).toMatchObject({ added: 0, removed: 5, edited: 5 })
    expect(counts('add', text)).toMatchObject({ added: 3, removed: 0, edited: 3 })
    expect(counts('delete', text)).toMatchObject({ added: 0, removed: 3, edited: 3 })
    // A real hunk in an added file's payload is still read as one.
    expect(counts('add', '@@ -0,0 +1,2 @@\n+a\n+b\n')).toMatchObject({ added: 2, removed: 0 })
    expect(diffSides(ruby, 'add')).toEqual({ oldText: '', newText: ruby })
    expect(diffSides(text, 'delete')).toEqual({ oldText: text, newText: '' })
  })

  it('the title names a few files and a count, so a huge patch gives a small row', () => {
    const files = Array.from({ length: 10_000 }, (_, index) => ({ path: 'd/'.repeat(100) + 'f' + index + '.ts', kind: { type: 'add' }, diff: 'x\n' }))
    const event = eventOf(patch(files), 'start')
    expect(event.title.length).toBeLessThanOrEqual(200)
    expect(event.title.startsWith('Edit d/d/')).toBe(true)
    expect(eventOf(patch([{ path: 'a.ts', kind: { type: 'add' }, diff: 'x' }, { path: 'b.ts', kind: { type: 'add' }, diff: 'x' }]), 'start').title).toBe('Edit a.ts, b.ts')
    const harness = assembled()
    harness.feed([event, eventOf(patch(files), 'complete')])
    expect(JSON.stringify(harness.rows).length).toBeLessThan(100_000)
  })
})

describe('codexToolEvent: searches, tools and plans', () => {
  it('a web search takes its query from the item, the action or the page it opened', () => {
    const query = (extra: Record<string, unknown>) => (eventOf({ type: 'webSearch', id: 'w', ...extra }, 'complete').activity as { query: string }).query
    expect(query({ query: 'direct' })).toBe('direct')
    expect(query({ query: '', action: { type: 'search', query: 'from action' } })).toBe('from action')
    expect(query({ query: '', action: { type: 'search', queries: ['a', 'b'] } })).toBe('a b')
    expect(query({ action: { type: 'open_page', url: 'https://example.test' } })).toBe('https://example.test')
    expect(query({ query: '', action: null })).toBe('')
    expect(eventOf({ type: 'webSearch', id: 'w', query: 'q', results: [{ title: 'T', url: 'https://a.test' }, { nope: 1 }] }, 'complete').activity).toMatchObject({
      results: [{ title: 'T', url: 'https://a.test' }]
    })
  })

  it('an MCP call is generic with its server; a large argument list is cut and the completion keeps the kind', () => {
    const call = { type: 'mcpToolCall', id: 'm1', server: 'docs', tool: 'search', arguments: { blob: 'x'.repeat(100_000) } }
    const start = eventOf({ ...call, status: 'inProgress' }, 'start')
    expect(start.toolName).toBe('mcp__docs__search')
    expect(start.activity).toMatchObject({ kind: 'generic', server: 'docs', input: { truncated: true } })
    expect(JSON.stringify(start).length).toBeLessThan(20_000)
    const done = eventOf({ ...call, status: 'completed', result: { content: [{ type: 'text', text: 'found it' }] } }, 'complete')
    expect(done.activity).toEqual({ kind: 'generic', server: 'docs', output: 'found it', status: 'done' })
    expect(eventOf({ ...call, status: 'failed', error: { message: 'boom' } }, 'complete').activity).toMatchObject({ output: 'boom', status: 'failed' })
  })

  it('a Mousse delegation keeps only its bounded record, never the prompt', () => {
    const call = { type: 'mcpToolCall', id: 'm2', server: 'mousse', tool: 'delegate_task', arguments: { title: 'Review', prompt: 'SECRET PROMPT' } }
    const start = eventOf({ ...call, status: 'inProgress' }, 'start')
    expect(start.record).toMatchObject({ input: { title: 'Review' } })
    expect(start.activity).toBeUndefined()
    expect(JSON.stringify(start)).not.toContain('SECRET PROMPT')
    const done = eventOf({ ...call, status: 'completed', result: { content: [{ type: 'text', text: JSON.stringify({ delegationId: 'd1', note: 'LONG NOTE' }) }] } }, 'complete')
    expect(JSON.stringify(done)).not.toMatch(/SECRET PROMPT|LONG NOTE/)
  })

  it('dynamic tools and images are generic, a failed or unsuccessful dynamic call is failed', () => {
    expect(eventOf({ type: 'dynamicToolCall', id: 'd', tool: 'lookup', arguments: { a: 1 }, status: 'inProgress' }, 'start').activity).toEqual({ kind: 'generic', input: { a: 1 } })
    const done = eventOf({ type: 'dynamicToolCall', id: 'd', tool: 'lookup', status: 'completed', success: false, contentItems: [{ type: 'inputText', text: 'nope' }] }, 'complete')
    expect(done.activity).toEqual({ kind: 'generic', output: 'nope', status: 'failed' })
    expect(eventOf({ type: 'imageView', id: 'i', path: '/w/a.png' }, 'start').activity).toEqual({ kind: 'generic', input: { path: '/w/a.png' } })
  })

  it('a plan item carries its text, and a turn plan its steps (bounded)', () => {
    expect(eventOf({ type: 'plan', id: 'pl', text: '# Plan' }, 'complete').activity).toEqual({ kind: 'plan', text: '# Plan', status: 'done' })
    const steps = planSteps(Array.from({ length: 80 }, (_, index) => ({ step: `step ${index}`, status: 'pending' })).concat([{ step: '', status: 'pending' }]))
    expect(steps).toHaveLength(50)
    expect(planSteps([{ step: 'x'.repeat(1000), status: 'inProgress' }])[0]!.step.length).toBe(300)
    expect(planSteps('nope')).toEqual([])
  })

  it('items that are not tool calls give no event', () => {
    for (const type of ['agentMessage', 'reasoning', 'userMessage', 'collabAgentToolCall', 'subAgentActivity']) expect(codexToolEvent(item({ type, id: 'x' }), 'start')).toBeUndefined()
  })
})

describe('helperNote', () => {
  it('a spawn only launches; the end is reported separately, by the helper or by a later state', () => {
    expect(
      helperNote(item({ type: 'collabAgentToolCall', id: 's', tool: 'spawnAgent', receiverThreadIds: ['h1'], prompt: ` Check\n  the docs ${'x'.repeat(400)}`, model: 'gpt-x', agentsStates: { h1: { status: 'running' } } }))
    ).toMatchObject({ launched: [{ threadId: 'h1', agentType: 'gpt-x' }], ended: [] })
    const description = helperNote(item({ type: 'collabAgentToolCall', id: 's', tool: 'spawnAgent', receiverThreadIds: ['h1'], prompt: ` Check\n  the docs ${'x'.repeat(400)}` }))!.launched[0]!.description!
    expect(description.startsWith('Check the docs x')).toBe(true)
    expect(description.length).toBe(200)
    expect(helperNote(item({ type: 'subAgentActivity', id: 'a', kind: 'started', agentThreadId: 'h1' }))).toMatchObject({ launched: [{ threadId: 'h1' }], ended: [] })
    expect(helperNote(item({ type: 'subAgentActivity', id: 'a', kind: 'completed', agentThreadId: 'h1' }))).toEqual({ launched: [], ended: [{ threadId: 'h1', outcome: 'done' }] })
    expect(helperNote(item({ type: 'subAgentActivity', id: 'a', kind: 'interrupted', agentThreadId: 'h1' }))).toEqual({ launched: [], ended: [{ threadId: 'h1', outcome: 'interrupted' }] })
    const states = helperNote(
      item({ type: 'collabAgentToolCall', id: 'w', tool: 'wait', agentsStates: { a: { status: 'completed' }, b: { status: 'errored' }, c: { status: 'interrupted' }, d: { status: 'running' }, e: { status: 'pendingInit' } } })
    )
    expect(states?.ended).toEqual([
      { threadId: 'a', outcome: 'done' },
      { threadId: 'b', outcome: 'failed' },
      { threadId: 'c', outcome: 'interrupted' }
    ])
    expect(helperNote(item({ type: 'commandExecution', id: 'c' }))).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------------------------
// The saved rows
// ---------------------------------------------------------------------------------------------

/** The saved rows of a run of tool events, through a real assembler. */
function assembled() {
  const rows: ChatMessage[] = []
  const state: TranscriptStreamState = {
    activeAssistantMessageId: null,
    activeThinkingMessageId: null,
    activeToolCallMessageIds: new Map(),
    callToMessage: new Map()
  }
  const assembler = new TranscriptAssembler(
    {
      getMessage: (id) => rows.find((row) => row.id === id),
      addMessage: (row) => void rows.push(row),
      updateMessage: (row) => {
        const index = rows.findIndex((entry) => entry.id === row.id)
        if (index !== -1) rows[index] = row
      },
      removeMessage: () => undefined,
      emitAdded: () => undefined,
      emitUpdated: () => undefined,
      persist: () => undefined,
      setPhase: () => undefined
    },
    state
  )
  const byCall = (callId: string): AgentActivityItem => {
    const row = rows.find((entry) => entry.activity?.callId === callId)
    if (!row?.activity) throw new Error(`no item for ${callId}`)
    return row.activity
  }
  return { rows, assembler, byCall, feed: (events: ProviderToolEvent[]) => events.forEach((event) => assembler.tool(runtimeToolEvent(event))) }
}

const itemsOf = (rows: ChatMessage[]) => rows.flatMap((row) => (row.activity ? [row.activity] : []))

// ---------------------------------------------------------------------------------------------
// The recorded stream, through the adapter
// ---------------------------------------------------------------------------------------------

describe('the activity fixture through the Codex adapter', () => {
  let home: string
  const services: AdapterService[] = []
  const questions = new UserQuestionService()
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-codex-activity-'))
    mkdirSync(join(home, 'work'))
  })
  afterEach(() => {
    for (const service of services.splice(0)) service.stop()
    rmSync(home, { recursive: true, force: true })
  })

  async function replayFixture() {
    const transcript = parseTranscript(readFileSync(join(__dirname, 'run', 'fixtures', 'activity', 'codex.ndjson'), 'utf8'))
    const replay = new ReplayTransport(transcript, { stallMs: 2_000 })
    const binary = join(home, 'codex')
    writeFileSync(binary, '#!/bin/sh\nexit 0\n')
    chmodSync(binary, 0o755)
    mkdirSync(join(home, 'providers', 'codex'), { recursive: true })
    writeFileSync(join(home, 'providers', 'codex', 'settings.json'), JSON.stringify({ binaryPath: binary, models: [{ id: 'gpt-x', label: 'GPT X' }] }))
    const service = createCodexProviderService(home, questions, { launch: replayCodexAppServer(replay) }, { launch: () => ({ binaryPath: binary }) })
    services.push(service)
    const tools: StreamingLlmToolEvent[] = []
    const sink = new Proxy({}, { get: (_target, name) => (name === 'tool' ? (event: StreamingLlmToolEvent) => tools.push(event) : () => undefined) }) as TurnSink
    const input = {
      runId: 'run-1',
      attemptId: 'attempt-1',
      threadId: 'thread-1',
      cwd: join(home, 'work'),
      instanceId: 'codex',
      model: 'gpt-x',
      llmProvider: 'codex',
      modelPinned: true,
      mode: 'agent',
      prompt: 'Do the work',
      messages: [],
      signal: new AbortController().signal
    } as TurnInput
    const control: TurnControl = { drainSteer: () => undefined, heartbeat: () => undefined }
    const host = {
      tools: {},
      bridge: { mcp: null, turnToken: 'turn-1', sessionInstructions: '', turnPreamble: '', userMcp: 'native' },
      context: { recoverOverflow: () => null, prepareNativeContext: () => null, nativeHistoryAfterTurn: (reply: string) => `history+${reply}` }
    } as unknown as AdapterHost
    await new CodexAdapter(() => service).startTurn(input, sink, control, host)
    replay.assertDone()
    return tools
  }

  it('streams a command in order, keeps its non-zero exit code on a done row, and the patch shows both files', async () => {
    const tools = await replayFixture()
    const cmd = tools.filter((event) => event.callId === 'cmd-1')
    expect(cmd.map((event) => event.phase)).toEqual(['start', 'update', 'update', 'complete'])
    expect(cmd.filter((event) => event.phase === 'update').map((event) => event.activity?.output)).toEqual(['PASS a\n', 'FAIL b\n'])
    const harness = assembled()
    for (const event of tools) harness.assembler.tool(event)
    const command = harness.byCall('cmd-1')
    expect(command).toMatchObject({
      kind: 'command',
      command: "/bin/bash -lc 'npm test'",
      cwd: '/w',
      output: 'PASS a\nFAIL b\n',
      outputBytes: 14,
      exitCode: 1,
      durationMs: 1200,
      status: 'done',
      nativeId: '4242'
    })
    expect(command).not.toHaveProperty('outputTruncated')
    const patch = harness.byCall('patch-1')
    expect(patch).toMatchObject({ kind: 'file_change', status: 'done' })
    const { changes } = patch as Extract<AgentActivityItem, { kind: 'file_change' }>
    expect(changes).toHaveLength(2)
    expect(changes[0]).toMatchObject({ path: 'src/a.ts', change: 'update', added: 1, removed: 1 })
    expect(changes[0]!.diff).toContain('-b\n+B\n')
    expect(changes[1]).toMatchObject({ path: 'src/new.ts', change: 'add', added: 2, removed: 0, diff: 'one\ntwo\n' })
  })

  it('a web search, the turn plan and the helper rows land as saved items; the orphaned command is no_result', async () => {
    const tools = await replayFixture()
    const harness = assembled()
    for (const event of tools) harness.assembler.tool(event)
    expect(harness.byCall('web-1')).toMatchObject({ kind: 'web_search', query: 'codex app server', status: 'done' })
    // One plan row for the turn: opened by the first update, refreshed by the second, done at turn/completed.
    const plans = itemsOf(harness.rows).filter((entry) => entry.kind === 'plan')
    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({ callId: 'plan:turn-1', status: 'done', steps: [{ step: 'Read the code', status: 'completed' }, { step: 'Write tests', status: 'inProgress' }] })
    // The spawn item is not a row; the helper is: it outlived that item and ended on its own report.
    expect(itemsOf(harness.rows).some((entry) => entry.callId === 'spawn-1')).toBe(false)
    const first = harness.byCall('helper:thr-help')
    expect(first).toMatchObject({ kind: 'subagent', status: 'done', nativeId: 'thr-help', agentType: 'gpt-x', description: 'Check the docs and report' })
    const second = harness.byCall('helper:thr-help#2')
    expect(second).toMatchObject({ kind: 'subagent', status: 'done', summary: 'More work', nativeId: 'thr-help' })
    expect(itemsOf(harness.rows).filter((entry) => entry.kind === 'subagent')).toHaveLength(2)
    // The helper's own commands nest under the episode they ran in, with their streamed output.
    const one = harness.byCall('thr-help:hcmd-1')
    const two = harness.byCall('thr-help:hcmd-2')
    expect(one).toMatchObject({ kind: 'command', parentId: first.id, output: 'docs ok\n', exitCode: 0, status: 'done' })
    expect(two).toMatchObject({ kind: 'command', parentId: second.id, exitCode: 1, status: 'done' })
    // Nothing the server never completed is left running or reported as done.
    expect(harness.byCall('cmd-orphan')).toMatchObject({ status: 'interrupted', interruptedBy: 'no_result', summary: 'No result reported' })
    expect(itemsOf(harness.rows).filter((entry) => entry.status === 'running')).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
// A scripted app-server
// ---------------------------------------------------------------------------------------------

describe('Codex activity against a scripted app-server', () => {
  type Message = { id?: number | string; method?: string; params?: Record<string, unknown> }
  const PARENT = 'thr-1'
  const HELPER = 'helper-1'
  let home: string
  const services: CodexProviderService[] = []
  const questions = new UserQuestionService()

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    home = mkdtempSync(join(tmpdir(), 'mousse-codex-activity-s-'))
    const binary = join(home, 'codex')
    writeFileSync(binary, '#!/bin/sh\nexit 0\n')
    chmodSync(binary, 0o755)
    mkdirSync(join(home, 'providers', 'codex'), { recursive: true })
    writeFileSync(join(home, 'providers', 'codex', 'settings.json'), JSON.stringify({ binaryPath: binary }))
  })
  afterEach(() => {
    for (const service of services.splice(0)) service.stop()
    rmSync(home, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  /** An app-server stand-in: a signed-in account, and whatever `onTurnStart` writes after a turn starts. */
  function server(options: { onTurnStart?: (send: (value: unknown) => void) => void; onInterrupt?: (send: (value: unknown) => void, params: Record<string, unknown>) => void } = {}) {
    const messages: Message[] = []
    let latest: PassThrough | undefined
    const launch = (): CodexProcess => {
      const stdout = new PassThrough()
      const stdin = new PassThrough()
      const process = Object.assign(new EventEmitter(), {
        stdin,
        stdout,
        stderr: new PassThrough(),
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        kill(signal: NodeJS.Signals = 'SIGTERM') {
          if (process.signalCode) return false
          process.signalCode = signal
          setImmediate(() => process.emit('exit', null, signal))
          return true
        }
      })
      const send = (value: unknown) => stdout.write(JSON.stringify(value) + '\n')
      latest = stdout
      let pending = ''
      stdin.on('data', (chunk: Buffer) => {
        pending += chunk.toString()
        let end: number
        while ((end = pending.indexOf('\n')) !== -1) {
          const message = JSON.parse(pending.slice(0, end)) as Message
          pending = pending.slice(end + 1)
          messages.push(message)
          if (message.id === undefined || !message.method) continue
          const result =
            message.method === 'initialize' ? { userAgent: 'test', codexHome: '/h/.codex', platformFamily: 'unix', platformOs: 'macos' }
            : message.method === 'account/read' ? { account: { type: 'chatgpt', email: 'me@example.com', planType: 'plus' }, requiresOpenaiAuth: true }
            : message.method === 'thread/list' ? { data: [], nextCursor: null }
            : message.method === 'thread/start' ? { thread: { id: PARENT }, model: 'gpt-x', modelProvider: CODEX_MODEL_PROVIDER, cwd: home }
            : message.method === 'turn/start' ? { turn: { id: 'turn-1', status: 'inProgress', error: null } }
            : {}
          send({ id: message.id, result })
          if (message.method === 'turn/interrupt') options.onInterrupt?.(send, message.params ?? {})
          if (message.method === 'turn/start') options.onTurnStart?.(send)
        }
      })
      return process as unknown as CodexProcess
    }
    return { launch: launch as (spec: CodexLaunch) => CodexProcess, emit: (value: unknown) => latest?.write(JSON.stringify(value) + '\n') }
  }

  function create(s: ReturnType<typeof server>, dependencies: Record<string, unknown> = {}): CodexProviderService {
    const service = new CodexProviderService(home, questions, { launch: s.launch, ...dependencies }, { launch: () => ({ binaryPath: join(home, 'codex') }) })
    services.push(service)
    return service
  }

  /** Runs a chat, collecting the tool events the provider reports. */
  function chat(service: CodexProviderService, events: ProviderToolEvent[], patch: Partial<CodexChatInput> = {}) {
    return service.chat({ threadId: 'thread', cwd: home, model: 'gpt-x', prompt: 'go', onText: () => undefined, onTool: (event) => void events.push(event), ...patch })
  }

  const note = (method: string, params: Record<string, unknown>) => ({ method, params })
  const turnDone = (threadId: string, turn: string, status = 'completed') => note('turn/completed', { threadId, turn: { id: turn, status, error: null } })
  const itemFrame = (phase: 'started' | 'completed', threadId: string, turnId: string, value: Record<string, unknown>) => note(`item/${phase}`, { threadId, turnId, item: value })
  const cmd = (id: string, extra: Record<string, unknown> = {}) => ({ type: 'commandExecution', id, command: 'npm test', cwd: '/w', status: 'inProgress', aggregatedOutput: null, exitCode: null, durationMs: null, ...extra })
  const delta = (threadId: string, turnId: string, itemId: string, text: string) => note('item/commandExecution/outputDelta', { threadId, turnId, itemId, delta: text })
  const spawn = () =>
    itemFrame('completed', PARENT, 'turn-1', { type: 'collabAgentToolCall', id: 'spawn-1', tool: 'spawnAgent', status: 'completed', senderThreadId: PARENT, receiverThreadIds: [HELPER], prompt: 'Look around', model: 'gpt-x', agentsStates: { [HELPER]: { status: 'running', message: null } } })
  const helperTurn = (turn = 'h-turn-1') => note('turn/started', { threadId: HELPER, turn: { id: turn, status: 'inProgress', error: null } })
  const interruptReply = (send: (value: unknown) => void, params: Record<string, unknown>) => send(turnDone(params.threadId as string, params.threadId === HELPER ? 'h-turn-1' : 'turn-1', 'interrupted'))
  const completeOf = (events: ProviderToolEvent[], callId: string) => events.find((event) => event.callId === callId && event.phase === 'complete')
  const phases = (events: ProviderToolEvent[], callId: string) => events.filter((event) => event.callId === callId).map((event) => event.phase)

  it('output arrives in order, once: a late chunk and a chunk for a call that never started are dropped', async () => {
    const events: ProviderToolEvent[] = []
    const s = server({
      onTurnStart: (send) =>
        setImmediate(() => {
          send(delta(PARENT, 'turn-1', 'nope', 'before any start\n'))
          send(itemFrame('started', PARENT, 'turn-1', cmd('c1')))
          for (const text of ['a\n', 'b\n', 'c\n']) send(delta(PARENT, 'turn-1', 'c1', text))
          send(itemFrame('completed', PARENT, 'turn-1', cmd('c1', { status: 'completed', aggregatedOutput: 'a\nb\nc\n', exitCode: 0, durationMs: 5 })))
          send(delta(PARENT, 'turn-1', 'c1', 'late\n'))
          send(turnDone(PARENT, 'turn-1'))
        })
    })
    await chat(create(s), events)
    expect(phases(events, 'c1')).toEqual(['start', 'update', 'update', 'update', 'complete'])
    expect(events.some((event) => event.callId === 'nope')).toBe(false)
    const harness = assembled()
    harness.feed(events)
    expect(harness.byCall('c1')).toMatchObject({ output: 'a\nb\nc\n', outputBytes: 6, status: 'done', exitCode: 0 })
  })

  it('100 KB of streamed output is a 64 KB tail cut at a line, with the full size, not doubled by the completion', async () => {
    const events: ProviderToolEvent[] = []
    const line = `${'x'.repeat(99)}\n`
    const all = line.repeat(1000)
    const s = server({
      onTurnStart: (send) =>
        setImmediate(() => {
          send(itemFrame('started', PARENT, 'turn-1', cmd('big')))
          for (let index = 0; index < 1000; index += 1) send(delta(PARENT, 'turn-1', 'big', line))
          send(itemFrame('completed', PARENT, 'turn-1', cmd('big', { status: 'completed', aggregatedOutput: all, exitCode: 0 })))
          send(turnDone(PARENT, 'turn-1'))
        })
    })
    await chat(create(s), events)
    const harness = assembled()
    harness.feed(events)
    const row = harness.rows.find((entry) => entry.activity?.callId === 'big')!
    const activity = row.activity as Extract<AgentActivityItem, { kind: 'command' }>
    expect(activity.outputBytes).toBe(100_000)
    expect(activity.outputTruncated).toBe(true)
    expect(Buffer.byteLength(activity.output!)).toBeLessThanOrEqual(ACTIVITY_OUTPUT_CAP_BYTES)
    expect(activity.output!.length % 100).toBe(0)
    expect(JSON.stringify(row).length).toBeLessThan(100_000)
  })

  it('arguments and patches over the caps keep their kind on completion and the saved rows stay small', async () => {
    const events: ProviderToolEvent[] = []
    const huge = 'y'.repeat(2_000_000)
    const mcp = { type: 'mcpToolCall', id: 'm1', server: 'docs', tool: 'search', arguments: { blob: 'x'.repeat(200_000) } }
    const patch = (status: string) => ({
      type: 'fileChange',
      id: 'p1',
      status,
      changes: [{ path: 'big.ts', kind: { type: 'add' }, diff: `${'line\n'.repeat(200_000)}` }]
    })
    const s = server({
      onTurnStart: (send) =>
        setImmediate(() => {
          send(itemFrame('started', PARENT, 'turn-1', cmd('h1', { command: `cat <<'EOF' > f\n${huge}\nEOF` })))
          send(itemFrame('completed', PARENT, 'turn-1', cmd('h1', { command: `cat <<'EOF' > f\n${huge}\nEOF`, status: 'completed', aggregatedOutput: '', exitCode: 0 })))
          send(itemFrame('started', PARENT, 'turn-1', { ...mcp, status: 'inProgress' }))
          send(itemFrame('completed', PARENT, 'turn-1', { ...mcp, status: 'completed', result: { content: [{ type: 'text', text: 'z'.repeat(100_000) }] } }))
          send(itemFrame('started', PARENT, 'turn-1', patch('inProgress')))
          send(itemFrame('completed', PARENT, 'turn-1', patch('completed')))
          send(turnDone(PARENT, 'turn-1'))
        })
    })
    await chat(create(s), events)
    const harness = assembled()
    harness.feed(events)
    expect(harness.byCall('h1')).toMatchObject({ kind: 'command', status: 'done', exitCode: 0 })
    expect(harness.byCall('m1')).toMatchObject({ kind: 'generic', server: 'docs', input: { truncated: true }, status: 'done' })
    expect(harness.byCall('p1')).toMatchObject({ kind: 'file_change', status: 'done', changes: [{ path: 'big.ts', change: 'add', added: 200_000, diffTruncated: true }] })
    for (const row of harness.rows) {
      expect(JSON.stringify(row).length).toBeLessThan(100_000)
      expect(row.toolCall?.response).toBeUndefined()
    }
  })

  it('a call that never got a result on a settled turn closes as no_result, with the status on the emitted event and the saved row', async () => {
    const events: ProviderToolEvent[] = []
    const s = server({
      onTurnStart: (send) =>
        setImmediate(() => {
          send(itemFrame('started', PARENT, 'turn-1', cmd('open-1')))
          send(turnDone(PARENT, 'turn-1'))
        })
    })
    await chat(create(s), events)
    expect(completeOf(events, 'open-1')?.activity).toEqual({ status: 'interrupted', interruptedBy: 'no_result', summary: 'No result reported' })
    const harness = assembled()
    harness.feed(events)
    expect(harness.byCall('open-1')).toMatchObject({ status: 'interrupted', interruptedBy: 'no_result', summary: 'No result reported' })
    expect(harness.byCall('open-1').endedAt).toBeDefined()
  })

  it('a helper nests its commands under its row, outlives the item that launched it, and is done when the run waited for it', async () => {
    const events: ProviderToolEvent[] = []
    let finish: () => void = () => undefined
    const s = server({
      onTurnStart: (send) => {
        finish = () => send(turnDone(HELPER, 'h-turn-1'))
        setImmediate(() => {
          send(spawn())
          send(helperTurn())
          send(itemFrame('started', HELPER, 'h-turn-1', cmd('hc1')))
          send(itemFrame('completed', HELPER, 'h-turn-1', cmd('hc1', { status: 'completed', aggregatedOutput: 'ok\n', exitCode: 0 })))
          // The parent's own turn ends first; the run holds for the helper.
          send(turnDone(PARENT, 'turn-1'))
        })
      }
    })
    const running = chat(create(s), events)
    await vi.waitFor(() => expect(events.some((event) => event.callId === `${HELPER}:hc1` && event.phase === 'complete')).toBe(true))
    await new Promise((done) => setTimeout(done, 60))
    // Still working: the spawn item completed, the helper did not.
    expect(completeOf(events, `helper:${HELPER}`)).toBeUndefined()
    finish()
    await running
    expect(events.find((event) => event.callId === `${HELPER}:hc1`)?.parentCallId).toBe(`helper:${HELPER}`)
    expect(completeOf(events, `helper:${HELPER}`)?.activity).toEqual({ status: 'done' })
    const harness = assembled()
    harness.feed(events)
    const row = harness.byCall(`helper:${HELPER}`)
    expect(row).toMatchObject({ kind: 'subagent', status: 'done', description: 'Look around' })
    expect(harness.byCall(`${HELPER}:hc1`)).toMatchObject({ parentId: row.id, status: 'done', output: 'ok\n' })
  })

  it('a helper still running when its run gives up on it is no_result, never done', async () => {
    const events: ProviderToolEvent[] = []
    const s = server({
      onTurnStart: (send) =>
        setImmediate(() => {
          send(spawn())
          send(helperTurn())
          send(turnDone(PARENT, 'turn-1'))
        })
    })
    await chat(create(s, { helperIdleCapMs: 40, helperPinCapMs: 40 }), events)
    expect(completeOf(events, `helper:${HELPER}`)?.activity).toEqual({ status: 'interrupted', interruptedBy: 'no_result', summary: 'No result reported' })
  })

  it('Stop with a command, a plan and a helper open: every row ends stopped, even a helper that reported done once Stop was requested', async () => {
    const events: ProviderToolEvent[] = []
    const s = server({
      onTurnStart: (send) =>
        setImmediate(() => {
          send(spawn())
          send(helperTurn())
          send(note('turn/plan/updated', { threadId: PARENT, turnId: 'turn-1', explanation: null, plan: [{ step: 'Work', status: 'inProgress' }] }))
          send(itemFrame('started', PARENT, 'turn-1', cmd('run-1')))
          send(itemFrame('started', HELPER, 'h-turn-1', cmd('hc1')))
        }),
      onInterrupt: (send, params) => {
        if (params.threadId === HELPER) {
          // The helper's end is reported before the abort reaches the turn's own handler.
          send(itemFrame('completed', PARENT, 'turn-1', { type: 'subAgentActivity', id: 'sub-1', kind: 'completed', agentThreadId: HELPER, agentPath: '/' }))
          send(turnDone(HELPER, 'h-turn-1'))
        } else send(turnDone(PARENT, 'turn-1', 'interrupted'))
      }
    })
    const service = create(s)
    const stop = new AbortController()
    const running = chat(service, events, { signal: stop.signal })
    running.catch(() => undefined)
    await vi.waitFor(() => expect(events.some((event) => event.callId === `${HELPER}:hc1`)).toBe(true))
    await service.interrupt(PARENT)
    await vi.waitFor(() => expect(events.some((event) => event.callId === `helper:${HELPER}` && event.phase === 'complete')).toBe(true))
    stop.abort(new Error('Stopped'))
    await expect(running).rejects.toThrow('Stopped')
    const stopped = { status: 'interrupted', interruptedBy: 'stop', summary: 'Stopped' }
    for (const callId of ['run-1', 'plan:turn-1', `helper:${HELPER}`, `${HELPER}:hc1`]) expect(completeOf(events, callId)?.activity, callId).toEqual(stopped)
    const harness = assembled()
    harness.feed(events)
    for (const entry of itemsOf(harness.rows)) expect(entry, entry.callId).toMatchObject({ status: 'interrupted', interruptedBy: 'stop' })
    expect(itemsOf(harness.rows)).toHaveLength(4)
  })

  it('a turn that completes after Stop was requested leaves the plan to Stop: it ends stopped, not done', async () => {
    const events: ProviderToolEvent[] = []
    const s = server({
      onTurnStart: (send) =>
        setImmediate(() => {
          send(spawn())
          send(helperTurn())
          send(note('turn/plan/updated', { threadId: PARENT, turnId: 'turn-1', explanation: null, plan: [{ step: 'Work', status: 'inProgress' }] }))
        })
    })
    const service = create(s)
    const stop = new AbortController()
    const running = chat(service, events, { signal: stop.signal })
    running.catch(() => undefined)
    await vi.waitFor(() => expect(events.some((event) => event.callId === 'plan:turn-1')).toBe(true))
    await service.interrupt(PARENT)
    // The turn finishes normally just as Stop lands; the helper keeps the chat waiting until the abort.
    s.emit(turnDone(PARENT, 'turn-1'))
    await new Promise((done) => setTimeout(done, 60))
    expect(completeOf(events, 'plan:turn-1')).toBeUndefined()
    stop.abort(new Error('Stopped'))
    await expect(running).rejects.toThrow('Stopped')
    expect(completeOf(events, 'plan:turn-1')?.activity).toEqual({ status: 'interrupted', interruptedBy: 'stop', summary: 'Stopped' })
    const harness = assembled()
    harness.feed(events)
    expect(harness.byCall('plan:turn-1')).toMatchObject({ status: 'interrupted', interruptedBy: 'stop' })
  })

  it('more work for a helper that already ended shows no empty row; its row opens when the helper runs, with the work under it', async () => {
    const events: ProviderToolEvent[] = []
    const s = server({
      onTurnStart: (send) =>
        setImmediate(() => {
          // The helper's earlier turn ended before this run's item names it (an earlier run gave up on it).
          send(helperTurn('h-turn-0'))
          send(turnDone(HELPER, 'h-turn-0'))
          send(itemFrame('completed', PARENT, 'turn-1', { type: 'subAgentActivity', id: 'sub-1', kind: 'interacted', agentThreadId: HELPER, agentPath: '/' }))
          send(helperTurn('h-turn-1'))
          send(itemFrame('started', HELPER, 'h-turn-1', cmd('hc1')))
          send(itemFrame('completed', HELPER, 'h-turn-1', cmd('hc1', { status: 'completed', exitCode: 0 })))
          send(turnDone(HELPER, 'h-turn-1'))
          send(turnDone(PARENT, 'turn-1'))
        })
    })
    await chat(create(s), events)
    const rows = events.filter((event) => event.phase === 'start' && event.callId.startsWith('helper:'))
    expect(rows.map((event) => event.callId)).toEqual([`helper:${HELPER}`])
    expect(rows[0]!.activity).toMatchObject({ kind: 'subagent', summary: 'More work' })
    expect(events.find((event) => event.callId === `${HELPER}:hc1`)?.parentCallId).toBe(`helper:${HELPER}`)
    expect(completeOf(events, `helper:${HELPER}`)?.activity).toEqual({ status: 'done' })
  })

  it('a helper that is still being stopped after the chat ended adds no rows', async () => {
    const events: ProviderToolEvent[] = []
    const s = server({
      onTurnStart: (send) =>
        setImmediate(() => {
          send(spawn())
          send(helperTurn())
        }),
      // Only the parent's turn answers its interrupt: the helper stays running, so the sweep keeps the run.
      onInterrupt: (send, params) => params.threadId === PARENT && send(turnDone(PARENT, 'turn-1', 'interrupted'))
    })
    const stop = new AbortController()
    const running = chat(create(s), events, { signal: stop.signal })
    running.catch(() => undefined)
    await vi.waitFor(() => expect(events.some((event) => event.callId === `helper:${HELPER}`)).toBe(true))
    stop.abort(new Error('Stopped'))
    await expect(running).rejects.toThrow('Stopped')
    const before = events.length
    s.emit(itemFrame('started', HELPER, 'h-turn-1', cmd('late-1')))
    s.emit(delta(HELPER, 'h-turn-1', 'late-1', 'x'))
    s.emit(itemFrame('completed', HELPER, 'h-turn-1', cmd('late-1', { status: 'completed' })))
    await new Promise((done) => setTimeout(done, 80))
    expect(events).toHaveLength(before)
  })

  it('more work for a helper opens a second episode under which its next items nest, and the first row stays as it ended', async () => {
    const events: ProviderToolEvent[] = []
    const s = server({
      onTurnStart: (send) =>
        setImmediate(() => {
          send(spawn())
          send(helperTurn())
          send(itemFrame('completed', PARENT, 'turn-1', { type: 'subAgentActivity', id: 'sub-1', kind: 'completed', agentThreadId: HELPER, agentPath: '/' }))
          // A repeat of `started` is not new work; `interacted` is.
          send(itemFrame('completed', PARENT, 'turn-1', { type: 'subAgentActivity', id: 'sub-2', kind: 'started', agentThreadId: HELPER, agentPath: '/' }))
          send(itemFrame('completed', PARENT, 'turn-1', { type: 'subAgentActivity', id: 'sub-3', kind: 'interacted', agentThreadId: HELPER, agentPath: '/' }))
          send(itemFrame('started', HELPER, 'h-turn-2', cmd('hc2')))
          send(itemFrame('completed', HELPER, 'h-turn-2', cmd('hc2', { status: 'completed', exitCode: 0 })))
          send(turnDone(HELPER, 'h-turn-2'))
          send(turnDone(PARENT, 'turn-1'))
        })
    })
    await chat(create(s), events)
    expect(phases(events, `helper:${HELPER}`)).toEqual(['start', 'complete'])
    expect(phases(events, `helper:${HELPER}#2`)).toEqual(['start', 'complete'])
    expect(events.some((event) => event.callId === `helper:${HELPER}#3`)).toBe(false)
    expect(events.find((event) => event.callId === `${HELPER}:hc2`)?.parentCallId).toBe(`helper:${HELPER}#2`)
    const harness = assembled()
    harness.feed(events)
    expect(harness.byCall(`helper:${HELPER}`)).toMatchObject({ status: 'done' })
    expect(harness.byCall(`helper:${HELPER}#2`)).toMatchObject({ status: 'done', summary: 'More work' })
  })

  it('a helper that reports interrupted ends interrupted, and one a later wait item shows errored ends failed', async () => {
    const events: ProviderToolEvent[] = []
    const s = server({
      onTurnStart: (send) =>
        setImmediate(() => {
          send(spawn())
          send(helperTurn())
          send(itemFrame('completed', PARENT, 'turn-1', { type: 'subAgentActivity', id: 'sub-1', kind: 'interrupted', agentThreadId: HELPER, agentPath: '/' }))
          send(turnDone(PARENT, 'turn-1'))
        })
    })
    await chat(create(s), events)
    expect(completeOf(events, `helper:${HELPER}`)?.activity).toEqual({ status: 'interrupted', interruptedBy: 'stop', summary: 'Stopped' })

    const failedEvents: ProviderToolEvent[] = []
    const t = server({
      onTurnStart: (send) =>
        setImmediate(() => {
          send(spawn())
          send(helperTurn())
          send(itemFrame('completed', PARENT, 'turn-1', { type: 'collabAgentToolCall', id: 'wait-1', tool: 'wait', status: 'completed', senderThreadId: PARENT, receiverThreadIds: [HELPER], agentsStates: { [HELPER]: { status: 'errored', message: 'x' } } }))
          send(turnDone(PARENT, 'turn-1'))
        })
    })
    await chat(create(t), failedEvents)
    expect(completeOf(failedEvents, `helper:${HELPER}`)?.activity).toEqual({ status: 'failed' })
  })

  it('a Mousse delegation call never carries its prompt on any event', async () => {
    const events: ProviderToolEvent[] = []
    const call = { type: 'mcpToolCall', id: 'd1', server: 'mousse', tool: 'delegate_task', arguments: { title: 'Review', prompt: 'SECRET PROMPT TEXT'.repeat(2000) } }
    const s = server({
      onTurnStart: (send) =>
        setImmediate(() => {
          send(itemFrame('started', PARENT, 'turn-1', { ...call, status: 'inProgress' }))
          send(itemFrame('completed', PARENT, 'turn-1', { ...call, status: 'completed', result: { content: [{ type: 'text', text: JSON.stringify({ delegationId: 'x1', childThreadId: 't9' }) }] } }))
          send(turnDone(PARENT, 'turn-1'))
        })
    })
    await chat(create(s), events)
    expect(JSON.stringify(events)).not.toContain('SECRET PROMPT TEXT')
    const harness = assembled()
    harness.feed(events)
    expect(JSON.stringify(harness.rows)).not.toContain('SECRET PROMPT TEXT')
  })
})
