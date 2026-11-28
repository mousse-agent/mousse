/**
 * How a bot's chat reads as a messenger, from its rows alone (botChatShape.ts): replies that only hand work off or pass a
 * note on, the presence under the name and its sticker, and lists that read as a card.
 */
import { describe, expect, it } from 'vitest'
import type { BotChatMessage, BotChip, BotLaunchedThread, BotWorkItem } from '../../src/shared/bots/personal/chat'
import { botMessageRowId, botMessageRowText } from '../../src/shared/bots/personal/botMessages'
import { botDoingLine, botExchanges, botRowLine, chatRows, launchedGroups, launchedLook, presenceOf, stickerOf, workSignalsOf, type BotChatRow } from '../../src/renderer/components/bots/botChatShape'

const started = (title: string, text = 'started'): BotChip => ({ icon: 'think', text, highlight: title })
const noted: BotChip = { icon: 'think', text: 'passed on your note' }
const bot = (id: string, text: string, chips: BotChip[] = [], extra: Partial<BotChatMessage> = {}): BotChatMessage =>
  ({ seq: 0, id, at: '2026-11-13T21:54:00.000Z', author: 'bot', kind: 'text', text, chips, ...extra })
const owner = (id: string, text: string): BotChatMessage => ({ seq: 0, id, at: '2026-11-13T21:53:00.000Z', author: 'owner', kind: 'text', text, chips: [] })

describe('botExchanges', () => {
  let n = 0
  /** A row another bot's message left: `bm_botmsg_<sender id>_<uuid>`, framed as the service writes it. */
  const from = (name: string): BotChatRow => {
    n += 1
    return { kind: 'message', message: bot(botMessageRowId(`bot-${name}`, `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`), botMessageRowText(name, `Note ${n}`)) }
  }
  const reply: BotChatRow = { kind: 'message', message: bot('r', 'Alpha says it passed.') }
  const asked: BotChatRow = { kind: 'message', message: owner('o', 'Ask Alpha.') }
  const line: BotChatRow = { kind: 'system', id: 's', at: '2026-11-13T21:54:00.000Z', text: 'You let Pippy use the browser' }
  // The frame's words on a row that is not another bot's message (its id says so) stay the bot's own.
  const framedOnly: BotChatRow = { kind: 'message', message: bot('m9', botMessageRowText('Alpha', 'Not really from Alpha.')) }
  const NEW_DAY = { day: 'Today' }
  // [what, rows, day lines by row, runs as [start, end, sender names]]
  const cases: Array<[string, () => BotChatRow[], Array<{ day?: string } | undefined>, Array<[number, number, string[]]>]> = [
    ['one message is a run of its own', () => [asked, from('Alpha'), reply], [], [[1, 2, ['Alpha']]]],
    ['messages in a row from one bot are one run', () => [from('Alpha'), from('Alpha'), from('Alpha')], [], [[0, 3, ['Alpha']]]],
    ['two bots in a row are one run, each named once', () => [from('Alpha'), from('Beta'), from('Alpha')], [], [[0, 3, ['Alpha', 'Beta']]]],
    ["the bot's own reply ends a run", () => [from('Alpha'), reply, from('Alpha')], [], [[0, 1, ['Alpha']], [2, 3, ['Alpha']]]],
    ["the owner's message ends a run", () => [from('Alpha'), asked, from('Alpha')], [], [[0, 1, ['Alpha']], [2, 3, ['Alpha']]]],
    ['a quiet line ends a run', () => [from('Alpha'), line, from('Alpha')], [], [[0, 1, ['Alpha']], [2, 3, ['Alpha']]]],
    ['a new day ends a run, so its day line shows', () => [from('Alpha'), from('Alpha')], [undefined, NEW_DAY], [[0, 1, ['Alpha']], [1, 2, ['Alpha']]]],
    ['a row with the words but not the id of one is none', () => [framedOnly, asked, reply], [], []]
  ]
  it.each(cases)('%s', (_what, rows, days, runs) => {
    const shown = rows()
    const found = botExchanges(shown, days)
    expect(found.map((run) => [run.start, run.end, run.senders.map((sender) => sender.name)])).toEqual(runs)
    // A run is known by its first message, so it keeps its id as it grows.
    for (const run of found) expect(run.id).toBe((shown[run.start] as Extract<BotChatRow, { kind: 'message' }>).message.id)
  })
})

describe('workSignalsOf', () => {
  // [what, message, titles, noted, only]
  const rows: Array<[string, BotChatMessage, string[], boolean, boolean]> = [
    ['a start with no words', bot('b', '', [started('System check')]), ['System check'], false, true],
    ['a start on a model of its own drops the model', bot('b', ' ', [started('Vacuum comparison · Opus 5.5')]), ['Vacuum comparison'], false, true],
    ['a note passed on with no words', bot('b', '', [noted]), [], true, true],
    // Any words keep the bubble: a reaction or a line never carries the reply.
    ['"On it." with a start', bot('b', 'On it, I’ll text you when it’s done.', [started('System check')]), ['System check'], false, false],
    ['a note with words', bot('b', 'I’ll use that tab from here on.', [{ icon: 'think', text: 'noted', title: 'For SSD search' }]), [], true, false],
    ['a reply that says more', bot('b', 'Rain at 4.\n\nI also started a forecast.', [started('Forecast')]), ['Forecast'], false, false],
    ['a reply with other work too', bot('b', '', [started('A'), { icon: 'search', text: 'searched the web' }]), ['A'], false, false],
    ['a reply with an ask', bot('b', '', [started('A')], { ask: { askId: 'k', title: 'use the browser', note: '', status: 'open' } }), ['A'], false, false],
    ['a report is never left out', bot('b', '', [started('A')], { kind: 'run_report' }), ['A'], false, false]
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
  it('puts a line and a 👍 on the message a start answers, and keeps every reply with words as a message', () => {
    const { rows, marks } = chatRows([
      owner('o1', 'run some command pls'),
      bot('b1', 'On it.', [started('System check')], { replyTo: { id: 'o1', author: 'owner', text: 'run some command pls' } }),
      owner('o2', 'Use PC Part Picker'),
      bot('b2', 'Got it.', [{ ...noted, title: 'For SSD search' }]),
      bot('b3', '', [started('A', 'will start'), started('B', 'will start')])
    ], 'alpha')
    expect(rows.map((row) => (row.kind === 'message' ? row.message.id : row.text))).toEqual(['o1', 'alpha started System check', 'b1', 'o2', 'b2', 'alpha will start A and B'])
    // The reply's words never move onto the mark.
    expect(marks.get('o1')).toEqual({ reaction: '👍' })
    // The later start with no reply-to lands on the owner's last message, beside its receipt.
    expect(marks.get('o2')).toEqual({ passedOn: true, reaction: '👍', title: 'For SSD search' })
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

  it('threads the bot started and still manages keep it busy, alone or beside its work', () => {
    const thread = (threadId: string, title: string, status: BotLaunchedThread['status'] = 'running'): BotLaunchedThread => ({ threadId, title, status, startedAt: '2026-11-13T21:40:00.000Z', updatedAt: '2026-11-13T21:40:00.000Z' })
    const threads = [thread('t1', 'Dictation mock-ups'), thread('t2', 'Typing dots shimmer')]
    const rows: Array<[string, BotWorkItem[], BotLaunchedThread[], string, string | undefined]> = [
      ['one thread alone names it', [], threads.slice(0, 1), 'Managing Dictation mock-ups', 'working'],
      ['several threads are counted', [], threads, 'Managing 2 threads', 'working'],
      ['work leads, threads add to +N', one, threads, 'System check +2', 'working'],
      ['none left: free', [], [], 'free', undefined],
      ['threads that ended or sit idle: free', [], [thread('t3', 'A', 'done'), thread('t4', 'B', 'failed'), thread('t5', 'C', 'stopped'), thread('t6', 'D', 'idle')], 'free', undefined],
      ['waiting on the owner still counts', [], [thread('t2', 'Typing dots shimmer', 'needs_input'), thread('t3', 'A', 'done')], 'Managing Typing dots shimmer', 'working'],
      ['on hold for the owner (a pause only Resume now ends): free', [], [thread('t7', 'Fix login', 'on_hold'), thread('t3', 'A', 'done')], 'free', undefined],
      ['on hold beside one that works: only the working one is managed', [], [thread('t7', 'Fix login', 'on_hold'), thread('t1', 'Dictation mock-ups')], 'Managing Dictation mock-ups', 'working']
    ]
    for (const [what, work, launched, text, sticker] of rows) {
      const presence = presenceOf({ state: text === 'free' ? 'idle' : 'working', work, threads: launched }, { typing: false, offline: false })
      expect([what, presence.text, stickerOf(presence, undefined)]).toEqual([what, text, sticker])
    }
    expect(presenceOf({ state: 'paused', threads }, { typing: false, offline: false }).text).toBe('paused')
  })

  it('background commands add to +N beside work or threads, and alone say what it waits on, still free', () => {
    const watcher = (id: string, title: string) => ({ id, title, command: 'make', startedAt: '2026-11-13T21:40:00.000Z', until: '2026-11-13T22:40:00.000Z' })
    const thread: BotLaunchedThread = { threadId: 't1', title: 'Dictation mock-ups', status: 'running', startedAt: '2026-11-13T21:40:00.000Z', updatedAt: '2026-11-13T21:40:00.000Z' }
    const rows: Array<[string, BotWorkItem[], BotLaunchedThread[], ReturnType<typeof watcher>[], string, string]> = [
      ['work leads', one, [], [watcher('w1', 'Nightly')], 'System check +1', 'busy'],
      ['a thread leads', [], [thread], [watcher('w1', 'Nightly')], 'Managing Dictation mock-ups +1', 'busy'],
      ['one alone names it', [], [], [watcher('w1', 'Nightly')], 'Waiting on Nightly', 'free'],
      ['several alone are counted', [], [], [watcher('w1', 'Nightly'), watcher('w2', 'Tests')], 'Waiting on 2 things', 'free']
    ]
    for (const [what, work, threads, watchers, text, kind] of rows) {
      const presence = presenceOf({ state: 'idle', work, threads, watchers }, { typing: false, offline: false })
      expect([what, presence.text, presence.kind]).toEqual([what, text, kind])
    }
  })

  it("splits the threads it started into those going (working, then waiting on the owner) and the rest (idle, then ended), each with its tint and word", () => {
    const thread = (threadId: string, status: BotLaunchedThread['status']): BotLaunchedThread => ({ threadId, title: threadId, status, startedAt: '2026-11-13T21:40:00.000Z', updatedAt: '2026-11-13T21:40:00.000Z' })
    const statuses: Array<[BotLaunchedThread['status'], string, string]> = [
      ['done', 'done', 'done'], ['needs_input', 'waiting', 'waiting on you'], ['running', 'working', 'working'], ['failed', 'failed', 'failed'],
      ['queued', 'working', 'queued'], ['idle', 'idle', 'idle'], ['stopped', 'failed', 'stopped'], ['paused', 'working', 'held'],
      ['subagents', 'working', 'waiting on subagents'], ['on_hold', 'waiting', 'waiting on you']
    ]
    for (const [status, tone, label] of statuses) expect([status, launchedLook(status)]).toEqual([status, { tone, label }])
    const { going, ended } = launchedGroups(statuses.map(([status]) => thread(status, status)), Date.parse('2026-11-14T01:00:00.000Z'))
    // Started at the same time here, so ties go by id.
    expect(going.map((item) => item.status)).toEqual(['paused', 'queued', 'running', 'subagents', 'needs_input', 'on_hold'])
    expect(ended.map((item) => item.status)).toEqual(['idle', 'done', 'failed', 'stopped'])
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

describe('the line beside the typing dots', () => {
  it('is only the bot’s own words; without them, the dots show alone', () => {
    expect(botDoingLine({ status: 'Comparing the two drives now' })).toEqual({ text: 'Comparing the two drives now', own: true })
    expect(botDoingLine({})).toEqual({ text: '', idle: true })
  })
})

describe('the line under a bot in the sidebar', () => {
  const work = (title: string, startedAt = '2026-11-13T21:50:00.000Z'): BotWorkItem => ({ id: title, title, status: 'running', startedAt })
  type Bot = Parameters<typeof botRowLine>[0]
  // [what, the bot, tone, words, whether its face sleeps]
  const rows: Array<[string, Bot, ReturnType<typeof botRowLine>['tone'], string, boolean]> = [
    ['nothing at all: idle, asleep', { state: 'idle', stateText: '' }, 'idle', 'Idle', true],
    ['paused, even with work', { state: 'paused', stateText: 'Paused', work: [work('System check')] }, 'idle', 'Paused', false],
    ['an ask waits on the owner', { state: 'needs_you', stateText: 'Wants to use files on this computer' }, 'needs', 'Wants to use files on this computer', false],
    ['stuck waits on the owner', { state: 'stuck', stateText: 'Needs you: Set up a provider so I can work.' }, 'needs', 'Needs you: Set up a provider so I can work.', false],
    ['an open question beats work', { state: 'working', stateText: 'Working…', needsOwner: true, work: [work('System check')] }, 'needs', 'Working…', false],
    ['its work, the longest-running first', { state: 'working', stateText: 'Working…', work: [work('Review PR', '2026-11-13T21:52:00.000Z'), work('System check')] }, 'working', 'System check +1', false],
    ['its chat turn writes', { state: 'working', stateText: 'Working…', chat: { activationId: 'a1' } }, 'working', 'Typing…', false],
    ['waiting for the internet', { state: 'working', stateText: 'Waiting for internet', chat: { activationId: 'a1', offline: true } }, 'idle', 'Waiting for internet', false],
    ['working with nothing listed', { state: 'working', stateText: 'Working…' }, 'working', 'Working…', false],
    ['only a background command: awake, waiting', { state: 'idle', stateText: '', watchers: [{ id: 'w', title: 'the build', command: 'npm run build', startedAt: '2026-11-13T21:50:00.000Z', until: '2026-11-13T22:50:00.000Z' }] }, 'idle', 'Waiting on the build', false]
  ]
  it.each(rows)('%s', (_what, bot, tone, text, resting) => {
    expect(botRowLine(bot)).toEqual({ tone, text, resting })
  })
})
