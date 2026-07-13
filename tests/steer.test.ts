import { describe, expect, it } from 'vitest'
import {
  STEER_MARKER_OPEN,
  STEER_MARKER_CLOSE,
  appendSteerToToolResultContent,
  formatSteerMarker
} from '../src/mms/orchestrator/steer'

describe('steer markers', () => {
  it('formats OOB markers', () => {
    const text = formatSteerMarker('do tests next')
    expect(text).toContain(STEER_MARKER_OPEN)
    expect(text).toContain('do tests next')
    expect(text).toContain(STEER_MARKER_CLOSE)
  })

  it('returns empty for blank steer', () => {
    expect(formatSteerMarker('   ')).toBe('')
  })

  it('appends to last text block of tool result content', () => {
    const content = appendSteerToToolResultContent(
      [
        { type: 'text', text: 'tool output' },
        { type: 'text', text: 'more' }
      ],
      'prefer unit tests'
    )
    expect(content[0]).toEqual({ type: 'text', text: 'tool output' })
    expect(content[1]?.text).toContain('more')
    expect(content[1]?.text).toContain(STEER_MARKER_OPEN)
    expect(content[1]?.text).toContain('prefer unit tests')
  })
})
