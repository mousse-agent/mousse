/**
 * Editor tunnels: one computer carries an editor's SSH connection to another computer of the same
 * user, inside the Mousse Net session between them. Browser-safe. Normative description:
 * docs/net/protocol.md (`tunnel.v1`) and docs/net/threat-model.md ("Editor connections").
 */

/**
 * What a tunnel ends at. There is exactly one kind: the SSH server of the computer that carries the
 * far end, which that computer chooses (loopback port 22). The caller never names a host or a port.
 */
export const TUNNEL_KINDS = ['ssh'] as const
export type TunnelKind = (typeof TUNNEL_KINDS)[number]

/**
 * Why a tunnel was refused or ended. Fixed words: it is the one detail that crosses the wire, so a
 * message never carries a path, an address or an error text of the other computer.
 */
export const TUNNEL_REASONS = [
  /** Ended in the ordinary way: one side was done. */
  'closed',
  /** Mousse Net (or Bridge) is off on the computer that carries the far end. */
  'net_off',
  /** That computer blocked this device. */
  'blocked',
  /** This device does not hold "Works on threads" there. */
  'capability',
  /** The owner's switch for other computers working on its threads is off. */
  'setting_off',
  /** "Editor connections from this device" is off there. */
  'editor_off',
  /** The device lost "Works on threads" or was revoked while the tunnel was open. */
  'access_lost',
  /** Nothing listens on that computer's SSH port. */
  'no_ssh_server',
  /** The SSH server is there, but Mousse cannot read its public host key. */
  'no_host_key',
  /** The device already has all the tunnels it may have, or this computer has all it can carry. */
  'limit',
  /** The device opens tunnels faster than this computer takes them. */
  'rate_limited',
  /** The far end failed, or ended with an error. */
  'far_end_error',
  /** The other side broke the tunnel protocol (more data than it had credit for). */
  'protocol'
] as const
export type TunnelReason = (typeof TUNNEL_REASONS)[number]
export const isTunnelReason = (value: unknown): value is TunnelReason =>
  (TUNNEL_REASONS as readonly unknown[]).includes(value)

/** The reasons that answer an open request with a refusal, as the caller sees them. */
export const TUNNEL_REFUSALS: readonly TunnelReason[] = [
  'net_off',
  'blocked',
  'capability',
  'setting_off',
  'editor_off',
  'no_ssh_server',
  'no_host_key',
  'limit',
  'rate_limited'
]

/** What can go wrong on the computer that opens a tunnel before the other one has said anything. */
export const TUNNEL_LOCAL_FAILURES = ['unsupported', 'offline', 'timeout', 'cancelled'] as const
/** Why an open failed, or a tunnel ended, as the computer that opened it sees it. */
export type TunnelFailure = TunnelReason | (typeof TUNNEL_LOCAL_FAILURES)[number]

/** Plain words for each reason, for a log line or a message the person reads. */
export const TUNNEL_REASON_TEXT: Readonly<Record<TunnelFailure, string>> = {
  unsupported: 'The other computer runs a version of Mousse that cannot carry editor connections.',
  offline: 'The other computer is offline.',
  timeout: 'The other computer did not answer in time.',
  cancelled: 'The editor connection was cancelled.',
  closed: 'The editor connection ended.',
  net_off: 'Mousse Net is turned off on the other computer.',
  blocked: 'The other computer blocked this computer.',
  capability: 'This computer is not allowed to work on the other computer.',
  setting_off: 'The other computer is not letting its other computers work on its threads.',
  editor_off: 'Editor connections from this computer are off on the other computer.',
  access_lost: 'This computer lost its access to the other computer.',
  no_ssh_server: 'The other computer has no SSH server running.',
  no_host_key: "The other computer's SSH host key could not be read.",
  limit: 'This computer already has all the editor connections it may have there.',
  rate_limited: 'Editor connections are being opened too fast.',
  far_end_error: "The other computer's SSH server ended the connection with an error.",
  protocol: 'The editor connection broke the tunnel protocol.'
}

/** A tunnel id: 128 random bits, chosen by the computer that opens the tunnel. */
export const TUNNEL_ID_PATTERN = /^[0-9a-f]{32}$/u

/** The largest piece of the byte stream in one `tunnel.data` message. */
export const TUNNEL_CHUNK_BYTES = 32 * 1024
/**
 * Bytes one side may send before the other side has written them out and granted more (`tunnel.credit`).
 * Both directions of a tunnel have their own. It bounds what a slow reader holds, per tunnel, and sits
 * at the lane's own window so a few tunnels never fill the mux queue.
 */
export const TUNNEL_WINDOW_BYTES = 256 * 1024
/** Credit is granted back in steps of this many bytes, so a stream of small writes sends few messages. */
export const TUNNEL_CREDIT_STEP_BYTES = 64 * 1024
/** Public host keys one computer vouches for in `tunnel.opened`. */
export const TUNNEL_HOST_KEYS_MAX = 8

/** Tunnels one device may have open on a computer at once, as for terminals. */
export const EDITOR_TUNNELS_PER_NODE = 4
/** Tunnels a computer carries for all devices together. */
export const EDITOR_TUNNELS_MAX = 16
/** Opens one device may attempt in a minute; more are refused `rate_limited`. */
export const EDITOR_OPENS_PER_MINUTE = 30
/** How long a caller waits for `tunnel.opened` (the far end is on loopback, so this is generous). */
export const TUNNEL_OPEN_TIMEOUT_MS = 15_000

/**
 * The route a session was carried over, as the person is told: through a Mousse relay, or not.
 * A relay carries ciphertext only and counts the bytes against its own quota.
 */
export type TunnelPath = 'direct' | 'relay'

/** Transport ids of the relays Mousse runs or lets the user run (`relay`, and the hosted `plus-relay`). */
const RELAY_TRANSPORTS: ReadonlySet<string> = new Set(['relay', 'plus-relay'])
export function tunnelPathOf(transport: string | undefined): TunnelPath {
  return transport !== undefined && RELAY_TRANSPORTS.has(transport) ? 'relay' : 'direct'
}

/** The public host key of an SSH server, in the form of a `known_hosts` line (`<type> <base64>`). */
export interface TunnelHostKey {
  type: string
  key: string
}

/** What a caller learns when a tunnel opens. */
export interface EditorTunnelInfo {
  path: TunnelPath
  /** The transport the session runs on (`direct`, `tailscale`, `relay`, `plus-relay`...), when known. */
  transport?: string
  /** What pinning the computer's host keys did: `unpinned` when this computer keeps no editor settings. */
  hostKey: 'added' | 'present' | 'replaced' | 'unpinned'
}
