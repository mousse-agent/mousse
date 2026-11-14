import { describe, expect, it } from 'vitest'
import type { NodeId, UserId } from '../../src/shared/net/ids'
import type { TeamDirectory, ThreadAccess } from '../../src/shared/teams/types'
import {
  DENY_ALL_TEAM_DIRECTORY,
  teamAccess,
  threadAccessAllows,
  type TeamAccessInput
} from '../../src/mms/teams/access'

const me = 'usr_me' as UserId,
  mate = 'usr_mate' as UserId,
  stranger = 'usr_stranger' as UserId,
  team = 'usr_team' as UserId
const self = { user: me, node: 'nod_here' as NodeId }
const peer = { user: mate, node: 'nod_mate' as NodeId }

/** A team of `me` and `mate` on this computer, with one thread each way. */
function directory(threads: Record<string, ThreadAccess> = {}): TeamDirectory {
  return {
    teamOf: (node) => (node === self.node ? team : undefined),
    isActiveMember: (of, user) => of === team && (user === me || user === mate),
    threadAccess: (threadId) => threads[threadId]
  }
}

const base = (overrides: Partial<TeamAccessInput> = {}): TeamAccessInput => ({
  peer,
  self,
  row: { crossUser: true },
  target: { threadId: 'thr_shared', localOnly: false },
  flags: { netTeams: true },
  directory: directory({ thr_shared: { owner: me, people: [mate] } }),
  ...overrides
})

describe('teamAccess', () => {
  it('leaves the same person to the checks of today, whatever else it is given', () => {
    expect(
      teamAccess(
        base({ peer: { user: me, node: 'nod_other' as NodeId }, flags: {}, row: undefined, target: undefined })
      )
    ).toEqual({ kind: 'same_person' })
  })

  it('lets a listed teammate reach a shared thread through a marked row', () => {
    expect(teamAccess(base())).toEqual({ kind: 'allow' })
  })

  it('refuses another person while the flag is off, before anything else', () => {
    expect(teamAccess(base({ flags: {} }))).toEqual({ kind: 'deny', reason: 'teams_off' })
    expect(teamAccess(base({ flags: { netTeams: false } }))).toEqual({ kind: 'deny', reason: 'teams_off' })
  })

  it('refuses a row that is not marked, and a method that is no row', () => {
    expect(teamAccess(base({ row: {} }))).toEqual({ kind: 'deny', reason: 'row_not_cross_user' })
    expect(teamAccess(base({ row: undefined }))).toEqual({ kind: 'deny', reason: 'row_not_cross_user' })
  })

  it('refuses a call that names no thread', () => {
    expect(teamAccess(base({ target: undefined }))).toEqual({ kind: 'deny', reason: 'no_thread_access' })
  })

  it('never shares a thread kept on this computer only, even one the directory opens to the team', () => {
    const open = directory({ thr_shared: { owner: mate, people: [mate], openToTeam: true } })
    expect(
      teamAccess(base({ directory: open, target: { threadId: 'thr_shared', localOnly: true } }))
    ).toEqual({ kind: 'deny', reason: 'local_only' })
  })

  it('refuses a person who is not an active member, and a computer in no team', () => {
    expect(teamAccess(base({ peer: { user: stranger, node: 'nod_x' as NodeId } }))).toEqual({
      kind: 'deny',
      reason: 'not_team_member'
    })
    expect(teamAccess(base({ self: { user: me, node: 'nod_elsewhere' as NodeId } }))).toEqual({
      kind: 'deny',
      reason: 'not_team_member'
    })
  })

  it('refuses a member the thread is not open to', () => {
    const mine = directory({ thr_shared: { owner: me, people: [] } })
    expect(teamAccess(base({ directory: mine }))).toEqual({ kind: 'deny', reason: 'no_thread_access' })
    expect(teamAccess(base({ directory: directory() }))).toEqual({ kind: 'deny', reason: 'no_thread_access' })
  })

  it('lets in the owner, a listed person, or any member of a thread open to the team', () => {
    expect(threadAccessAllows({ owner: mate, people: [] }, mate)).toBe(true)
    expect(threadAccessAllows({ owner: me, people: [mate] }, mate)).toBe(true)
    expect(threadAccessAllows({ owner: me, people: [], openToTeam: true }, mate)).toBe(true)
    expect(threadAccessAllows({ owner: me, people: [] }, mate)).toBe(false)
    expect(threadAccessAllows(undefined, mate)).toBe(false)
  })

  it('refuses everyone else with the default directory', () => {
    expect(teamAccess(base({ directory: DENY_ALL_TEAM_DIRECTORY }))).toEqual({
      kind: 'deny',
      reason: 'not_team_member'
    })
  })
})
