// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver

/** The model Monaco would keep under the file's path: what an earlier editor left in it. */
const kept = { text: 'old text', edits: [] as string[] }
const model = {
  getValue: () => kept.text,
  getFullModelRange: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: kept.text.length + 1 }),
  pushEditOperations: (_selections: unknown, operations: Array<{ text: string }>) => {
    kept.edits.push(operations[0].text)
    kept.text = operations[0].text
    return null
  }
}
const editorProps: Array<Record<string, unknown>> = []
const mounted = vi.fn()

vi.mock('@monaco-editor/react', () => ({
  default: (props: Record<string, unknown> & { onMount: (editor: unknown, monaco: unknown) => void }) => {
    editorProps.push(props)
    useEffect(() => {
      const container = document.createElement('div')
      props.onMount({
        getContainerDomNode: () => container,
        onDidDispose: () => ({ dispose() {} }),
        addCommand: () => null,
        getModel: () => model,
        layout: () => undefined,
        focus: () => undefined
      }, {
        KeyMod: { CtrlCmd: 1 },
        KeyCode: { KeyS: 2 },
        languages: { registerCompletionItemProvider: () => ({ dispose() {} }), CompletionItemKind: {} },
        editor: { setModelMarkers: () => undefined },
        MarkerSeverity: {}
      })
    }, [])
    return createElement('div', { className: 'monaco-stub' })
  }
}))
vi.mock('../../src/renderer/utils/monacoTheme', () => ({ applyEditorTheme: () => undefined, MOUSSE_EDITOR_THEME: 'mousse' }))

const { MarkdownDocumentEditor } = await import('../../src/renderer/components/editors/MarkdownDocumentEditor')

let root: Root
let host: HTMLElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  kept.text = 'old text'
  kept.edits = []
  editorProps.length = 0
  window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('Markdown editor with a kept model', () => {
  it('asks Monaco to keep the model, and brings a stale one up to date as one undoable edit', async () => {
    await act(async () => root.render(createElement(MarkdownDocumentEditor, {
      value: 'new text', path: 'scope\0notes.md', keepModel: true, viewMode: 'source', onEditorMount: mounted
    })))
    expect(editorProps.at(-1)).toMatchObject({ path: 'scope\0notes.md', keepCurrentModel: true })
    expect(kept.edits).toEqual(['new text'])
    expect(mounted).toHaveBeenCalledTimes(1)
  })

  it('leaves an up-to-date model, and other editors drop their model as before', async () => {
    kept.text = 'same'
    await act(async () => root.render(createElement(MarkdownDocumentEditor, { value: 'same', path: 'a.md', keepModel: true })))
    expect(kept.edits).toEqual([])
    act(() => root.unmount())
    root = createRoot(host)
    await act(async () => root.render(createElement(MarkdownDocumentEditor, { value: 'other', path: 'b.md' })))
    expect(editorProps.at(-1)).toMatchObject({ keepCurrentModel: false })
    expect(kept.edits).toEqual([])
  })
})
