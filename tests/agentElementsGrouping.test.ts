import { describe, expect, it } from 'vitest'
import {
  formatSearchRowLabels,
  latestThoughtHeading,
  searchResultCount,
  thoughtHeading,
} from '../src/renderer/chat/components/agent-elements/utils/format-tool'
import { getToolStatus } from '../src/renderer/chat/components/agent-elements/utils/format-tool'
import { mapPartStateToInvocationState } from '../src/renderer/chat/components/agent-elements/utils/tool-adapters'
import {
  analyzeAssistantMessage,
  foldTurnWork,
  partitionTurnSegments,
  settleFinishedTurn,
  workGroupIconType,
  workGroupTitle,
} from '../src/renderer/chat/components/agent-elements/utils/assistant-blocks'

const tool = (type: string, toolCallId: string, extra: Record<string, unknown> = {}) => ({
  type,
  toolCallId,
  state: 'output-available',
  input: {},
  ...extra,
})

describe('latestThoughtHeading', () => {
  it('takes the last titled summary, else the last paragraph', () => {
    expect(latestThoughtHeading('**One**\n\nbody\n\n__Two__\n\nmore body')).toBe('Two')
    expect(latestThoughtHeading('First idea.\n\n  \n\nSecond idea\nwith detail')).toBe('Second idea')
    expect(latestThoughtHeading('   ')).toBe('')
    expect(latestThoughtHeading(undefined)).toBe('')
  })
})

describe('thoughtHeading', () => {
  it('uses the first non-empty line as the heading', () => {
    expect(thoughtHeading('  \nCheck the auth flow\nSecond line')).toBe('Check the auth flow')
  })

  it('strips markdown heading and quote markers', () => {
    expect(thoughtHeading('## Plan of attack')).toBe('Plan of attack')
    expect(thoughtHeading('> quoted thought')).toBe('quoted thought')
  })

  it('strips inline markdown formatting from the heading', () => {
    expect(thoughtHeading('**Bold** move with `code`')).toBe('Bold move with code')
    expect(thoughtHeading('See [the docs](https://example.com) now')).toBe('See the docs now')
    expect(thoughtHeading('*italic* and ~~struck~~ text')).toBe('italic and struck text')
  })

  it('truncates long headings', () => {
    const heading = thoughtHeading(`x${'y'.repeat(100)}`)
    expect(heading.endsWith('...')).toBe(true)
    expect(heading.length).toBeLessThanOrEqual(64)
  })

  it('returns empty for missing content', () => {
    expect(thoughtHeading(undefined)).toBe('')
    expect(thoughtHeading('   \n  ')).toBe('')
  })
})

describe('mapPartStateToInvocationState', () => {
  it('treats output-error as finished so failed calls never shimmer', () => {
    expect(mapPartStateToInvocationState('output-available')).toBe('result')
    expect(mapPartStateToInvocationState('output-error')).toBe('result')
    expect(mapPartStateToInvocationState('input-streaming')).toBe('partial-call')
    expect(mapPartStateToInvocationState('input-available')).toBe('call')
    expect(mapPartStateToInvocationState(undefined)).toBe('call')
  })
})

describe('getToolStatus', () => {
  it('reports an item that ended without a result as interrupted, whatever the chat is doing', () => {
    const part = { type: 'tool-Bash', state: 'output-available', output: { stdout: '', interrupted: true } }
    for (const chatStatus of ['ready', 'streaming', undefined]) {
      expect(getToolStatus(part, chatStatus)).toEqual({
        isPending: false,
        isError: false,
        isSuccess: false,
        isInterrupted: true,
      })
    }
  })

  it('keeps the pending-while-not-streaming rule for rows without the flag', () => {
    expect(getToolStatus({ state: 'input-available' }, 'ready').isInterrupted).toBe(true)
    expect(getToolStatus({ state: 'input-available' }, 'streaming')).toMatchObject({ isPending: true, isInterrupted: false })
    expect(getToolStatus({ state: 'output-available', output: 'ok' }, 'ready')).toMatchObject({ isSuccess: true, isInterrupted: false })
  })
})

describe('formatSearchRowLabels', () => {
  it('always names the tool and query', () => {
    expect(formatSearchRowLabels('Grep', 'foo.*bar', 0)).toEqual({
      completeLabel: 'No matches',
      detail: 'Grep \u201Cfoo.*bar\u201D',
    })
    expect(formatSearchRowLabels('Glob', 'src/**', 3)).toEqual({
      completeLabel: 'Found 3 results',
      detail: 'Glob \u201Csrc/**\u201D',
    })
    expect(formatSearchRowLabels('Grep', 'x', 1)).toEqual({
      completeLabel: 'Found 1 result',
      detail: 'Grep \u201Cx\u201D',
    })
  })

  it('reads how many a code or file search found from its output', () => {
    expect(searchResultCount({ numFiles: 4, text: 'a' })).toBe(4)
    expect(searchResultCount({ numFiles: 0 })).toBe(0)
    expect(searchResultCount({ text: 'a' })).toBeUndefined()
    expect(searchResultCount('raw text')).toBeUndefined()
    expect(searchResultCount(undefined)).toBeUndefined()
  })

  it('falls back to a bare tool name without a query', () => {
    expect(formatSearchRowLabels(undefined, undefined, 0)).toEqual({
      completeLabel: 'No matches',
      detail: 'Search',
    })
  })
})

describe('analyzeAssistantMessage', () => {
  it('marks a lone tool message as groupable', () => {
    const result = analyzeAssistantMessage([tool('tool-Bash', 'a')], false)
    expect(result.toolsOnly).toBe(true)
    expect(result.toolItems).toHaveLength(1)
  })

  it('rejects messages mixing text and tools', () => {
    const result = analyzeAssistantMessage(
      [{ type: 'text', text: 'hi' }, tool('tool-Bash', 'a')],
      false
    )
    expect(result.toolsOnly).toBe(false)
  })

  it('lets thoughts join a group and keeps questions out', () => {
    const thought = analyzeAssistantMessage(
      [tool('tool-Thinking', 't', { input: { thought: 'Inspect the catalog' } }), tool('tool-Bash', 'a')],
      false
    )
    expect(thought.toolsOnly).toBe(true)
    expect(thought.toolItems).toHaveLength(2)
    expect(
      analyzeAssistantMessage(
        [tool('tool-Question', 'q'), tool('tool-Bash', 'a')],
        false
      ).toolsOnly
    ).toBe(false)
  })

  it('ignores suppressed questions and task output so runs stay joined', () => {
    const result = analyzeAssistantMessage(
      [
        tool('tool-Question', 'q'),
        tool('tool-TaskOutput', 't'),
        tool('tool-Bash', 'a'),
      ],
      true
    )
    expect(result.toolsOnly).toBe(true)
    expect(result.toolItems).toHaveLength(1)
  })

  it('rejects empty and error messages', () => {
    expect(analyzeAssistantMessage([], false).toolsOnly).toBe(false)
    expect(
      analyzeAssistantMessage(
        [{ type: 'error', message: 'boom' }, tool('tool-Bash', 'a')],
        false
      ).toolsOnly
    ).toBe(false)
  })

  it('lets file edits join a group and still keeps questions out', () => {
    expect(analyzeAssistantMessage([tool('tool-Write', 'w')], false).toolsOnly).toBe(true)
    expect(analyzeAssistantMessage([tool('tool-Edit', 'e')], false).toolsOnly).toBe(true)
    expect(analyzeAssistantMessage([tool('tool-Write_file', 'w')], false).toolsOnly).toBe(true)
    expect(analyzeAssistantMessage([tool('tool-Apply_patch', 'p')], false).toolsOnly).toBe(true)
    expect(
      analyzeAssistantMessage([tool('tool-mcp__custom__write', 'w')], false).toolsOnly
    ).toBe(true)
    expect(
      analyzeAssistantMessage(
        [tool('tool-Thinking', 't', { input: { thought: 'Update the file' } }), tool('tool-Edit', 'e')],
        false
      ).toolsOnly
    ).toBe(true)
    expect(analyzeAssistantMessage([tool('tool-Question', 'q')], false).toolsOnly).toBe(false)
  })

  it('keeps approval and plan cards out of a group', () => {
    for (const type of ['tool-QuickAction', 'tool-ExitPlanMode', 'tool-PlanWrite']) {
      expect(analyzeAssistantMessage([tool(type, 'x')], false).toolsOnly).toBe(false)
    }
  })
})

describe('workGroupTitle', () => {
  const item = (type: string, input: Record<string, unknown> = {}, id = Math.random().toString(36)) => ({ part: tool(type, id, { input }) })
  const read = (path: string) => item('tool-Read', { file_path: path })
  const run = (command = 'ls') => item('tool-Bash', { command })
  const edit = (path: string) => item('tool-Edit', { file_path: path })
  const thought = (text: string) => item('tool-Thinking', { thought: text })

  it('names what the calls did, by kind, in the order they first ran', () => {
    expect(workGroupTitle([read('a.ts'), run(), read('b.ts'), run(), read('c.ts'), run()])).toBe('Read 3 files and ran 3 commands')
    expect(workGroupTitle([run(), read('a.ts')])).toBe('Ran 1 command and read 1 file')
    expect(workGroupTitle([edit('a.ts'), edit('b.ts')])).toBe('Edited 2 files')
    expect(workGroupTitle([item('tool-Write', { file_path: 'n.ts' })])).toBe('Edited 1 file')
    expect(workGroupTitle([item('tool-Grep', { pattern: 'x' }), item('tool-Glob', { pattern: '*' })])).toBe('Searched code twice')
    expect(workGroupTitle([item('tool-WebSearch', { query: 'x' })])).toBe('Searched the web once')
    expect(workGroupTitle([item('tool-WebFetch'), item('tool-WebFetch')])).toBe('Fetched 2 pages')
    expect(workGroupTitle([item('tool-mcp__github__get_issue'), item('tool-TodoWrite')])).toBe('Used 2 tools')
  })

  it('counts a file read twice once', () => {
    expect(workGroupTitle([read('a.ts'), read('a.ts'), read('b.ts')])).toBe('Read 2 files')
  })

  it('names up to three kinds; with more, changes before reads, and the rest counted as other actions', () => {
    expect(workGroupTitle([read('a.ts'), read('b.ts'), run(), run(), edit('a.ts')])).toBe('Read 2 files, ran 2 commands and edited 1 file')
    expect(workGroupTitle([read('a.ts'), item('tool-Grep'), edit('a.ts'), run()])).toBe('Edited 1 file, ran 1 command and 2 other actions')
    expect(workGroupTitle([read('a.ts'), item('tool-Grep'), item('tool-WebFetch'), item('tool-WebSearch')])).toBe('Read 1 file, searched code once and 2 other actions')
  })

  it('leaves thoughts out, and takes the latest thought\'s line for a group of thoughts alone', () => {
    expect(workGroupTitle([thought('Look'), read('a.ts'), thought('More')])).toBe('Read 1 file')
    expect(workGroupTitle([thought('**First**\n\nbody'), thought('   '), thought('**Checking the order**\n\nbody')])).toBe('Checking the order')
    expect(workGroupTitle([thought('')])).toBe('Thought')
  })

  it('gives the icon of the calls\' kind, none for a mix', () => {
    expect(workGroupIconType([read('a.ts'), thought('x'), read('b.ts')])).toBe('tool-Read')
    expect(workGroupIconType([read('a.ts'), run()])).toBeUndefined()
    expect(workGroupIconType([thought('x')])).toBe('tool-Thinking')
  })
})

describe('foldTurnWork', () => {
  const tools = { kind: 'tools' as const }
  const text = { kind: 'message' as const, text: true }
  const call = { kind: 'message' as const, toolsOnly: true }
  const keep = { kind: 'message' as const, keep: true }
  const steer = { kind: 'message' as const, steer: true }
  const cards = (running = false) => ({ kind: 'cards' as const, running })

  it('folds the work and the narration, never the answer', () => {
    expect(foldTurnWork([text, tools, text, call, tools, text])).toEqual([true, true, true, true, true, false])
  })

  it('keeps errors, questions and notices in view, and finds the answer before them', () => {
    expect(foldTurnWork([tools, text, keep])).toEqual([true, false, false])
    expect(foldTurnWork([tools, keep, tools])).toEqual([true, false, true])
  })

  it('keeps calls with a failure the agent did not get past in view', () => {
    expect(foldTurnWork([tools, { kind: 'tools', keep: true }, keep])).toEqual([true, false, false])
    expect(foldTurnWork([{ kind: 'message', toolsOnly: true, keep: true }, text])).toEqual([false, false])
  })

  it('folds all the work of a turn cut off before its answer', () => {
    expect(foldTurnWork([text, tools])).toEqual([true, true])
  })

  it('keeps steered messages and the replies written before them, and subagents still working', () => {
    expect(foldTurnWork([text, tools, steer, tools, text])).toEqual([false, true, false, true, false])
    expect(foldTurnWork([tools, cards(true), cards(false), text])).toEqual([true, false, true, false])
  })
})

describe('partitionTurnSegments', () => {
  it('groups runs of 2+ consecutive tools-only messages', () => {
    expect(partitionTurnSegments([true, true, false, true])).toEqual([
      { kind: 'tools', msgIndices: [0, 1] },
      { kind: 'message', msgIndex: 2 },
      { kind: 'message', msgIndex: 3 },
    ])
  })

  it('keeps isolated tools as plain messages', () => {
    expect(partitionTurnSegments([true])).toEqual([{ kind: 'message', msgIndex: 0 }])
    expect(partitionTurnSegments([])).toEqual([])
    expect(partitionTurnSegments([false, false])).toEqual([
      { kind: 'message', msgIndex: 0 },
      { kind: 'message', msgIndex: 1 },
    ])
  })

  it('splits at narration, and groups one message that holds two calls', () => {
    expect(partitionTurnSegments([true, true, false, true, true], [], [1, 1, 0, 1, 1])).toEqual([
      { kind: 'tools', msgIndices: [0, 1] },
      { kind: 'message', msgIndex: 2 },
      { kind: 'tools', msgIndices: [3, 4] },
    ])
    expect(partitionTurnSegments([true], [], [2])).toEqual([{ kind: 'tools', msgIndices: [0] }])
  })

  it('groups a smaller run when asked (a call still running in a live turn)', () => {
    expect(partitionTurnSegments([false, true], [], [0, 1], (run) => run.includes(1))).toEqual([
      { kind: 'message', msgIndex: 0 },
      { kind: 'tools', msgIndices: [1] },
    ])
  })
})

describe('applet activity segmentation', () => {
  it('keeps an applet alongside tools on its own visible message surface', () => {
    expect(analyzeAssistantMessage([{ type: 'tool-Bash', toolCallId: 't', state: 'output-available' }, { type: 'data-applet', data: { appletId: 'a' } }], false).toolsOnly).toBe(false)
  })
})

describe('settleFinishedTurn', () => {
  const said = (id: string, text: string, role = 'assistant') => ({ id, role, parts: [{ type: 'text', text }] })
  const step = (id: string, type = 'tool-Bash') => ({ id, role: 'assistant', parts: [tool(type, id)] })
  const settle = (messages: Array<{ id: string; role?: string; parts: unknown[]; metadata?: unknown }>, cutOff = false) => {
    const settled = settleFinishedTurn(messages, messages.map((message) => analyzeAssistantMessage(message.parts, false)), cutOff)
    return {
      order: settled.order.map((index) => messages[index]!.id),
      grouped: settled.order.filter((index) => settled.analyses[index]!.toolsOnly).map((index) => messages[index]!.id),
      notes: settled.analyses.flatMap((analysis) => analysis.toolItems.filter((item) => item.part.type === 'tool-Note').map((item) => item.part.input)),
    }
  }

  it('puts the answer last and keeps the narration before it as prose, where it was', () => {
    const turn = settle([said('n1', 'Checking.'), step('c1'), said('n2', ' Reading the log. '), step('c2'), said('a1', 'Done.'), step('t1', 'tool-Thinking')])
    expect(turn.order).toEqual(['n1', 'c1', 'n2', 'c2', 't1', 'a1'])
    expect(turn.grouped).toEqual(['c1', 'c2', 't1'])
    expect(turn.notes).toEqual([])
  })

  it('keeps a turn without reply text, and what is not activity, where it was', () => {
    expect(settle([step('c1'), step('c2')]).order).toEqual(['c1', 'c2'])
    const errored = settle([step('c1'), said('a1', 'Done.'), { id: 'e1', role: 'assistant', parts: [{ type: 'error', message: 'Lost' }] }, step('c2')])
    expect(errored.order).toEqual(['c1', 'c2', 'a1', 'e1'])
  })

  it('never takes a steer for the answer or a note', () => {
    const turn = settle([said('a1', 'Started.'), step('c1'), said('s1', 'Also check the docs', 'user')])
    expect(turn.order).toEqual(['c1', 'a1', 's1'])
    expect(turn.notes).toEqual([])
  })

  it('moves the one reply row of an older turn below the work that came after it', () => {
    // Turns saved before notes had rows of their own keep all their text in the first reply row.
    expect(settle([step('t1', 'tool-Thinking'), said('a1', 'Checking.All done.'), step('c1'), step('t2', 'tool-Thinking')]).order).toEqual(['t1', 'c1', 't2', 'a1'])
  })

  it('keeps a stopped turn in the order it ran when its last text came before its last command', () => {
    // "Running the build." then a command the Stop cut off: the text is a note, not an answer.
    const turn = settle([said('n1', 'Running the build.'), step('c1')], true)
    expect(turn.order).toEqual(['n1', 'c1'])
    expect(turn.notes).toEqual([])
    const steer = { id: 's1', role: 'user', parts: [], metadata: { steerGroup: [said('m1', 'Also check the docs', 'user')] } }
    const steered = settle([said('a1', 'Started.'), step('c0'), steer, said('n1', 'Checking the docs.'), step('c1'), step('t1', 'tool-Thinking')], true)
    expect(steered.order).toEqual(['a1', 'c0', 's1', 'n1', 'c1', 't1'])
  })

  it('leaves a model switch marker where it is, never as the answer or a note', () => {
    const marker = { id: 'h1', role: 'assistant', parts: [{ type: 'text', text: 'Claude Opus 5.5 → Claude Sonnet 5.5' }], metadata: { contextHandoff: { from: { model: 'opus' }, to: { model: 'sonnet' } } } }
    const turn = settle([marker, step('t1', 'tool-Thinking'), said('a1', 'Done.')])
    expect(turn.order).toEqual(['h1', 't1', 'a1'])
    expect(turn.grouped).toEqual(['t1'])
    expect(turn.notes).toEqual([])
  })

  it('still ends a stopped turn on text written after its work', () => {
    const turn = settle([said('n1', 'Checking.'), step('c1'), said('a1', 'Half an ans')], true)
    expect(turn.order).toEqual(['n1', 'c1', 'a1'])
    expect(turn.notes).toEqual([])
  })
})
