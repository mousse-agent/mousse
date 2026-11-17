import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Go to latest', () => {
  it('takes no input while the view follows the end', () => {
    const list = readFileSync(new URL('../../src/renderer/chat/components/agent-elements/message-list.tsx', import.meta.url), 'utf8')
    expect(list).toContain('inert={!showJumpButton}')
  })
})
