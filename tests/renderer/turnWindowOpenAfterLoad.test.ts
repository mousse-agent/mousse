// @vitest-environment jsdom
import { act, createElement, useLayoutEffect, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useTurnWindow } from '../../src/renderer/chat/components/agent-elements/virtual/use-turn-window'
import { RENDER_ALL_THRESHOLD, windowRowItems } from '../../src/renderer/chat/components/agent-elements/virtual/turn-window'
import type { FollowMode } from '../../src/renderer/chat/components/agent-elements/virtual/follow-mode'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// A thread that is not cached opens in a transcript that is already mounted and empty; its turns arrive a moment
// later. The rows mounted in that first commit are the cost of the open: on a code-heavy thread, each row is hundreds
// of nodes, and rows the window drops a commit later were built for nothing.
let root: Root
let host: HTMLElement
const realResizeObserver = globalThis.ResizeObserver

beforeEach(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  globalThis.ResizeObserver = realResizeObserver
})

/** Rows on the page at each commit, read after the hook's own layout effects and before any re-render they ask for. */
type Commit = { turns: number; rows: string[] }

function Transcript({ keys, commits }: { keys: string[]; commits: Commit[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const rowsRef = useRef<HTMLDivElement | null>(null)
  // A thread opens at its newest turn.
  const modeRef = useRef<FollowMode>('following-end')
  const enabled = keys.length > RENDER_ALL_THRESHOLD
  const api = useTurnWindow({ containerRef, rowsRef, keys, estimate: () => 120, enabled, modeRef, onProgrammaticScroll: () => {} })
  useLayoutEffect(() => {
    commits.push({ turns: keys.length, rows: Array.from(host.querySelectorAll<HTMLElement>('[data-turn-key]'), (row) => row.dataset.turnKey!) })
  })
  const items = enabled ? windowRowItems(keys.length, api.window) : keys.map((_, index) => ({ kind: 'row' as const, index }))
  return createElement('div', { ref: containerRef },
    createElement('div', { ref: rowsRef },
      items.map((item) => item.kind === 'row'
        ? createElement('div', { key: keys[item.index], ref: enabled ? api.rowRef(keys[item.index]!) : undefined, 'data-turn-key': keys[item.index] }, `Turn ${item.index}`)
        : createElement('div', { key: item.kind, ref: item.kind === 'top-spacer' ? api.topSpacerRef : api.bottomSpacerRef, 'data-spacer': item.kind }))))
}

const turns = (count: number) => Array.from({ length: count }, (_, index) => `t-${index}`)

/**
 * Renders the transcript with each count of turns in `before`, then with `after`, and returns the rows of the first
 * commit made with `after`. Only that commit is read: jsdom has no layout, so every row the window measures is 0 px
 * tall and the commits after it are not what a window shows (turn-window-electron covers those with real layout).
 */
function firstCommit(before: number[], after: number): string[] {
  const commits: Commit[] = []
  for (const count of before) act(() => root.render(createElement(Transcript, { keys: turns(count), commits })))
  commits.length = 0
  act(() => root.render(createElement(Transcript, { keys: turns(after), commits })))
  const first = commits.find((commit) => commit.turns === after)
  if (!first) throw new Error(`no commit with ${after} turns`)
  return first.rows
}

describe('a long thread that arrives in a mounted transcript', () => {
  // About 14 estimated rows of 120 px fill the 800 px viewport and 600 px of overscan on each side.
  it.each([
    ['an empty transcript (a thread still loading)', 0],
    ['a transcript with one turn (a live message that came before the thread)', 1],
    ['a transcript with two turns', 2],
  ])('opens from %s with only the rows near its end', (_label, before) => {
    const rows = firstCommit([before], 200)
    // The first and last turns are always mounted; the rest are the turns just above the last one.
    expect(rows[0]).toBe('t-0')
    expect(rows.at(-1)).toBe('t-199')
    expect(rows.length).toBeLessThanOrEqual(20)
    const middle = rows.slice(1).map((key) => Number(key.slice(2)))
    expect(Math.min(...middle)).toBeGreaterThan(199 - 20)
  })

  it('keeps every row of a short thread mounted for the commit in which it grows past the threshold', () => {
    // A new thread: the transcript mounts empty and the thread grows in it. Its rows are all on the page already when
    // it passes the threshold; they stay for that commit so the window measures them before it trims, and the text
    // being read does not move.
    expect(firstCommit([0, RENDER_ALL_THRESHOLD - 10], RENDER_ALL_THRESHOLD + 1)).toHaveLength(RENDER_ALL_THRESHOLD + 1)
  })
})
