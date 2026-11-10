import { describe, expect, it } from 'vitest'
import { promptRailLeft } from '../../src/renderer/chat/components/agent-elements/message-list'

describe('the jump-to-prompt rail', () => {
  it("sits close to the pane's left edge", () => {
    expect(promptRailLeft({ textLeft: 300, prompts: 12 })).toBe(12)
  })

  it('shows from two prompts, however short the thread is', () => {
    expect(promptRailLeft({ textLeft: 300, prompts: 0 })).toBeNull()
    expect(promptRailLeft({ textLeft: 300, prompts: 1 })).toBeNull()
    expect(promptRailLeft({ textLeft: 300, prompts: 2 })).toBe(12)
  })

  it('is hidden when the gutter is too narrow to stay clear of the text', () => {
    // A narrow pane: the column reaches the edge and its text starts after its own 24px padding.
    // The 40px rail 12px in ends at 52px, and keeps at least 8px to the text.
    expect(promptRailLeft({ textLeft: 24, prompts: 12 })).toBeNull()
    expect(promptRailLeft({ textLeft: 59, prompts: 12 })).toBeNull()
    expect(promptRailLeft({ textLeft: 60, prompts: 12 })).toBe(12)
  })
})
