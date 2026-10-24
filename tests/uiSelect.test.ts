import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { Select } from '../src/renderer/components/ui/Select'

const options = [
  { value: 'never', label: 'Never' },
  { value: '30', label: 'After 30 days', group: 'Automatic' }
]

it('renders a closed listbox trigger that shows the chosen label and exposes its value', () => {
  const html = renderToStaticMarkup(createElement(Select, { id: 'policy', value: '30', onChange: () => undefined, options, 'data-testid': 'policy' }))
  expect(html).toContain('role="combobox"')
  expect(html).toContain('aria-haspopup="listbox"')
  expect(html).toContain('aria-expanded="false"')
  expect(html).toContain('value="30"')
  expect(html).toMatch(/<button[^>]*data-value="30"[^>]*data-testid="policy"/)
  expect(html).toContain('After 30 days')
  // Options render only while the list is open.
  expect(html).not.toContain('role="option"')
  expect(html).not.toContain('Never')
})

it('shows the placeholder when no option matches and honours disabled', () => {
  const html = renderToStaticMarkup(createElement(Select, { value: '', placeholder: 'Loading…', disabled: true, ariaLabel: 'Policy', onChange: () => undefined, options }))
  expect(html).toContain('Loading…')
  expect(html).toContain('ui-select-value placeholder')
  expect(html).toMatch(/<button[^>]*disabled=""/)
  expect(html).toContain('aria-label="Policy"')
})
