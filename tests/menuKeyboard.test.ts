import { describe, expect, it } from 'vitest'
import { nextMenuIndex } from '../src/renderer/hooks/useMenuKeyboard'

describe('nextMenuIndex', () => {
  it('moves and wraps with the arrow keys', () => {
    expect(nextMenuIndex('ArrowDown', 0, 3)).toBe(1)
    expect(nextMenuIndex('ArrowDown', 2, 3)).toBe(0)
    expect(nextMenuIndex('ArrowUp', 0, 3)).toBe(2)
    expect(nextMenuIndex('ArrowUp', 2, 3)).toBe(1)
  })

  it('jumps with Home and End', () => {
    expect(nextMenuIndex('Home', 2, 3)).toBe(0)
    expect(nextMenuIndex('End', 0, 3)).toBe(2)
  })

  it('starts from the first item when focus is outside the items', () => {
    expect(nextMenuIndex('ArrowDown', -1, 3)).toBe(0)
  })

  it('ignores other keys and never moves in an empty menu', () => {
    expect(nextMenuIndex('a', 0, 3)).toBeUndefined()
    expect(nextMenuIndex('Escape', 0, 3)).toBeUndefined()
    expect(nextMenuIndex('ArrowDown', -1, 0)).toBeUndefined()
    expect(nextMenuIndex('End', -1, 0)).toBeUndefined()
  })
})
