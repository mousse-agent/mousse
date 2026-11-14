/**
 * The one access decision for a routed call from another person (`docs/plans/teams-architecture.md` §6.5.3).
 * Pure: the caller hands in the flag, the row, the target thread and the team directory.
 */
import type { NodeId, UserId } from '../../shared/net/ids'
import type {
  TeamAccessDecision,
  TeamDirectory,
  TeamId,
  ThreadAccess
} from '../../shared/teams/types'

/** Knows no team, so it refuses every other person. The default until a team's Space provides one. */
export const DENY_ALL_TEAM_DIRECTORY: TeamDirectory = Object.freeze({
  teamOf: () => undefined,
  isActiveMember: () => false,
  threadAccess: () => undefined
})

/** The thread a call acts on, as this computer knows it. */
export interface TeamAccessTarget {
  threadId: string
  /** Kept on this computer only (`Thread.localOnly`, including by lineage). */
  localOnly: boolean
}

export interface TeamAccessInput {
  peer: { user: UserId; node: NodeId }
  self: { user: UserId; node: NodeId }
  /** The routed row the call names; undefined for any other Net method. */
  row: { crossUser?: true } | undefined
  /** Undefined when the call names no thread (or it is not known here). */
  target: TeamAccessTarget | undefined
  flags: { netTeams?: boolean }
  directory: TeamDirectory
}

const deny = (reason: Extract<TeamAccessDecision, { kind: 'deny' }>['reason']): TeamAccessDecision => ({
  kind: 'deny',
  reason
})

/** Whether `access` lets `user` reach the thread: its owner, a listed person, or any member when it is open to the team. */
export function threadAccessAllows(access: ThreadAccess | undefined, user: UserId): boolean {
  return (
    !!access && (access.owner === user || access.people.includes(user) || access.openToTeam === true)
  )
}

/** Whether `user`, a member of `team`, may see the thread. A thread kept on this computer only never is. */
export function personMaySeeThread(
  directory: TeamDirectory,
  team: TeamId | undefined,
  user: UserId,
  thread: { id: string; localOnly: boolean }
): boolean {
  return (
    !thread.localOnly &&
    team !== undefined &&
    directory.isActiveMember(team, user) &&
    threadAccessAllows(directory.threadAccess(thread.id), user)
  )
}

/**
 * Same person: today's checks, unchanged. Anyone else is refused unless every step passes, in this order:
 * the flag is on, the row is marked `crossUser`, the thread is not kept on this computer only, the person is
 * an active member of this computer's team, and the thread is open to them.
 */
export function teamAccess({
  peer,
  self,
  row,
  target,
  flags,
  directory
}: TeamAccessInput): TeamAccessDecision {
  if (peer.user === self.user) return { kind: 'same_person' }
  if (flags.netTeams !== true) return deny('teams_off')
  if (row?.crossUser !== true) return deny('row_not_cross_user')
  if (!target) return deny('no_thread_access')
  if (target.localOnly) return deny('local_only')
  const team = directory.teamOf(self.node)
  if (team === undefined || !directory.isActiveMember(team, peer.user)) return deny('not_team_member')
  return threadAccessAllows(directory.threadAccess(target.threadId), peer.user)
    ? { kind: 'allow' }
    : deny('no_thread_access')
}
