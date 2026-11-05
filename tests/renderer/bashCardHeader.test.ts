// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { BashToolTerminalCard } from '../../src/renderer/chat/components/agent-elements/tools/bash-tool'
import { bashOutputLines } from '../../src/renderer/chat/components/agent-elements/utils/bash-output'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const command = 'for i in 1 2 3 4 5 6; do npx vitest run tests/checkout.test.ts --sequence.shuffle; done'
const output = ['✓ tests/checkout.test.ts (1) 4ms', '× adds', 'AssertionError: expected 2.2000000000000002 to be 2.2', 'Test Files  1 failed | 5 passed (6)'].join('\n')

describe('the bash card', () => {
  let root: Root | undefined
  afterEach(() => {
    act(() => root?.unmount())
    document.body.innerHTML = ''
  })

  const mount = (extra: { bashLabel?: string; bashCommand?: string } = {}) => {
    const host = document.body.appendChild(document.createElement('div'))
    root = createRoot(host)
    act(() => root!.render(createElement(BashToolTerminalCard, {
      step: { id: 'b1', type: 'tool-call', toolName: 'Bash', duration: 0, bashCommand: command, bashOutput: output, bashExitCode: 0, ...extra },
      state: 'complete',
      onComplete: () => undefined
    })))
    return host
  }

  it('shows the whole command in the collapsed header and leaves the cut to the row width', () => {
    const header = mount().querySelector('button')!
    expect(header.textContent).toContain(command)
    expect(header.querySelector('.font-mono.truncate')?.getAttribute('title')).toBe(command)
  })

  it('prefers the command as run over the tool label', () => {
    const header = mount({ bashLabel: 'npx vitest run tests/checkout.test.ts--sequence.shuffle' }).querySelector('button')!
    expect(header.querySelector('.font-mono.truncate')?.getAttribute('title')).toBe(command)
  })

  it('shows a wrapped command without its shell wrapper, spacing kept', () => {
    const header = mount({ bashCommand: `/bin/zsh -lc '${command}'`, bashLabel: 'tests/checkout.test.ts--sequence.shuffle' }).querySelector('button')!
    expect(header.querySelector('.font-mono.truncate')?.textContent).toBe(command)
  })

  it('shows each token of a command with its spacing, ligatures off so "--" keeps the space before it', () => {
    const multi = 'npx vitest run tests/checkout.test.ts --sequence.shuffle -t "adds  items" --reporter=dot'
    const text = mount({ bashCommand: multi }).querySelector('button .font-mono.truncate')!
    expect(text.textContent).toBe('npx vitest run tests/checkout.test.ts --sequence.shuffle -t "adds items" --reporter=dot')
    expect(text.textContent).toContain('test.ts --sequence')
    expect(text.className).toContain('[font-variant-ligatures:none]')
  })

  it('does not repeat the command in the header once expanded', () => {
    const host = mount()
    act(() => host.querySelector('button')!.click())
    expect(host.querySelector('button')!.textContent).not.toContain('vitest')
    expect(host.textContent!.split(command)).toHaveLength(2)
  })

  it('tints failure lines of the output in danger', () => {
    const host = mount()
    act(() => host.querySelector('button')!.click())
    const tinted = [...host.querySelectorAll('.text-\\[var\\(--danger\\)\\]')].map((node) => node.textContent?.trim())
    expect(tinted).toEqual(['× adds', 'AssertionError: expected 2.2000000000000002 to be 2.2'])
  })
})

describe('bash output lines', () => {
  it('marks failure lines of common runners and removes escape sequences', () => {
    expect(bashOutputLines('\u001b[31mFAIL\u001b[39m src/a.test.ts\nPASS src/b.test.ts\nnpm ERR! code 1\nerror[E0308]: mismatched types\n  ✓ ok')).toEqual([
      { text: 'FAIL src/a.test.ts', failed: true },
      { text: 'PASS src/b.test.ts', failed: false },
      { text: 'npm ERR! code 1', failed: true },
      { text: 'error[E0308]: mismatched types', failed: true },
      { text: '  ✓ ok', failed: false }
    ])
  })
})
