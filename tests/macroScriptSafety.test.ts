import { describe, expect, it } from 'vitest'
import {
  buildMacroPowerShellScript,
  escapePowerShellSingleQuoted
} from '../src/mms/macros/Win32MacroExecutor'
import type { MacroConfig, MacroStep } from '../src/shared/types'

function makeConfig(overrides: Partial<MacroConfig> = {}): MacroConfig {
  return {
    name: 'test-macro',
    cliType: 'claude',
    cliCommand: 'claude',
    windowTitlePattern: 'mousse',
    steps: [],
    ...overrides
  }
}

const PAYLOAD = "'; Start-Process calc; '"

describe('escapePowerShellSingleQuoted', () => {
  it('doubles single quotes', () => {
    expect(escapePowerShellSingleQuoted("it's")).toBe("it''s")
  })

  it('leaves strings without quotes untouched', () => {
    expect(escapePowerShellSingleQuoted('plain')).toBe('plain')
  })
})

describe('buildMacroPowerShellScript injection safety', () => {
  it('escapes a hostile windowTitlePattern from config', () => {
    const script = buildMacroPowerShellScript(makeConfig({ windowTitlePattern: PAYLOAD }), {
      prompt: ''
    })
    const match = script.match(/-Pattern '((?:''|[^'])*)'/)
    expect(match).not.toBeNull()
    // The only quotes inside the interpolated argument are escaped doubles,
    // so the string literal terminates exactly where the template says.
    expect(match![1]).toBe(PAYLOAD.replace(/'/g, "''"))
  })

  it('escapes a hostile runtime window title (context overrides config)', () => {
    const script = buildMacroPowerShellScript(makeConfig(), { prompt: '', windowTitle: PAYLOAD })
    expect(script).toContain("-Pattern '''; Start-Process calc; '''")
    expect(script).not.toMatch(/-Pattern '[^']*'; [A-Z]/)
  })

  it('escapes a hostile paste prompt', () => {
    const script = buildMacroPowerShellScript(
      makeConfig({ steps: [{ type: 'paste' }] }),
      { prompt: PAYLOAD }
    )
    expect(script).toContain("SetText('''; Start-Process calc; ''')")
    expect(script).not.toContain("SetText(''; Start-Process calc")
  })

  it('escapes hostile typed text', () => {
    const script = buildMacroPowerShellScript(
      makeConfig({ steps: [{ type: 'type', text: PAYLOAD }] }),
      { prompt: '' }
    )
    expect(script).toContain("SendWait('''; Start-Process calc; ''')")
  })

  it('escapes hostile key names', () => {
    const script = buildMacroPowerShellScript(
      makeConfig({ steps: [{ type: 'key', key: `${PAYLOAD}` }] }),
      { prompt: '' }
    )
    expect(script).toMatch(/SendWait\('''; Start-Process calc; '''\)/)
    // No second statement may have been smuggled onto the SendWait line
    expect(script).not.toMatch(/SendWait\('[^']*(?<!')'\s*;\s*Start-Process/)
  })

  it('rejects non-finite click coordinates instead of interpolating them', () => {
    const steps = [{ type: 'click', x: Number.NaN, y: 0 }] as unknown as MacroStep[]
    expect(() => buildMacroPowerShellScript(makeConfig({ steps }), { prompt: '' })).toThrow(
      /must be a finite number/
    )
  })

  it('rejects stringy delay values that could smuggle statements', () => {
    const steps = [{ type: 'delay', ms: '0; Start-Process calc' } as unknown as MacroStep]
    expect(() => buildMacroPowerShellScript(makeConfig({ steps }), { prompt: '' })).toThrow(
      /must be a finite number/
    )
  })

  it('renders benign values unchanged', () => {
    const script = buildMacroPowerShellScript(
      makeConfig({
        windowTitlePattern: 'Windows Terminal',
        steps: [
          { type: 'click', x: 120, y: 40 },
          { type: 'delay', ms: 250 },
          { type: 'key', key: 'Enter' },
          { type: 'paste' }
        ]
      }),
      { prompt: 'hello world' }
    )
    expect(script).toContain("-Pattern 'Windows Terminal'")
    expect(script).toContain('$offsetX + (120)')
    expect(script).toContain('Start-Sleep -Milliseconds 250')
    expect(script).toContain("SendWait('{ENTER}')")
    expect(script).toContain("SetText('hello world')")
  })
})
