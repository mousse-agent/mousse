// @vitest-environment jsdom
import { act, createElement, memo } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PromptUndoProvider, sameHistory, usePromptThreadId } from '../../src/renderer/components/PromptUndoControls'
import type { ThreadActionHistory } from '../../src/renderer/utils/threadActionHistory'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('typing in the composer', () => {
  it('does not re-render the controls of every prompt', async () => {
    // Every prompt's Undo, Edit, versions and menu read the undo context. The chat shell renders its
    // provider again on each keystroke, with the same thread and transcript.
    let renders = 0
    const PromptControl = memo(function PromptControl() {
      renders += 1
      usePromptThreadId()
      return null
    })
    const control = createElement(PromptControl)
    const keystroke = () =>
      act(async () => {
        root.render(createElement(PromptUndoProvider, { threadId: null, busy: false, revision: 'same', children: control }))
      })
    await keystroke()
    expect(renders).toBe(1)
    for (let key = 0; key < 5; key += 1) await keystroke()
    expect(renders).toBe(1)
  })
})

describe('the undo history read every few seconds', () => {
  const read = (generation: number) =>
    ({ actions: [], receipts: [], journalGeneration: generation, undoTarget: null }) as unknown as ThreadActionHistory

  it('counts as unchanged when it says the same thing, so the prompts keep their state', () => {
    expect(sameHistory(read(7), read(7))).toBe(true)
  })

  it('counts as changed when anything in it differs', () => {
    expect(sameHistory(read(7), read(8))).toBe(false)
    expect(sameHistory(null, read(7))).toBe(false)
    expect(sameHistory(read(7), null)).toBe(false)
  })
})
