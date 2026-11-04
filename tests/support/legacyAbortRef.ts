import { gitStep, mousseCommitEnvNow, tryGitStep } from '../../src/mms/actions/git'
import { worktreeTreeSteps } from '../../src/mms/actions/snapshots'
import { runAsync, type Steps } from '../../src/mms/actions/steps'

/**
 * The copy an abort of an older version of Mousse kept: every file of the folder as a snapshot's tree, as one commit
 * under `refs/mousse/preserved/<operation>-abort-<12 hex>`. No abort writes these any more; refs already written that way
 * are still the thread's, expire, and are listed by a purge, which these tests check with a ref made the same way.
 */
function* legacyAbortRefSteps(folder: string, operationId: string): Steps<{ ref: string; top: string }> {
  const top = yield* gitStep(folder, ['rev-parse', '--show-toplevel'])
  const tree = yield* worktreeTreeSteps(top)
  const head = (yield* tryGitStep(top, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'])).stdout
  const sha = yield* gitStep(top, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', 'mousse snapshot: files kept before an abort', '-m', `Mousse-Operation: ${operationId}`], mousseCommitEnvNow())
  const ref = `refs/mousse/preserved/${operationId}-abort-${sha.slice(0, 12)}`
  yield* gitStep(top, ['update-ref', '--no-deref', ref, sha])
  return { ref, top }
}

export function legacyAbortRefAsync(folder: string, operationId: string): Promise<{ ref: string; top: string }> {
  return runAsync(legacyAbortRefSteps(folder, operationId))
}
