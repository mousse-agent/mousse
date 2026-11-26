import { describe, expect, it } from 'vitest'
import {
  formatSearchRowLabels,
  searchResultCount,
  thoughtHeadline,
} from '../src/renderer/chat/components/agent-elements/utils/format-tool'
import { getToolStatus } from '../src/renderer/chat/components/agent-elements/utils/format-tool'
import { mapPartStateToInvocationState } from '../src/renderer/chat/components/agent-elements/utils/tool-adapters'
import {
  activeMs,
  analyzeAssistantMessage,
  foldTurnWork,
  partitionTurnSegments,
  partWorkTimes,
  settleFinishedTurn,
  turnFoldParts,
  turnWaitSpans,
  type FoldRow,
  workGroupHeading,
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

describe('thoughtHeadline', () => {
  it.each([
    // The latest title heads every paragraph after it.
    ['a bold title', '**Checking the auth flow**\n\nThe token is read twice.', 'Checking the auth flow'],
    ['a title with a colon', '__Plan:__\nRead the file first.', 'Plan'],
    ['a markdown heading', '## Plan of attack\nStart with the store.', 'Plan of attack'],
    ['a title heads its whole section, not just the paragraph under it', '**Finding why the test is slow**\n\nThe file runs twice. I should time it.\n\nThen I can compare it with one file.', 'Finding why the test is slow'],
    ['the latest title, not the first', '**One**\n\nbody\n\n__Two__\n\nmore body\n\neven more body', 'Two'],
    ['a title written mid-paragraph heads what follows', 'Some notes first.\n**Next step**\nRead the file.', 'Next step'],
    ['untitled text after untitled text: the first sentence of the newest paragraph', 'Old idea.\n\nFirst look at the store. Then the list.', 'First look at the store.'],
    ['untitled text before a title is headed by the title once it arrives', 'Old idea.\n\n## Fix', 'Fix'],
    ['a bold phrase inside a sentence is no title', 'This is **very** slow. Next.', 'This is very slow.'],
    // Code in a fence is not a title.
    ['a heading inside a fence', 'Run the script.\n\n```sh\n# install deps\nnpm ci\n```\n\nThen check the log. Done.', 'Then check the log.'],
    ['bold inside a fence', 'Look at it.\n\n~~~md\n**Not a title**\n~~~\n\nThe file is fine. Next.', 'The file is fine.'],
    ['a real title above a fence, prose after it: the title wins', '**Checking the setup**\n\n```py\n# Load the config\nload()\n```\n\nIt reads the file twice.', 'Checking the setup'],
    ['a fence still being written', '**Checking the setup**\n\n```sh\n# not a title', 'Checking the setup'],
    ['a fence nested in a list item', '**Checking the setup**\n\n- Install it:\n\n    ```sh\n    # install deps\n    npm ci\n    ```\n\nThen run it.', 'Checking the setup'],
    ['an indented fence', '**Checking the setup**\n\n        ```\n        **not a title**\n        ```', 'Checking the setup'],
    ['a nested fence still being written', '**Checking the setup**\n\n- Install it:\n    ```sh\n    # install deps', 'Checking the setup'],
    // With no title, a code block is not the newest paragraph: the prose before it is.
    ['no title, ending in a closed code block', 'Checking the script.\n\n```sh\n# install deps\nnpm ci\n```', 'Checking the script.'],
    ['no title, ending in a code block still being written', 'Checking the script.\n\n```sh\n# install deps\nnpm', 'Checking the script.'],
    ['no title, a code block straight after the prose', 'Run this first:\n```sh\nnpm ci\n```', 'Run this first:'],
    // A fence opened on a list item's or a quote's own line.
    ['a fence opened on a list-marker line, prose after it', 'Install the deps.\n\n- ```sh\n  # install deps\n  npm ci\n  ```\n\nThen run the tests. Done.', 'Then run the tests.'],
    ['a fence opened on a numbered item, prose after it', 'Install the deps.\n\n1. ~~~\n   **not a title**\n   ~~~\n\nThen run the tests.', 'Then run the tests.'],
    ['a fence opened in a quote, prose after it', 'Install the deps.\n\n> ```sh\n> # install deps\n> ```\n\nThen run the tests.', 'Then run the tests.'],
    ['a thought that is only code', '```sh\n# install deps\nnpm ci\n```', ''],
    ['a thought that is only code, opened on a list-marker line', '* ```sh\n  # install deps\n  ```', ''],
    ['a sentence still being written is shown as far as it goes', 'Looking at the sto', 'Looking at the sto'],
    ['a question ends a sentence', 'Why does it remount? The key changes.', 'Why does it remount?'],
    ['a closing quote stays with its sentence', 'He said "stop." Then left.', 'He said "stop."'],
    // Not a sentence end.
    ['abbreviations', 'Check the caches, e.g. the disk one. Then stop.', 'Check the caches, e.g. the disk one.'],
    ['etc. and vs.', 'Compare a vs. b etc. in the list. Next.', 'Compare a vs. b etc. in the list.'],
    ['dotted names', 'Read package.json and src/main.ts first. Then build.', 'Read package.json and src/main.ts first.'],
    ['a path ending in a dot word', 'Open ~/.mousse/config now. Then edit.', 'Open ~/.mousse/config now.'],
    ['version numbers', 'Node 24.2.0 is fine. Next.', 'Node 24.2.0 is fine.'],
    ['initials', 'Ask J. Smith first. Then go.', 'Ask J. Smith first.'],
    ['an ellipsis mid-sentence', 'Working... checking files. Next.', 'Working... checking files.'],
    ['an ellipsis before a capital', 'Hmm... Let me check. Next.', 'Hmm... Let me check.'],
    // A number before a dot and a space does end a sentence ("1. Check" as a list item is a marker, stripped above).
    ['a number at the end of a sentence', 'Version 1. Next step.', 'Version 1.'],
    ['a numbered list item', '1. Check the file. Then go.', 'Check the file.'],
    ['inside inline code', 'Run `a. b` then go. Next.', 'Run a. b then go.'],
    // Plain text out.
    ['inline markdown is dropped', 'A **bold** move with `code`. More.', 'A bold move with code.'],
    ['links keep their text', 'See [the docs](https://example.com) now. Then go.', 'See the docs now.'],
    ['quote and list markers', '> quoted thought. More.', 'quoted thought.'],
    ['lines of a paragraph join', 'Looking at the\nstore now. Then go.', 'Looking at the store now.'],
    // Edges.
    ['empty', '', ''],
    ['whitespace', '   \n\n  ', ''],
    ['missing', undefined, ''],
  ] as const)('%s', (_name, content, expected) => {
    expect(thoughtHeadline(content)).toBe(expected)
  })

  // [case, the thought so far, the live line, the line once it is finished]
  it.each([
    ['a paragraph of a stray word or two keeps the one before it', 'Check the file.\n\ne.', 'Check the file.', 'e.'],
    ['a new paragraph just begun', 'Check the file.\n\nI', 'Check the file.', 'I'],
    ['the start of a bold title still being written', 'Check the file.\n\n**', 'Check the file.', ''],
    ['a paragraph with four characters is its own line', 'Check the file.\n\nNext', 'Next', 'Next'],
    ['a stub with nothing before it is all there is', 'I', 'I', 'I'],
    ['stubs back to back go back to the last full paragraph', 'Check the file.\n\nI\n\ne.', 'Check the file.', 'e.'],
  ] as const)('a thought being written: %s', (_name, content, live, finished) => {
    expect(thoughtHeadline(content, { live: true })).toBe(live)
    expect(thoughtHeadline(content)).toBe(finished)
  })

  it('cuts a long sentence at 200 code points, never inside an emoji', () => {
    const long = '😀'.repeat(300)
    const headline = thoughtHeadline(long)
    expect(headline.endsWith('…')).toBe(true)
    expect(Array.from(headline)).toHaveLength(200)
    expect(Array.from(headline).slice(0, -1).every((ch) => ch === '😀')).toBe(true)
  })

  it('stays the same while its paragraph grows, and changes when a new one starts', () => {
    const chunks = ['Looking at', ' the store. It holds', ' the text and', ' the parts.', '\n\nNow the list', '. It remounts.']
    let text = ''
    const seen: string[] = []
    for (const chunk of chunks) {
      text += chunk
      seen.push(thoughtHeadline(text))
    }
    expect(seen).toEqual([
      'Looking at',
      'Looking at the store.',
      'Looking at the store.',
      'Looking at the store.',
      'Now the list',
      'Now the list.',
    ])
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

  it('keeps quick-action and plan cards out of a group', () => {
    for (const type of ['tool-QuickAction', 'tool-PlanWrite']) {
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

/**
 * A finished turn's rows, one letter each: T a tool group, c calls in a message of their own, m text written beside
 * calls (work), x a reply (narration or an answer), s a steered message, k a row that stays in view whatever the fold
 * (an error, a question, an approval, a notice, a marker, an applet), f calls holding a failure the agent did not get
 * past, C settled subagent cards, K subagent cards still going or failed without being continued.
 */
const foldRows = (rows: string): FoldRow[] =>
  [...rows].map((letter) => {
    switch (letter) {
      case 'T': return { kind: 'tools' }
      case 'f': return { kind: 'tools', keep: true }
      case 'c': return { kind: 'message', toolsOnly: true }
      case 'm': return { kind: 'message', toolsOnly: true, text: true }
      case 'x': return { kind: 'message', text: true }
      case 's': return { kind: 'message', steer: true }
      case 'k': return { kind: 'message', keep: true }
      case 'C': return { kind: 'cards' }
      case 'K': return { kind: 'cards', keep: true }
      default: throw new Error(letter)
    }
  })

describe('foldTurnWork', () => {
  // Expected: "1" folds behind its part's line, "0" stays in view.
  it.each([
    ['a plain turn: work, then the answer', 'Tx', '10'],
    ['an answer and no work', 'x', '0'],
    ['narration between the work folds, the answer stays', 'xTxcTx', '111110'],
    ['steered once: each part keeps its last reply', 'xTsTx', '01010'],
    ['steered once, the part before the steer replied before more work', 'TxTsTx', '101010'],
    ['steered twice', 'TxsTxsTx', '10010010'],
    ['a steered part with no reply of its own', 'TxsT', '1001'],
    ['stopped after narration: what it said stays', 'xT', '01'],
    ['stopped after two notes: the last stays', 'xTxT', '1101'],
    ['stopped before saying anything', 'T', '1'],
    ['a failure: the error and what it said before stay', 'xTk', '010'],
    ['calls with a failure the agent did not get past stay', 'Tfk', '100'],
    ['a kept row between the work and the answer', 'TkTx', '1010'],
    ['settled subagent cards fold behind Worked for', 'TCTCx', '11110'],
    ['subagent cards still going or failed stay in view while settled ones fold', 'TCKCx', '11010'],
    ['a subagent-only turn with no reply folds its settled cards', 'C', '1'],
    ['text written beside calls is work', 'mx', '10'],
    ['a stopped turn whose only text was beside calls', 'm', '1'],
  ])('%s', (_name, rows, expected) => {
    expect(foldTurnWork(foldRows(rows)).map((folded) => (folded ? '1' : '0')).join('')).toBe(expected)
  })
})

describe('turnFoldParts', () => {
  it.each([
    ['a turn nobody steered is one part', 'TxTx', [[0, 4]]],
    ['each steered message starts a part', 'xTsTxsx', [[0, 2], [2, 5], [5, 7]]],
    ['a steered message first in the turn starts none', 'sTx', [[0, 3]]],
  ])('%s', (_name, rows, expected) => {
    expect(turnFoldParts(foldRows(rows)).map(({ from, to }) => [from, to])).toEqual(expected)
  })
})

describe('the time a turn worked, without the time it waited on the person', () => {
  const s = (seconds: number) => seconds * 1000

  it.each([
    ['no waits', [], 10],
    ['a wait inside the span', [{ from: s(2), to: s(5) }], 7],
    ['overlapping waits count once', [{ from: s(2), to: s(5) }, { from: s(4), to: s(6) }], 6],
    ['a wait still open runs to the end', [{ from: s(8), to: null }], 8],
    ['only the part of a wait inside the span counts', [{ from: s(-5), to: s(1) }, { from: s(9), to: s(30) }], 8],
  ] as const)('activeMs: %s', (_name, waits, seconds) => {
    expect(activeMs(0, s(10), waits)).toBe(s(seconds))
  })

  it.each([
    ['one part', [[0, 10]], [], [10]],
    ['each part runs until the next steered message, so the parts add up to the turn', [[0, 10], [12, 20]], [], [12, 8]],
    ['a command still running when the steer came in counts in the part before', [[0, null], [12, 20]], [], [12, 8]],
    ['a wait counts in its own part only', [[0, 10], [12, 30]], [[15, 25]], [12, 8]],
    ['a last part with no messages of its own', [[0, 10], [12, null]], [], [12, 0]],
    ['a steered message saved without its time starts where the part before ended', [[0, 10], [null, 20]], [], [10, 10]],
  ] as const)('partWorkTimes: %s', (_name, parts, waits, seconds) => {
    const bounds = parts.map(([start, end]) => ({ startedAt: start == null ? null : s(start), endedAt: end == null ? null : s(end) }))
    const spans = waits.map(([from, to]) => ({ from: s(from), to: s(to) }))
    expect(partWorkTimes(bounds, spans)).toEqual(seconds.map(s))
  })

  it('has no time for a turn that does not say when it started', () => {
    expect(partWorkTimes([{ startedAt: null, endedAt: s(4) }], [])).toEqual([null])
  })

  const at = (seconds: number) => new Date(s(seconds)).toISOString()
  const approval = (seconds: number, data: Record<string, unknown>) => ({ id: `p${seconds}`, role: 'assistant', createdAt: at(seconds), parts: [{ type: 'data-permission-request', data: { requestId: `r${seconds}`, ...data } }] })
  const question = (seconds: number, state = 'output-available') => ({ id: `q${seconds}`, role: 'assistant', createdAt: at(seconds), parts: [tool('tool-Question', `q${seconds}`, { state })] })
  const answers = (seconds: number) => ({ id: `a${seconds}`, role: 'assistant', createdAt: at(seconds), parts: [tool('tool-QuestionAnswers', `a${seconds}`)] })
  const step = (seconds: number) => ({ id: `c${seconds}`, role: 'assistant', createdAt: at(seconds), parts: [tool('tool-Bash', `c${seconds}`)] })
  const secretCall = (seconds: number, type: string, extra: Record<string, unknown> = {}) => ({ id: `s${seconds}`, role: 'assistant', createdAt: at(seconds), parts: [tool(type, `s${seconds}`, extra)] })

  it.each([
    ['an answered approval, from when it was asked to when it was answered', [approval(5, { status: 'answered', settledAt: at(9) })], [[5, 9]]],
    ['a cancelled approval', [approval(5, { status: 'cancelled', settledAt: at(7) })], [[5, 7]]],
    ['an approval still waiting', [approval(5, { status: 'pending' })], [[5, null]]],
    ['an answered approval saved without its answer time', [approval(5, { status: 'answered' })], []],
    ['a question until its answers', [question(3), answers(20), step(21)], [[3, 20]]],
    ['a question asked without waiting: work ran before its answers', [question(3), step(4), answers(20)], []],
    ['a question still waiting', [step(1), question(3, 'input-available')], [[3, null]]],
    ['a secret request still open', [{ id: 'secret:1', role: 'assistant', createdAt: at(6), parts: [{ type: 'data-secret-request', data: { requestId: '1' } }] }], [[6, null]]],
    ['a secret request call waiting: its open request says so', [step(1), secretCall(5, 'tool-mcp__mousse__secret_request', { state: 'input-available' }), { id: 'secret:1', role: 'assistant', createdAt: at(6), parts: [{ type: 'data-secret-request', data: { requestId: '1' } }] }], [[6, null]]],
    ['an answered secret request: from the call to when its result arrived', [secretCall(5, 'tool-mcp__mousse__secret_request', { endedAt: at(300) }), step(301)], [[5, 300]]],
    ['an answered secret request with a call in the same step', [secretCall(5, 'tool-mcp__mousse__secret_request', { endedAt: at(300) }), step(6), step(301)], [[5, 300]]],
    ['an answered secret request that is the turn\'s last call', [step(1), secretCall(5, 'tool-mcp__mousse__secret_request', { endedAt: at(300) })], [[5, 300]]],
    ['an answered secret request under a plain name', [secretCall(5, 'tool-secret_request', { endedAt: at(300) }), step(301)], [[5, 300]]],
    ['a subagent\'s secret request: from the call\'s own start', [{ id: 'sub', role: 'assistant', createdAt: at(1), parts: [tool('tool-Agent', 'sub'), tool('tool-mcp__mousse__secret_request', 'sub:s', { startedAt: at(5), endedAt: at(300) })] }], [[5, 300]]],
    ['an answered secret request saved without its end', [secretCall(5, 'tool-mcp__mousse__secret_request'), step(300)], []],
    ['work alone', [step(1), step(2)], []],
  ])('turnWaitSpans: %s', (_name, messages, expected) => {
    expect(turnWaitSpans(messages).map(({ from, to }) => [from / 1000, to == null ? null : to / 1000])).toEqual(expected)
  })
})

describe('partitionTurnSegments', () => {
  // Messages: c = subagent start, t = thought, x = tool call, r = reply. `near` says which starts are close in time.
  const shape = (kinds: string, near = (_a: number, _b: number) => true) =>
    partitionTurnSegments(
      [...kinds].map((k) => k === 't' || k === 'x'),
      [...kinds].map((k) => k === 'c'),
      [...kinds].map(() => 1),
      undefined,
      { quiet: (i) => kinds[i] === 't', join: near },
    )

  it('joins starts in quick succession into one card list, the thoughts between them above it', () => {
    expect(shape('ctcc')).toEqual([{ kind: 'message', msgIndex: 1 }, { kind: 'cards', msgIndices: [0, 2, 3] }])
    expect(shape('tctcr')).toEqual([
      { kind: 'message', msgIndex: 0 },
      { kind: 'message', msgIndex: 2 },
      { kind: 'cards', msgIndices: [1, 3] },
      { kind: 'message', msgIndex: 4 },
    ])
  })

  it('keeps a thought after the last start where it was', () => {
    expect(shape('cctr')).toEqual([{ kind: 'cards', msgIndices: [0, 1] }, { kind: 'message', msgIndex: 2 }, { kind: 'message', msgIndex: 3 }])
  })

  it('starts a new card list after tool work, narration, or a long gap', () => {
    expect(shape('cxc')).toEqual([{ kind: 'cards', msgIndices: [0] }, { kind: 'message', msgIndex: 1 }, { kind: 'cards', msgIndices: [2] }])
    expect(shape('crc')).toEqual([{ kind: 'cards', msgIndices: [0] }, { kind: 'message', msgIndex: 1 }, { kind: 'cards', msgIndices: [2] }])
    expect(shape('ctc', () => false)).toEqual([{ kind: 'cards', msgIndices: [0] }, { kind: 'message', msgIndex: 1 }, { kind: 'cards', msgIndices: [2] }])
    expect(shape('cc', () => false)).toEqual([{ kind: 'cards', msgIndices: [0] }, { kind: 'cards', msgIndices: [1] }])
  })

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
    }
  }

  it('puts the answer last and keeps the narration before it as prose, where it was', () => {
    const turn = settle([said('n1', 'Checking.'), step('c1'), said('n2', ' Reading the log. '), step('c2'), said('a1', 'Done.'), step('t1', 'tool-Thinking')])
    expect(turn.order).toEqual(['n1', 'c1', 'n2', 'c2', 't1', 'a1'])
    expect(turn.grouped).toEqual(['c1', 'c2', 't1'])
  })

  it('keeps a turn without reply text, and what is not activity, where it was', () => {
    expect(settle([step('c1'), step('c2')]).order).toEqual(['c1', 'c2'])
    const errored = settle([step('c1'), said('a1', 'Done.'), { id: 'e1', role: 'assistant', parts: [{ type: 'error', message: 'Lost' }] }, step('c2')])
    expect(errored.order).toEqual(['c1', 'c2', 'a1', 'e1'])
  })

  it('never takes a steer for the answer', () => {
    const turn = settle([said('a1', 'Started.'), step('c1'), said('s1', 'Also check the docs', 'user')])
    expect(turn.order).toEqual(['c1', 'a1', 's1'])
  })

  it('moves the one reply row of an older turn below the work that came after it', () => {
    // Turns saved before notes had rows of their own keep all their text in the first reply row.
    expect(settle([step('t1', 'tool-Thinking'), said('a1', 'Checking.All done.'), step('c1'), step('t2', 'tool-Thinking')]).order).toEqual(['t1', 'c1', 't2', 'a1'])
  })

  it('keeps a stopped turn in the order it ran when its last text came before its last command', () => {
    // "Running the build." then a command the Stop cut off: the text is narration, not an answer.
    const turn = settle([said('n1', 'Running the build.'), step('c1')], true)
    expect(turn.order).toEqual(['n1', 'c1'])
    const steer = { id: 's1', role: 'user', parts: [], metadata: { steerGroup: [said('m1', 'Also check the docs', 'user')] } }
    const steered = settle([said('a1', 'Started.'), step('c0'), steer, said('n1', 'Checking the docs.'), step('c1'), step('t1', 'tool-Thinking')], true)
    expect(steered.order).toEqual(['a1', 'c0', 's1', 'n1', 'c1', 't1'])
  })

  it('leaves a model switch marker where it is, never as the answer', () => {
    const marker = { id: 'h1', role: 'assistant', parts: [{ type: 'text', text: 'Claude Opus 5.5 → Claude Sonnet 5.5' }], metadata: { contextHandoff: { from: { model: 'opus' }, to: { model: 'sonnet' } } } }
    const turn = settle([marker, step('t1', 'tool-Thinking'), said('a1', 'Done.')])
    expect(turn.order).toEqual(['h1', 't1', 'a1'])
    expect(turn.grouped).toEqual(['t1'])
  })

  it('still ends a stopped turn on text written after its work', () => {
    const turn = settle([said('n1', 'Checking.'), step('c1'), said('a1', 'Half an ans')], true)
    expect(turn.order).toEqual(['n1', 'c1', 'a1'])
  })
})

describe('workGroupHeading', () => {
  const item = (type: string, input: Record<string, unknown> = {}, id = Math.random().toString(36)) => ({ part: tool(type, id, { input }) })
  const run = (command = 'ls') => item('tool-Bash', { command })
  const read = (path: string) => item('tool-Read', { file_path: path })
  const thought = (text: string) => item('tool-Thinking', { thought: text })
  const long = `I need to find where the open-pencil MCP server is configured, so I will look in the Claude settings ${'and more '.repeat(10)}`.trim()

  it.each([
    ['a thought before the calls titles them, what they did follows', [thought('Find the config'), run()], { title: 'Find the config', summary: 'Ran 1 command', thought: true }],
    ['the latest thought before the last call titles the group: the headline last seen while it ran', [thought('Look around'), read('a.ts'), thought('Run the tests'), run()], { title: 'Run the tests', summary: '2 actions', thought: true }],
    ['of the thoughts before the first call, the latest one', [thought('Look around'), thought('Read it'), read('a.ts')], { title: 'Read it', summary: 'Read 1 file', thought: true }],
    ['a thought between calls with none before the first still titles the group', [read('a.ts'), thought('Now run it'), run()], { title: 'Now run it', summary: '2 actions', thought: true }],
    ['a thought after the last call is about what comes next: the count stays the title', [run(), thought('Now the fix')], { title: 'Ran 1 command' }],
    ['no thought: the count is the title', [run(), run()], { title: 'Ran 2 commands' }],
    ['thoughts alone: the latest one, no count', [thought('Look around'), thought('Check the order')], { title: 'Check the order' }],
    ['a long thought is whole: the row cuts it at its width', [thought(long), run()], { title: long, summary: 'Ran 1 command', thought: true }],
    ['an empty thought titles nothing', [thought(''), run()], { title: 'Ran 1 command' }],
    ['a mix counts every call, a file read twice too', [thought('Check it'), read('a.ts'), read('a.ts'), run()], { title: 'Check it', summary: '3 actions', thought: true }],
  ] as const)('%s', (_name, items, expected) => {
    expect(workGroupHeading([...items])).toEqual(expected)
  })
})
