// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReviewFileEntry, ReviewFilesResult } from '../../src/shared/review'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../src/renderer/components/ui/Select', () => import('../support/selectStub'))
vi.mock('../../src/renderer/components/review/reviewData', () => ({
  readWorkspaceAvailability: async () => 'shared',
  readReviewHistory: async () => ({ actions: [] }),
  turnReturnedToIdle: () => false
}))
// The diff pane loads Monaco; the stub shows only the line it would show without a file.
vi.mock('../../src/renderer/components/review/ReviewDiffPane', () => ({
  DiffOptionsMenu: () => createElement('button', { className: 'diff-options-trigger' }, 'Diff options'),
  ReviewDiffPane: ({ path, emptyLabel }: { path: string | null; emptyLabel?: string }) =>
    createElement('div', { className: 'diff-stub' }, path ?? emptyLabel)
}))

const { ReviewPanel } = await import('../../src/renderer/components/review/ReviewPanel')
const { useAppStore } = await import('../../src/renderer/stores/appStore')

let root: Root
let host: HTMLElement
let files: (() => Promise<ReviewFilesResult>) = async () => result([])

function result(entries: ReviewFileEntry[]): ReviewFilesResult {
  return { root: '/repo', scope: { kind: 'worktree' }, range: {} as ReviewFilesResult['range'], files: entries, truncated: false, mergeCommits: 0 }
}

const entry: ReviewFileEntry = { path: 'src/a.ts', status: 'modified', additions: 2, deletions: 1, binary: false, countsExact: true }

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  ;(window as unknown as { mousse: unknown }).mousse = { review: { files: () => files() } }
  useAppStore.setState({ activeThreadId: 'thread-1' })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function render() {
  await act(async () => root.render(createElement(ReviewPanel)))
  await act(async () => {})
}

describe('Review panel with no changes', () => {
  it('shows one scoped line and no diff pane, diff options or resize handle', async () => {
    files = async () => result([])
    await render()
    expect(host.textContent).toContain('No changes in Working tree')
    expect(host.querySelector('.git-diff')).toBeNull()
    expect(host.querySelector('.diff-options-trigger')).toBeNull()
    expect(host.querySelector('.panel-sidebar-resize-handle')).toBeNull()
    expect(host.querySelector('.review-sidebar')?.classList.contains('resizable-panel-sidebar-fill')).toBe(true)
    expect(host.textContent).not.toContain('Select a changed file')
  })

  it('keeps the split layout and opens the first file when there are changes', async () => {
    files = async () => result([entry])
    await render()
    expect(host.querySelector('.git-diff')).not.toBeNull()
    expect(host.querySelector('.panel-sidebar-resize-handle')).not.toBeNull()
    expect(host.querySelector('.diff-stub')?.textContent).toBe('src/a.ts')
    expect(host.textContent).toContain('1 changed file')
  })

  it('keeps loading and a failed load apart from an empty scope', async () => {
    let resolve: (value: ReviewFilesResult) => void = () => {}
    files = () => new Promise((done) => { resolve = done })
    await render()
    // The shared delayed loader holds the spot (no text); it is not the empty state.
    expect(host.querySelector('.ui-loader-slot')).not.toBeNull()
    expect(host.textContent).not.toContain('No changes')
    expect(host.querySelector('.diff-stub')?.textContent).toBe('')
    await act(async () => resolve(result([])))

    files = async () => { throw new Error('git failed') }
    useAppStore.setState({ activeThreadId: 'thread-2' })
    await render()
    expect(host.textContent).toContain('Could not load changes: git failed')
    expect(host.textContent).not.toContain('No changes')
    expect(host.textContent).not.toContain('Select a changed file')
  })
})
