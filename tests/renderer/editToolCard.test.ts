// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ review: [] as unknown[][], files: [] as unknown[] }))

vi.mock('../../src/renderer/components/review/openReview', () => ({
  openTurnInReview: async (...args: unknown[]) => { calls.review.push(args) }
}))
vi.mock('../../src/renderer/utils/chatLinks', () => ({
  openFileInPanel: (detail: unknown) => { calls.files.push(detail) }
}))
// The diff library draws with web components and a highlighter; a marker is enough to see that the diff is shown.
vi.mock('@pierre/diffs/react', () => ({
  PatchDiff: () => createElement('div', { 'data-testid': 'diff' }),
  MultiFileDiff: () => createElement('div', { 'data-testid': 'diff' })
}))

import { EditTool } from '../../src/renderer/chat/components/agent-elements/tools/edit-tool'
import { TurnIdContext } from '../../src/renderer/chat/components/agent-elements/turn-context'
import { useAppStore } from '../../src/renderer/stores/appStore'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

const edit = {
  type: 'tool-Edit',
  toolCallId: 'c1',
  state: 'output-available',
  input: { file_path: '/repo/src/app.ts', old_string: 'a', new_string: 'b\nc' }
}

const draw = (part: Record<string, unknown>) =>
  act(() => root.render(createElement(TurnIdContext.Provider, { value: 'turn-1' }, createElement(EditTool, { part }))))
const click = (target: Element | null) => act(() => { (target as HTMLElement).click() })
const toggle = () => host.querySelector<HTMLButtonElement>('.an-edit-row-toggle')!
const line = () => host.querySelector('.an-edit-row-toggle')!.textContent

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  calls.review = []
  calls.files = []
  useAppStore.setState({ activeThreadId: 't1' })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('edit row', () => {
  it('is one collapsed line: verb, file name, line totals', () => {
    draw(edit)
    expect(line()).toBe('Editedapp.ts+2−1')
    expect(host.querySelector('.an-edit-row-name')!.textContent).toBe('app.ts')
    expect(host.querySelector('.turn-edits-add')!.textContent).toBe('+2')
    expect(host.querySelector('.turn-edits-del')!.textContent).toBe('−1')
    expect(toggle().tagName).toBe('BUTTON')
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(host.querySelector('.an-edit-surface')).toBeNull()
    expect(host.querySelector('.an-edit-tool-card')).toBeNull()
  })

  it('opens to the diff on one surface, and closes again', () => {
    draw(edit)
    click(toggle())
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(host.querySelectorAll('.an-edit-surface')).toHaveLength(1)
    expect(host.querySelector('.an-edit-surface [data-testid="diff"]')).not.toBeNull()
    click(toggle())
    expect(host.querySelector('.an-edit-surface')).toBeNull()
  })

  it('stays collapsed while the edit is still running', () => {
    draw({ ...edit, state: 'input-available' })
    expect(line()).toContain('Editing')
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(host.querySelector('.an-edit-surface')).toBeNull()
  })

  it('"Open in Review" opens Review on this turn at this file', async () => {
    draw(edit)
    const review = host.querySelector('button[aria-label="Open app.ts in Review"]')!
    expect(review.getAttribute('title')).toBe('Open in Review')
    click(review)
    expect(calls.review).toEqual([['t1', 'turn-1', '/repo/src/app.ts']])
    expect(calls.files).toEqual([])
    // The action does not open the diff.
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
  })

  it('"Open file" opens the file in the Files panel', () => {
    draw(edit)
    const open = host.querySelector('button[aria-label="Open app.ts"]')!
    expect(open.getAttribute('title')).toBe('Open file')
    click(open)
    expect(calls.files).toEqual([{ path: '/repo/src/app.ts' }])
    expect(calls.review).toEqual([])
  })

  it('a failed edit says so and opens to its error', () => {
    draw({ ...edit, state: 'output-error', errorText: 'old_string not found in file' })
    expect(line()).toContain('Failed to edit')
    expect(host.querySelector('.an-edit-row')!.getAttribute('data-status')).toBe('failed')
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(host.querySelector('.an-edit-surface')!.textContent).toContain('old_string not found in file')
  })

  it('opens when a running edit fails', () => {
    draw({ ...edit, state: 'input-available' })
    draw({ ...edit, state: 'output-error', errorText: 'Permission denied' })
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(host.querySelector('.an-edit-surface')!.textContent).toContain('Permission denied')
  })

  it('a written file reads "Created"', () => {
    draw({ type: 'tool-Write', toolCallId: 'w1', state: 'output-available', input: { file_path: 'docs/cart.md', content: 'one\ntwo\n' } })
    expect(line()).toBe('Createdcart.md+2')
  })

  it('a MultiEdit call adds up its edits', () => {
    draw({
      type: 'tool-MultiEdit',
      toolCallId: 'm1',
      state: 'output-available',
      input: { file_path: 'src/a.ts', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd\ne' }] }
    })
    expect(line()).toBe('Editeda.ts+3−2')
  })

  it('a call about several files is one summary line that lists each file', () => {
    draw({
      ...edit,
      output: {
        changes: [
          { path: 'src/a.ts', change: 'update', added: 5, removed: 1, diff: '@@ -1 +1 @@\n-a\n+b\n' },
          { path: 'src/b.ts', change: 'update', added: 4, removed: 3, diffUnavailable: true },
          { path: 'src/c.ts', change: 'add', added: 3, removed: 0, diffUnavailable: true }
        ]
      }
    })
    expect(line()).toBe('Edited3 files+12−4')
    // The summary names no single file, so it has no file actions.
    expect(host.querySelector('button[title="Open in Review"]')).toBeNull()
    click(toggle())
    const rows = [...host.querySelectorAll('.an-edit-files .an-edit-row-toggle')].map((row) => row.textContent)
    expect(rows).toEqual(['Editeda.ts+5−1', 'Editedb.ts+4−3', 'Createdc.ts+3'])
    click(host.querySelector('button[aria-label="Open b.ts in Review"]'))
    expect(calls.review).toEqual([['t1', 'turn-1', 'src/b.ts']])
  })
})
