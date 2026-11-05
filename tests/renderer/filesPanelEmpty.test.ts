// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@monaco-editor/react', () => ({ default: () => createElement('div', { className: 'editor-stub' }) }))
vi.mock('../../src/renderer/components/editors/MarkdownDocumentEditor', () => ({ MarkdownDocumentEditor: () => null }))
vi.mock('../../src/renderer/components/FilesSearch', () => ({ FilesSearch: () => null }))
// The tree stub offers one file to open.
vi.mock('../../src/renderer/components/FileTree', () => ({
  FileTreeToolbar: () => null,
  FileTree: ({ onSelectFile }: { onSelectFile: (path: string) => void }) =>
    createElement('button', { type: 'button', className: 'tree-stub', onClick: () => onSelectFile('notes.txt') }, 'notes.txt')
}))

const { FilesPanel } = await import('../../src/renderer/components/FilesPanel')

let root: Root
let host: HTMLElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  ;(window as unknown as { mousse: unknown }).mousse = {
    app: { getFilesRoot: async () => '/repo' },
    fs: { readFile: async () => 'hello', writeFile: async () => undefined, readAsset: async () => null },
    threads: { select: async () => undefined }
  }
  window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('Files panel without an open file', () => {
  it('says once, in the body, to pick a file; the header and tabs appear with a real file', async () => {
    await act(async () => root.render(createElement(FilesPanel)))
    expect(host.textContent?.match(/Select a file/g)).toHaveLength(1)
    expect(host.querySelector('.files-editor-toolbar')).toBeNull()
    expect(host.querySelector('[role="tablist"]')).toBeNull()

    await act(async () => host.querySelector<HTMLButtonElement>('.tree-stub')?.click())
    await act(async () => {})
    expect(host.querySelector('.files-editor-toolbar .panel-toolbar-path')?.textContent).toBe('notes.txt')
    expect(host.querySelector('[role="tablist"]')).not.toBeNull()
    expect(host.textContent).not.toContain('Select a file')
  })
})
