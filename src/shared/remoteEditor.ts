/**
 * Opening the folder of a thread that runs on another of the user's computers in an editor installed on
 * this one. The main process opens it (`src/main/remoteEditor*.ts`); the window words the answer.
 */
import type { EditorAskReply } from './bridge/editorAsk'
import type { TunnelFailure, TunnelPath } from './net/tunnel'

/**
 * Whether Mousse's own SSH names (`Host mousse-…` in `~/.mousse/ssh/config`, carried by `mousse-cli net ssh-proxy`) are
 * offered to an editor. They are, with the states that say why a connection is refused (offline, editor connections
 * off with Ask, no SSH server...). A computer with an approved SSH address never uses them: it opens over that address.
 */
export const EDITOR_PROXY_READY = true

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

/**
 * Why an editor connection to a computer cannot be used right now: the fixed reasons of the tunnel
 * (`offline`, `editor_off`, `no_ssh_server`, `host_untrusted`...), and what a sign-in check found after the
 * tunnel itself opened (`key_refused`: the computer's SSH server did not accept this computer's key;
 * `ssh_failed`: it failed in another way).
 */
export type EditorConnectionFailure = TunnelFailure | 'key_refused' | 'ssh_failed'

/** Why a folder was not opened. The window words each one with the computer's and the editor's names. */
export type RemoteOpenReason =
  /** No SSH route to the computer exists yet. */
  | 'no_route'
  /** The editor is not installed, or has no command to start it. */
  | 'editor_missing'
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
  /** The editor connection to the computer cannot be used; `failure` says why. */
  | 'connection'
  /** The computer or the link said no in words of its own, in `message`. */
  | 'failed'

export type RemoteOpenResult =
  /**
   * `hint`: the editor's Remote - SSH extension could not be found; the editor was started anyway.
   * `via`: how the connection runs, when Mousse carries it (`relay`: through a Mousse relay), from this open's own check.
   */
  | {
      ok: true
      hint?: string
      via?: { path: TunnelPath; transport?: string }
      /** The sign-in check did not pass. The editor was started anyway; this is only advice, shown briefly. */
      advice?: { failure: 'key_refused' | 'ssh_failed'; message?: string; command?: string }
    }
  | {
      ok: false
      reason: RemoteOpenReason
      message?: string
      /** For `ssh_settings`: the `EditorSshProblemCode`. */
      code?: string
      /** For `ssh_settings`: the line Mousse would add to `~/.ssh/config`, for the person to add by hand. */
      includeLine?: string
      /** For `connection`: why. */
      failure?: EditorConnectionFailure
      /** For `key_refused`: the command that puts this computer's key on the other one, to run in a terminal here. */
      command?: string
    }

/** What asking another computer for editor connections answered (`editors.askAccess`). */
export type RemoteAskResult =
  | { ok: true; reply: EditorAskReply }
  | { ok: false; failure: EditorConnectionFailure; message?: string }
