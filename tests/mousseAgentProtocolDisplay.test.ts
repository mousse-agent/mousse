import { describe, expect, it } from 'vitest'
import { stripTaskProgressProtocolForDisplay } from '../src/mms/agents/MousseAgentService'

describe('subagent task protocol display', () => {
  it('hides the internal progress protocol from the visible assignment', () => {
    const assignment = [
      'Fix the sticky chat behavior.',
      '',
      '[Mousse task progress protocol]',
      'Mousse is monitoring this file: C:\\workspace\\.mousse\\task-progress.json',
      'This file is your only readiness signal.'
    ].join('\n')

    expect(stripTaskProgressProtocolForDisplay(assignment)).toBe(
      'Fix the sticky chat behavior.'
    )
  })

  it('leaves ordinary user messages unchanged', () => {
    expect(stripTaskProgressProtocolForDisplay('Normal follow-up message')).toBe(
      'Normal follow-up message'
    )
  })
})
