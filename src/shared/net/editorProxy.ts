/**
 * What `mousse-cli net ssh-proxy` and the daemon of the same computer say to each other, and the words
 * the proxy prints when it cannot carry the editor's SSH. Browser-safe: it imports types only.
 *
 * The proxy is the program an editor's `ssh` starts as its `ProxyCommand`. It runs on every reconnect, so
 * it speaks the local protocol with nothing but Node's own modules (`src/cli/fastpath/sshProxy.ts`).
 * The daemon owns the tunnel itself (`NetService.openEditorTunnel`); the proxy moves the bytes of its
 * stdin and stdout through four local methods, in pieces, one call at a time in each direction.
 */
import type { TunnelFailure, TunnelPath } from './tunnel'

export const EDITOR_TUNNEL_LOCAL_METHODS = [
  'net.editor.tunnel.open',
  'net.editor.tunnel.read',
  'net.editor.tunnel.write',
  /** The editor's `ssh` sent everything it will: half-close the write side and keep reading. */
  'net.editor.tunnel.end',
  'net.editor.tunnel.close'
] as const
export type EditorTunnelLocalMethod = (typeof EDITOR_TUNNEL_LOCAL_METHODS)[number]
export const isEditorTunnelLocalMethod = (value: unknown): value is EditorTunnelLocalMethod =>
  (EDITOR_TUNNEL_LOCAL_METHODS as readonly unknown[]).includes(value)

/** The most bytes one `read` returns or one `write` takes. */
export const EDITOR_TUNNEL_LOCAL_CHUNK_BYTES = 32 * 1024
/** How long a `read` waits for bytes before it answers with none (the proxy asks again at once). */
export const EDITOR_TUNNEL_LOCAL_READ_WAIT_MS = 20_000
/** A tunnel nobody has read from or written to for this long is closed: its proxy is gone or stuck. */
export const EDITOR_TUNNEL_LOCAL_IDLE_MS = 2 * 60_000
/** Tunnels one local connection may hold at once. */
export const EDITOR_TUNNELS_PER_CONNECTION = 8
/** A tunnel handle on the local connection: random, chosen by the daemon. */
export const EDITOR_TUNNEL_HANDLE = /^[0-9a-f]{32}$/u

/** Why an open did not give a tunnel, on top of the reasons the tunnel itself has. */
export type ProxyRefusal =
  | TunnelFailure
  /** Mousse Net is off, or this computer is not set up with other computers. */
  | 'net_disabled'
  /** No computer of the user's has that identity. */
  | 'unknown_computer'
  /** Mousse's editor settings could not take the computer's host key. */
  | 'ssh_settings'
  /** Anything else. */
  | 'failed'

export type EditorTunnelOpenAnswer =
  | {
      ok: true
      handle: string
      path: TunnelPath
      transport?: string
      /** What the person calls that computer. */
      computer: string
    }
  | { ok: false; reason: ProxyRefusal; computer?: string }

export interface EditorTunnelReadAnswer {
  /** Base64 of the bytes the other computer's SSH server sent; absent when none came in time. */
  data?: string
  /** The tunnel is over and everything it sent has been read. */
  end?: TunnelFailure
}

export type EditorTunnelWriteAnswer = { ok: true } | { end: TunnelFailure }

/** Exit codes of `mousse-cli net ssh-proxy`. The editor shows only the stderr line; ssh needs non-zero. */
export const SSH_PROXY_EXIT = {
  /** Either side ended the connection in the ordinary way. */
  ok: 0,
  /** The tunnel was refused or broke. A line on stderr says why. */
  refused: 1,
  /** The command line is not valid. */
  usage: 2
} as const

export const SSH_PROXY_USAGE = 'Usage: mousse-cli net ssh-proxy <node-id> --profile <profile>'

/** A computer's name as one short line, safe to print: no control characters, no long text. */
export function proxyComputerName(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined
  const line = name
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (!line) return undefined
  return Array.from(line).slice(0, 64).join('')
}

/** The local reasons the proxy has on top of `ProxyRefusal`: nothing reached the daemon, or it answered oddly. */
export type ProxyLocalProblem =
  'not_running' | 'daemon_version' | 'daemon_old' | 'profile' | 'daemon_lost' | 'usage'

/**
 * The line printed on stderr (the editor's log shows it) for a refusal. One plain sentence, no stack, no path,
 * no address. `computer` is the other computer's name as the person sees it.
 */
export function proxyMessage(reason: ProxyRefusal | ProxyLocalProblem, computer?: string): string {
  const name = proxyComputerName(computer) ?? 'The other computer'
  const they = proxyComputerName(computer) ?? 'the other computer'
  const text = ((): string => {
    switch (reason) {
      case 'offline':
        return `${name} is offline.`
      case 'editor_off':
        return `Editor connections are off for this computer on ${they}.`
      case 'no_ssh_server':
        return `${name} has no SSH server.`
      case 'no_host_key':
        return `The SSH host key of ${they} could not be read.`
      case 'host_untrusted':
        return `The SSH server of ${they} cannot be shown to be the system's own, so Mousse does not vouch for it.`
      case 'blocked':
        return `${name} blocked this computer.`
      case 'capability':
      case 'access_lost':
        return `This computer is not allowed to work on ${they}.`
      case 'setting_off':
        return `${name} is not letting its other computers work on its threads.`
      case 'net_off':
        return `Mousse Net is turned off on ${they}.`
      case 'limit':
        return `This computer already has all the editor connections it may have on ${they}.`
      case 'rate_limited':
        return 'Editor connections are being opened too fast.'
      case 'unsupported':
        return `${name} runs a version of Mousse that cannot carry editor connections.`
      case 'timeout':
        return `${name} did not answer in time.`
      case 'far_end_error':
        return `The SSH server of ${they} ended the connection with an error.`
      case 'protocol':
        return `The connection to ${they} broke the editor tunnel protocol.`
      case 'cancelled':
        return 'The editor connection was cancelled.'
      case 'closed':
        return 'The editor connection ended.'
      case 'net_disabled':
        return 'Mousse Net is turned off on this computer.'
      case 'unknown_computer':
        return 'This computer does not know that computer. Pair it in Mousse, Devices.'
      case 'ssh_settings':
        return "Mousse could not save the other computer's SSH host key. Open Mousse, Settings, Devices."
      case 'not_running':
        return 'Mousse is not running on this computer. Start Mousse and open the folder again.'
      case 'daemon_version':
        return 'Mousse on this computer runs another version than this command. Restart Mousse and try again.'
      case 'daemon_old':
        return 'Mousse on this computer was started before editor connections existed. Restart Mousse and try again.'
      case 'profile':
        return 'The Mousse profile for this editor connection does not exist. Open the folder again from Mousse.'
      case 'daemon_lost':
        return 'Mousse on this computer stopped, and the editor connection ended.'
      case 'usage':
        return SSH_PROXY_USAGE
      case 'failed':
      default:
        return 'Mousse could not open the editor connection.'
    }
  })()
  // The editor's log mixes many programs; a line that does not already start with the name says whose it is.
  return text.startsWith('Mousse') ? text : `Mousse: ${text}`
}
