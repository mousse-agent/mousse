import { existsSync } from 'node:fs'
import { userInfo } from 'node:os'
import {
  editorFolderStyleOf,
  remoteEditorPath,
  type EditorFolder,
  type EditorFolderKind
} from '../../shared/bridge/editorFolder'
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
}

/** The login name of the person who runs Mousse here, or undefined when the system has none to give. */
function loginName(): string | undefined {
  try {
    return userInfo().username || undefined
  } catch {
    return undefined
  }
}

/**
 * The folder an editor on another computer opens for a thread of this computer: the thread's own worktree
 * while it is ready (the folder the thread's agents and its Files panel work in), otherwise the project's
 * folder. It starts from the thread id only. Nothing here restores or creates a worktree: a worktree that a
 * storage rule retired is not brought back for someone who only looks, and the project's folder is opened.
 *
 * A folder that is not on disk (`folder_missing`) or whose path an editor's address cannot carry
 * (`folder_not_openable`: a Windows network share, a `..` segment) is a refusal that names no path.
 */
export function resolveEditorFolder(input: EditorFolderInput): EditorFolder {
  const { threadId, projectPath } = input
  const platform = input.platform ?? process.platform
  const manager = new ThreadWorkspaceManager(input.threadDirectory)
  const stored = manager.load()
  const execution = manager.executionContext(projectPath, stored ? manager.verify(stored) : undefined)
  const candidates: Array<[EditorFolderKind, string]> = []
  if (execution.lifecycle === 'ready' && execution.projectPath)
    candidates.push(['worktree', execution.projectPath])
  candidates.push(['project', projectPath])
  const found = candidates.find(([, path]) => existsSync(path))
  if (!found)
    throw new DomainRpcError('folder_missing', "This thread's folder is no longer on this computer.", {
      threadId
    })
  const [kind, path] = found
  const style = editorFolderStyleOf(platform)
  const uriPath = remoteEditorPath(path, style)
  if (!uriPath)
    throw new DomainRpcError(
      'folder_not_openable',
      'This folder cannot be opened in an editor from another computer.',
      { threadId }
    )
  const user = input.user ?? loginName()
  return { path, uriPath, style, platform, kind, ...(user ? { user } : {}) }
}
