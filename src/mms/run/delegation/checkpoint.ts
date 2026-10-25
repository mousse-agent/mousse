import type { ThreadAction } from '../../../shared/threadActions'

/**
 * The commit a finished task ended with: the end of the code checkpoint its run left in the
 * subagent's thread (checkpointing commits whatever the run changed). A turn's id is its run id.
 * Integration merges this commit, so continuing the subagent afterwards, even with uncommitted
 * work, changes nothing about what is merged. Only a completed checkpoint counts; a conversation
 * record, another run's checkpoint and one that is still running do not.
 */
export function taskCheckpoint(
  actions: ReadonlyArray<Pick<ThreadAction, 'turnId' | 'scope' | 'state' | 'endSha'>>,
  childRunId: string
): string | undefined {
  return actions.find((action) => action.turnId === childRunId && action.scope !== 'conversation' && action.state === 'completed' && action.endSha)?.endSha
}
