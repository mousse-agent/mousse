/**
 * What the main process asks before an editor opens a folder of another computer: how this computer
 * reaches it, and which folder the thread works in there. Starts no editor and spawns nothing; the daemon
 * is reached through `ask`, so tests give it fakes.
 */
import { isComputerErrorCode } from '../shared/bridge/computerErrors'
import type { EditorSshResult, EditorSshStatus } from '../shared/net/local'
import type { RemoteOpenResult, RemoteRoute } from '../shared/remoteEditor'
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
    default:
      // Words of the router (offline, not allowed, update the other computer): shown as they are.
      return isComputerErrorCode(codeOf(error)) ? { ok: false, reason: 'failed', message: messageOf(error) } : undefined
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

/** The plain refusal of Mousse's SSH settings, or the alias of the computer once they are ready. */
export async function mousseHost(ask: Ask, node: string): Promise<{ ok: true; host: RemoteHost } | RemoteFailure> {
  const result = (await ask('net.editor.ssh.prepare', {})) as EditorSshResult
  if (!result.ok) return { ok: false, reason: 'ssh_settings', code: result.code, message: result.message, includeLine: result.status.includeLine }
  const computer = result.status.computers.find((entry) => entry.node === node)
  if (!computer) return { ok: false, reason: 'no_route' }
  return { ok: true, host: { kind: 'mousse', alias: computer.alias } }
}

/**
 * Everything to open the folder of `threadId`: its host and its folder. Mousse's SSH settings are prepared
 * last, after the folder is known, so the `Include` line is added only for an open that goes ahead.
 */
export async function resolveRemoteOpen(
  ask: Ask,
  threadId: unknown,
  options: FlowOptions
): Promise<{ ok: true; host: RemoteHost; folder: CheckedFolder } | RemoteFailure> {
  const node = nodeOfThread(threadId)
  if (!node || typeof threadId !== 'string') throw new Error('This thread is on this computer. Its folder opens from the other editors.')
  const route = await remoteRoute(ask, node, options)
  if (route.kind === 'none') return { ok: false, reason: 'no_route' }
  const folder = await remoteFolder(ask, threadId)
  if (!folder.ok) return folder
  if (route.host) return { ok: true, host: route.host, folder: folder.folder }
  const host = await mousseHost(ask, node)
  return host.ok ? { ok: true, host: host.host, folder: folder.folder } : host
}
