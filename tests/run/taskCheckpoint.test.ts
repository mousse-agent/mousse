import { describe, expect, it } from 'vitest'
import { taskCheckpoint } from '../../src/mms/run/delegation/checkpoint'

describe('the checkpoint a delegated task is integrated from (issue #142)', () => {
  const action = (overrides: Record<string, unknown>) => ({ turnId: 'run:a', scope: undefined, state: 'completed', endSha: 'sha-a', ...overrides }) as never

  it('is the end of the completed checkpoint of the task\'s own run', () => {
    expect(taskCheckpoint([action({ turnId: 'run:b', endSha: 'sha-b' }), action({})], 'run:a')).toBe('sha-a')
    expect(taskCheckpoint([action({ turnId: 'run:b', endSha: 'sha-b' })], 'run:b')).toBe('sha-b')
  })

  it.each([
    ['another run', { turnId: 'run:other' }],
    ['a conversation record', { scope: 'conversation' }],
    ['a checkpoint still running', { state: 'running' }],
    ['a failed run', { state: 'failed' }],
    ['a stopped run', { state: 'stopped' }],
    ['a checkpoint without a commit', { endSha: '' }]
  ])('is not %s', (_name, overrides) => {
    expect(taskCheckpoint([action(overrides)], 'run:a')).toBeUndefined()
  })

  it('has nothing to give for a task with no checkpoint', () => {
    expect(taskCheckpoint([], 'run:a')).toBeUndefined()
  })
})
