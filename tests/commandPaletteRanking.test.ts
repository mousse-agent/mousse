import { describe, expect, it } from 'vitest'
import { COMMANDS, type CommandContext, type CommandId } from '../src/shared/commands'
import type { Project, Thread, ThreadSearchResult } from '../src/shared/types'
import { rankItems, scoreItem } from '../src/renderer/commands/paletteRank'
import {
  MESSAGE_HITS_PER_THREAD,
  RECENT_THREAD_COUNT,
  buildPaletteGroups,
  categoryLabels,
  eligibleCommands,
  flattenGroups,
  markMatches,
  messageQuery,
  paletteKeyAction,
  type PaletteGroup,
  type PaletteItem
} from '../src/renderer/commands/paletteItems'

const titles = (query: string, items: string[]) => rankItems(query, items.map((title) => ({ title }))).map((item) => item.title)

describe('rankItems', () => {
  it('finds a title from its words run together', () => {
    expect(titles('newth', ['Open terminal', 'New thread', 'Next thread'])).toEqual(['New thread'])
  })

  it('does not find a word through a short fragment inside it', () => {
    expect(titles('del', ['Pick model 1', 'Delete workflow node'])).toEqual(['Delete workflow node'])
    expect(titles('del', ['Pick model 1'])).toEqual([])
  })

  it('finds a row through its hidden terms, at word starts only', () => {
    const stop = [{ title: 'Stop run', terms: ['interrupt', 'cancel'] }, { title: 'Open terminal', terms: ['shell'] }]
    expect(rankItems('interrupt', stop).map((item) => item.title)).toEqual(['Stop run'])
    expect(rankItems('stop', stop).map((item) => item.title)).toEqual(['Stop run'])
    expect(rankItems('rupt', stop)).toEqual([])
  })

  it('does not treat a numeric difference as a typo', () => {
    expect(titles('#124', ['Fix #123'])).toEqual([])
    expect(titles('#13', ['Fix #123'])).toEqual([])
    expect(titles('#12', ['Fix #123'])).toEqual(['Fix #123'])
  })

  it('forgives one typo only in words of four letters or more', () => {
    expect(titles('stpo', ['Stop run'])).toEqual(['Stop run'])
    expect(titles('trminal', ['Open terminal'])).toEqual(['Open terminal'])
    expect(titles('snp', ['Stop run'])).toEqual([])
    expect(titles('sxxp', ['Stop run'])).toEqual([])
  })

  it('matches a fragment inside a word only from four characters', () => {
    expect(titles('ggle', ['Toggle side card'])).toEqual(['Toggle side card'])
    expect(titles('ggl', ['Toggle side card'])).toEqual([])
  })

  it('ignores case and accents', () => {
    expect(titles('resume', ['Résumé draft', 'Other'])).toEqual(['Résumé draft'])
    expect(titles('RÉSUMÉ', ['resume draft'])).toEqual(['resume draft'])
  })

  it('splits camelCase and digit runs into words', () => {
    expect(titles('thread', ['openThreadPane'])).toEqual(['openThreadPane'])
    expect(titles('v2', ['Release v2 notes'])).toEqual(['Release v2 notes'])
  })

  it('ranks a title that starts with the query above one that only has it in a later word, and keeps input order for ties', () => {
    expect(titles('thr', ['Next thread', 'Threads overview', 'Thread notes'])).toEqual([
      'Threads overview',
      'Thread notes',
      'Next thread'
    ])
  })

  it('returns everything in order for an empty query', () => {
    expect(titles('', ['b', 'a'])).toEqual(['b', 'a'])
    expect(titles('   ', ['b', 'a'])).toEqual(['b', 'a'])
  })

  it('scores a miss as zero', () => {
    expect(scoreItem('zzz', { title: 'New thread' })).toBe(0)
  })
})

const ctx = (over: Partial<CommandContext> = {}): CommandContext => ({
  platform: 'win32',
  inTextInput: false,
  inTerminal: false,
  overlay: null,
  threadOpen: true,
  runActive: true,
  mainAreaOpen: true,
  projectsMode: true,
  // The Files panel is showing, so its quick open and text search commands are eligible too.
  inFilesPanel: true,
  ...over
})

function thread(id: string, name: string, over: Partial<Thread> = {}): Thread {
  return {
    id,
    name,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:01.000Z',
    order: 0,
    ...over
  }
}

const project = (id: string, name: string): Project => ({ id, name, path: `/work/${name}`, createdAt: '2026-01-01T00:00:00.000Z', order: 0 })

const registeredAll = () => true
const allCommands = eligibleCommands(ctx(), registeredAll)

const labels = (groups: PaletteGroup[]) => groups.map((group) => `${group.label}: ${group.items.map((item) => item.title).join(', ')}`)

describe('eligibleCommands', () => {
  it('lists registered commands, without the palette toggle, display-only entries or picker chords', () => {
    const ids = allCommands.map((item) => (item.kind === 'command' ? item.id : null))
    expect(ids).toContain('thread.new')
    expect(ids).toContain('run.stop')
    expect(ids).not.toContain('palette.open')
    expect(ids).not.toContain('workflow.undo')
    expect(ids).not.toContain('git.commit')
    // The model picker is not open, so its chords are not commands to offer.
    expect(ids).not.toContain('model.pick1')
  })

  it('hides commands nothing is registered for, and those whose rule is false', () => {
    const registered = new Set<CommandId>(['thread.new', 'run.stop', 'composer.focus'])
    const ids = (context: CommandContext) =>
      eligibleCommands(context, (id) => registered.has(id)).map((item) => (item.kind === 'command' ? item.id : null))
    // Listed by group: Threads, then Composer (Focus composer leads it).
    expect(ids(ctx())).toEqual(['thread.new', 'composer.focus', 'run.stop'])
    expect(ids(ctx({ runActive: false }))).toEqual(['thread.new', 'composer.focus'])
    expect(ids(ctx({ threadOpen: false, runActive: false }))).toEqual(['thread.new'])
  })

  it('lists a text-denied command, since a palette row is not typed into a field', () => {
    const ids = eligibleCommands(ctx(), (id) => id === 'surface.browser').map((item) => (item.kind === 'command' ? item.id : null))
    expect(ids).toEqual(['surface.browser'])
    // The same command is gone once its own rule fails.
    expect(eligibleCommands(ctx({ mainAreaOpen: false }), (id) => id === 'surface.browser')).toEqual([])
  })

  it('has a row for every non-fixed command that can be registered', () => {
    const expected = COMMANDS.filter((command) => !command.fixed && command.id !== 'palette.open' && command.scope !== 'model-picker')
    expect(allCommands).toHaveLength(expected.length)
  })
})

describe('buildPaletteGroups', () => {
  const projects = [project('p1', 'Mousse'), project('p2', 'Website')]
  const threads = [
    thread('t1', 'New thread ideas', { projectId: 'p1', updatedAt: '2026-03-01T00:00:00.000Z' }),
    thread('t2', 'Fix login', { projectId: 'p2', updatedAt: '2026-04-01T00:00:00.000Z' }),
    thread('t3', 'Résumé layout', { updatedAt: '2026-02-01T00:00:00.000Z' }),
    thread('t4', 'Shelved work', { archivedAt: '2026-04-02T00:00:00.000Z', updatedAt: '2026-04-02T00:00:00.000Z' }),
    thread('t5', 'Thread 5', { startedAt: undefined, name: 'New Thread', updatedAt: '2026-05-01T00:00:00.000Z' })
  ]
  const build = (query: string, commands = allCommands) => buildPaletteGroups({ query, commands, threads, projects })

  it('shows the newest threads, then every eligible command, for an empty query', () => {
    const groups = build('')
    expect(groups.map((group) => group.label)).toEqual(['Recent', 'Commands'])
    // Newest first; the archived thread and the empty draft are not listed.
    expect(groups[0]!.items.map((item) => item.kind === 'thread' && item.id)).toEqual(['t2', 't1', 't3'])
    expect(groups[1]!.items).toHaveLength(allCommands.length)
  })

  it('shows only the recent threads in message mode before anything is typed; commands wait for text or >', () => {
    const groups = buildPaletteGroups({ query: '', commands: allCommands, threads, projects, mode: 'messages' })
    expect(groups.map((group) => group.label)).toEqual(['Recent'])
    const commandsOnly = buildPaletteGroups({ query: '>', commands: allCommands, threads, projects, mode: 'messages' })
    expect(commandsOnly.map((group) => group.label)).toEqual(['Commands'])
  })

  it("names a command's category once per run of same-category rows", () => {
    const command = (id: string, category: string) => ({ ...allCommands[0]!, key: `command:${id}`, category }) as PaletteItem
    const rows: PaletteItem[] = [
      command('a', 'Thread'),
      command('b', 'Thread'),
      command('c', 'Thread'),
      command('d', 'View'),
      command('e', 'Thread'),
      { kind: 'thread', key: 'thread:t1', id: 't1', title: 'Fix login' }
    ]
    expect(categoryLabels(rows)).toEqual(['Thread', undefined, undefined, 'View', 'Thread', undefined])
  })

  it('caps the recent threads', () => {
    const many = Array.from({ length: 12 }, (_, i) => thread(`m${i}`, `Thread ${i}`, { updatedAt: `2026-06-${String(i + 10)}T00:00:00.000Z` }))
    const groups = buildPaletteGroups({ query: '', commands: [], threads: many, projects: [] })
    expect(groups[0]!.items).toHaveLength(RECENT_THREAD_COUNT)
    expect(groups[0]!.items[0]).toMatchObject({ kind: 'thread', id: 'm11' })
  })

  it('finds a command and a thread with the same words, commands first', () => {
    const groups = build('newth')
    expect(labels(groups)).toEqual(['Commands: New thread', 'Threads: New thread ideas'])
  })

  it('finds a thread with an accented title and a project by name, with the project\'s newest thread as its target', () => {
    expect(build('resume').find((group) => group.label === 'Threads')!.items).toMatchObject([{ id: 't3' }])
    const projectRows = build('mous').find((group) => group.label === 'Projects')!.items
    expect(projectRows).toMatchObject([{ kind: 'project', id: 'p1', threadId: 't1' }])
    expect(build('web').find((group) => group.label === 'Projects')!.items).toMatchObject([{ id: 'p2', threadId: 't2' }])
  })

  it('names the project on a thread row', () => {
    const items = build('login').find((group) => group.label === 'Threads')!.items
    expect(items).toMatchObject([{ id: 't2', detail: 'Website' }])
  })

  it('finds archived threads by title in their own group after the open ones, and leaves empty drafts out', () => {
    const shelved = build('shelved')
    expect(shelved.find((group) => group.label === 'Archived')!.items).toMatchObject([{ id: 't4' }])
    expect(shelved.some((group) => group.label === 'Threads')).toBe(false)
    const withOpen = buildPaletteGroups({ query: 'work', commands: [], threads: [threads[3]!, thread('t6', 'Open work', { projectId: 'p1' })], projects })
    expect(labels(withOpen)).toEqual(['Threads: Open work', 'Archived: Shelved work'])
    expect(withOpen[0]!.items).toMatchObject([{ id: 't6', detail: 'Mousse' }])
    expect(flattenGroups(build('new')).some((item) => item.kind === 'thread' && item.id === 't5')).toBe(false)
  })

  it('names an archived thread whose messages alone match', () => {
    const hit: ThreadSearchResult = { threadId: 't4', threadName: 'Shelved work', matchType: 'message', messageId: 'm1', snippet: 'the quarterly numbers', score: 2 } as ThreadSearchResult
    const messages = buildPaletteGroups({ query: 'quarterly', commands: [], threads, projects, messages: [hit] }).find((group) => group.label === 'Messages')!
    expect(messages.items[0]).toMatchObject({ kind: 'thread', id: 't4', detail: 'Archived' })
  })

  it('limits the list to commands behind a > prefix', () => {
    const groups = build('>new')
    expect(labels(groups)).toEqual(['Commands: New thread, New private thread'])
    expect(build('>').map((group) => group.label)).toEqual(['Commands'])
    expect(build('  > stop').flatMap((group) => group.items.map((item) => item.title))).toEqual(['Stop run'])
  })

  it('finds Stop run through its hidden term', () => {
    expect(labels(build('interrupt'))).toEqual(['Commands: Stop run'])
  })

  it('shows nothing when nothing matches', () => {
    expect(build('qqqqzz')).toEqual([])
  })
})

describe('message hits in the palette', () => {
  const hit = (threadId: string, messageId: string, over: Partial<ThreadSearchResult> = {}): ThreadSearchResult => ({
    threadId,
    threadName: `Thread ${threadId}`,
    projectName: 'acme-web',
    matchType: 'message',
    messageId,
    snippet: `…the Checkout test ${messageId}…`,
    ...over
  })
  // The search returns a thread's hits oldest first.
  const messages = [
    ...['m1', 'm2', 'm3', 'm4', 'm5'].map((id) => hit('a', id)),
    hit('b', 'n1', { node: 'nod_other', projectName: undefined }),
    // Title and project matches are the palette's own rows; only message hits are used.
    { threadId: 'c', threadName: 'Checkout', matchType: 'thread' } as ThreadSearchResult
  ]
  const computers = { nod_other: { name: 'Studio' } }
  const build = (query: string, extra: Partial<Parameters<typeof buildPaletteGroups>[0]> = {}) =>
    buildPaletteGroups({ query, commands: allCommands, threads: [], projects: [], computers, messages, ...extra })
  const messageRows = (groups: PaletteGroup[]) =>
    groups.find((group) => group.label === 'Messages')!.items.map((item) => `${item.kind}:${item.title}`)

  it('shows one row per thread, then its newest three hits and a "+N more" row', () => {
    expect(messageRows(build('checkout'))).toEqual([
      'thread:Thread a',
      'message:…the Checkout test m5…',
      'message:…the Checkout test m4…',
      'message:…the Checkout test m3…',
      'more:+2 more',
      'thread:Thread b',
      'message:…the Checkout test n1…'
    ])
    const rows = build('checkout').find((group) => group.label === 'Messages')!.items
    expect(rows[0]).toMatchObject({ kind: 'thread', id: 'a', detail: 'acme-web' })
    expect(rows[1]).toMatchObject({ kind: 'message', id: 'm5', threadId: 'a', match: 'checkout' })
    expect(rows[5]).toMatchObject({ kind: 'thread', id: 'b', detail: 'Studio' })
  })

  it('shows every hit of an expanded thread', () => {
    const rows = messageRows(build('checkout', { expanded: new Set(['a']) }))
    expect(rows.filter((row) => row.startsWith('message:') && row.includes(' m'))).toHaveLength(5)
    expect(rows.some((row) => row.startsWith('more:'))).toBe(false)
  })

  it('lists a thread that matches by title once, with its hits under its Threads row', () => {
    const threads = [thread('a', 'Checkout flow')]
    const groups = build('checkout', { threads })
    expect(groups.find((group) => group.label === 'Threads')!.items.map((item) => `${item.kind}:${item.title}`)).toEqual([
      'thread:Checkout flow',
      'message:…the Checkout test m5…',
      'message:…the Checkout test m4…',
      'message:…the Checkout test m3…',
      'more:+2 more'
    ])
    expect(messageRows(groups)).toEqual(['thread:Thread b', 'message:…the Checkout test n1…'])
    expect(flattenGroups(groups).filter((item) => item.kind === 'thread' && item.id === 'a')).toHaveLength(1)
  })

  it('says "N+ more" when the search stopped at its hit limit', () => {
    expect(messageRows(build('checkout', { messagesCapped: true }))).toContain('more:2+ more')
  })

  it('puts messages after commands, threads and projects, and in Search everything after what was found, with commands last', () => {
    const projects = [project('p1', 'Checkout service')]
    const threads = [thread('t1', 'Checkout flow')]
    const stopHit = [hit('a', 'm1', { snippet: 'stop the run' })]
    expect(build('checkout', { projects, threads }).map((group) => group.label)).toEqual(['Threads', 'Projects', 'Messages'])
    expect(build('stop', { messages: stopHit }).map((group) => group.label)).toEqual(['Commands', 'Messages'])
    expect(build('checkout', { projects, threads, mode: 'messages' }).map((group) => group.label)).toEqual(['Threads', 'Messages', 'Projects'])
    expect(build('stop', { messages: stopHit, mode: 'messages' }).map((group) => group.label)).toEqual(['Messages', 'Commands'])
  })

  it('searches messages from two characters, and never behind >', () => {
    expect(messageQuery('c')).toBeNull()
    expect(messageQuery(' ch ')).toBe('ch')
    expect(messageQuery('>checkout')).toBeNull()
    expect(build('c').some((group) => group.label === 'Messages')).toBe(false)
    expect(build('>checkout').some((group) => group.label === 'Messages')).toBe(false)
  })

  it('marks every occurrence of the query in a snippet, ignoring case', () => {
    expect(markMatches('The checkout test: Checkout.', 'checkout')).toEqual([
      { text: 'The ', match: false },
      { text: 'checkout', match: true },
      { text: ' test: ', match: false },
      { text: 'Checkout', match: true },
      { text: '.', match: false }
    ])
    expect(markMatches('nothing here', 'zz')).toEqual([{ text: 'nothing here', match: false }])
    expect(markMatches('aaa', 'aa')).toEqual([{ text: 'aa', match: true }, { text: 'a', match: false }])
  })
})

describe('Search everything', () => {
  const alpha = { botId: 'b1', name: 'alpha' }
  const projects = [project('p1', 'mousse')]
  const threads = [
    thread('t1', 'Nightly installer drops the tray icon', { projectId: 'p1' }),
    thread('t2', 'Nightly build triage', { projectId: 'p1', startedByBot: alpha }),
    thread('t3', 'Mac nightly signing check', { projectId: 'p1', startedByBot: alpha, archivedAt: '2026-02-01T00:00:00.000Z' }),
    // alpha's own chat runs in this thread; it is found as the bot, never as a thread.
    thread('home', 'Nightly chat with alpha'),
    thread('chat-thread', 'Release crew nightly')
  ]
  const bots = [
    { id: 'b1', name: 'alpha', description: 'Runs the nightly builds.\nAnd the weekly sweeps.', homeThreadId: 'home' },
    { id: 'b2', name: 'Funbo', description: 'Keeps dependencies fresh.', last: { text: 'The nightly bump is merged.' } },
    { id: 'b3', name: 'Garden', description: 'Waters the plants.' }
  ]
  const chats = [
    { id: 'c1', name: 'Release crew', kind: 'group' as const, threadId: 'chat-thread', lastMessage: { text: 'Nightly 0.48 is signed.' } },
    { id: 'c2', name: 'Opus', kind: 'direct' as const, lastMessage: { text: 'Lunch?' } }
  ]
  const hit = (threadId: string, messageId: string, threadName: string): ThreadSearchResult =>
    ({ threadId, threadName, matchType: 'message', messageId, snippet: `the nightly ${messageId}` }) as ThreadSearchResult
  const build = (query: string, messages: ThreadSearchResult[] = []) =>
    buildPaletteGroups({ query, commands: allCommands, threads, projects, bots, chats, messages, mode: 'messages' })
  const group = (groups: PaletteGroup[], label: string) => groups.find((entry) => entry.label === label)?.items ?? []

  it('groups threads, bot threads, archived threads, bots, chats and messages, the same for every query', () => {
    const groups = build('nightly', [hit('t9', 'm1', 'Weekly issue sweep')])
    expect(labels(groups)).toEqual([
      'Threads: Nightly installer drops the tray icon',
      'Bot threads: Nightly build triage',
      'Archived: Mac nightly signing check',
      'Bots: alpha, Funbo',
      'Chats: Release crew',
      'Messages: Weekly issue sweep, the nightly m1'
    ])
  })

  it('names the bot that started a thread, and says Archived only outside the Archived group', () => {
    const groups = build('nightly')
    expect(group(groups, 'Bot threads')).toMatchObject([{ kind: 'thread', id: 't2', detail: 'alpha · mousse' }])
    expect(group(groups, 'Archived')).toMatchObject([{ kind: 'thread', id: 't3', detail: 'alpha · mousse' }])
    const messageOnly = group(build('signing', [hit('t3', 'm1', 'Mac nightly signing check')]), 'Archived')
    expect(messageOnly.map((item) => item.kind)).toEqual(['thread', 'message'])
  })

  it('finds a bot by name, by what it does or by its latest message, and shows the line that matched', () => {
    expect(group(build('nightly'), 'Bots')).toEqual([
      { kind: 'bot', key: 'bot:b1', id: 'b1', title: 'alpha', detail: 'Runs the nightly builds.' },
      { kind: 'bot', key: 'bot:b2', id: 'b2', title: 'Funbo', detail: 'The nightly bump is merged.' }
    ])
    expect(group(build('garden'), 'Bots')).toMatchObject([{ id: 'b3', detail: 'Waters the plants.' }])
  })

  it('finds a chat by name or by its latest message, a group saying so', () => {
    expect(group(build('nightly'), 'Chats')).toEqual([{ kind: 'chat', key: 'chat:c1', id: 'c1', title: 'Release crew', detail: 'Group · Nightly 0.48 is signed.' }])
    expect(group(build('opus'), 'Chats')).toMatchObject([{ id: 'c2', detail: 'Lunch?' }])
  })

  it("puts a hit in a bot's or a chat's own thread under that bot or chat, and the hit opens it", () => {
    const groups = build('nightly', [hit('home', 'm1', 'Nightly chat with alpha'), hit('chat-thread', 'm2', 'Release crew nightly')])
    expect(group(groups, 'Messages')).toMatchObject([
      { kind: 'bot', id: 'b1', title: 'alpha', detail: 'Bot chat' },
      { kind: 'message', threadId: 'home', place: { kind: 'bot', id: 'b1' } },
      { kind: 'chat', id: 'c1', title: 'Release crew', detail: 'Group' },
      { kind: 'message', threadId: 'chat-thread', place: { kind: 'chat', id: 'c1' } }
    ])
    expect(flattenGroups(groups).some((item) => item.kind === 'thread' && (item.id === 'home' || item.id === 'chat-thread'))).toBe(false)
  })
})

describe('palette keys', () => {
  it('moves with the arrows, wrapping at the ends', () => {
    expect(paletteKeyAction({ key: 'ArrowDown' }, 0, 3)).toEqual({ type: 'move', index: 1 })
    expect(paletteKeyAction({ key: 'ArrowDown' }, 2, 3)).toEqual({ type: 'move', index: 0 })
    expect(paletteKeyAction({ key: 'ArrowUp' }, 0, 3)).toEqual({ type: 'move', index: 2 })
  })

  it('jumps with Home, End and the page keys', () => {
    expect(paletteKeyAction({ key: 'Home' }, 7, 20)).toEqual({ type: 'move', index: 0 })
    expect(paletteKeyAction({ key: 'End' }, 3, 20)).toEqual({ type: 'move', index: 19 })
    expect(paletteKeyAction({ key: 'PageDown' }, 3, 20)).toEqual({ type: 'move', index: 11 })
  })

  it('never moves in an empty list and ignores other keys', () => {
    expect(paletteKeyAction({ key: 'ArrowDown' }, 0, 0)).toBeNull()
    expect(paletteKeyAction({ key: 'a' }, 0, 3)).toBeNull()
    expect(paletteKeyAction({ key: 'Tab' }, 0, 3)).toBeNull()
  })

  it('chooses on Enter when there is a row, and closes on Escape', () => {
    expect(paletteKeyAction({ key: 'Enter' }, 1, 3)).toEqual({ type: 'choose' })
    expect(paletteKeyAction({ key: 'Enter' }, 0, 0)).toBeNull()
    expect(paletteKeyAction({ key: 'Escape' }, 0, 0)).toEqual({ type: 'close' })
  })

  it('ignores Enter and Escape while an input method is composing', () => {
    for (const key of ['Enter', 'Escape']) {
      expect(paletteKeyAction({ key, isComposing: true }, 0, 3)).toBeNull()
      expect(paletteKeyAction({ key, keyCode: 229 }, 0, 3)).toBeNull()
    }
  })
})
