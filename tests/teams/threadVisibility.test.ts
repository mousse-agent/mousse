import { describe, expect, it } from 'vitest'
import type { UserId } from '../../src/shared/net/ids'
import type { TeamDirectory, ThreadAccess } from '../../src/shared/teams/types'
import type { Thread } from '../../src/shared/types'
import { DENY_ALL_TEAM_DIRECTORY } from '../../src/mms/teams/access'
import { threadsForPerson, visibleThreadsFor } from '../../src/mms/protocol/threadVisibility'

const me = 'usr_me' as UserId,
  mate = 'usr_mate' as UserId,
  team = 'usr_team' as UserId

const thread = (id: string, extra: Partial<Thread> = {}): Thread =>
  ({ id, name: id, projectId: null, ...extra }) as unknown as Thread

function directory(threads: Record<string, ThreadAccess>, members: UserId[] = [me, mate]): TeamDirectory {
  return {
    teamOf: () => team,
    isActiveMember: (of, user) => of === team && members.includes(user),
    threadAccess: (threadId) => threads[threadId]
  }
}

const access: Record<string, ThreadAccess> = {
  listed: { owner: me, people: [mate] },
  open: { owner: me, people: [], openToTeam: true },
  theirs: { owner: mate, people: [] },
  mine: { owner: me, people: [] },
  // The directory may open a thread kept on this computer only; the filter still never shows it.
  kept: { owner: me, people: [mate], openToTeam: true },
  keptChild: { owner: me, people: [mate], openToTeam: true }
}
const threads = [
  thread('listed'),
  thread('open'),
  thread('theirs'),
  thread('mine'),
  thread('unknown'),
  thread('kept', { localOnly: true }),
  thread('keptChild', { lineage: { rootThreadId: 'kept' } } as Partial<Thread>)
]
const ids = (rows: readonly Thread[]) => rows.map((row) => row.id)

describe('the per-person thread filter', () => {
  it('keeps only the threads open to the person, and never one kept on this computer only', () => {
    const person = { user: mate, team, directory: directory(access) }
    expect(ids(threadsForPerson(person, threads))).toEqual(['listed', 'open', 'theirs'])
    // A local connection sees kept threads, but a person never does.
    expect(ids(visibleThreadsFor({ clientType: 'gui' }, threads, threads, person))).toEqual([
      'listed',
      'open',
      'theirs'
    ])
  })

  it('shows nothing to someone who is not an active member, in no team, or with the default directory', () => {
    expect(threadsForPerson({ user: mate, team, directory: directory(access, [me]) }, threads)).toEqual([])
    expect(threadsForPerson({ user: mate, team: undefined, directory: directory(access) }, threads)).toEqual([])
    expect(threadsForPerson({ user: mate, team, directory: DENY_ALL_TEAM_DIRECTORY }, threads)).toEqual([])
  })

  it('changes nothing for a caller who is not another person', () => {
    expect(ids(visibleThreadsFor({ clientType: 'gui' }, threads))).toEqual(ids(threads))
    expect(ids(visibleThreadsFor({ clientType: 'bridge' }, threads))).toEqual([
      'listed',
      'open',
      'theirs',
      'mine',
      'unknown'
    ])
  })
})
