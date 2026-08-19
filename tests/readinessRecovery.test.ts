import { describe, expect, it } from 'vitest'
import {
  buildCompleteTaskFailureWake,
  buildCompleteTaskSuccessWake,
  isRecoverableNoDiffReadinessFailure,
  isRecoverableReadinessFailure,
  isUncommittedReadinessFailure
} from '../src/mms/orchestrator/OrchestratorService'

describe('readiness recovery helpers', () => {
  it('recovers once from uncommitted-changes completion races', () => {
    const error =
      'Agent left uncommitted changes: subagent-lab/package.json, subagent-lab/src/cli/index.ts'
    expect(isUncommittedReadinessFailure(error)).toBe(true)
    expect(isRecoverableReadinessFailure(error, false, 0)).toBe(true)
    expect(isRecoverableReadinessFailure(error, false, 1)).toBe(false)
    expect(isRecoverableReadinessFailure(error, true, 0)).toBe(false)
  })

  it('recovers once from missing implementation diffs', () => {
    expect(
      isRecoverableReadinessFailure(
        'Agent completed without creating a worker-authored commit.',
        false,
        0
      )
    ).toBe(true)
    expect(
      isRecoverableNoDiffReadinessFailure(
        'Agent created only empty commits; the branch has no changes.',
        false,
        0
      )
    ).toBe(true)
    expect(
      isRecoverableNoDiffReadinessFailure('Ready commit contains no implementation diff.', false, 0)
    ).toBe(true)
  })

  it('does not recover unrelated readiness failures', () => {
    expect(isRecoverableReadinessFailure('Agent worktree no longer exists.', false, 0)).toBe(false)
    expect(isUncommittedReadinessFailure('Agent worktree no longer exists.')).toBe(false)
  })
})

describe('complete_task wake messages', () => {
  it('wakes the parent after successful merges so multi-wave plans continue', () => {
    const logs = [
      '[mousse] Stopped agent cec4da46',
      '[merge] Merged mousse/agent/cec4da46-4c4c-4b13-958b-816cf97ef862',
      '[mousse] Closed GUI agent cec4da46',
      '[mousse] Stopped agent 72a089bb',
      '[merge] Merged mousse/agent/72a089bb-32d9-4234-a2ac-91c4410219b1',
      '[mousse] Closed GUI agent 72a089bb'
    ]
    const ids = ['cec4da46-4c4c-4b13-958b-816cf97ef862', '72a089bb-32d9-4234-a2ac-91c4410219b1']

    expect(buildCompleteTaskFailureWake(ids, logs)).toBeUndefined()
    const wake = buildCompleteTaskSuccessWake(ids, logs)
    expect(wake).toMatch(/Integration finished/)
    expect(wake).toMatch(/Continue the user plan/)
    expect(wake).toContain('[merge] Merged mousse/agent/cec4da46-4c4c-4b13-958b-816cf97ef862')
  })

  it('does not emit a success wake when merges failed', () => {
    const logs = ['[merge] Failed for mousse/agent/x: dirty index']
    const ids = ['x']
    expect(buildCompleteTaskSuccessWake(ids, logs)).toBeUndefined()
    expect(buildCompleteTaskFailureWake(ids, logs)).toMatch(/was not merged/)
  })
})
