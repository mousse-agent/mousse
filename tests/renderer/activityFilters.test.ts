// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SelectProps } from '../../src/renderer/components/ui/Select'
import { buildLineEditSnapshot, buildUsageStatsSnapshot } from '../../src/shared/lineEditStats'
import { LineEditHeatmap } from '../../src/renderer/components/LineEditHeatmap'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// A native select that reports changes, so the test can pick filter values.
vi.mock('../../src/renderer/components/ui/Select', () => ({
  Select: ({ value, options, ariaLabel, onChange }: SelectProps<string>) => createElement('select', {
    'aria-label': ariaLabel, value, onChange: (event: { target: { value: string } }) => onChange(event.target.value)
  }, options.map((option) => createElement('option', { key: option.value, value: option.value }, option.label)))
}))

let root: Root
let host: HTMLElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function pick(label: string, value: string) {
  const select = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)
  if (!select) throw new Error(`${label} is not shown`)
  act(() => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('Token usage filters', () => {
  it('a filter combination with no usage says so and keeps both filters so it can be cleared', () => {
    const usage = buildUsageStatsSnapshot([
      { timestamp: '2026-08-25T10:00:00.000Z', provider: 'openai', model: 'gpt-test', input: 10, output: 1, cacheRead: 0, cacheWrite: 0 },
      { timestamp: '2026-08-26T10:00:00.000Z', provider: 'anthropic', model: 'claude-test', input: 10, output: 1, cacheRead: 0, cacheWrite: 0 }
    ])
    act(() => root.render(createElement(LineEditHeatmap, { stats: buildLineEditSnapshot({}), usage })))

    pick('Provider filter', 'openai')
    pick('Model filter', 'claude-test')
    expect(host.textContent).toContain('No token usage matches the filters')
    expect(host.textContent).not.toContain('Tokens in')

    pick('Model filter', 'all')
    expect(host.textContent).toContain('Tokens in')
    expect(host.querySelector('select[aria-label="Provider filter"]')).not.toBeNull()
  })
})
