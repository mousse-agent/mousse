import type { KeyboardEvent } from 'react'

/** Where an arrow, Home or End key moves in a group of `count` choices from `index`; undefined for other keys. */
export function radioKeyTarget(key: string, index: number, count: number): number | undefined {
  if (count === 0) return undefined
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return index < 0 ? 0 : (index + 1) % count
    case 'ArrowLeft':
    case 'ArrowUp':
      return index < 0 ? count - 1 : (index - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return undefined
  }
}

/**
 * Keys for a radio group with one tab stop (the chosen item): the arrows move to the next or previous
 * choice and choose it, Home and End go to the first and last. Disabled choices are skipped.
 * Put it on the element with role="radiogroup".
 */
export function onRadioGroupKeyDown(event: KeyboardEvent<HTMLElement>): void {
  const radios = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')]
    .filter((radio) => !(radio as HTMLButtonElement).disabled && radio.getAttribute('aria-disabled') !== 'true')
  const at = radios.indexOf(document.activeElement as HTMLElement)
  const target = radioKeyTarget(event.key, at, radios.length)
  if (target === undefined) return
  event.preventDefault()
  const radio = radios[target]!
  radio.focus()
  if (radio.getAttribute('aria-checked') !== 'true') radio.click()
}

/** The tab stop of a radio group: the chosen item, or the first when none is chosen. */
export function radioTabIndex(checked: boolean, index: number, anyChecked: boolean): 0 | -1 {
  return checked || (!anyChecked && index === 0) ? 0 : -1
}
