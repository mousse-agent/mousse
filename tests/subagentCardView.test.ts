import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { SubagentCardGroup, SubagentCardView, SubagentTool } from '../src/renderer/chat/components/agent-elements/tools/SubagentCard'
import { SubagentNoticeView } from '../src/renderer/chat/components/agent-elements/tools/SubagentNotice'
import { SubagentCardsContext } from '../src/renderer/chat/components/agent-elements/tools/subagent-cards-context'
import {
  cardElapsedLabel,
  cardGroupElapsedLabel,
  cardGroupLabel,
  cardGroupSummary,
  cardIconStack,
  cardStateNote,
  cardStatusLabel,
  formatElapsed,
  lastResultText,
  LruCache,
  RESULT_CACHE_LIMIT
} from '../src/renderer/chat/components/agent-elements/tools/subagent-card-logic'
import { MessageList } from '../src/renderer/chat/components/agent-elements/message-list'
import {
  analyzeAssistantMessage,
  partitionTurnSegments
} from '../src/renderer/chat/components/agent-elements/utils/assistant-blocks'
import type { SubagentCardModel } from '../src/renderer/chat/adapters/subagentCards'

const NOW = Date.parse('2026-10-25T12:10:00.000Z')

const card = (patch: Partial<SubagentCardModel> = {}): SubagentCardModel => ({
  toolCallId: 'call-1',
  pending: false,
  childThreadId: 'child-1',
  delegationId: 'd1',
  title: 'API reviewer',
  state: 'working',
  provider: 'claude',
  model: 'opus',
  continued: false,
  latest: true,
  waitingOn: [],
  exact: true,
  createdAt: Date.parse('2026-10-25T12:08:00.000Z'),
  completedAt: null,
  ...patch
})

const tool = (type: string, toolCallId: string, extra: Record<string, unknown> = {}) => ({ type, toolCallId, state: 'output-available', input: {}, ...extra })
const subagentTool = (toolCallId: string, extra: Record<string, unknown> = {}) => tool('tool-Subagent', toolCallId, { subagentTool: 'delegate_task', ...extra })

describe('grouping with subagent cards', () => {
  const cardIds = new Set(['card-a', 'card-b'])

  it('keeps a card out of the activity groups, whether its task is running or done', () => {
    const analysis = analyzeAssistantMessage([subagentTool('card-a')], false, cardIds)
    expect(analysis.toolsOnly).toBe(false)
    expect(analysis.cardsOnly).toBe(true)
    expect(analysis.cardParts.map((part) => part.toolCallId)).toEqual(['card-a'])
  })

  it('a call without a card is an ordinary groupable row', () => {
    const analysis = analyzeAssistantMessage([subagentTool('failed-call')], false, cardIds)
    expect(analysis.toolsOnly).toBe(true)
    expect(analysis.cardsOnly).toBe(false)
  })

  it('a message holding a card and another row renders as the message itself', () => {
    const analysis = analyzeAssistantMessage([subagentTool('card-a'), tool('tool-Bash', 'b')], false, cardIds)
    expect(analysis).toMatchObject({ toolsOnly: false, cardsOnly: false, toolItems: [], cardParts: [] })
  })

  it('splits a run of tool rows around a card, and joins consecutive cards into one list', () => {
    // tools, tools, card, tools, tools, card, card, text
    expect(partitionTurnSegments([true, true, false, true, true, false, false, false], [false, false, true, false, false, true, true, false])).toEqual([
      { kind: 'tools', msgIndices: [0, 1] },
      { kind: 'cards', msgIndices: [2] },
      { kind: 'tools', msgIndices: [3, 4] },
      { kind: 'cards', msgIndices: [5, 6] },
      { kind: 'message', msgIndex: 7 }
    ])
  })

  it('partitions as before when nothing is a card', () => {
    expect(partitionTurnSegments([true, true, false, true])).toEqual([
      { kind: 'tools', msgIndices: [0, 1] },
      { kind: 'message', msgIndex: 2 },
      { kind: 'message', msgIndex: 3 }
    ])
  })
})

describe('card text', () => {
  it('says what the subagent is doing in words', () => {
    expect(cardStatusLabel(card({ state: 'working' }))).toBe('Working')
    expect(cardStatusLabel(card({ state: 'needs_input' }))).toBe('Needs input')
    expect(cardStatusLabel(card({ state: 'paused' }))).toBe('Paused')
    expect(cardStatusLabel(card({ state: 'done' }))).toBe('Done')
    expect(cardStatusLabel(card({ state: 'failed' }))).toBe('Failed')
    expect(cardStatusLabel(card({ state: 'stopped' }))).toBe('Stopped')
    expect(cardStatusLabel(card({ state: 'waiting', waitingOn: [] }))).toBe('Waiting on subagents')
    expect(cardStatusLabel(card({ state: 'waiting', waitingOn: [{ title: 'a', state: 'working' }, { title: 'b', state: 'working' }] }))).toBe('Waiting on 2 subagents')
    expect(cardStatusLabel(card({ pending: true, state: 'starting' }))).toBe('Starting')
  })

  it('says when a finished task was continued', () => {
    expect(cardStatusLabel(card({ state: 'done', continued: true }))).toBe('Done · continued')
    expect(cardStatusLabel(card({ state: 'working', continued: true }))).toBe('Working')
  })

  it('times a running task up to now and a finished one by how long it took', () => {
    expect(cardElapsedLabel(card(), NOW)).toBe('2m 00s')
    expect(cardElapsedLabel(card({ state: 'done', completedAt: Date.parse('2026-10-25T12:08:45.000Z') }), NOW)).toBe('45s')
    expect(cardElapsedLabel(card({ state: 'done', completedAt: null }), NOW)).toBeNull()
    expect(cardElapsedLabel(card({ createdAt: null }), NOW)).toBeNull()
    expect([5_000, 125_000, 3_780_000].map(formatElapsed)).toEqual(['5s', '2m 05s', '1h 03m'])
  })

  it('words only the states the status dot cannot say on its own', () => {
    expect(cardStateNote(card({ state: 'working' }))).toBeNull()
    expect(cardStateNote(card({ state: 'queued' }))).toBeNull()
    expect(cardStateNote(card({ pending: true, state: 'starting' }))).toBeNull()
    expect(cardStateNote(card({ state: 'done' }))).toBeNull()
    expect(cardStateNote(card({ state: 'needs_input' }))).toBe('Needs input')
    expect(cardStateNote(card({ state: 'paused' }))).toBe('Paused')
    expect(cardStateNote(card({ state: 'failed' }))).toBe('Failed')
    expect(cardStateNote(card({ state: 'stopped' }))).toBe('Stopped')
    expect(cardStateNote(card({ state: 'waiting', waitingOn: [{ title: 'a', state: 'working' }] }))).toBe('Waiting on 1 subagent')
    expect(cardStateNote(card({ state: 'done', continued: true }))).toBe('Continued')
    expect(cardStateNote(card({ state: 'failed', continued: true }))).toBe('Failed · continued')
  })

  it('sums up a group by what its subagents are doing, what needs the user first', () => {
    expect(cardGroupSummary(Array.from({ length: 5 }, () => card()))).toEqual({ title: '5 subagents', parts: [{ tone: 'running', text: '5 working' }] })
    expect(cardGroupSummary([card(), card({ pending: true, state: 'starting' }), card({ state: 'done' }), card({ state: 'done' }), card({ state: 'done' })]).parts).toEqual([
      { tone: 'running', text: '2 working' },
      { tone: 'done', text: '3 done' }
    ])
    expect(cardGroupSummary([card({ state: 'done' }), card({ state: 'failed' }), card({ state: 'needs_input' }), card({ state: 'waiting' }), card({ state: 'stopped' })]).parts).toEqual([
      { tone: 'attention', text: '1 needs input' },
      { tone: 'attention', text: '1 waiting' },
      { tone: 'failed', text: '1 failed' },
      { tone: 'done', text: '1 done' },
      { tone: 'idle', text: '1 stopped' }
    ])
    expect(cardGroupLabel([card(), card({ state: 'done' }), card({ state: 'done' })])).toBe('3 subagents · 1 working · 2 done')
  })

  it('times a group from its first start to now while any runs, else to its last finish', () => {
    const first = card({ createdAt: Date.parse('2026-10-25T12:08:00.000Z') })
    const second = card({ createdAt: Date.parse('2026-10-25T12:09:00.000Z'), state: 'done', completedAt: Date.parse('2026-10-25T12:09:30.000Z') })
    expect(cardGroupElapsedLabel([first, second], NOW)).toBe('2m 00s')
    const done = { ...first, state: 'done' as const, completedAt: Date.parse('2026-10-25T12:08:40.000Z') }
    expect(cardGroupElapsedLabel([done, second], NOW)).toBe('1m 30s')
    expect(cardGroupElapsedLabel([card({ createdAt: null }), card({ createdAt: null })], NOW)).toBeNull()
  })

  it('stacks at most three icons and counts the rest', () => {
    expect(cardIconStack(['a', 'b'])).toEqual({ shown: ['a', 'b'], extra: 0 })
    expect(cardIconStack(['a', 'b', 'c', 'd', 'e'])).toEqual({ shown: ['a', 'b', 'c'], extra: 2 })
  })

  it('quotes the last finished reply of a subagent, clipped, never a streaming or non-reply row', () => {
    expect(
      lastResultText([
        { role: 'assistant', content: 'Early answer' },
        { role: 'assistant', content: '  Final   answer\nwith\n\nbreaks  ' },
        { role: 'assistant', content: 'still typing', streaming: true },
        { role: 'assistant', kind: 'thinking', content: 'hmm' },
        { role: 'system', content: 'note' }
      ])
    ).toBe('Final answer with breaks')
    expect(lastResultText([{ role: 'user', content: 'hi' }])).toBeNull()
    expect(lastResultText([{ role: 'assistant', content: 'x'.repeat(400) }])!.length).toBe(280)
  })
})

describe('the cache of subagent replies', () => {
  it('holds at most its limit and drops the entry used longest ago', () => {
    const cache = new LruCache<string | null>(3)
    for (const key of ['a', 'b', 'c']) cache.set(key, key)
    expect(cache.get('a')).toBe('a')
    cache.set('d', 'd')
    expect(cache.size).toBe(3)
    expect([cache.has('a'), cache.has('b'), cache.has('c'), cache.has('d')]).toEqual([true, false, true, true])
    cache.set('c', null)
    expect(cache.has('c')).toBe(true)
    expect(cache.get('c')).toBeNull()
    expect(cache.get('missing')).toBeUndefined()
  })

  it('is bounded for the cards, not growing with every subagent read', () => {
    expect(RESULT_CACHE_LIMIT).toBe(200)
    const cache = new LruCache<string | null>(RESULT_CACHE_LIMIT)
    for (let index = 0; index < 1000; index += 1) cache.set(`thread-${index}`, 'reply')
    expect(cache.size).toBe(RESULT_CACHE_LIMIT)
  })
})

describe('SubagentCardView', () => {
  const render = (model: SubagentCardModel, result?: string | null) =>
    renderToStaticMarkup(createElement(SubagentCardView, { card: model, now: NOW, result, onOpen: () => undefined }))

  it('shows the provider icon, title, provider and model, elapsed time, and the last result', () => {
    const html = render(card({ state: 'done', completedAt: Date.parse('2026-10-25T12:09:00.000Z') }), 'Found two issues.')
    expect(html).toContain('subagent-avatar')
    expect(html).toContain('background-color:#D97757')
    expect(html).toContain('API reviewer')
    expect(html).toContain('claude · opus')
    expect(html).toContain('>1m 00s<')
    expect(html).not.toContain('>Done')
    expect(html).toContain('Found two issues.')
    expect(html).toContain('aria-label="Open API reviewer, Done"')
  })

  it('drops the Working text of a running row and keeps its elapsed time', () => {
    const html = render(card())
    expect(html).not.toContain('>Working')
    expect(html).toContain('>2m 00s<')
    expect(html).toContain('aria-label="Open API reviewer, Working"')
  })

  it('puts a status dot on the icon: running, needs input, done, failed', () => {
    expect(render(card())).toContain('data-tone="running"')
    expect(render(card({ state: 'needs_input' }))).toContain('data-tone="attention"')
    expect(render(card({ state: 'needs_input' }))).toContain('>Needs input<')
    expect(render(card({ state: 'done' }))).toContain('data-tone="done"')
    expect(render(card({ state: 'failed' }), 'boom')).toContain('data-tone="failed"')
    expect(render(card({ state: 'failed' }), 'boom')).toContain('>Failed<')
  })

  it('draws the inherited provider for a subagent that names none, else a generic mark', () => {
    const inherited = renderToStaticMarkup(
      createElement(SubagentCardView, { card: card({ provider: null }), now: NOW, inheritedProvider: 'codex', onOpen: () => undefined })
    )
    expect(inherited).toContain('mask-image')
    expect(inherited).not.toContain('#D97757')
    expect(render(card({ provider: null }))).toContain('<svg')
  })

  it('highlights by background only, with no side or edge bar', () => {
    const css = readFileSync(new URL('../src/renderer/chat/components/agent-elements/tools/subagent-card.css', import.meta.url), 'utf8')
    expect(css).not.toMatch(/border-(left|right|inline-start|inline-end)\s*:/)
    expect(css).not.toMatch(/inset\s+-?[1-9]\d*px\s+0/)
    expect(css).not.toMatch(/::(before|after)/)
  })

  it('cannot be opened before its subagent is known', () => {
    const html = render(card({ pending: true, state: 'starting', childThreadId: null, title: 'Docs', createdAt: null }))
    expect(html).toContain('disabled')
    expect(html).toContain('Starting')
  })
})

describe('a subagent tool row', () => {
  const withCards = (cards: SubagentCardModel[], element: ReturnType<typeof createElement>) =>
    renderToStaticMarkup(createElement(SubagentCardsContext.Provider, { value: new Map(cards.map((entry) => [entry.toolCallId, entry])) }, element))

  it('draws the card of a call that started a task', () => {
    const html = withCards([card({ toolCallId: 'c1' })], createElement(SubagentTool, { part: subagentTool('c1') }))
    expect(html).toContain('subagent-card')
    expect(html).toContain('API reviewer')
  })

  it('keeps the raw row of a call that failed, with the reason', () => {
    const html = withCards(
      [],
      createElement(SubagentTool, {
        part: subagentTool('c2', { output: { started: false, code: 'title_taken', message: 'You already have a subagent titled "API reviewer".' } })
      })
    )
    expect(html).not.toContain('subagent-card')
    expect(html).toContain("Couldn&#x27;t start subagent")
    expect(html).toContain('You already have a subagent titled')
  })

  it('keeps the raw row of an errored call', () => {
    const html = withCards([], createElement(SubagentTool, { part: subagentTool('c3', { state: 'output-error' }) }))
    expect(html).not.toContain('subagent-card')
    expect(html).toContain("Couldn&#x27;t start subagent")
  })

  it('says a call cut off before it returned did not finish, and a running one is starting', () => {
    const part = subagentTool('c5', { state: 'input-available', input: { recordVersion: 1 } })
    expect(withCards([], createElement(SubagentTool, { part }))).toContain("Subagent call didn&#x27;t finish")
    const live = withCards([], createElement(SubagentTool, { part, chatStatus: 'streaming' }))
    expect(live).toContain('Starting subagent')
    expect(live).not.toContain('didn')
  })

  it('shows the other subagent tools as plain rows, never as cards', () => {
    const status = withCards([card({ toolCallId: 'c4' })], createElement(SubagentTool, { part: subagentTool('c4x', { subagentTool: 'task_status', input: { subagent: 'API reviewer' } }) }))
    expect(status).not.toContain('subagent-card')
    expect(status).toContain('Checked subagent')
    expect(status).toContain('API reviewer')
  })

  it('folds two or more cards into a group with stacked icons, a coloured summary and a toggle', () => {
    const cards = ['a', 'b', 'c', 'd', 'e'].map((id, index) => card({ toolCallId: id, state: index < 2 ? 'working' : 'done', completedAt: NOW - 1000 }))
    const html = withCards(cards, createElement(SubagentCardGroup, { toolCallIds: cards.map((entry) => entry.toolCallId) }, createElement('span', null, 'rows')))
    expect(html).toContain('aria-label="5 subagents · 2 working · 3 done"')
    expect(html).toContain('>5 subagents<')
    expect(html).toContain('data-tone="running">2 working<')
    expect(html).toContain('data-tone="done">3 done<')
    expect(html.match(/class="subagent-avatar is-chip"/g)).toHaveLength(3)
    expect(html).toMatch(/class="subagent-group-more">\+(<!-- -->)?2</)
    expect(html).toContain('subagent-group-elapsed')
    // Open while any task is going.
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('rows')
  })

  it('starts a group folded once every task has finished', () => {
    const done = [card({ toolCallId: 'a', state: 'done', completedAt: NOW }), card({ toolCallId: 'b', state: 'failed', completedAt: NOW })]
    const html = withCards(done, createElement(SubagentCardGroup, { toolCallIds: ['a', 'b'] }, createElement('span', null, 'rows')))
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('1 failed')
    expect(html).not.toContain('rows')
  })

  it('leaves a single card alone, with no group header', () => {
    const one = withCards([card({ toolCallId: 'a' })], createElement(SubagentCardGroup, { toolCallIds: ['a'] }, createElement('span', null, 'rows')))
    expect(one).not.toContain('subagent-group-head')
    expect(one).toContain('rows')
  })
})

describe('SubagentNoticeView', () => {
  const items = [
    { delegationId: 'd1', childThreadId: 'a', title: 'API reviewer', runStatus: 'completed', fullyShown: true },
    { delegationId: 'd2', childThreadId: 'b', title: 'Docs', runStatus: 'failed', fullyShown: false }
  ]

  it('shows one row per task from the structured payload, each opening its subagent', () => {
    const html = renderToStaticMarkup(createElement(SubagentNoticeView, { items, onOpen: () => undefined }))
    expect(html).toContain('API reviewer')
    expect(html).toContain('finished')
    expect(html).toContain('Docs')
    expect(html).toContain('failed')
    expect(html).toContain('partial result')
    expect(html).toContain('title="Open Docs"')
    expect(html).toContain('data-tone="failed"')
  })

  it('says how many more a long notice leaves out', () => {
    const many = Array.from({ length: 7 }, (_, index) => ({ ...items[0]!, delegationId: `d${index}`, childThreadId: `t${index}`, title: `Task ${index}` }))
    expect(renderToStaticMarkup(createElement(SubagentNoticeView, { items: many, onOpen: () => undefined }))).toContain('and 2 more')
  })
})

describe('the transcript with cards and notices', () => {
  const message = (id: string, role: 'user' | 'assistant', parts: unknown[], metadata?: unknown): UIMessage =>
    ({ id, role, parts, createdAt: '2026-10-25T12:00:00.000Z', metadata }) as unknown as UIMessage

  const render = (messages: UIMessage[], cards: SubagentCardModel[]) =>
    renderToStaticMarkup(
      createElement(
        SubagentCardsContext.Provider,
        { value: new Map(cards.map((entry) => [entry.toolCallId, entry])) },
        createElement(MessageList, { messages, status: 'ready' })
      )
    )

  it('keeps cards out of the collapsed tool group', () => {
    const html = render(
      [
        message('u1', 'user', [{ type: 'text', text: 'Review this' }]),
        message('a1', 'assistant', [tool('tool-Bash', 'b1')]),
        message('a2', 'assistant', [tool('tool-Bash', 'b2')]),
        message('a3', 'assistant', [subagentTool('card-1')]),
        message('a4', 'assistant', [subagentTool('card-2')])
      ],
      [card({ toolCallId: 'card-1', title: 'Reviewer one' }), card({ toolCallId: 'card-2', title: 'Reviewer two', state: 'done' })]
    )
    const group = html.indexOf('Tool calls')
    expect(group).toBeGreaterThan(-1)
    expect(html).toContain('Reviewer one')
    expect(html).toContain('Reviewer two')
    expect(html).toContain('2 subagents · 1 working · 1 done')
    // The group holds its two rows; the cards come after it, not inside it.
    expect(html.indexOf('Reviewer one')).toBeGreaterThan(group)
    expect(html.match(/class="subagent-card"/g)).toHaveLength(2)
  })

  it('draws a wake message as a notice, not as something the user wrote', () => {
    const html = render(
      [
        message('wake', 'user', [{ type: 'text', text: 'Subagent "WRONG NAME" finished task d1. SECRET RESULT TEXT' }], {
          subagentNotice: [{ delegationId: 'd1', childThreadId: 'a', title: 'API reviewer', runStatus: 'completed', fullyShown: true }]
        }),
        message('a1', 'assistant', [{ type: 'text', text: 'Thanks, merging.' }])
      ],
      []
    )
    expect(html).toContain('subagent-notice')
    expect(html).toContain('API reviewer')
    expect(html).not.toContain('WRONG NAME')
    expect(html).not.toContain('SECRET RESULT TEXT')
    expect(html).not.toContain('chat-user-bubble')
    expect(html).not.toContain('data-prompt-id')
    expect(html).toContain('Thanks, merging.')
  })

  it('still draws an ordinary user message as a bubble', () => {
    const html = render([message('u1', 'user', [{ type: 'text', text: 'hello there' }])], [])
    expect(html).toContain('chat-user-bubble')
    expect(html).toContain('data-prompt-id="u1"')
  })
})
