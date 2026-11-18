/**
 * Which archived rows are drawn (ArchivedList): the rows in the footer's view plus the overscan, the rows kept drawn
 * wherever they are, and a spacer for each run between them. Layout in a real window: archived-list-electron.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { ARCHIVED_FIRST_ROWS, ARCHIVED_OVERSCAN, listParts, rowRange, rowTops } from '../../src/renderer/components/sidebar/ArchivedList'

// 100 rows of 50px, 2px apart: row i starts at 52 * i.
const tops = rowTops(Array.from({ length: 100 }, () => 50), 2)

describe('rowRange', () => {
  it.each([
    ['nothing laid out yet', 0, 0, { start: 0, end: ARCHIVED_FIRST_ROWS }],
    ['the top', 0, 260, { start: 0, end: 5 + 1 + ARCHIVED_OVERSCAN }],
    ['the middle', 52 * 50, 260, { start: 50 - ARCHIVED_OVERSCAN, end: 55 + 1 + ARCHIVED_OVERSCAN }],
    ['the end', 52 * 95, 258, { start: 95 - ARCHIVED_OVERSCAN, end: 100 }],
    ['scrolled past the end (overscroll)', 52 * 120, 260, { start: 100 - ARCHIVED_OVERSCAN, end: 100 }],
  ])('%s', (_name, viewTop, viewHeight, range) => {
    expect(rowRange(tops, viewTop, viewHeight)).toEqual(range)
  })

  it('draws nothing for an empty list', () => {
    expect(rowRange(rowTops([], 2), 0, 300)).toEqual({ start: 0, end: 0 })
  })

  it('places rows by their own heights', () => {
    // A tall row 0 (300px) fills the view on its own.
    expect(rowRange(rowTops([300, 50, 50, 50], 0), 0, 200, 0)).toEqual({ start: 0, end: 1 })
  })
})

describe('listParts', () => {
  const rows = (parts: ReturnType<typeof listParts>) => parts.map((part) => (part.kind === 'row' ? part.index : `${part.from}-${part.to}`))

  it.each([
    ['the window alone', 10, { start: 0, end: 3 }, [], [0, 1, 2, '3-10']],
    ['a window in the middle', 10, { start: 4, end: 6 }, [], ['0-4', 4, 5, '6-10']],
    ['a kept row far from the window', 10, { start: 0, end: 2 }, [7], [0, 1, '2-7', 7, '8-10']],
    ['a kept row inside the window', 10, { start: 2, end: 4 }, [3], ['0-2', 2, 3, '4-10']],
    ['a kept row that is gone', 10, { start: 0, end: 2 }, [-1, 12], [0, 1, '2-10']],
    ['a window from before the list got shorter', 3, { start: 0, end: 8 }, [], [0, 1, 2]],
  ])('%s', (_name, count, range, kept, expected) => {
    expect(rows(listParts(count, range, kept))).toEqual(expected)
  })
})
