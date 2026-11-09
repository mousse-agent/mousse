// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenInEditorView } from '../src/renderer/components/sideCard/EditorMenuButton'
import type { EditorInfo } from '../src/shared/types'

const zed: EditorInfo = { id: 'zed', label: 'Zed', kind: 'editor' }
const finder: EditorInfo = { id: 'files', label: 'Finder', kind: 'files' }

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
})

describe('the card header’s file manager button', () => {
  it('shows the folder without making the file manager the editor the main button opens', async () => {
    const onOpen = vi.fn(async () => undefined)
    act(() => root.render(createElement(OpenInEditorView, { path: '/work/app', editors: [zed, finder], lastId: 'zed', onOpen, compact: true })))
    await act(async () => host.querySelector<HTMLButtonElement>('.side-card-open-editor-files')!.click())
    expect(onOpen).toHaveBeenCalledWith(finder, { remember: false })

    await act(async () => host.querySelector<HTMLButtonElement>('.side-card-open-editor-main')!.click())
    expect(onOpen).toHaveBeenLastCalledWith(zed, undefined)
  })
})
