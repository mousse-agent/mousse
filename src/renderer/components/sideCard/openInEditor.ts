import { opensOnOwner, type RemoteOpenResult } from '../../../shared/remoteEditor'
import type { EditorInfo } from '../../../shared/types'
import { helpForOpenResult } from '../../lib/editorConnection'
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

/**
 * The editors that open a folder of another computer over their own SSH support, and can open one of a computer
 * that runs `platform` (Zed: not Windows; Windsurf: Linux only). Never the file manager.
 */
export function remoteEditors(editors: readonly EditorInfo[], platform?: string): EditorInfo[] {
  return editors.filter((editor) => editor.kind === 'editor' && editor.remote === true && opensOnOwner(editor.id, platform))
}

/** What a person can do when this computer cannot reach the computer that runs the thread over SSH. */
export interface NoRouteHelp {
  message: string
  /** `approve` opens the dialog that approves the address the computer offers; `devices` opens Settings, Devices at it. */
  action: 'approve' | 'devices'
  label: string
  /** For `approve`: the address the computer offers. */
  endpoint?: string
}

/**
 * Said under the button while this computer has no way at all to open the folder of the computer that runs the
 * thread: no SSH address it approved, and no editor connection of Mousse's own. A computer that offers an SSH
 * address only needs it approved (that path stays for computers set up over SSH). Otherwise Devices is where
 * a connection is made. The states of an editor connection that exists (offline, off, no SSH server...) are
 * `editorConnection.ts`.
 */
export function noRouteHelp(
  editor: Pick<EditorInfo, 'label'>,
  computer: string,
  device?: { platform?: string; sshOffer?: { endpoint: string } }
): NoRouteHelp {
  if (device?.sshOffer) {
    return {
      message: `${computer} offers SSH (${device.sshOffer.endpoint})`,
      action: 'approve',
      label: 'Approve address…',
      endpoint: device.sshOffer.endpoint
    }
  }
  return {
    message: `No connection to ${computer}`,
    action: 'devices',
    label: 'Open Devices…'
  }
}

/** Said when no installed editor can open a folder of another computer. */
export function noRemoteEditorMessage(computer: string): string {
  return `No installed editor can open ${computer}’s folder`
}

/** What a refused open says, in plain words with the computer's and the editor's names. */
export function remoteRefusalMessage(
  result: Extract<RemoteOpenResult, { ok: false }>,
  editor: Pick<EditorInfo, 'label'>,
  computer: string
): string {
  switch (result.reason) {
    case 'no_route':
      return `No connection to ${computer}`
    case 'editor_missing':
      return result.message || `${editor.label} could not be started.`
    case 'no_folder':
      return `No folder on ${computer}`
    case 'folder_missing':
      return `Folder gone from ${computer}`
    case 'folder_protected':
      return `${computer} keeps this folder private`
    case 'folder_not_openable':
      return `This folder cannot be opened remotely`
    case 'worktree_missing':
      return `Worktree on ${computer} was removed`
    case 'worktree_recovery':
      return `Worktree on ${computer} needs recovery`
    case 'ssh_settings':
      return editorSshProblemWords({ code: result.code ?? '', message: result.message ?? '' }, result.includeLine)
    case 'connection': {
      // The side card shows these as a line with an action; this is the line.
      const help = helpForOpenResult(result, computer)
      return help ? help.message : result.message || `${computer} did not answer`
    }
    case 'failed':
      return result.message || `${computer} did not answer`
  }
}
