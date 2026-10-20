/** SPEC §16.1 Delivery: how a planned handoff reaches the provider. */
import { describe, expect, it } from 'vitest'
import { handoffMessages, promptWithHandoff, renderHandoffBlock } from '../../src/mms/run/handoff/delivery'
import type { SelectedHandoffItem } from '../../src/mms/run/handoff/budget'
import type { HandoffPlan } from '../../src/mms/run/handoff/HandoffService'

const item = (index: number, role: 'user' | 'assistant', text: string, compacted = false): SelectedHandoffItem => ({ index, runOrdinal: 1, role, text, compacted })

function plan(history: SelectedHandoffItem[], over: { pointer?: string; from?: number | null; to?: number | null; omitted?: number; strategy?: HandoffPlan['strategy'] } = {}): Pick<HandoffPlan, 'strategy' | 'history' | 'pointer' | 'record'> {
  return {
    strategy: over.strategy ?? 'delta',
    history,
    pointer: over.pointer ?? '',
    record: {
      coveredFromOrdinal: over.from === undefined ? 1 : over.from, coveredToOrdinal: over.to === undefined ? 3 : over.to,
      selectedItems: history.length, omittedItems: over.omitted ?? 0,
      toRef: { provider: 'codex', model: 'gpt-test', instanceId: 'codex' }
    } as HandoffPlan['record']
  }
}

describe('handoff delivery', () => {
  it('renders the prompt block with covered range, item counts, compaction marks and the recovery pointer', () => {
    const block = renderHandoffBlock(plan([item(0, 'user', 'first'), item(1, 'assistant', 'second', true)], { omitted: 2, pointer: 'Use thread_read for 2 older items.' }))
    expect(block).toBe([
      '<handoff strategy="delta" covered="1-3" items="2/4">',
      '[user] first',
      '[assistant, compacted] second',
      '</handoff>',
      'Use thread_read for 2 older items.'
    ].join('\n'))
  })

  it.each([
    ['no run covered', null, null, 'none'],
    ['one run covered', 4, 4, '4'],
    ['a range covered', 2, 5, '2-5']
  ])('names the covered range when %s', (_title, from, to, covered) => {
    expect(renderHandoffBlock(plan([item(0, 'user', 'x')], { from, to }))).toContain(`covered="${covered}"`)
    expect(handoffMessages(plan([item(0, 'user', 'x')], { from, to }))[0]).toMatchObject({ content: expect.stringContaining(`covered=${covered}.`) })
  })

  it('puts the block in front of the prompt for a prompt-injected runtime', () => {
    const delivered = promptWithHandoff(plan([item(0, 'user', 'earlier')]), 'now do the thing')
    expect(delivered.endsWith('</handoff>\n\nnow do the thing')).toBe(true)
    expect(delivered.startsWith('<handoff ')).toBe(true)
  })

  it('delivers nothing as messages when nothing was selected and nothing was omitted', () => {
    expect(handoffMessages(plan([], { from: null, to: null }))).toEqual([])
  })

  it('still opens with a header carrying the pointer when everything was omitted', () => {
    const messages = handoffMessages(plan([], { omitted: 3, pointer: 'Use thread_read.' }))
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ role: 'user', content: '[Context handoff: strategy=delta, covered=1-3. Use thread_read.]' })
  })

  it('joins consecutive items of one role so roles alternate, and heads the first user message with the header', () => {
    const messages = handoffMessages(plan([item(0, 'user', 'a'), item(1, 'user', 'b'), item(2, 'assistant', 'c'), item(3, 'assistant', 'd'), item(4, 'user', 'e')]))
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user'])
    expect(messages[0]).toMatchObject({ content: '[Context handoff: strategy=delta, covered=1-3.]\n\na\n\nb' })
    expect(messages[1]).toMatchObject({ content: [{ type: 'text', text: 'c\n\nd' }], provider: 'codex', model: 'gpt-test', stopReason: 'stop' })
    expect(messages[2]).toMatchObject({ content: 'e' })
  })

  it('opens with a header-only user message when history starts with an assistant item', () => {
    const messages = handoffMessages(plan([item(0, 'assistant', 'I answered first')]))
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(messages[0]).toMatchObject({ content: '[Context handoff: strategy=delta, covered=1-3.]' })
  })

  it('names the handoff model in assistant messages, defaulting when the target has no model', () => {
    const messages = handoffMessages({ ...plan([item(0, 'assistant', 'x')]), record: { ...plan([]).record, toRef: { provider: 'codex', instanceId: 'codex' } } as HandoffPlan['record'] })
    expect(messages[1]).toMatchObject({ model: 'handoff' })
  })
})
