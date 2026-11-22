import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAIN_AREA_WIDTH,
  MIN_CONVERSATION_WIDTH,
  mainAreaStyle,
  mainAreaWidthAtPointer,
  mainAreaWidthBounds
} from '../../src/renderer/lib/panelSplit'

// The conversation and panel area share x = 310…1290.
const row = { right: 1290, width: 980 }

describe('dragging the divider between the conversation and the panel area', () => {
  it('follows the pointer freely between the conversation bounds', () => {
    expect(mainAreaWidthAtPointer(700, row)).toBe(590)
    expect(mainAreaWidthAtPointer(1000, row)).toBe(290)
  })

  it('stops where the conversation reaches its 280px minimum', () => {
    expect(mainAreaWidthAtPointer(-500, row)).toBe(row.width - MIN_CONVERSATION_WIDTH)
  })

  it.each([
    { right: 1290, width: 980 },
    { right: 2560, width: 2512 }
  ])('can drag to 160px regardless of the available width ($width)', (row) => {
    expect(mainAreaWidthAtPointer(row.right - 180, row)).toBe(180)
    expect(mainAreaWidthAtPointer(row.right - 20, row)).toBe(160)
  })

  it.each([
    { width: 380, available: 100 },
    { width: 200, available: 0 }
  ])('reserves room for the conversation in a tight row ($width)', ({ width, available }) => {
    expect(mainAreaWidthBounds({ width })).toEqual({ min: available, max: available })
  })
})

describe('the panel area style', () => {
  it('uses the default width when nothing is saved', () => {
    expect(mainAreaStyle(null, 0).width).toBe(`${DEFAULT_MAIN_AREA_WIDTH}px`)
  })

  it('keeps the saved width for flex to fit to the window', () => {
    expect(mainAreaStyle(1100, 263).width).toBe('1100px')
  })
})
