import { describe, expect, it } from 'vitest'
import { formatRestartNote, type RestartNote } from '../../src/mms/run/restartNote'

const note = (patch: Partial<RestartNote> = {}): RestartNote => ({
  runIds: ['r1'],
  uncertainRunIds: [],
  cutOffTools: [],
  epoch: 2,
  ...patch
})

describe('formatRestartNote', () => {
  it('reports interrupted runs only when nothing is uncertain', () => {
    expect(formatRestartNote(note({ runIds: ['r1', 'r2'] }))).toBe(
      'The Mousse daemon restarted during the previous turn. Interrupted: 2 run(s).'
    )
  })

  it('lists the non-idempotent tools of uncertain runs once each', () => {
    const text = formatRestartNote(
      note({
        runIds: ['r1', 'r2'],
        uncertainRunIds: ['r1'],
        cutOffTools: [
          { runId: 'r1', invocationId: 'i1', tool: 'bash', idempotent: false },
          { runId: 'r1', invocationId: 'i2', tool: 'read_file', idempotent: true },
          { runId: 'r1', invocationId: 'i3', tool: 'bash', idempotent: false },
          { runId: 'r1', invocationId: 'i4', tool: 'write_file', idempotent: false },
          { runId: 'r2', invocationId: 'i5', tool: 'edit_file', idempotent: false }
        ]
      })
    )
    expect(text).toBe(
      'The Mousse daemon restarted during the previous turn. Interrupted: 2 run(s). ' +
        'These tool calls may have run without a recorded result; verify before repeating: ' +
        'bash, write_file.'
    )
  })
})
