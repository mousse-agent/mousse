// @vitest-environment jsdom
/** The edit row's diff is its own chunk: if it fails to load, the row says so and Retry loads it again. */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const diffChunk = vi.hoisted(() => ({ loads: 0 }))
vi.mock('../../src/renderer/chat/components/agent-elements/tools/edit-diff', async () => {
  diffChunk.loads += 1
  if (diffChunk.loads === 1) throw new TypeError('Failed to fetch dynamically imported module')
  const { createElement: element } = await import('react')
  return { EditDiff: () => element('div', { 'data-testid': 'diff' }) }
})
vi.mock('../../src/renderer/components/changes/openChanges', () => ({ openTurnInChanges: async () => {} }))
vi.mock('../../src/renderer/utils/chatLinks', () => ({ openFileInPanel: () => {} }))

import { EditTool } from '../../src/renderer/chat/components/agent-elements/tools/edit-tool'
import { TurnIdContext } from '../../src/renderer/chat/components/agent-elements/turn-context'
import { useAppStore } from '../../src/renderer/stores/appStore'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  useAppStore.setState({ activeThreadId: 't1' })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const settle = () => act(async () => { for (let i = 0; i < 10; i += 1) await new Promise((done) => setTimeout(done, 0)) })

it("shows Couldn't load in the open row, and Retry draws the diff", async () => {
  const part = {
    type: 'tool-Edit',
    toolCallId: 'c1',
    state: 'output-available',
    input: { file_path: '/repo/src/app.ts', old_string: 'a', new_string: 'b\nc' }
  }
  act(() => root.render(createElement(TurnIdContext.Provider, { value: 'turn-1' }, createElement(EditTool, { part }))))
  act(() => { host.querySelector<HTMLButtonElement>('.an-edit-row-toggle')!.click() })
  await settle()
  // The row and its surface stay; only the diff is replaced by the failure line.
  expect(host.querySelector('.an-edit-surface [role="alert"]')?.textContent).toBe("Couldn't load. Retry")
  expect(host.querySelector('[data-testid="diff"]')).toBeNull()
  act(() => { host.querySelector<HTMLButtonElement>('.lazy-load-failed-retry')!.click() })
  await settle()
  expect(diffChunk.loads).toBe(2)
  expect(host.querySelector('.an-edit-surface [data-testid="diff"]')).not.toBeNull()
  expect(host.querySelector('[role="alert"]')).toBeNull()
})
