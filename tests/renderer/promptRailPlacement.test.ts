import { describe, expect, it } from 'vitest'
import { promptRailLeft } from '../../src/renderer/chat/components/agent-elements/message-list'

describe('the jump-to-prompt rail', () => {
  it('sits right beside the transcript text on a long thread', () => {
    // Text starts 300px in; the 40px rail ends 8px before it.
    expect(promptRailLeft({ textLeft: 300, scrollHeight: 4000, clientHeight: 800 })).toBe(252)
  })

  it('is hidden until the thread is taller than three screens', () => {
    expect(promptRailLeft({ textLeft: 300, scrollHeight: 2400, clientHeight: 800 })).toBeNull()
    expect(promptRailLeft({ textLeft: 300, scrollHeight: 2401, clientHeight: 800 })).toBe(252)
    expect(promptRailLeft({ textLeft: 300, scrollHeight: 0, clientHeight: 0 })).toBeNull()
  })

  it('is hidden when the gutter is too narrow to stay clear of the text', () => {
    // A narrow pane: the column reaches the edge and its text starts after its own 24px padding.
    expect(promptRailLeft({ textLeft: 24, scrollHeight: 4000, clientHeight: 800 })).toBeNull()
    expect(promptRailLeft({ textLeft: 51, scrollHeight: 4000, clientHeight: 800 })).toBeNull()
    expect(promptRailLeft({ textLeft: 52, scrollHeight: 4000, clientHeight: 800 })).toBe(4)
  })
})
