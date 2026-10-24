import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenInEditorView } from '../src/renderer/components/sideCard/EditorMenuButton'
import {
  defaultEditor,
  hasEditorChoices,
  loadLastEditorId,
  openErrorMessage,
  openLabel,
  sameEditors,
  saveLastEditorId,
  splitEditors
} from '../src/renderer/components/sideCard/openInEditor'
import { profilePreferenceKey } from '../src/renderer/lib/profilePreferences'
import type { EditorInfo } from '../src/shared/types'

const cursor: EditorInfo = { id: 'cursor', label: 'Cursor', kind: 'editor', iconDataUrl: 'data:image/png;base64,AAAA' }
const zed: EditorInfo = { id: 'zed', label: 'Zed', kind: 'editor' }
const finder: EditorInfo = { id: 'files', label: 'Finder', kind: 'files' }

describe('defaultEditor', () => {
  it('uses the remembered editor while it is detected', () => {
    expect(defaultEditor([cursor, zed, finder], 'zed')).toBe(zed)
    expect(defaultEditor([cursor, zed, finder], 'files')).toBe(finder)
  })

  it('falls back to the first detected editor when nothing is remembered or it is gone', () => {
    expect(defaultEditor([cursor, zed, finder], null)).toBe(cursor)
    expect(defaultEditor([cursor, zed, finder], 'vscode')).toBe(cursor)
  })

  it('falls back to the files entry when no editor is detected', () => {
    expect(defaultEditor([finder], null)).toBe(finder)
    expect(defaultEditor([finder], 'vscode')).toBe(finder)
  })

  it('has no default for an empty list', () => {
    expect(defaultEditor([], 'cursor')).toBeNull()
  })
})

describe('menu helpers', () => {
  it('shows the chevron only when there is more than the files entry', () => {
    expect(hasEditorChoices([finder])).toBe(false)
    expect(hasEditorChoices([cursor, finder])).toBe(true)
  })

  it('labels editors and the file manager', () => {
    expect(openLabel(cursor)).toBe('Open in Cursor')
    expect(openLabel(finder)).toBe('Show in Finder')
    expect(openLabel({ kind: 'files', label: 'File Explorer' })).toBe('Show in File Explorer')
    expect(openLabel({ kind: 'files', label: 'Files' })).toBe('Show in Files')
  })

  it('splits editors from the files entry', () => {
    expect(splitEditors([cursor, zed, finder])).toEqual({ editors: [cursor, zed], files: [finder] })
  })

  it('compares lists by content', () => {
    expect(sameEditors([cursor, finder], [{ ...cursor }, { ...finder }])).toBe(true)
    expect(sameEditors([cursor, finder], [cursor])).toBe(false)
    expect(sameEditors([cursor], [{ ...cursor, iconDataUrl: undefined }])).toBe(false)
  })

  it('strips the transport prefix from failures', () => {
    expect(openErrorMessage(new Error("Error invoking remote method 'editors:open': Error: That folder does not exist.")))
      .toBe('That folder does not exist.')
    expect(openErrorMessage(new Error(''))).toBe('Could not open the folder')
  })
})

describe('last choice preference', () => {
  const store = new Map<string, string>()

  beforeEach(() => {
    store.clear()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) },
      removeItem: (key: string) => { store.delete(key) }
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('reads nothing before a choice is saved', () => {
    expect(loadLastEditorId('p1')).toBeNull()
  })

  it('round-trips under the profile key', () => {
    saveLastEditorId('p1', 'zed')
    expect(store.get(profilePreferenceKey('p1', 'openInEditor.v1'))).toBe('zed')
    expect(loadLastEditorId('p1')).toBe('zed')
    expect(loadLastEditorId('p2')).toBeNull()
  })

  it('survives unavailable storage', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') }
    })
    expect(loadLastEditorId('p1')).toBeNull()
    expect(() => saveLastEditorId('p1', 'zed')).not.toThrow()
  })
})

describe('OpenInEditorView', () => {
  const render = (props: { path: string | null; editors: EditorInfo[]; lastId: string | null }) =>
    renderToStaticMarkup(createElement(OpenInEditorView, { ...props, onOpen: async () => {} }))

  it('renders nothing without a folder', () => {
    expect(render({ path: null, editors: [cursor, finder], lastId: null })).toBe('')
  })

  it('renders a split button with the remembered editor and a chevron', () => {
    const html = render({ path: '/work/app', editors: [cursor, zed, finder], lastId: 'zed' })
    expect(html).toContain('Open in Zed')
    expect(html).not.toContain('Open in Cursor')
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-label="Choose where to open"')
    expect(html).not.toContain('role="menu"')
  })

  it('shows the editor icon with empty alt text', () => {
    const html = render({ path: '/work/app', editors: [cursor, finder], lastId: null })
    expect(html).toContain('Open in Cursor')
    expect(html).toContain('<img class="side-card-open-editor-icon" src="data:image/png;base64,AAAA" alt=""')
  })

  it('renders one plain button when only the files entry exists', () => {
    const html = render({ path: '/work/app', editors: [finder], lastId: 'cursor' })
    expect(html).toContain('Show in Finder')
    expect(html).toContain('side-card-open-editor-group single')
    expect(html).not.toContain('aria-haspopup')
    expect(html).not.toContain('side-card-open-editor-chevron')
  })
})
