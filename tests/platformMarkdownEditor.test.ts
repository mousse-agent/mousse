import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MARKDOWN_SELECTION,
  restoreMarkdownSelection,
  switchMarkdownViewMode
} from '../src/renderer/components/editors/markdownEditorState'
import {
  isExternalOrUnsafePreviewUrl,
  isSafePreviewHref,
  preserveMarkdownSource,
  previewImageDecision,
  resolvePreviewImageSrc
} from '../src/renderer/components/editors/markdownPreviewPolicy'
import { MarkdownPreview } from '../src/renderer/components/editors/MarkdownPreview'
import { MarkdownViewTabs } from '../src/renderer/components/editors/MarkdownViewTabs'

const filesPanelSource = readFileSync(
  new URL('../src/renderer/components/FilesPanel.tsx', import.meta.url),
  'utf8'
)
const editorSource = readFileSync(
  new URL('../src/renderer/components/editors/MarkdownDocumentEditor.tsx', import.meta.url),
  'utf8'
)

describe('MarkdownDocumentEditor source preservation', () => {
  it('keeps exact source bytes when switching Source and Preview', () => {
    const source = '# Title\n\nKeep  *this*  spacing.\n\n```js\nconst n = 1\n```\n'
    const afterPreview = switchMarkdownViewMode(
      { value: source, viewMode: 'source', selection: { startLineNumber: 3, startColumn: 6, endLineNumber: 3, endColumn: 10 } },
      'preview'
    )
    expect(afterPreview.value).toBe(source)
    expect(afterPreview.value).toBe(preserveMarkdownSource(source))
    expect(afterPreview.viewMode).toBe('preview')
    expect(afterPreview.selection).toEqual({
      startLineNumber: 3,
      startColumn: 6,
      endLineNumber: 3,
      endColumn: 10
    })

    const backToSource = switchMarkdownViewMode(afterPreview, 'source')
    expect(backToSource.value).toBe(source)
    expect(restoreMarkdownSelection(backToSource.selection)).toEqual(afterPreview.selection)
  })

  it('restores a missing selection to the document start without inventing content', () => {
    expect(restoreMarkdownSelection(null)).toEqual(DEFAULT_MARKDOWN_SELECTION)
    expect(restoreMarkdownSelection(undefined).startLineNumber).toBe(1)
  })
})

describe('Markdown preview safety', () => {
  it('blocks remote, protocol, and renderer-origin image fetches', () => {
    expect(isExternalOrUnsafePreviewUrl('https://example.com/x.png')).toBe(true)
    expect(isExternalOrUnsafePreviewUrl('http://127.0.0.1/x.png')).toBe(true)
    expect(isExternalOrUnsafePreviewUrl('//cdn.example/x.png')).toBe(true)
    expect(isExternalOrUnsafePreviewUrl('javascript:alert(1)')).toBe(true)
    expect(isExternalOrUnsafePreviewUrl('file:///tmp/x.png')).toBe(true)
    expect(isExternalOrUnsafePreviewUrl('blob:https://app/uuid')).toBe(true)
    expect(isExternalOrUnsafePreviewUrl('data:text/html,<img>')).toBe(true)
    expect(resolvePreviewImageSrc('./local.png')).toBeNull()
    expect(previewImageDecision('https://evil.test/a.png')).toBe('block')
    expect(resolvePreviewImageSrc('data:image/png;base64,aaa')).toBe('data:image/png;base64,aaa')
  })

  it('rejects javascript and data hyperlinks', () => {
    expect(isSafePreviewHref('javascript:alert(1)')).toBe(false)
    expect(isSafePreviewHref('data:text/html,hi')).toBe(false)
    expect(isSafePreviewHref('https://example.com')).toBe(true)
    expect(isSafePreviewHref('#section')).toBe(true)
  })

  it('static preview markup omits remote image src and raw HTML (not a UI interaction pass)', () => {
    const markup = renderToStaticMarkup(
      createElement(MarkdownPreview, {
        value: [
          'Hello **world**',
          '',
          '<script>alert(1)</script>',
          '',
          '![remote](https://example.com/tracker.png)',
          '',
          '![inline](data:image/png;base64,abc)',
          '',
          '[ok](https://example.com)',
          '',
          '[bad](javascript:alert(1))'
        ].join('\n')
      })
    )
    expect(markup).toContain('<strong>world</strong>')
    expect(markup).not.toContain('https://example.com/tracker.png')
    expect(markup).toContain('Image omitted: remote')
    expect(markup).not.toContain('src="data:')
    expect(resolvePreviewImageSrc('data:image/png;base64,abc')).toBe('data:image/png;base64,abc')
    expect(markup).not.toContain('<script>')
    expect(markup).toContain('href="https://example.com"')
    expect(markup).not.toContain('javascript:alert(1)')
  })
})

describe('Markdown Source/Preview tabs (static markup)', () => {
  it('renders accessible Source and Preview tabs without claiming keyboard focus was exercised', () => {
    const sourceMarkup = renderToStaticMarkup(
      createElement(MarkdownViewTabs, {
        viewMode: 'source',
        sourceTabId: 'src',
        previewTabId: 'prv',
        sourcePanelId: 'src-panel',
        previewPanelId: 'prv-panel',
        onViewModeChange: () => undefined
      })
    )
    expect(sourceMarkup).toContain('role="tablist"')
    expect(sourceMarkup).toContain('aria-label="Markdown view"')
    expect(sourceMarkup).toContain('Source')
    expect(sourceMarkup).toContain('Preview')
    expect(sourceMarkup).toContain('aria-selected="true"')
    expect(sourceMarkup).toContain('id="src"')
    expect(sourceMarkup).toMatch(/id="src"[^>]*tabindex="0"/)
    expect(sourceMarkup).toMatch(/id="prv"[^>]*tabindex="-1"/)

    const previewMarkup = renderToStaticMarkup(
      createElement(MarkdownViewTabs, {
        viewMode: 'preview',
        sourceTabId: 'src',
        previewTabId: 'prv',
        sourcePanelId: 'src-panel',
        previewPanelId: 'prv-panel',
        onViewModeChange: () => undefined
      })
    )
    expect(previewMarkup).toMatch(/id="prv"[^>]*aria-selected="true"/)
    expect(previewMarkup).toMatch(/id="src"[^>]*tabindex="-1"/)
    expect(previewMarkup).toMatch(/id="prv"[^>]*tabindex="0"/)
  })
})

describe('FilesPanel markdown extraction', () => {
  it('consumes MarkdownDocumentEditor for markdown and retains other file kinds', () => {
    expect(filesPanelSource).toContain('MarkdownDocumentEditor')
    expect(filesPanelSource).toContain("selected.kind === 'markdown'")
    expect(filesPanelSource).toContain("selected.kind === 'html'")
    expect(filesPanelSource).toContain('files-html-preview')
    expect(filesPanelSource).toContain('Binary files cannot be edited.')
    expect(filesPanelSource).toContain('readAsset')
    expect(filesPanelSource).toContain('languageForPath')
    expect(filesPanelSource).not.toContain('ReactMarkdown')
    expect(filesPanelSource).not.toContain('remarkGfm')
  })

  it('keeps file writes in FilesPanel; editor owns no daemon or fs calls', () => {
    expect(filesPanelSource).toContain('window.mousse.fs.writeFile')
    expect(filesPanelSource).toContain('window.mousse.fs.readFile')
    expect(editorSource).not.toContain('window.mousse')
    expect(editorSource).not.toContain('writeFile')
    expect(editorSource).not.toContain('readFile')
    expect(editorSource).toContain('readOnly')
    expect(editorSource).toContain('variableSuggestions')
    expect(editorSource).toContain('validationMessages')
    expect(editorSource).toContain('automaticLayout')
    expect(editorSource).toContain('applyEditorTheme')
  })
})
