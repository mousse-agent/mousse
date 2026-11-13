/**
 * How a bot's chat reads as a messenger, from its rows alone (botChatShape.ts): replies that only hand work off or pass a
 * note on, the presence under the name and its sticker, and lists that read as a card.
 */
import { describe, expect, it } from 'vitest'
import type { BotChatMessage, BotChip, BotWorkItem } from '../../src/shared/bots/personal/chat'
import { chatRows, isKeyValueList, presenceOf, stickerOf, workSignalsOf } from '../../src/renderer/components/bots/botChatShape'

const started = (title: string, text = 'started'): BotChip => ({ icon: 'think', text, highlight: title })
const noted: BotChip = { icon: 'think', text: 'passed on your note' }
const bot = (id: string, text: string, chips: BotChip[] = [], extra: Partial<BotChatMessage> = {}): BotChatMessage =>
  ({ seq: 0, id, at: '2026-11-13T21:54:00.000Z', author: 'bot', kind: 'text', text, chips, ...extra })
const owner = (id: string, text: string): BotChatMessage => ({ seq: 0, id, at: '2026-11-13T21:53:00.000Z', author: 'owner', kind: 'text', text, chips: [] })

describe('workSignalsOf', () => {
  // [what, message, titles, noted, only]
  const rows: Array<[string, BotChatMessage, string[], boolean, boolean]> = [
    ['"On it." with a start', bot('b', 'On it, I’ll text you when it’s done.', [started('System check')]), ['System check'], false, true],
    ['a start on a model of its own drops the model', bot('b', 'On it.', [started('Vacuum comparison · Opus 5.5')]), ['Vacuum comparison'], false, true],
    ['a note passed on', bot('b', 'Your note’s with it now.', [noted]), [], true, true],
    ['a reply that says more', bot('b', 'Rain at 4.\n\nI also started a forecast.', [started('Forecast')]), ['Forecast'], false, false],
    ['a reply with other work too', bot('b', 'On it.', [started('A'), { icon: 'search', text: 'searched the web' }]), ['A'], false, false],
    ['a reply with an ask', bot('b', 'On it.', [started('A')], { ask: { askId: 'k', title: 'use the browser', note: '', status: 'open' } }), ['A'], false, false],
    ['a report is never left out', bot('b', 'Done.', [started('A')], { kind: 'run_report' }), ['A'], false, false],
    ['a long one-paragraph reply', bot('b', 'x'.repeat(200), [started('A')]), ['A'], false, false]
  ]
  it.each(rows)('%s', (_what, message, titles, isNoted, only) => {
    expect(workSignalsOf(message)).toMatchObject({ titles, noted: isNoted, only })
  })

  it('is nothing for a message that did neither, or for the owner’s', () => {
    expect(workSignalsOf(bot('b', 'Hi.', [{ icon: 'memory', text: 'remembered' }]))).toBeNull()
    expect(workSignalsOf({ ...owner('o', 'x'), chips: [started('A')] })).toBeNull()
  })
})

describe('chatRows', () => {
  it('leaves out a hand-off’s bubble for a line and a 👍 on the message it answers, and a note for "Passed on"', () => {
    const { rows, marks } = chatRows([
      owner('o1', 'run some command pls'),
      bot('b1', 'On it.', [started('System check')], { replyTo: { id: 'o1', author: 'owner', text: 'run some command pls' } }),
      owner('o2', 'Use PC Part Picker'),
      bot('b2', 'Got it.', [noted]),
      bot('b3', 'Two now.', [started('A', 'will start'), started('B', 'will start')])
    ], 'alpha')
    expect(rows.map((row) => (row.kind === 'message' ? row.message.id : row.text))).toEqual(['o1', 'alpha started System check', 'o2', 'alpha will start A and B'])
    expect(marks.get('o1')).toEqual({ reaction: '👍', title: 'On it.' })
    // The later start with no reply-to lands on the owner's last message, beside its receipt.
    expect(marks.get('o2')).toEqual({ passedOn: true, reaction: '👍', title: 'Two now.' })
  })

  it('follows an answered ask with its line, and an open one with none', () => {
    const { rows } = chatRows([
      bot('a1', 'Can I?', [], { ask: { askId: 'k1', title: 'use the browser', note: '', status: 'allowed' } }),
      bot('a2', 'And this?', [], { ask: { askId: 'k2', title: 'run commands', note: '', status: 'not_now' } }),
      bot('a3', 'One more?', [], { ask: { askId: 'k3', title: 'use files on this computer', note: '', status: 'open' } })
    ], 'alpha', () => 'what it did')
    expect(rows.map((row) => (row.kind === 'message' ? row.message.id : [row.text, row.title]))).toEqual([
      'a1', ['You let alpha use the browser', 'what it did'], 'a2', ['You said not now to alpha: run commands', 'what it did'], 'a3'
    ])
  })
})

describe('presence and sticker', () => {
  const item = (id: string, title: string, status: BotWorkItem['status'], startedAt: string): BotWorkItem => ({ id, title, status, startedAt })
  const one = [item('w1', 'System check', 'running', '2026-11-13T21:50:00.000Z')]
  const two = [item('w2', 'Find biggest folders', 'running', '2026-11-13T21:52:00.000Z'), ...one]
  // [what, state, work, typing, offline, text, sticker with no chip]
  const rows: Array<[string, 'idle' | 'working' | 'paused', BotWorkItem[], boolean, boolean, string, string | undefined]> = [
    ['free', 'idle', [], false, false, 'free', undefined],
    ['typing', 'working', [], true, false, 'typing…', 'typing'],
    ['typing wins over work', 'working', one, true, false, 'typing…', 'typing'],
    ['one task alone, never +0', 'working', one, false, false, 'System check', 'working'],
    ['the longest-running task, then +1', 'working', two, false, false, 'System check +1', 'working'],
    ['waiting for internet', 'working', [], false, true, 'waiting for internet', undefined],
    ['paused', 'paused', one, false, false, 'paused', 'paused']
  ]
  it.each(rows)('%s', (_what, state, work, typing, offline, text, sticker) => {
    const presence = presenceOf({ state, work }, { typing, offline })
    expect(presence.text).toBe(text)
    expect(stickerOf(presence, undefined)).toBe(sticker)
  })

  it('shows the lead work’s live activity, and "working" for a kind with no picture', () => {
    const presence = presenceOf({ state: 'working', work: one }, { typing: false, offline: false })
    const kinds = ([
      [{ icon: 'web', text: 'using the browser' }, 'browser'],
      [{ icon: 'web', text: 'reading a page' }, 'web'],
      [{ icon: 'search', text: 'searching the web' }, 'search'],
      [{ icon: 'think', text: 'running a command' }, 'command'],
      [{ icon: 'read', text: 'reading files' }, 'file'],
      [{ icon: 'edit', text: 'saving a file' }, 'file'],
      [{ icon: 'think', text: 'checking with' }, 'working']
    ] as Array<[BotChip, string]>).map(([chip, kind]) => [stickerOf(presence, chip), kind])
    for (const [shown, kind] of kinds) expect(shown).toBe(kind)
    // A task that waits shows no activity of its own.
    expect(stickerOf(presenceOf({ state: 'working', work: [item('q', 'Later', 'queued', '2026-11-13T21:55:00.000Z')] }, { typing: false, offline: false }), { icon: 'search', text: 'searching the web' })).toBe('working')
  })
})

describe('isKeyValueList', () => {
  const text = (value: string) => ({ type: 'text', value })
  const li = (...children: unknown[]) => ({ type: 'element', tagName: 'li', children })
  const strong = (value: string) => ({ type: 'element', tagName: 'strong', children: [text(value)] })
  const ul = (...items: unknown[]) => ({ type: 'element', tagName: 'ul', children: items.flatMap((item) => [text('\n'), item]) }) as never

  it('is a list whose every item starts with a bold key, two items at least', () => {
    expect(isKeyValueList(ul(li(strong('CPU:'), text(' Ryzen 9')), li(strong('RAM'), text(': 19.7 GB'))))).toBe(true)
    expect(isKeyValueList(ul(li(strong('CPU:'), text(' Ryzen 9'))))).toBe(false)
    expect(isKeyValueList(ul(li(strong('CPU:'), text(' Ryzen 9')), li(text('plain'))))).toBe(false)
    expect(isKeyValueList(ul(li(strong('Note'), text(' this is bold, not a key')), li(strong('Other'), text(' one'))))).toBe(false)
    expect(isKeyValueList(ul(li(strong('A:'), text(' x'), { type: 'element', tagName: 'ul', children: [] }), li(strong('B:'), text(' y'))))).toBe(false)
  })
})
