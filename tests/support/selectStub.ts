import { createElement, type ReactNode } from 'react'
import type { SelectProps } from '../../src/renderer/components/ui/Select'

/**
 * Server-rendered stand-in for components/ui/Select. The real control only
 * renders its options while open, so static-markup tests mock it with this
 * native-shaped <select> to check which options a component passes in.
 * Use: vi.mock('../src/renderer/components/ui/Select', () => import('./support/selectStub'))
 */
export function Select<T extends string>({ value, options, disabled, placeholder, id, ariaLabel }: SelectProps<T>) {
  const matched = options.some((option) => option.value === value)
  const children: ReactNode[] = []
  if (!matched && placeholder !== undefined) {
    children.push(createElement('option', { key: '__placeholder', value: '', disabled: true }, placeholder))
  }
  let index = 0
  while (index < options.length) {
    const group = options[index].group
    const run: ReactNode[] = []
    for (; index < options.length && options[index].group === group; index++) {
      const option = options[index]
      run.push(createElement('option', { key: `${option.value}:${index}`, value: option.value, disabled: option.disabled }, option.label))
    }
    children.push(group === undefined ? run : createElement('optgroup', { key: `group:${index}:${group}`, label: group }, run))
  }
  return createElement(
    'select',
    { id, 'aria-label': ariaLabel, disabled, value: matched ? value : '', onChange: () => undefined },
    children
  )
}
