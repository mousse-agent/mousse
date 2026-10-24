import type { EditorInfo } from '../../../shared/types'
import { ipcErrorLine } from '../../lib/errorText'
import { profilePreferenceKey } from '../../lib/profilePreferences'

const PREFERENCE_NAME = 'openInEditor.v1'

/** The editor or file manager last chosen for this profile, or null. */
export function loadLastEditorId(profileId: string): string | null {
  try {
    const raw = localStorage.getItem(profilePreferenceKey(profileId, PREFERENCE_NAME))
    return raw ? raw : null
  } catch {
    return null
  }
}

export function saveLastEditorId(profileId: string, editorId: string): void {
  try {
    localStorage.setItem(profilePreferenceKey(profileId, PREFERENCE_NAME), editorId)
  } catch {
    /* ignore quota / private mode */
  }
}

/**
 * The entry the main button opens: the remembered one while it is still detected,
 * otherwise the first detected editor, otherwise the file manager.
 */
export function defaultEditor(editors: readonly EditorInfo[], lastId: string | null): EditorInfo | null {
  const remembered = lastId ? editors.find((editor) => editor.id === lastId) : undefined
  return remembered ?? editors.find((editor) => editor.kind === 'editor') ?? editors.find((editor) => editor.kind === 'files') ?? null
}

/** The chevron and menu only exist when there is something to choose between. */
export function hasEditorChoices(editors: readonly EditorInfo[]): boolean {
  return editors.length > 1
}

/** "Open in Cursor", "Show in Finder". */
export function openLabel(editor: Pick<EditorInfo, 'kind' | 'label'>): string {
  return `${editor.kind === 'files' ? 'Show' : 'Open'} in ${editor.label}`
}

/** Editors first, then the file manager after a separator. */
export function splitEditors(editors: readonly EditorInfo[]): { editors: EditorInfo[]; files: EditorInfo[] } {
  return {
    editors: editors.filter((editor) => editor.kind === 'editor'),
    files: editors.filter((editor) => editor.kind === 'files')
  }
}

export function sameEditors(a: readonly EditorInfo[], b: readonly EditorInfo[]): boolean {
  return a.length === b.length && a.every((editor, index) => {
    const other = b[index]
    return editor.id === other.id && editor.label === other.label && editor.kind === other.kind && editor.iconDataUrl === other.iconDataUrl
  })
}

/** The failure's own message, without the IPC transport prefix. */
export function openErrorMessage(error: unknown): string {
  return ipcErrorLine(error) || 'Could not open the folder'
}
