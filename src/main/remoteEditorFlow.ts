/**
 * What the main process asks before an editor opens a folder of another computer: how this computer
 * reaches it, and which folder the thread works in there. Starts no editor and spawns nothing; the daemon
 * is reached through `ask`, so tests give it fakes.
 */
import { isComputerErrorCode } from '../shared/bridge/computerErrors'
import type { EditorProbeResult, EditorSshResult, EditorSshStatus } from '../shared/net/local'
import type { EditorConnectionFailure, RemoteOpenResult, RemoteRoute } from '../shared/remoteEditor'
import { parseQualifiedId } from '../shared/threadRef'
import { checkedFolder, parseSshTarget, RemoteOpenError, type CheckedFolder, type RemoteHost } from './remoteEditor'

export type Ask = (method: string, params: Record<string, unknown>) => Promise<unknown>
export type RemoteFailure = Extract<RemoteOpenResult, { ok: false }>

export interface FlowOptions {
  /** Whether Mousse's own SSH names reach a computer (`EDITOR_PROXY_READY`). */
  proxyReady: boolean
}

const codeOf = (error: unknown): string | undefined => {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  return typeof code === 'string' ? code : undefined
}
const stateOf = (error: unknown): unknown => {
  const details = error && typeof error === 'object' ? (error as { details?: unknown }).details : undefined
  return details && typeof details === 'object' ? (details as { state?: unknown }).state : undefined
}
const messageOf = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : 'The computer did not answer.'
const reasonOf = (error: unknown): unknown => {
  const details = error && typeof error === 'object' ? (error as { details?: unknown }).details : undefined
  return details && typeof details === 'object' ? (details as { reason?: unknown }).reason : undefined
}

/**
 * The editor connection state a failed call to another computer stands for: it is offline, it blocked this
 * computer or switched other computers off, this computer lacks the grant, or it runs a Mousse too old for
 * the call. Undefined for an error that says something else (the router's other words are shown as they are).
 */
export function connectionFailureOf(error: unknown): EditorConnectionFailure | undefined {
  switch (codeOf(error)) {
    case 'computer_offline':
      return 'offline'
    case 'computer_outdated':
      return 'unsupported'
    case 'rate_limited':
      return 'rate_limited'
    case 'deadline_exceeded':
      return 'timeout'
    case 'computer_forbidden': {
      const reason = reasonOf(error)
      return reason === 'blocked' || reason === 'setting_off' || reason === 'capability' ? reason : undefined
    }
    default:
      return undefined
  }
}

/** The computer that runs a thread, from the thread's qualified id. Undefined for a thread of this computer. */
export function nodeOfThread(threadId: unknown): string | undefined {
  return parseQualifiedId(threadId)?.node
}

/**
 * How this computer reaches `node` for an editor:
 * - an SSH address this computer approved for it (SSH setup's `approvals.json`), used as it is;
 * - else one of Mousse's own SSH names, only when its proxy command exists;
 * - else none.
 * Reads only. Mousse's name for the computer is made when the folder is opened (`prepare`).
 */
export async function remoteRoute(ask: Ask, node: string, options: FlowOptions): Promise<RemoteRoute & { host?: RemoteHost }> {
  const saved = await ask('net.ssh.target', { node }).catch(() => undefined)
  const endpoint = saved && typeof saved === 'object' ? (saved as { endpoint?: unknown }).endpoint : undefined
  const target = parseSshTarget(endpoint)
  if (target) return { kind: 'ssh', host: { kind: 'ssh', target } }
  if (options.proxyReady) {
    const status = (await ask('net.editor.ssh.status', {}).catch(() => undefined)) as EditorSshStatus | undefined
    if (status?.available) return { kind: 'mousse' }
  }
  return { kind: 'none' }
}

/** A refusal of the computer that runs the thread, as a result; undefined for an error that is not one. */
function refusalOf(error: unknown): RemoteFailure | undefined {
  switch (codeOf(error)) {
    case 'thread_has_no_folder':
      return { ok: false, reason: 'no_folder' }
    case 'folder_missing':
      return { ok: false, reason: 'folder_missing' }
    case 'folder_protected':
      return { ok: false, reason: 'folder_protected' }
    case 'folder_not_openable':
      return { ok: false, reason: 'folder_not_openable' }
    case 'workspace_not_ready':
      return { ok: false, reason: stateOf(error) === 'recovery_required' ? 'worktree_recovery' : 'worktree_missing' }
    default: {
      // Offline, blocked, switched off, too old: states the window words with a next step.
      const failure = connectionFailureOf(error)
      if (failure) return { ok: false, reason: 'connection', failure, message: messageOf(error) }
      // Any other word of the router (not allowed, one action on several computers): shown as it is.
      return isComputerErrorCode(codeOf(error)) ? { ok: false, reason: 'failed', message: messageOf(error) } : undefined
    }
  }
}

/**
 * The folder a thread of another computer works in, as that computer answers `editor.folder`. A worktree
 * that was removed (`workspace_not_ready`, state `missing`) is restored there with the routed
 * `workspace.restore` and the folder is asked for again, once.
 */
export async function remoteFolder(ask: Ask, threadId: string): Promise<{ ok: true; folder: CheckedFolder } | RemoteFailure> {
  const attempt = async (): Promise<{ answer: unknown } | { error: unknown }> => {
    try {
      return { answer: await ask('editor.folder', { threadId }) }
    } catch (error) {
      return { error }
    }
  }
  let result = await attempt()
  if ('error' in result && codeOf(result.error) === 'workspace_not_ready' && stateOf(result.error) === 'missing') {
    try {
      await ask('workspace.restore', { threadId })
    } catch (error) {
      // The computer or the link refused in its own words, or the worktree could not be brought back.
      return refusalOf(error) ?? { ok: false, reason: 'worktree_missing' }
    }
    result = await attempt()
  }
  if ('error' in result) {
    const refusal = refusalOf(result.error)
    if (refusal) return refusal
    throw result.error
  }
  try {
    return { ok: true, folder: checkedFolder(result.answer) }
  } catch (error) {
    if (error instanceof RemoteOpenError) return { ok: false, reason: 'folder_not_openable' }
    throw error
  }
}

/**
 * The alias of the computer in Mousse's own files (`net.editor.alias`), or the plain refusal of its settings. It
 * writes nothing in the user's `~/.ssh/config`: the connection is checked with the alias first, and the `Include`
 * line is added by `mousseHost` only once the check passed and the open is going ahead.
 */
export async function mousseAlias(ask: Ask, node: string): Promise<{ ok: true; host: RemoteHost; config: string } | RemoteFailure> {
  const result = (await ask('net.editor.alias', {})) as EditorSshResult
  if (!result.ok) return { ok: false, reason: 'ssh_settings', code: result.code, message: result.message, includeLine: result.status.includeLine }
  const computer = result.status.computers.find((entry) => entry.node === node)
  if (!computer) return { ok: false, reason: 'no_route' }
  return { ok: true, host: { kind: 'mousse', alias: computer.alias }, config: result.status.mousseConfig }
}

/** Adds the `Include` line if it is not there (`net.editor.ssh.prepare`), or gives the plain refusal of Mousse's SSH settings. */
export async function mousseHost(ask: Ask, node: string): Promise<{ ok: true; host: RemoteHost } | RemoteFailure> {
  const result = (await ask('net.editor.ssh.prepare', {})) as EditorSshResult
  if (!result.ok) return { ok: false, reason: 'ssh_settings', code: result.code, message: result.message, includeLine: result.status.includeLine }
  const computer = result.status.computers.find((entry) => entry.node === node)
  if (!computer) return { ok: false, reason: 'no_route' }
  return { ok: true, host: { kind: 'mousse', alias: computer.alias } }
}

/**
 * Everything to open the folder of `threadId`: its host and its folder. For one of Mousse's own names only the alias
 * is made here (`config` is the file that holds it); the connection is checked next, and the `Include` line is added
 * (`mousseHost`) only when the check passed, so a refused open leaves `~/.ssh/config` as it was.
 */
export async function resolveRemoteOpen(
  ask: Ask,
  threadId: unknown,
  options: FlowOptions
): Promise<{ ok: true; host: RemoteHost; folder: CheckedFolder; config?: string } | RemoteFailure> {
  const node = nodeOfThread(threadId)
  if (!node || typeof threadId !== 'string') throw new Error('This thread is on this computer. Its folder opens from the other editors.')
  const route = await remoteRoute(ask, node, options)
  if (route.kind === 'none') return { ok: false, reason: 'no_route' }
  const folder = await remoteFolder(ask, threadId)
  if (!folder.ok) return folder
  if (route.host) return { ok: true, host: route.host, folder: folder.folder }
  const host = await mousseAlias(ask, node)
  return host.ok ? { ok: true, host: host.host, folder: folder.folder, config: host.config } : host
}

/** How the connection to a computer runs, as the tunnel probe found it. */
export type ConnectionVia = NonNullable<Extract<RemoteOpenResult, { ok: true }>['via']>

/**
 * Opens an editor connection to the computer and closes it at once (`net.editor.probe`). What a refusal says is
 * what the editor's own connection would meet, so the person sees it here instead of a hung editor window.
 */
export async function probeTunnel(ask: Ask, node: string): Promise<{ ok: true; via: ConnectionVia } | RemoteFailure> {
  const result = (await ask('net.editor.probe', { node })) as EditorProbeResult
  if (result.ok) return { ok: true, via: { path: result.path, ...(result.transport ? { transport: result.transport } : {}) } }
  if (result.reason === 'ssh_settings') return { ok: false, reason: 'ssh_settings', code: result.code, message: result.message }
  return { ok: false, reason: 'connection', failure: result.reason, message: result.message }
}

/** What running `ssh -o BatchMode=yes <alias> exit` ended with. `skipped`: this computer has no `ssh` to ask. */
export type SshProbeOutcome = { ok: true } | { ok: false; stderr: string } | { skipped: true }

/** The last line `ssh` printed, shortened, for a message. Never more than a line of what ssh itself said. */
function lastLine(text: string): string {
  const line = text.split(/\r?\n/u).map((row) => row.trim()).filter(Boolean).pop() ?? ''
  return line.length > 200 ? `${line.slice(0, 197)}...` : line
}

/** What the sign-in check advises when it did not pass: shown after the editor started, never a reason to stop it. */
export type SignInAdvice = NonNullable<Extract<RemoteOpenResult, { ok: true }>['advice']>

/**
 * What a sign-in check that did not pass advises. A server that offers a password or keyboard-interactive
 * sign-in is one the editor will ask about, so there is nothing to say. Only a server that offers keys alone is
 * reported as not accepting this computer's, with the command to add the key where this computer has one (`ssh-copy-id`
 * needs a password sign-in on that computer). Anything else is the last line `ssh` printed.
 */
export function sshSignInAdvice(stderr: string, alias: string, windows: boolean): SignInAdvice | undefined {
  const denied = /Permission denied \(([^)]*)\)/iu.exec(stderr)
  if (denied) {
    const methods = denied[1].toLowerCase().split(',').map((method) => method.trim())
    if (methods.includes('password') || methods.includes('keyboard-interactive')) return undefined
    return { failure: 'key_refused', ...(windows ? {} : { command: `ssh-copy-id ${alias}` }) }
  }
  const line = lastLine(stderr)
  return line ? { failure: 'ssh_failed', message: line } : undefined
}
