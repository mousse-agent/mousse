import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAIN_AREA_WIDTH,
  MIN_CONVERSATION_WIDTH,
  mainAreaStyle,
  mainAreaWidthAtPointer,
  mainAreaWidthBounds
} from '../../src/renderer/lib/panelSplit'

// A 1290px window: a 1242px workspace whose first 262px hold the threads sidebar; the conversation and
// the panel area share the rest, x = 310…1290.
const row = { right: 1290, width: 980, workspaceWidth: 1242 }

describe('dragging the divider between the conversation and the panel area', () => {
  it('follows the pointer freely between the conversation bounds', () => {
    expect(mainAreaWidthAtPointer(700, row)).toBe(590)
    expect(mainAreaWidthAtPointer(1000, row)).toBe(290)
  })

  it('stops where the conversation reaches its 280px minimum', () => {
    expect(mainAreaWidthAtPointer(-500, row)).toBe(row.width - MIN_CONVERSATION_WIDTH)
  })

  it('stops where the conversation reaches 60% of the workspace', () => {
    // 60% of 1242 is 745.2, so the panel keeps 980 - 745.2.
    expect(mainAreaWidthAtPointer(1289, row)).toBe(235)
    expect(mainAreaWidthBounds(row)).toEqual({ min: 980 - 1242 * 0.6, max: 700 })
  })

  it('never makes either side negative in a tiny window', () => {
    const tiny = { right: 300, width: 200, workspaceWidth: 300 }
    const { min, max } = mainAreaWidthBounds(tiny)
    expect(min).toBeGreaterThanOrEqual(0)
    expect(max).toBeLessThanOrEqual(tiny.width)
  })
})

describe('the panel area style', () => {
  it('uses the default width when nothing is saved', () => {
    expect(mainAreaStyle(null, 0).width).toBe(`${DEFAULT_MAIN_AREA_WIDTH}px`)
  })

  it('keeps the saved width and the conversation share bound in CSS, so window resizes follow it', () => {
    expect(mainAreaStyle(1100, 263)).toEqual({ width: '1100px', minWidth: 'max(0px, 100% - 263px - 60%)' })
  })
})
