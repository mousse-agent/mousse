import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(resolve(process.cwd(), 'src/renderer/styles/app.css'), 'utf8')

describe('chat layout styles', () => {
  it('allows the chat flex containers to shrink so messages remain scrollable', () => {
    expect(css).toMatch(/\.chat\s*\{[\s\S]*?min-height:\s*0;/)
    expect(css).toMatch(/\.chat-messages\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?overflow-y:\s*auto;/)
  })
})
