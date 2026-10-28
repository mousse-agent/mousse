import type { Duplex } from 'node:stream'
import type { NodeId } from '../../../../shared/net/ids'
import type { TunnelHostKey } from '../../../../shared/net/tunnel'

/** What an SSH connection did, as counts: never a command, a file name or an address. */
export interface EndpointCounts {
  exec: number
  shell: number
  sftp: number
  forwards: number
}

/** Something the endpoint refused or accepted that the owner's audit says, with a device attached. */
export type EndpointEvent =
  | { kind: 'login'; node: NodeId; method: string }
  | { kind: 'login_refused'; node: NodeId; reason: 'user' | 'too_many' | 'grace' }
  | {
      kind: 'refused'
      node: NodeId
      what:
        | 'direct-tcpip'
        | 'tcpip-forward'
        | 'streamlocal'
        | 'agent'
        | 'x11'
        | 'subsystem'
        | 'channel_limit'
        | 'terminal'
    }

/** One SSH connection the endpoint serves on one tunnel. */
export interface EndpointConnection {
  /**
   * The tunnel is over. An ordinary end (the editor closed, the carrier session was lost) is handled as `sshd`
   * handles a lost connection: terminals are hung up, pipes are closed, and what the programs started keeps
   * running. A forced end (a block, a switch going off, a revoke, Net being turned off) also stops everything
   * the device started on this computer, whether or not it belongs to a session that still exists.
   */
  end(forced: boolean): void
  counts(): EndpointCounts
}

/**
 * The SSH server inside the daemon, as the tunnels see it. It listens on no port: a tunnel hands it the stream
 * of one connection, together with the id of the device that opened the tunnel, which is what authenticates the
 * SSH login.
 */
export interface EditorEndpointPort {
  /** Whether this computer can answer editor connections itself (not on Windows without a working helper). */
  available(): boolean
  /** The public host keys this computer vouches for over Net. May throw when the key cannot be made. */
  hostKeys(): TunnelHostKey[]
  /** Serves one connection on `stream`, which the endpoint owns from now on and destroys when it is over. */
  serve(stream: Duplex, node: NodeId): EndpointConnection
  /** Stops everything started for `node`, whether or not a connection of it is open. */
  killDevice(node: NodeId): Promise<void>
  /**
   * Stops every program of every device that is not in `allowed`, found by the marker the programs carry (not by any
   * list of devices kept here), and so also those of a device that was revoked and of an earlier run of the daemon.
   * Never stops the daemon's own tree. Resolves with how many processes were signalled; does nothing, and says so
   * with 0, when the marker keys cannot be read.
   */
  sweep(allowed: readonly NodeId[]): Promise<number>
}
