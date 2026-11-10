import { describe, expect, it } from 'vitest'
import { promptRailLeft } from '../../src/renderer/chat/components/agent-elements/message-list'

describe('the jump-to-prompt rail', () => {
  it('sits right beside the transcript text', () => {
    // Text starts 300px in; the 40px rail ends 8px before it.
    expect(promptRailLeft({ textLeft: 300, prompts: 12 })).toBe(252)
  })

  it('shows from two prompts, however short the thread is', () => {
    expect(promptRailLeft({ textLeft: 300, prompts: 0 })).toBeNull()
    expect(promptRailLeft({ textLeft: 300, prompts: 1 })).toBeNull()
    expect(promptRailLeft({ textLeft: 300, prompts: 2 })).toBe(252)
  })

  it('is hidden when the gutter is too narrow to stay clear of the text', () => {
    // A narrow pane: the column reaches the edge and its text starts after its own 24px padding.
    expect(promptRailLeft({ textLeft: 24, prompts: 12 })).toBeNull()
    expect(promptRailLeft({ textLeft: 51, prompts: 12 })).toBeNull()
    expect(promptRailLeft({ textLeft: 52, prompts: 12 })).toBe(4)
  })
})
