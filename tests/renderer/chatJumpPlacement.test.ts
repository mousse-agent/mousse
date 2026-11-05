import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const polish = readFileSync(new URL('../../src/renderer/styles/polish.css', import.meta.url), 'utf8')
const app = readFileSync(new URL('../../src/renderer/styles/app.css', import.meta.url), 'utf8')

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`)
  expect(at, selector).toBeGreaterThanOrEqual(0)
  return css.slice(at, css.indexOf('}', at))
}

/** The px offset added to the composer's height in `calc(var(--chat-composer-stack, …) ± Npx)`. */
const offset = (text: string, sign = 1) => {
  const match = /var\(--chat-composer-stack, \d+px\) ([+-]) (\d+)px/.exec(text)
  expect(match, text).not.toBeNull()
  return (match![1] === '-' ? -1 : 1) * Number(match![2]) * sign
}

describe('Go to latest', () => {
  it('sits above the composer, in a strip the transcript has faded out of', () => {
    const jump = rule(polish, '.chat-jump')
    const bottom = offset(/bottom: (.*);/.exec(jump)![1]!)
    const top = bottom + Number(/height: (\d+)px/.exec(jump)![1])
    expect(bottom).toBeGreaterThanOrEqual(0)
    const mask = rule(polish, '.chat:not(.chat--empty) .an-message-list')
    // `100% - stack - Npx` from the top is N px above the composer.
    const stops = [...mask.matchAll(/(#000|transparent) max\(28px, calc\((100% - var\(--chat-composer-stack, \d+px\) [+-] \d+px)\)\)/g)]
    const clear = stops.find((stop) => stop[1] === 'transparent')!
    expect(offset(clear[2]!, -1)).toBeGreaterThanOrEqual(top)
    // At the end of the transcript, the last line ends above that strip.
    const padding = offset(rule(polish, '.chat:not(.chat--empty) .an-message-list > div'))
    const opaque = stops.find((stop) => stop[1] === '#000')!
    expect(padding).toBeGreaterThanOrEqual(offset(opaque[2]!, -1))
  })

  it('hides while a composer menu or the notice slot is open', () => {
    expect(rule(polish, '.chat:has(.chat-composer-stack [aria-expanded="true"], .composer-notice-slot) .chat-jump')).toContain('display: none')
  })
})

describe('Add project on an empty new chat', () => {
  it('is in the flow, centred under the composer, not floated over the workspace toolbar', () => {
    const css = rule(app, '.chat-empty-add-project')
    expect(css).not.toContain('position: absolute')
    expect(css).toContain('margin: var(--space-16) auto 0')
    const chat = readFileSync(new URL('../../src/renderer/components/OrchestratorChat.tsx', import.meta.url), 'utf8')
    expect(chat.indexOf('<EmptyThreadAddProject')).toBeGreaterThan(chat.indexOf('<ComposerWorkspaceToolbar'))
  })
})
