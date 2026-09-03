import { describe, expect, it } from 'vitest'
import {
  extractCommandSummary,
  formatSearchRowLabels,
  thoughtHeading,
} from '../src/renderer/chat/components/agent-elements/utils/format-tool'
import { mapPartStateToInvocationState } from '../src/renderer/chat/components/agent-elements/utils/tool-adapters'
import {
  analyzeAssistantMessage,
  partitionTurnSegments,
} from '../src/renderer/chat/components/agent-elements/utils/assistant-blocks'

const tool = (type: string, toolCallId: string, extra: Record<string, unknown> = {}) => ({
  type,
  toolCallId,
  state: 'output-available',
  input: {},
  ...extra,
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

describe('extractCommandSummary', () => {
  it('collapses whitespace and truncates long commands', () => {
    expect(extractCommandSummary('npm run dev')).toBe('npm run dev')
    expect(extractCommandSummary('  find .  -name\n"x"  ')).toBe('find . -name "x"')
    const long = extractCommandSummary(`x${'y'.repeat(100)}`)
    expect(long.endsWith('...')).toBe(true)
    expect(long.length).toBeLessThanOrEqual(64)
    expect(extractCommandSummary('')).toBe('')
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

  it('rejects messages with thought or question rows', () => {
    expect(
      analyzeAssistantMessage(
        [tool('tool-Thinking', 't'), tool('tool-Bash', 'a')],
        false
      ).toolsOnly
    ).toBe(false)
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

  it('keeps file-write tools out of groups so edits stay visible', () => {
    // Current Pi tool names.
    expect(analyzeAssistantMessage([tool('tool-Write', 'w')], false).toolsOnly).toBe(false)
    expect(analyzeAssistantMessage([tool('tool-Edit', 'e')], false).toolsOnly).toBe(false)
    // Legacy / variant names: write_file normalizes to tool-Write_file.
    expect(analyzeAssistantMessage([tool('tool-Write_file', 'w')], false).toolsOnly).toBe(false)
    expect(analyzeAssistantMessage([tool('tool-Apply_patch', 'p')], false).toolsOnly).toBe(false)
    // Same-named MCP tools also stay expanded.
    expect(
      analyzeAssistantMessage([tool('tool-mcp__custom__write', 'w')], false).toolsOnly
    ).toBe(false)
    // A write breaks an otherwise groupable run; reads still group.
    expect(partitionTurnSegments([true, false, true])).toEqual([
      { kind: 'message', msgIndex: 0 },
      { kind: 'message', msgIndex: 1 },
      { kind: 'message', msgIndex: 2 },
    ])
    expect(
      analyzeAssistantMessage([tool('tool-Read', 'r')], false).toolsOnly
    ).toBe(true)
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
})
