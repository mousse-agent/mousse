/**
 * Teams: the types of the one decision that lets a teammate (another person, not another of the user's own
 * computers) reach a thread through Bridge's routed path. Nothing here is reachable while the `netTeams` flag
 * is off, and the default directory knows no team, so every call from another person is refused as today.
 */
import type { NodeId, UserId } from '../net/ids'

/** A team is an identity of its own, not any one member (`docs/plans/teams-architecture.md` §6.2). */
export type TeamId = UserId

/** Who may reach one thread: its owner, the people it lists, and, when it is open to the team, every member. */
export interface ThreadAccess {
  owner: UserId
  people: UserId[]
  openToTeam?: boolean
}

/** Why a call from another person is refused. */
export type TeamAccessDenial =
  /** The person is not an active member of this computer's team, or the computer is in no team. */
  | 'not_team_member'
  /** The thread is not open to the person, or the call names no thread. */
  | 'no_thread_access'
  /** The routed row is not one another person may call (`RoutedRow.crossUser`). */
  | 'row_not_cross_user'
  /** The thread is kept on this computer only (`Thread.localOnly`): never shared, with anyone. */
  | 'local_only'
  /** The `netTeams` flag is off. */
  | 'teams_off'

export type TeamAccessDecision =
  /** The caller is the user of this computer: the usual same-person checks apply, unchanged. */
  | { kind: 'same_person' }
  | { kind: 'allow' }
  | { kind: 'deny'; reason: TeamAccessDenial }

/**
 * What this computer knows about its team. A later change reads it from the team's Space; until then the
 * directory knows no team (`DENY_ALL_TEAM_DIRECTORY`), which refuses every other person.
 */
export interface TeamDirectory {
  /** The team the computer `node` belongs to, if any. */
  teamOf(node: NodeId): TeamId | undefined
  isActiveMember(team: TeamId, user: UserId): boolean
  /** Who may reach the thread, if the team shares it at all. */
  threadAccess(threadId: string): ThreadAccess | undefined
}
