import { describe, expect, it } from 'vitest'
import { COMMANDS, type CommandContext, type CommandId } from '../src/shared/commands'
import type { Project, Thread } from '../src/shared/types'
import { rankItems, scoreItem } from '../src/renderer/commands/paletteRank'
import {
  RECENT_THREAD_COUNT,
  buildPaletteGroups,
  eligibleCommands,
  flattenGroups,
  paletteKeyAction,
  type PaletteGroup
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
    expect(ids(ctx())).toEqual(['thread.new', 'run.stop', 'composer.focus'])
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
    thread('t4', 'Settled work', { settledAt: '2026-04-02T00:00:00.000Z', updatedAt: '2026-04-02T00:00:00.000Z' }),
    thread('t5', 'Thread 5', { startedAt: undefined, name: 'New Thread', updatedAt: '2026-05-01T00:00:00.000Z' })
  ]
  const build = (query: string, commands = allCommands) => buildPaletteGroups({ query, commands, threads, projects })

  it('shows every eligible command and the newest threads for an empty query', () => {
    const groups = build('')
    expect(groups.map((group) => group.label)).toEqual(['Commands', 'Threads'])
    expect(groups[0]!.items).toHaveLength(allCommands.length)
    // Newest first; the settled thread and the empty draft are not listed.
    expect(groups[1]!.items.map((item) => item.id)).toEqual(['t2', 't1', 't3'])
  })

  it('caps the recent threads', () => {
    const many = Array.from({ length: 12 }, (_, i) => thread(`m${i}`, `Thread ${i}`, { updatedAt: `2026-06-${String(i + 10)}T00:00:00.000Z` }))
    const groups = buildPaletteGroups({ query: '', commands: [], threads: many, projects: [] })
    expect(groups[0]!.items).toHaveLength(RECENT_THREAD_COUNT)
    expect(groups[0]!.items[0]!.id).toBe('m11')
  })

  it('finds a command and a thread with the same words, commands first', () => {
    const groups = build('newth')
    expect(labels(groups)).toEqual(['Commands: New thread', 'Threads: New thread ideas'])
  })

  it('finds a thread with an accented title and a project by name, with the project\'s newest thread as its target', () => {
    expect(build('resume').find((group) => group.label === 'Threads')!.items.map((item) => item.id)).toEqual(['t3'])
    const projectRows = build('mous').find((group) => group.label === 'Projects')!.items
    expect(projectRows).toMatchObject([{ kind: 'project', id: 'p1', threadId: 't1' }])
    expect(build('web').find((group) => group.label === 'Projects')!.items).toMatchObject([{ id: 'p2', threadId: 't2' }])
  })

  it('names the project on a thread row', () => {
    const items = build('login').find((group) => group.label === 'Threads')!.items
    expect(items).toMatchObject([{ id: 't2', detail: 'Website' }])
  })

  it('hides settled threads and empty drafts from a search', () => {
    expect(build('settled').find((group) => group.label === 'Threads')).toBeUndefined()
    expect(flattenGroups(build('new')).some((item) => item.kind === 'thread' && item.id === 't5')).toBe(false)
  })

  it('limits the list to commands behind a > prefix', () => {
    const groups = build('>new')
    expect(labels(groups)).toEqual(['Commands: New thread'])
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
