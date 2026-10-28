import { realpathSync, statSync } from 'node:fs'
import { userInfo } from 'node:os'
import {
  editorFolderStyleOf,
  isSafeLoginName,
  remoteEditorPath,
  type EditorFolder,
  type EditorFolderKind
} from '../../shared/bridge/editorFolder'
import { sensitiveFolderContaining } from '../files/sensitiveFolders'
import { DomainRpcError } from '../protocol/domainRegistry'
import { ThreadWorkspaceManager } from './ThreadWorkspaceManager'

export interface EditorFolderInput {
  threadId: string
  /** The thread's own directory in this profile (where its worktree record lives). */
  threadDirectory: string
  /** The folder of the thread's project on this computer. */
  projectPath: string
  /** The system this computer runs; tests give another one. */
  platform?: string
  /** This computer's login name; tests give one. */
  user?: string
  /** What a real path holds when it is in a credentials or settings folder of this computer. Defaults to the shared table. */
  sensitive?: (realPath: string) => string | undefined
}

/** The login name of the person who runs Mousse here, or undefined when the system has none to give. */
function loginName(): string | undefined {
  try {
    return userInfo().username || undefined
  } catch {
    return undefined
  }
}

/** The real path of `path` if it is a folder, and undefined when it is not there, is a file, or cannot be read. */
function realFolder(path: string): string | undefined {
  try {
    const real = realpathSync.native(path)
    return statSync(real).isDirectory() ? real : undefined
  } catch {
    return undefined
  }
}

/**
 * The folder an editor on another computer opens for a thread of this computer. It starts from the thread
 * id only:
 * - a thread that has a worktree opens it while it is ready, the folder the thread's agents and its Files
 *   panel work in. A worktree that is not ready (`missing`: a storage rule removed it; `recovery_required`:
 *   its HEAD moved outside a recorded operation) is refused with `workspace_not_ready` and the state in
 *   `details.state`, never answered with the project's folder, which is another checkout on another
 *   branch. The caller restores a missing worktree (`workspace.restore`) and asks again; nothing here
 *   restores or creates one, so asking is safe to repeat;
 * - a thread that never had a worktree opens its project's folder.
 *
 * The folder must be a directory, and its real path (every link and junction followed) must not be inside a
 * credentials or settings folder of this computer: routed Files refuses those even when the project is one.
 * The reply names the folder as it is spelled (a project reached through a link keeps the link's name).
 *
 * Every refusal names the thread and never a path: `folder_missing` (not on disk, or not a folder),
 * `folder_protected`, `folder_not_openable` (a Windows network share or `\\?\` path, a `..` segment, a
 * control character) and `workspace_not_ready`.
 */
export function resolveEditorFolder(input: EditorFolderInput): EditorFolder {
  const { threadId, projectPath } = input
  const platform = input.platform ?? process.platform
  const sensitive = input.sensitive ?? ((real: string) => sensitiveFolderContaining(real))
  const manager = new ThreadWorkspaceManager(input.threadDirectory)
  const stored = manager.load()
  let kind: EditorFolderKind = 'project'
  let path = projectPath
  if (stored) {
    const verified = manager.verify(stored)
    if (verified.lifecycle !== 'ready')
      throw new DomainRpcError(
        'workspace_not_ready',
        verified.lifecycle === 'missing'
          ? "This thread's worktree was removed. Restore it to open its folder."
          : "This thread's worktree needs recovery before its folder can be opened.",
        { threadId, state: verified.lifecycle }
      )
    kind = 'worktree'
    path = manager.executionContext(projectPath, verified).projectPath
  }
  const real = realFolder(path)
  if (!real)
    throw new DomainRpcError('folder_missing', "This thread's folder is no longer on this computer.", {
      threadId
    })
  const holds = sensitive(real)
  if (holds)
    throw new DomainRpcError(
      'folder_protected',
      `This folder holds ${holds}, so another computer cannot open it.`,
      { threadId }
    )
  const style = editorFolderStyleOf(platform)
  const uriPath = remoteEditorPath(path, style)
  if (!uriPath)
    throw new DomainRpcError(
      'folder_not_openable',
      'This folder cannot be opened in an editor from another computer.',
      { threadId }
    )
  const name = input.user ?? loginName()
  return { path, uriPath, style, platform, kind, ...(isSafeLoginName(name) ? { user: name } : {}) }
}
