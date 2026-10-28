/**
 * Opening the folder of a thread that runs on another of the user's computers in an editor installed on
 * this one. The main process opens it (`src/main/remoteEditor*.ts`); the window words the answer.
 */

/**
 * Whether `mousse-cli net ssh-proxy` exists. Mousse's own SSH names (`Host mousse-…` in `~/.mousse/ssh/config`)
 * reach a computer only through it, so until it does a name from that file is not offered to an editor and the
 * `Include` line is not added for one. The change that adds the command turns this on.
 */
export const EDITOR_PROXY_READY = false

/** How this computer reaches the owner for an editor. */
export type RemoteRouteKind =
  /** An SSH address this computer approved for the computer (SSH setup), used as it is. */
  | 'ssh'
  /** One of Mousse's own SSH names, carried by Mousse's connection. */
  | 'mousse'
  /** Neither exists yet. */
  | 'none'

export interface RemoteRoute {
  kind: RemoteRouteKind
}

/** Why a folder was not opened. The window words each one with the computer's and the editor's names. */
export type RemoteOpenReason =
  /** No SSH route to the computer exists yet. */
  | 'no_route'
  /** The editor is not installed, or has no command to start it. */
  | 'editor_missing'
  /** The editor's Remote - SSH extension is not installed. `message` names it. */
  | 'extension_missing'
  /** The thread has no folder on its computer. */
  | 'no_folder'
  | 'folder_missing'
  /** The folder holds credentials or settings, so its computer refuses to hand it out. */
  | 'folder_protected'
  /** The folder's path cannot be written as an address (a network share, a `..`). */
  | 'folder_not_openable'
  /** The thread's worktree was removed and could not be restored, or needs recovery on its computer. */
  | 'worktree_missing'
  | 'worktree_recovery'
  /** Mousse's SSH settings could not be prepared. `code` is the `EditorSshProblemCode`. */
  | 'ssh_settings'
  /** The computer or the link said no in words of its own, in `message`. */
  | 'failed'

export type RemoteOpenResult =
  | { ok: true }
  | {
      ok: false
      reason: RemoteOpenReason
      message?: string
      /** For `ssh_settings`: the `EditorSshProblemCode`. */
      code?: string
      /** For `ssh_settings`: the line Mousse would add to `~/.ssh/config`, for the person to add by hand. */
      includeLine?: string
    }
