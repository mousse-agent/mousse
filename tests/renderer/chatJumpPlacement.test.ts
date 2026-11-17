import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const polish = readFileSync(new URL('../../src/renderer/styles/polish.css', import.meta.url), 'utf8')

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`)
  expect(at, selector).toBeGreaterThanOrEqual(0)
  return css.slice(at, css.indexOf('}', at))
}

describe('Go to latest', () => {
  it('takes no input while the view follows the end', () => {
    const list = readFileSync(new URL('../../src/renderer/chat/components/agent-elements/message-list.tsx', import.meta.url), 'utf8')
    expect(list).toContain('inert={!showJumpButton}')
  })

  it('hides while a composer menu or the notice slot is open', () => {
    expect(rule(polish, '.chat:has(.chat-composer-stack [aria-expanded="true"], .composer-notice-slot) .chat-jump')).toContain('display: none')
  })
})
