import type { RemoteOpenResult } from '../../../shared/remoteEditor'
import type { EditorInfo } from '../../../shared/types'
import { editorSshProblemWords } from '../../lib/editorSsh'
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
    return editor.id === other.id && editor.label === other.label && editor.kind === other.kind && editor.remote === other.remote && editor.iconDataUrl === other.iconDataUrl
  })
}

/** The failure's own message, without the IPC transport prefix. */
export function openErrorMessage(error: unknown): string {
  return ipcErrorLine(error) || 'Could not open the folder'
}

/** The editors that open a folder of another computer over their own SSH support. Never the file manager. */
export function remoteEditors(editors: readonly EditorInfo[]): EditorInfo[] {
  return editors.filter((editor) => editor.kind === 'editor' && editor.remote === true)
}

/** Said under the button while this computer has no SSH route to the computer that runs the thread. */
export function noRouteMessage(editor: Pick<EditorInfo, 'label'>, computer: string): string {
  return `Opening ${computer}’s folder in ${editor.label} here needs an SSH route. It arrives with editor connections; until then, set ${computer} up over SSH.`
}

/** Said when no installed editor can open a folder of another computer. */
export function noRemoteEditorMessage(computer: string): string {
  return `None of the editors installed on this computer can open a folder on ${computer}. VS Code, Cursor, Windsurf and VSCodium can.`
}

/** What a refused open says, in plain words with the computer's and the editor's names. */
export function remoteRefusalMessage(
  result: Extract<RemoteOpenResult, { ok: false }>,
  editor: Pick<EditorInfo, 'label'>,
  computer: string
): string {
  switch (result.reason) {
    case 'no_route':
      return noRouteMessage(editor, computer)
    case 'editor_missing':
    case 'extension_missing':
      return result.message || `${editor.label} could not be started.`
    case 'no_folder':
      return `This thread has no folder on ${computer}.`
    case 'folder_missing':
      return `The thread’s folder is no longer on ${computer}.`
    case 'folder_protected':
      return `${computer} will not hand out this folder: it holds credentials or settings.`
    case 'folder_not_openable':
      return `This folder cannot be opened in an editor from another computer.`
    case 'worktree_missing':
      return `The thread’s worktree on ${computer} was removed and could not be restored. Restore it on ${computer}, then open it again.`
    case 'worktree_recovery':
      return `The thread’s worktree on ${computer} needs recovery there before its folder can be opened.`
    case 'ssh_settings':
      return editorSshProblemWords({ code: result.code ?? '', message: result.message ?? '' }, result.includeLine)
    case 'failed':
      return result.message || `${computer} did not answer.`
  }
}
