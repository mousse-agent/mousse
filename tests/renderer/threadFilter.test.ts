/**
 * The sidebar filter's rules (`lib/threadFilter.ts`): which threads Show, a bot, a project, a computer and the typed
 * words keep, how a sub-list orders its options, and what typing suggests.
 */
import { describe, expect, it } from 'vitest'
import type { Thread } from '../../src/shared/types'
import { filterNarrows, filterSuggestions, LOCAL_COMPUTER_ID, orderOptions, threadInFilter, type ThreadFilter } from '../../src/renderer/lib/threadFilter'

const at = '2026-11-18T10:00:00.000Z'
const thread = (over: Partial<Thread> = {}): Thread => ({ id: 't', name: 'Fix steer after the answer', createdAt: at, updatedAt: at, projectId: 'p1', ...over } as Thread)
const alpha = { startedByBot: { botId: 'b1', name: 'Alpha (old name)' } }
const filter = (over: Partial<ThreadFilter> = {}): ThreadFilter => ({ query: '', show: 'mine', projectId: null, botId: null, computerId: null, archived: false, ...over })
const context = {
  // p1 and p1-mac are one project on two computers.
  groupOf: (id: string) => (id === 'p1-mac' ? 'p1' : id),
  projectName: (id: string) => ({ p1: 'mousse', 'p1-mac': 'mousse', p2: 'smiletrack' } as Record<string, string>)[id],
  botName: (id: string) => (id === 'b1' ? 'alpha' : undefined),
  computerName: (node: string | undefined) => (node === 'mac' ? "Avarnic's Mac mini" : node ? 'Work Linux' : 'This computer')
}

describe('which threads the filter keeps', () => {
  const rows: Array<[string, Partial<Thread>, Partial<ThreadFilter>, boolean]> = [
    ['My threads: a thread of mine', {}, {}, true],
    ['My threads: a bot thread the owner brought into the sidebar', alpha, {}, true],
    ['My threads: a bot thread kept hidden', { ...alpha, hidden: true }, {}, false],
    ['My threads: a hidden bot thread once archived', { ...alpha, hidden: true, archivedAt: at }, {}, true],
    ['Bot threads: a thread of mine', {}, { show: 'bots' }, false],
    ['Bot threads: a hidden bot thread', { ...alpha, hidden: true }, { show: 'bots' }, true],
    ['All: a hidden bot thread', { ...alpha, hidden: true }, { show: 'all' }, true],
    ['a bot: its hidden thread, whatever Show says', { ...alpha, hidden: true }, { botId: 'b1' }, true],
    ['a bot: a thread of another bot', { startedByBot: { botId: 'b2', name: 'Beta' } }, { botId: 'b1', show: 'all' }, false],
    ['a bot: a thread of mine', {}, { botId: 'b1', show: 'all' }, false],
    ['a project: its thread on another computer', { projectId: 'p1-mac' }, { projectId: 'p1' }, true],
    ['a project: another project\'s thread', { projectId: 'p2' }, { projectId: 'p1' }, false],
    ['a project: a thread of no project', { projectId: undefined }, { projectId: 'p1' }, false],
    ['a computer: this computer keeps a local thread', {}, { computerId: LOCAL_COMPUTER_ID }, true],
    ['a computer: this computer leaves out a remote thread', { node: 'mac' }, { computerId: LOCAL_COMPUTER_ID }, false],
    ['a computer: a remote computer keeps its own thread', { node: 'mac' }, { computerId: 'mac' }, true],
    ['a computer: a remote computer leaves out a local thread', {}, { computerId: 'mac' }, false],
    ['a computer: a remote computer leaves out another remote computer\'s thread', { node: 'linux' }, { computerId: 'mac' }, false],
    ['typed: words of the title, any case and order', {}, { query: 'ANSWER steer' }, true],
    ['typed: the project\'s name', {}, { query: 'mous' }, true],
    ['typed: the bot\'s name now', alpha, { query: 'alpha' }, true],
    ['typed: the bot\'s name when it started the thread, when the bot is gone', { startedByBot: { botId: 'gone', name: 'Monty' } }, { query: 'monty', show: 'all' }, true],
    ['typed: the computer\'s name', { node: 'mac' }, { query: 'mac mini' }, true],
    ['typed: a word found nowhere', {}, { query: 'steer zebra' }, false],
    ['typed: only spaces', {}, { query: '   ' }, true]
  ]
  it.each(rows)('%s', (_name, over, set, kept) => {
    expect(threadInFilter(thread(over), filter(set), context)).toBe(kept)
  })

  it('treats a chosen computer as narrowing the list', () => {
    expect(filterNarrows(filter())).toBe(false)
    expect(filterNarrows(filter({ computerId: 'mac' }))).toBe(true)
    expect(filterNarrows(filter({ computerId: LOCAL_COMPUTER_ID }))).toBe(true)
  })
})

describe('a sub-list\'s order', () => {
  const option = (id: string, lastUsed?: string) => ({ id, name: id, ...(lastUsed ? { lastUsed } : {}) })
  const many = [option('zeta', '2026-11-18T09:00:00Z'), option('alpha'), option('mousse', '2026-11-18T11:00:00Z'), option('beta'), option('smile', '2026-11-18T10:00:00Z'), option('gamma', '2026-11-17T10:00:00Z'), option('delta')]

  it('puts the three used last under Recent, then the rest by name', () => {
    const { recent, rest } = orderOptions(many, '')
    expect(recent.map((item) => item.id)).toEqual(['mousse', 'smile', 'zeta'])
    expect(rest.map((item) => item.id)).toEqual(['alpha', 'beta', 'delta', 'gamma'])
  })

  it('has no Recent while the list is short', () => {
    expect(orderOptions(many.slice(0, 3), '').recent).toEqual([])
  })

  it('keeps the names holding the search, those starting with it first', () => {
    const { recent, rest } = orderOptions([option('smiletrack'), option('legacy-smile'), option('smile'), option('mousse')], 'SMI')
    expect(recent).toEqual([])
    expect(rest.map((item) => item.id)).toEqual(['smile', 'smiletrack', 'legacy-smile'])
  })
})

describe('what typing suggests', () => {
  const projects = [{ id: 'p1', name: 'mousse' }, { id: 'p2', name: 'smiletrack' }, { id: 'p3', name: 'mousse-site' }, { id: 'p4', name: 'old-mousse' }]
  const bots = [{ id: 'b1', name: 'Monty' }, { id: 'b2', name: 'alpha' }]
  const computers = [{ id: LOCAL_COMPUTER_ID, name: 'This computer' }, { id: 'mac', name: "Avarnic's Mac mini" }, { id: 'mini', name: 'Mobile Mac' }]

  it('the matching projects, bots, then computers, at most two of each', () => {
    expect(filterSuggestions('mo', filter(), projects, bots, computers)).toEqual([
      { kind: 'project', id: 'p1', name: 'mousse' },
      { kind: 'project', id: 'p3', name: 'mousse-site' },
      { kind: 'bot', id: 'b1', name: 'Monty' },
      { kind: 'computer', id: 'mini', name: 'Mobile Mac' }
    ])
  })

  it('nothing for an empty field, and not what is already filtered on', () => {
    expect(filterSuggestions(' ', filter(), projects, bots, computers)).toEqual([])
    expect(filterSuggestions('mo', filter({ projectId: 'p1', botId: 'b1', computerId: 'mini' }), projects, bots, computers).map((item) => item.id)).toEqual(['p3', 'p4'])
  })
})
