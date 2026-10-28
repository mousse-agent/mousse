import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenInEditorView } from '../src/renderer/components/sideCard/EditorMenuButton'
import {
  defaultEditor,
  hasEditorChoices,
  loadLastEditorId,
  noRemoteEditorMessage,
  noRouteMessage,
  openErrorMessage,
  openLabel,
  remoteEditors,
  remoteRefusalMessage,
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

describe('a folder of another computer', () => {
  const code: EditorInfo = { id: 'vscode', label: 'VS Code', kind: 'editor', remote: true }
  const codium: EditorInfo = { id: 'vscodium', label: 'VSCodium', kind: 'editor', remote: true }
  const idea: EditorInfo = { id: 'idea', label: 'IntelliJ IDEA', kind: 'editor' }

  it('lists only the editors that open remote folders, never the file manager', () => {
    expect(remoteEditors([code, idea, zed, codium, finder])).toEqual([code, codium])
    expect(remoteEditors([idea, finder])).toEqual([])
  })

  it('picks the remembered remote editor and otherwise the first one', () => {
    expect(defaultEditor(remoteEditors([code, idea, codium, finder]), 'vscodium')).toBe(codium)
    expect(defaultEditor(remoteEditors([code, idea, codium, finder]), 'idea')).toBe(code)
    expect(defaultEditor(remoteEditors([idea, finder]), null)).toBeNull()
  })

  it('treats the remote flag as part of an editor when comparing lists', () => {
    expect(sameEditors([code], [{ ...code }])).toBe(true)
    expect(sameEditors([code], [{ id: 'vscode', label: 'VS Code', kind: 'editor' }])).toBe(false)
  })

  it('says what is missing without an SSH route, and when no installed editor can open it', () => {
    expect(noRouteMessage(code, 'Computer B')).toBe(
      'Opening Computer B’s folder in VS Code here needs an SSH route. It arrives with editor connections; until then, set Computer B up over SSH.'
    )
    expect(noRemoteEditorMessage('Computer B')).toContain('None of the editors installed on this computer can open a folder on Computer B.')
  })

  it('words each refusal with the computer and the editor, and shows a computer’s own words as they are', () => {
    const refuse = (reason: Parameters<typeof remoteRefusalMessage>[0]['reason'], more: object = {}) =>
      remoteRefusalMessage({ ok: false, reason, ...more }, code, 'Computer B')
    expect(refuse('no_route')).toBe(noRouteMessage(code, 'Computer B'))
    expect(refuse('folder_protected')).toBe('Computer B will not hand out this folder: it holds credentials or settings.')
    expect(refuse('folder_missing')).toBe('The thread’s folder is no longer on Computer B.')
    expect(refuse('no_folder')).toBe('This thread has no folder on Computer B.')
    expect(refuse('worktree_missing')).toContain('worktree on Computer B was removed and could not be restored')
    expect(refuse('worktree_recovery')).toContain('needs recovery there')
    expect(refuse('folder_not_openable')).toContain('cannot be opened in an editor from another computer')
    expect(refuse('extension_missing', { message: 'Install the Remote - SSH extension (ms-vscode-remote.remote-ssh) in VS Code, then open this folder again.' })).toContain('Install the Remote - SSH extension')
    expect(refuse('failed', { message: 'Computer B is offline.' })).toBe('Computer B is offline.')
    expect(refuse('failed')).toBe('Computer B did not answer.')
  })

  it('gives the line to add by hand when Mousse could not write its settings', () => {
    const line = 'Include ~/.mousse/ssh/config'
    for (const code of ['unwritable', 'not_owner', 'ssh_check_failed']) {
      expect(remoteRefusalMessage({ ok: false, reason: 'ssh_settings', code, message: 'detail', includeLine: line }, { label: 'VS Code' }, 'Computer B')).toContain(line)
    }
  })

  it('renders the same button as a local thread without the file manager, and a blocked one with its reason', () => {
    const open = renderToStaticMarkup(createElement(OpenInEditorView, { path: 'Computer B', editors: remoteEditors([code, codium, finder]), lastId: null, onOpen: async () => {} }))
    expect(open).toContain('Open in VS Code')
    expect(open).toContain('Choose where to open')
    expect(open).not.toContain('Show in')
    expect(open).not.toContain('aria-disabled')

    const blocked = renderToStaticMarkup(createElement(OpenInEditorView, { path: 'Computer B', editors: [code, codium], lastId: 'vscodium', onOpen: async () => {}, blocked: noRouteMessage(codium, 'Computer B') }))
    expect(blocked).toContain('Open in VSCodium')
    expect(blocked).toContain('aria-disabled="true"')
    expect(blocked).toContain('role="note"')
    expect(blocked).toContain('needs an SSH route')
    expect(blocked).toContain('aria-haspopup="menu"')
  })

  it('shows a refusal under the button until the next try', () => {
    const html = renderToStaticMarkup(createElement(OpenInEditorView, { path: 'Computer B', editors: [code], lastId: null, onOpen: async () => {}, refusal: 'Computer B is offline.' }))
    expect(html).toContain('role="alert"')
    expect(html).toContain('Computer B is offline.')
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
