import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MacroEngine } from '../src/mms/macros/MacroEngine'

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

describe('user macro configs with legacy steps', () => {
  it('skips legacy click steps and window titles instead of failing the PTY macro', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mousse-macros-'))
    roots.push(dir)
    cpSync(resolve(__dirname, '../macros'), dir, { recursive: true })
    const file = join(dir, 'claude-code.json')
    const config = JSON.parse(readFileSync(file, 'utf8'))
    config.windowTitlePattern = 'Claude'
    config.steps = [
      { type: 'click', x: 10, y: 20 },
      { type: 'paste', usePrompt: true },
      { type: 'key', key: 'Enter' }
    ]
    writeFileSync(file, JSON.stringify(config))

    const writes: string[] = []
    const result = await new MacroEngine(dir).runPtyMacro('claude-code', { prompt: 'fix the bug' }, (data) => { writes.push(data) })

    expect(result.success).toBe(true)
    expect(writes).toEqual(['fix the bug', '\r'])
    expect(result.log).toContain('[macro] skipped unknown step click')
  })
})
