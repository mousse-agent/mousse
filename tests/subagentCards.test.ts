import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { mousseToUIMessages } from '../src/renderer/chat/adapters/mousseToUI'
import {
  collectSubagentCalls,
  joinSubagentCards,
  type SubagentCall,
  type SubagentCardModel
} from '../src/renderer/chat/adapters/subagentCards'
import { noticeOutcome, noticeSummary, readSubagentNotice } from '../src/renderer/chat/adapters/subagentNotice'
import {
  isRefusedSubagentResult,
  readSubagentResult,
  subagentToolName,
  subagentToolOfRecord,
  type SubagentToolName
} from '../src/shared/subagentTools'
import { previewText } from '../src/renderer/components/QueuedMessages'
import type { ChatMessage, QueuedMessage } from '../src/shared/types'
import type { SubagentSummary, SubagentTaskSummary } from '../src/shared/subagents'

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 25, 12, 0, seconds)).toISOString()

describe('subagentToolName', () => {
  it.each<[string | undefined, SubagentToolName | null]>([
    // The seven tools, bare (the pi loop).
    ['delegate_task', 'delegate_task'],
    ['continue_subagent', 'continue_subagent'],
    ['answer_subagent', 'answer_subagent'],
    ['task_status', 'task_status'],
    ['task_cancel', 'task_cancel'],
    ['list_subagents', 'list_subagents'],
    ['integrate_delegation', 'integrate_delegation'],
    // As MCP tools (Claude, Codex) and as a Codex row title.
    ['mcp__mousse__delegate_task', 'delegate_task'],
    ['mcp__mousse__continue_subagent', 'continue_subagent'],
    ['mousse.task_status', 'task_status'],
    ['Called mousse.integrate_delegation', 'integrate_delegation'],
    ['  MCP__Mousse__Task_Cancel ', 'task_cancel'],
    // Older names that still dispatch map to the tool that replaced them.
    ['create_subagent', 'delegate_task'],
    ['recall_subagent', 'continue_subagent'],
    ['list_delegations', 'list_subagents'],
    ['integrate_subagent', 'integrate_delegation'],
    ['mcp__mousse__recall_subagent', 'continue_subagent'],
    // Other tools, other servers, and the batch call are not subagent cards.
    ['create_subagents', null],
    ['mcp__other__delegate_task', null],
    ['github.delegate_task', null],
    ['mcp__mousse', null],
    ['Edit src/delegate_task.ts', null],
    ['Bash', null],
    ['', null],
    [undefined, null]
  ])('%s', (raw, expected) => {
    expect(subagentToolName(raw)).toBe(expected)
  })
})

describe('subagentToolOfRecord', () => {
  it('reads Claude and Codex rows, which name the tool in the title and summary', () => {
    expect(subagentToolOfRecord({ title: 'mcp__mousse__delegate_task', summary: 'mcp__mousse__delegate_task', details: [] })).toBe('delegate_task')
    expect(subagentToolOfRecord({ title: 'mousse.continue_subagent', summary: 'mousse.continue_subagent', details: [] })).toBe('continue_subagent')
  })

  it('reads the pi loop`s structured tool name', () => {
    expect(subagentToolOfRecord({ toolName: 'delegate_task', title: 'Called mousse.delegate_task', summary: 'x', details: [] })).toBe('delegate_task')
  })

  it('reads an MCP call event`s server and tool details, and refuses another server', () => {
    expect(subagentToolOfRecord({ title: 'Called mousse.task_status', summary: 'The orchestrator called an MCP tool.', details: ['Server: mousse', 'Tool: task_status'] })).toBe('task_status')
    expect(subagentToolOfRecord({ title: 'Called tracker.delegate_task', summary: 'The orchestrator called an MCP tool.', details: ['Server: tracker', 'Tool: delegate_task'] })).toBeNull()
  })

  it('ignores static provider summaries', () => {
    expect(subagentToolOfRecord({ title: 'Web tool search', summary: 'Running search.', details: ['Tool: search'] })).toBeNull()
  })
})

describe('subagent tool results', () => {
  it('reads a recorded result as an object, from JSON text or already parsed', () => {
    expect(readSubagentResult('{"delegationId":"d1"}')).toEqual({ delegationId: 'd1' })
    expect(readSubagentResult({ delegationId: 'd1' })).toEqual({ delegationId: 'd1' })
    expect(readSubagentResult('plain text')).toBeNull()
    expect(readSubagentResult('[1]')).toBeNull()
    expect(readSubagentResult(undefined)).toBeNull()
  })

  it('treats a refusal value as a call that started nothing', () => {
    expect(isRefusedSubagentResult({ started: false, code: 'title_taken' })).toBe(true)
    expect(isRefusedSubagentResult('{"started":false,"code":"needs_answer"}')).toBe(true)
    expect(isRefusedSubagentResult({ answered: false, code: 'no_such_question' })).toBe(true)
    expect(isRefusedSubagentResult({ delegationId: 'd1', status: 'started' })).toBe(false)
    expect(isRefusedSubagentResult(undefined)).toBe(false)
  })
})

const row = (overrides: Partial<ChatMessage>): ChatMessage => ({ id: 'm', role: 'system', content: '', timestamp: at(0), ...overrides })

describe('subagent tool rows in the transcript', () => {
  it('become one row type whichever runtime wrote them, and keep other MCP tools as they were', () => {
    const out = mousseToUIMessages([
      row({ id: 'claude', kind: 'mcp_tool_call', toolCall: { title: 'mcp__mousse__delegate_task', summary: 'mcp__mousse__delegate_task', details: [], status: 'complete' } }),
      row({ id: 'codex', kind: 'mcp_tool_call', toolCall: { title: 'mousse.continue_subagent', summary: 'mousse.continue_subagent', details: [], status: 'processing' } }),
      row({
        id: 'pi',
        kind: 'mcp_tool_result',
        toolCall: { title: 'Called mousse.delegate_task', summary: 'ok', details: ['Server: mousse', 'Tool: delegate_task'], toolName: 'delegate_task', status: 'complete', input: { title: 'API reviewer' }, response: '{"delegationId":"d1"}' }
      }),
      row({ id: 'other', kind: 'mcp_tool_call', toolCall: { title: 'Called tracker.delegate_task', summary: 's', details: ['Server: tracker', 'Tool: delegate_task'], status: 'complete' } })
    ])
    const parts = out.map((message) => message.parts[0] as unknown as Record<string, any>)
    expect(parts.map((part) => part.type)).toEqual(['tool-Subagent', 'tool-Subagent', 'tool-Subagent', 'tool-mcp__tracker__delegate_task'])
    expect(parts.slice(0, 3).map((part) => part.subagentTool)).toEqual(['delegate_task', 'continue_subagent', 'delegate_task'])
    expect(parts[1].state).toBe('input-available')
    expect(parts[2].input).toEqual({ title: 'API reviewer' })
    // A vendor row records no input: nothing is invented from its static summary.
    expect(parts[0].input).toEqual({})
  })

  it('collects the calls that start a task, in order, with when they ran', () => {
    const out = mousseToUIMessages([
      row({ id: 'a', timestamp: at(1), kind: 'mcp_tool_call', toolCall: { title: 'mcp__mousse__delegate_task', summary: 'mcp__mousse__delegate_task', details: [], status: 'complete' } }),
      row({ id: 'status', timestamp: at(2), kind: 'mcp_tool_call', toolCall: { title: 'mcp__mousse__task_status', summary: 'mcp__mousse__task_status', details: [], status: 'complete' } }),
      row({ id: 'b', timestamp: at(3), kind: 'mcp_tool_call', toolCall: { title: 'mcp__mousse__continue_subagent', summary: 'mcp__mousse__continue_subagent', details: [], status: 'processing' } })
    ])
    const calls = collectSubagentCalls(out)
    expect(calls.map((call) => [call.toolCallId, call.tool, call.pending, call.failed])).toEqual([
      ['a', 'delegate_task', false, false],
      ['b', 'continue_subagent', true, false]
    ])
    expect(calls[0]!.startedAt).toBe(Date.parse(at(1)))
  })
})

const task = (delegationId: string, createdSeconds: number, patch: Partial<SubagentTaskSummary> = {}): SubagentTaskSummary => ({
  delegationId,
  childRunId: `run-${delegationId}`,
  outcome: 'running',
  unread: false,
  continued: false,
  createdAt: at(createdSeconds),
  completedAt: null,
  ...patch
})

const subagent = (id: string, tasks: SubagentTaskSummary[], patch: Partial<SubagentSummary> = {}): SubagentSummary => ({
  childThreadId: id,
  title: `Subagent ${id}`,
  activity: 'working',
  state: 'working',
  latestDelegationId: tasks.at(-1)!.delegationId,
  unread: false,
  provider: 'claude',
  model: 'opus',
  workspace: 'shared',
  role: null,
  createdAt: tasks[0]!.createdAt,
  updatedAt: tasks.at(-1)!.createdAt,
  waitingOn: [],
  tasks,
  ...patch
})

const call = (toolCallId: string, tool: SubagentCall['tool'], startedSeconds: number, patch: Partial<SubagentCall> = {}): SubagentCall => ({
  toolCallId,
  tool,
  startedAt: Date.parse(at(startedSeconds)),
  pending: false,
  recorded: false,
  failed: false,
  input: {},
  output: undefined,
  ...patch
})

const join = (calls: SubagentCall[], subagents: SubagentSummary[], options: { loaded?: boolean; previous?: ReadonlyMap<string, SubagentCardModel> } = {}) =>
  joinSubagentCards(calls, subagents, { loaded: options.loaded ?? true, previous: options.previous })

describe('joinSubagentCards', () => {
  it('gives each start-a-task call the task the daemon recorded after it, by order', () => {
    const cards = join(
      [call('c1', 'delegate_task', 1), call('c2', 'delegate_task', 2)],
      [subagent('a', [task('da', 2)], { state: 'done' }), subagent('b', [task('db', 3)])]
    )
    expect(cards.get('c1')).toMatchObject({ childThreadId: 'a', delegationId: 'da', title: 'Subagent a', state: 'done', pending: false })
    expect(cards.get('c2')).toMatchObject({ childThreadId: 'b', delegationId: 'db', state: 'working', provider: 'claude', model: 'opus' })
  })

  it('joins by the delegation id a row recorded, ahead of order', () => {
    const cards = join(
      [call('c1', 'delegate_task', 1), call('c2', 'delegate_task', 2, { output: { delegationId: 'da' } })],
      [subagent('a', [task('da', 2)]), subagent('b', [task('db', 3)])]
    )
    expect(cards.get('c2')!.delegationId).toBe('da')
    expect(cards.get('c1')!.delegationId).toBe('db')
  })

  it('joins by the title a row recorded, whatever the order and time', () => {
    const subagents = [subagent('a', [task('da', 2)], { title: 'Docs' }), subagent('b', [task('db', 3)], { title: 'API reviewer' })]
    const cards = join(
      [call('c1', 'delegate_task', 5, { input: { title: 'API reviewer' } }), call('c2', 'delegate_task', 5, { input: { title: 'docs' } })],
      subagents
    )
    expect(cards.get('c1')!.childThreadId).toBe('b')
    expect(cards.get('c2')!.childThreadId).toBe('a')
  })

  describe('two calls started in the same instant', () => {
    // The daemon recorded the second call's task first.
    const subagents = [subagent('docs', [task('d-docs', 6)]), subagent('api', [task('d-api', 7)])]

    it('join exactly by the delegation id each row recorded', () => {
      const cards = join(
        [call('c1', 'delegate_task', 5, { output: { delegationId: 'd-api' } }), call('c2', 'delegate_task', 5, { output: '{"delegationId":"d-docs"}' })],
        subagents
      )
      expect(cards.get('c1')!.delegationId).toBe('d-api')
      expect(cards.get('c2')!.delegationId).toBe('d-docs')
    })

    it('join exactly by the subagent a follow-up names', () => {
      const tasks = [task('d1', 2, { outcome: 'done' }), task('d2', 8, { outcome: 'done' }), task('d3', 9)]
      const cards = join(
        [call('c1', 'continue_subagent', 7, { input: { subagent: 'Subagent b' } }), call('c2', 'continue_subagent', 7, { input: { subagent: 'Subagent a' } })],
        [subagent('a', [task('a1', 1), task('a2', 9)]), subagent('b', tasks)]
      )
      expect(cards.get('c1')!.childThreadId).toBe('b')
      expect(cards.get('c1')!.delegationId).toBe('d2')
      expect(cards.get('c2')!.delegationId).toBe('a2')
    })

    it('fall back to order and time only for rows that record neither', () => {
      const cards = join([call('c1', 'delegate_task', 5), call('c2', 'delegate_task', 5)], subagents)
      expect(cards.get('c1')!.delegationId).toBe('d-docs')
      expect(cards.get('c2')!.delegationId).toBe('d-api')
    })
  })

  it('never gives a row that names its task, or its subagent, another call`s task by time', () => {
    const subagents = [subagent('a', [task('da', 3)])]
    // The recorded task is not in the list (a trashed thread), the recorded title is of a renamed subagent.
    const cards = join(
      [call('gone', 'delegate_task', 1, { output: { delegationId: 'd-missing' } }), call('renamed', 'delegate_task', 2, { input: { title: 'Old name' } }), call('plain', 'delegate_task', 2)],
      subagents
    )
    expect(cards.has('gone')).toBe(false)
    expect(cards.has('renamed')).toBe(false)
    expect(cards.get('plain')!.delegationId).toBe('da')
  })

  it('starts a subagent with delegate_task and later tasks with continue_subagent', () => {
    const subagents = [subagent('a', [task('da1', 2, { outcome: 'done', continued: true }), task('da2', 6)])]
    const cards = join([call('c1', 'delegate_task', 1), call('c2', 'continue_subagent', 5, { input: { subagent: 'Subagent a' } })], subagents)
    expect(cards.get('c1')!.delegationId).toBe('da1')
    expect(cards.get('c2')!.delegationId).toBe('da2')
  })

  it('shows an older task by its own outcome and says the subagent has continued', () => {
    const subagents = [subagent('a', [task('da1', 2, { outcome: 'done', continued: true, completedAt: at(4) }), task('da2', 6)])]
    const cards = join([call('c1', 'delegate_task', 1), call('c2', 'continue_subagent', 5)], subagents)
    expect(cards.get('c1')).toMatchObject({ state: 'done', continued: true, latest: false })
    expect(cards.get('c2')).toMatchObject({ state: 'working', continued: false, latest: true })
  })

  it('does not hand a task started by someone else (a message typed in the subagent) to a later call', () => {
    // The user typed in the subagent at t=5 (task da2); the model continued it at t=8 (task da3).
    const subagents = [subagent('a', [task('da1', 2, { outcome: 'done', continued: true }), task('da2', 5, { outcome: 'done', continued: true }), task('da3', 9)])]
    const cards = join([call('c1', 'delegate_task', 1), call('c2', 'continue_subagent', 8)], subagents)
    expect(cards.get('c2')!.delegationId).toBe('da3')
  })

  it('shows waiting with what the subagent waits on', () => {
    const waiting = subagent('a', [task('da', 2, { outcome: 'waiting_for_subagents' })], { state: 'waiting', activity: 'waiting', waitingOn: [{ title: 'Child', state: 'working' }] })
    expect(join([call('c1', 'delegate_task', 1)], [waiting]).get('c1')).toMatchObject({ state: 'waiting', waitingOn: [{ title: 'Child', state: 'working' }] })
  })

  it('carries the reason a task did not finish', () => {
    const failed = subagent('a', [task('da', 2, { outcome: 'failed', error: 'boom', completedAt: at(3) })], { state: 'failed', activity: 'idle' })
    expect(join([call('c1', 'delegate_task', 1)], [failed]).get('c1')).toMatchObject({ state: 'failed', error: 'boom' })
  })

  describe('a card keeps the task it showed', () => {
    it('keeps task A when A drops out of the list, and hands it to no other call', () => {
      // Two rows from before the daemon kept records, joined to A and B by order and time.
      const calls = [call('c1', 'delegate_task', 1), call('c2', 'delegate_task', 1)]
      const a = subagent('a', [task('da', 2)], { state: 'done', activity: 'idle' })
      const b = subagent('b', [task('db', 3)])
      const before = join(calls, [a, b])
      expect(before.get('c1')!.delegationId).toBe('da')
      expect(before.get('c2')!.delegationId).toBe('db')
      const after = join(calls, [b], { previous: before })
      expect(after.get('c1')).toBe(before.get('c1'))
      expect(after.get('c1')).toMatchObject({ delegationId: 'da', childThreadId: 'a', state: 'done' })
      expect(after.get('c2')!.delegationId).toBe('db')
    })

    it('still refreshes a card whose task is listed', () => {
      const calls = [call('c1', 'delegate_task', 1)]
      const before = join(calls, [subagent('a', [task('da', 2)])])
      const after = join(calls, [subagent('a', [task('da', 2, { outcome: 'done', completedAt: at(9) })], { state: 'done', activity: 'idle' })], { previous: before })
      expect(after.get('c1')!.state).toBe('done')
    })
  })

  describe('a row with a record from the daemon', () => {
    const recorded = (toolCallId: string, tool: SubagentCall['tool'], patch: Partial<SubagentCall> = {}) =>
      call(toolCallId, tool, 5, { recorded: true, pending: true, input: { recordVersion: 1 }, ...patch })
    const subagents = [subagent('docs', [task('d-docs', 6)]), subagent('api', [task('d-api', 7)])]

    it('is never joined by order and time: until it names its task it is a pending card', () => {
      const cards = join([recorded('c1', 'delegate_task'), recorded('c2', 'delegate_task')], subagents)
      for (const id of ['c1', 'c2']) expect(cards.get(id)).toMatchObject({ pending: true, childThreadId: null, delegationId: null })
    })

    it('joins by title as soon as the input arrives, before the result', () => {
      const cards = join(
        [recorded('c1', 'delegate_task', { input: { recordVersion: 1, title: 'API reviewer' } }), recorded('c2', 'delegate_task')],
        [subagent('docs', [task('d-docs', 6)], { title: 'Docs' }), subagent('api', [task('d-api', 7)], { title: 'API reviewer' })]
      )
      expect(cards.get('c1')).toMatchObject({ delegationId: 'd-api', pending: false })
      expect(cards.get('c2')).toMatchObject({ pending: true, childThreadId: null })
    })

    it('does not guess between two follow-ups to one subagent until their results arrive', () => {
      const tasks = [task('d1', 1, { outcome: 'done' }), task('d2', 6), task('d3', 7)]
      const input = { recordVersion: 1, subagent: 'Subagent a' }
      const calls = [recorded('c1', 'continue_subagent', { input }), recorded('c2', 'continue_subagent', { input })]
      const waiting = join(calls, [subagent('a', tasks)])
      expect(waiting.get('c1')!.pending).toBe(true)
      expect(waiting.get('c2')!.pending).toBe(true)
      const answered = join(
        [{ ...calls[0]!, pending: false, output: { delegationId: 'd3' } }, { ...calls[1]!, pending: false, output: { delegationId: 'd2' } }],
        [subagent('a', tasks)]
      )
      expect(answered.get('c1')!.delegationId).toBe('d3')
      expect(answered.get('c2')!.delegationId).toBe('d2')
    })

    it('keeps its raw row when it finished without naming a task', () => {
      expect(join([recorded('c1', 'delegate_task', { pending: false })], subagents).has('c1')).toBe(false)
    })
  })

  describe('a call that started nothing', () => {
    it('keeps its raw row when it errored or was refused, and never takes the next task', () => {
      const cards = join(
        [call('bad', 'delegate_task', 1, { failed: true, output: { started: false, code: 'title_taken' } }), call('good', 'delegate_task', 2)],
        [subagent('a', [task('da', 3)])]
      )
      expect(cards.has('bad')).toBe(false)
      expect(cards.get('good')!.delegationId).toBe('da')
    })

    it('keeps its raw row once the list has loaded and no task matches', () => {
      expect(join([call('c1', 'delegate_task', 1)], []).has('c1')).toBe(false)
    })
  })

  describe('before a call has a task', () => {
    it('shows a starting card while the call is still running', () => {
      const cards = join([call('c1', 'delegate_task', 1, { pending: true, input: { title: 'API reviewer' } })], [])
      expect(cards.get('c1')).toMatchObject({ pending: true, state: 'starting', title: 'API reviewer', childThreadId: null })
    })

    it('holds a finished call as a card until the list has loaded, so rows do not flash', () => {
      expect(join([call('c1', 'delegate_task', 1)], [], { loaded: false }).get('c1')).toMatchObject({ pending: true })
    })
  })

  describe('a card persists', () => {
    it('follows its task from running to done', () => {
      const calls = [call('c1', 'delegate_task', 1)]
      const running = join(calls, [subagent('a', [task('da', 2)])])
      expect(running.get('c1')!.state).toBe('working')
      const finished = join(calls, [subagent('a', [task('da', 2, { outcome: 'done', completedAt: at(9) })], { state: 'done', activity: 'idle' })], { previous: running })
      expect(finished.get('c1')).toMatchObject({ state: 'done', delegationId: 'da' })
    })

    it('stays when its subagent drops out of the list, as a trashed thread does', () => {
      const calls = [call('c1', 'delegate_task', 1)]
      const before = join(calls, [subagent('a', [task('da', 2, { outcome: 'done' })], { state: 'done', activity: 'idle' })])
      const after = join(calls, [], { previous: before })
      expect(after.get('c1')).toBe(before.get('c1'))
    })

    it('is not replaced by a card for the wrong task when the list is empty', () => {
      const calls = [call('c1', 'delegate_task', 1)]
      const before = join(calls, [subagent('a', [task('da', 2)])])
      expect(join(calls, [], { previous: before, loaded: false }).get('c1')!.delegationId).toBe('da')
    })
  })
})

describe('subagent notices', () => {
  const items = [
    { delegationId: 'd1', childThreadId: 'a', title: 'API reviewer', runStatus: 'completed', fullyShown: true },
    { delegationId: 'd2', childThreadId: 'b', title: null, runStatus: 'failed', fullyShown: false }
  ]

  it('reads the structured payload from a message and nothing else', () => {
    const [message] = mousseToUIMessages([
      row({ id: 'wake', role: 'user', content: 'Subagent "API reviewer" (thread a) finished task d1.\nAll good.', subagentNotice: items })
    ])
    expect(readSubagentNotice(message)).toEqual(items)
  })

  it('does not treat text that looks like a notice as one', () => {
    const [message] = mousseToUIMessages([row({ id: 'u', role: 'user', content: 'Subagent "API reviewer" (thread a) finished task d1.' })])
    expect(readSubagentNotice(message)).toBeNull()
  })

  it('keeps a notice message with no text, which would otherwise be dropped as empty', () => {
    const out = mousseToUIMessages([row({ id: 'wake', role: 'user', content: '', subagentNotice: items })])
    expect(out).toHaveLength(1)
    expect(readSubagentNotice(out[0])).toEqual(items)
  })

  it('ignores a malformed payload', () => {
    expect(readSubagentNotice({ metadata: { subagentNotice: [{ nope: true }, 3] } } as unknown as UIMessage)).toBeNull()
    expect(readSubagentNotice({ metadata: undefined } as unknown as UIMessage)).toBeNull()
  })

  it('shows a queued steer by what it reports, never by the text the model reads', () => {
    const queued = (patch: Partial<QueuedMessage>): QueuedMessage =>
      ({ id: 'q', threadId: 'p', content: 'Subagent "API reviewer" (thread a) finished task d1.\nSECRET RESULT', order: 0, intent: 'steer', state: 'queued', ...patch }) as QueuedMessage
    expect(previewText(queued({ subagentNotice: [items[0]!] }))).toBe('API reviewer finished')
    expect(previewText(queued({ content: 'also check the docs', subagentNotice: undefined }))).toBe('also check the docs')
  })

  it('names the outcome of each task and summarizes a notice in a line', () => {
    expect(noticeOutcome({ runStatus: 'completed' })).toEqual({ verb: 'finished', tone: 'done' })
    expect(noticeOutcome({ runStatus: 'failed' })).toEqual({ verb: 'failed', tone: 'failed' })
    expect(noticeOutcome({ runStatus: 'cancelled' }).tone).toBe('stopped')
    expect(noticeSummary([items[0]!])).toBe('API reviewer finished')
    expect(noticeSummary([items[1]!])).toBe('Subagent failed')
    expect(noticeSummary(items)).toBe('2 subagent results')
    expect(noticeSummary([items[0]!, { ...items[0]!, delegationId: 'd3' }])).toBe('2 subagents finished')
    expect(noticeSummary([])).toBe('Subagent result')
  })
})
