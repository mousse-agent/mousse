import { join } from 'node:path'
import { NetError } from '../../shared/net/errors'
import type { NodeId } from '../../shared/net'
import { validateWireMessage } from '../../shared/net/schemas'
import type { TunnelReason } from '../../shared/net/tunnel'
import type { TunnelMessage } from '../../shared/net/wire'
import type { SessionState, SessionTunnelPort, TunnelLink } from '../net/contracts'
import { systemClock } from '../net/clock'
import { EditorEndpoint } from '../net/editor/endpoint/endpoint'
import type { ProcessHost } from '../net/editor/endpoint/host'
import type { EditorEndpointPort } from '../net/editor/endpoint/port'
import { systemProcessHost } from '../net/editor/endpoint/systemHost'
import { findSshdHelper } from '../net/editor/endpoint/windowsHost'
import { EditorTunnels, type EditorTunnelOptions } from '../net/editor/tunnel'
import type { NetRuntime } from '../net/NetService'
import { engineControl } from './limits'
import type { EngineClient } from './session/client'
import { Channel, type EngineConnection, type EngineStream } from './session/transport'

/**
 * Editor connections over the engine (Phase 1b §9.2): the engine's own `EditorTunnels` and `EditorEndpoint`, built
 * the way v1's `NetService` builds its pair and sharing nothing with it, so an editor reaches another computer with
 * v1 networking off. The editor security of `net/editor/` is reused unchanged; only the transport is new.
 *
 * **Transport.** Each tunnel is one engine stream labelled `mousse.tunnel`, opened by the computer that opens the
 * tunnel. It carries v1's `TunnelMessage`s, framed as engine messages, for the whole life of the tunnel: `tunnel.open`
 * first, then `tunnel.opened` or `tunnel.close`, then `tunnel.data` (its bytes as the message's one part) and
 * `tunnel.credit` each way. Keeping v1's credit messages over a stream that has flow control of its own costs a few
 * bytes per 32 KiB and lets `EditorTunnels` run as it does for v1, its refusals and ends included, with no new splice.
 * Every message is checked against v1's wire schema (`validateWireMessage`): an extra field or another tunnel's id
 * ends that tunnel (`protocol`), as an invalid message ends a v1 session.
 */

/** One side of an engine pairing as a tunnel link sees it: a client opens tunnel streams, a host only accepts them. */
interface LinkEnd {
  open?(): EngineStream
  isOpen(): boolean
  onClosed(listener: () => void): () => void
}

interface Held {
  channel: Channel
  sentEnd: boolean
  gotEnd: boolean
}

/**
 * A pairing's connection as `EditorTunnels` sees a v1 session: `peer.node`, open or not, and `sendTunnel`. A client
 * link (this computer opens tunnels to the other) rides the pairing's current outbound client; a host link (the other
 * computer opens tunnels here) is one inbound connection, and remembers the grant it was opened under.
 */
export class EngineTunnelLink implements TunnelLink {
  readonly peer: TunnelLink['peer']
  private readonly held = new Map<string, Held>()
  constructor(
    node: NodeId,
    private readonly end: LinkEnd,
    private readonly port: SessionTunnelPort,
    /** The grant of the inbound connection, for a host link. */
    readonly grant?: string
  ) {
    // Only the node is read through a link (counts, refusals, the audit); there is no v1 delegation here.
    this.peer = { node } as TunnelLink['peer']
  }

  state(): SessionState {
    return this.end.isOpen() ? 'open' : 'closed'
  }
  supportsTunnels(): boolean {
    return true
  }
  onClosed(listener: (error?: Error) => void): () => void {
    return this.end.onClosed(() => listener())
  }

  async sendTunnel(message: TunnelMessage, bytes?: Uint8Array): Promise<void> {
    let held = this.held.get(message.tunnel)
    if (!held) {
      // A credit or a close for a tunnel whose stream already ended has nobody to reach.
      if (message.t !== 'tunnel.open' || !this.end.open) return
      if (!this.end.isOpen()) throw new NetError('peer_offline')
      held = this.listen(new Channel(this.end.open()), message.tunnel)
    }
    if (!held.channel.isOpen()) {
      if (message.t === 'tunnel.open') throw new NetError('peer_offline')
      return
    }
    const { parts: _parts, ...header } = message as TunnelMessage & { parts?: unknown }
    held.channel.send(header, message.t === 'tunnel.data' ? [bytes ?? new Uint8Array(0)] : [])
    if (message.t === 'tunnel.close') {
      // Nothing follows a close on this tunnel.
      this.held.delete(message.tunnel)
      held.channel.end()
      return
    }
    if (message.t === 'tunnel.data' && message.end) {
      held.sentEnd = true
      this.maybeEnd(held)
    }
    // A sender of many pieces waits here until the stream takes more.
    await held.channel.drained()
  }

  /** A `mousse.tunnel` stream the other computer opened over this host link. */
  accept(stream: EngineStream): void {
    this.listen(new Channel(stream))
  }

  /** Reads one tunnel's messages from its stream; `id` is known for a stream this side opened. */
  private listen(channel: Channel, opened?: string): Held {
    const held: Held = { channel, sentEnd: false, gotEnd: false }
    let id = opened
    if (id !== undefined) this.held.set(id, held)
    const broken = (): void => {
      if (id !== undefined && this.held.get(id) === held) {
        this.held.delete(id)
        this.port.receive(this, { t: 'tunnel.close', tunnel: id, reason: 'protocol' }, undefined)
      }
      channel.reset('bad_message')
    }
    channel.onMessage(({ header, parts }) => {
      const message = (
        header.t === 'tunnel.data' ? { ...header, parts: parts.map((part) => part.byteLength) } : header
      ) as unknown as TunnelMessage
      if (!isTunnelMessage(message) || parts.length > (message.t === 'tunnel.data' ? 1 : 0)) return broken()
      if (id === undefined) {
        // The first message of a stream the other computer opened opens its tunnel, under an id not in use here.
        if (message.t !== 'tunnel.open' || this.held.has(message.tunnel)) return broken()
        id = message.tunnel
        this.held.set(id, held)
      } else if (message.tunnel !== id || message.t === 'tunnel.open') return broken()
      if (message.t === 'tunnel.data' && message.end) {
        held.gotEnd = true
        this.maybeEnd(held)
      }
      this.port.receive(this, message, message.t === 'tunnel.data' ? parts[0] : undefined)
      // Nothing follows a close either way: this side's half ends too, so the stream (and its credit) is let go.
      if (message.t === 'tunnel.close') {
        if (this.held.get(id) === held) this.held.delete(id)
        channel.end()
      }
    })
    channel.onEnd(() => {
      // The other side is done with the stream: so is this one, whatever it still meant to say.
      channel.end()
      if (id === undefined || this.held.get(id) !== held) return
      this.held.delete(id)
      const tunnel = id
      // The stream ended under a tunnel that had not: it is over (after an ordinary end this finds it gone). When the
      // whole connection is closing, its own close says so (`offline`), so that is waited for first.
      setImmediate(() => {
        if (this.end.isOpen())
          this.port.receive(this, { t: 'tunnel.close', tunnel, reason: 'closed' }, undefined)
      })
    })
    return held
  }

  /** Both directions said `end`: nothing more is needed this way (a late credit has nobody waiting for it). */
  private maybeEnd(held: Held): void {
    if (held.sentEnd && held.gotEnd) held.channel.end()
  }
}

const TUNNEL_TYPES: ReadonlySet<string> = new Set([
  'tunnel.open',
  'tunnel.opened',
  'tunnel.data',
  'tunnel.credit',
  'tunnel.close'
])
function isTunnelMessage(value: { t: string }): value is TunnelMessage {
  return TUNNEL_TYPES.has(value.t) && validateWireMessage(value)
}

/** What the engine refusal reads, live, for each open and each reconcile. */
export interface EngineEditorRights {
  /** The profile's engine is on. */
  on(): boolean
  /** The pairing's serving row (not removing or removed), with the grant the other computer holds here. */
  row(node: NodeId): { grant: string } | undefined
  blocked(node: NodeId): boolean
  /** The other computer has a connection open to this one. */
  connected(node: NodeId): boolean
  /** "Let my other computers work on this computer's threads". */
  workOnThreads(): boolean
  /** "Editor connections from this device". */
  editor(node: NodeId): boolean
}

/**
 * Why `node` may not have an editor tunnel on this computer now (the engine twin of `NetService.deviceRefusal`), in
 * this order: networking off; the pairing missing, removing, removed, blocked or not connected; its grant not the
 * live one (`grant`, the connection's, when known); the work switch off; the device's editor switch off.
 */
export function engineEditorRefusal(
  rights: EngineEditorRights,
  node: NodeId,
  grant?: string
): TunnelReason | undefined {
  if (!rights.on()) return 'net_off'
  const row = rights.row(node)
  if (!row || rights.blocked(node) || !rights.connected(node)) return 'blocked'
  if (!row.grant || (grant !== undefined && grant !== row.grant)) return 'capability'
  if (!rights.workOnThreads()) return 'setting_off'
  // The editor check's control skips the device's own switch.
  if (!engineControl('tunnel-ignores-editor') && !rights.editor(node)) return 'editor_off'
  return undefined
}

/** What tests give the engine's tunnels: an echo far end, a folder of host keys, the endpoint's host, small limits. */
export type EngineEditorTestOptions = Pick<
  EditorTunnelOptions,
  'farEnd' | 'hostKeyDirectories' | 'hostTrust' | 'perNode' | 'total' | 'opensPerMinute'
> & {
  /** The SSH endpoint's host; `null` leaves it with none. Unset: the system's, unless a far end was given. */
  endpointHost?: ProcessHost | null
  /** A stand-in for the whole endpoint, which records what the tunnels did to it. */
  endpoint?: EditorEndpointPort
}

/** The engine's own editor tunnels and SSH endpoint for one profile, and the links its connections give them. */
export class EngineEditor {
  readonly tunnels: EditorTunnels
  readonly endpoint?: EditorEndpointPort
  private readonly hostLinks = new WeakMap<EngineConnection, EngineTunnelLink>()
  private readonly clientLinks = new WeakMap<EngineClient, EngineTunnelLink>()
  constructor(options: {
    rt: Pick<NetRuntime, 'audit' | 'keys'>
    /** Where the endpoint's own files go (its account's home on Windows, its host's scratch). */
    directory: string
    rights: EngineEditorRights
    /** The pairings that may have a tunnel here now, for the sweep of what the endpoint started. */
    devices(): NodeId[] | undefined
    useSystemSsh(node: NodeId): boolean
    onFirstOpen?(node: NodeId): void
    test?: EngineEditorTestOptions
  }) {
    const { endpointHost, endpoint: standIn, ...test } = options.test ?? {}
    const endpoint =
      standIn ??
      ((test.farEnd || test.hostKeyDirectories) && endpointHost === undefined
        ? undefined
        : new EditorEndpoint({
            keys: options.rt.keys,
            host:
              endpointHost === undefined
                ? systemProcessHost(process.platform, findSshdHelper, join(options.directory, 'editor-ssh'))
                : (endpointHost ?? undefined),
            onEvent: (event) => this.tunnels.recordEndpointEvent(event)
          }))
    this.endpoint = endpoint
    this.tunnels = new EditorTunnels({
      clock: systemClock,
      audit: options.rt.audit,
      refusal: (link) =>
        engineEditorRefusal(
          options.rights,
          link.peer.node,
          link instanceof EngineTunnelLink ? link.grant : undefined
        ),
      allowedDevices: () => options.devices(),
      useSystemSsh: (node) => options.useSystemSsh(node),
      ...(endpoint ? { endpoint } : {}),
      transportOf: () => 'engine',
      ...(options.onFirstOpen ? { onFirstOpen: options.onFirstOpen } : {}),
      ...test
    })
  }

  /** A `mousse.tunnel` stream on an inbound connection: the caller there opens a tunnel to this computer. */
  accept(connection: EngineConnection, stream: EngineStream): void {
    let link = this.hostLinks.get(connection)
    if (!link) {
      const closed = new Set<() => void>()
      let open = connection.isOpen()
      connection.onClose(() => {
        open = false
        for (const listener of [...closed]) listener()
      })
      link = new EngineTunnelLink(
        connection.peer,
        {
          isOpen: () => open && connection.isOpen(),
          onClosed: (listener) => {
            closed.add(listener)
            return () => closed.delete(listener)
          }
        },
        this.tunnels,
        connection.grant
      )
      this.hostLinks.set(connection, link)
    }
    link.accept(stream)
  }

  /** The link this computer opens tunnels to `node` over: its current outbound client. */
  clientLink(node: NodeId, client: EngineClient): EngineTunnelLink {
    let link = this.clientLinks.get(client)
    if (!link) {
      link = new EngineTunnelLink(
        node,
        {
          open: () => client.connection.open('mousse.tunnel'),
          isOpen: () => client.state() === 'open',
          onClosed: (listener) => client.onClosed(() => listener())
        },
        this.tunnels
      )
      this.clientLinks.set(client, link)
    }
    return link
  }

  /** Every right that could have changed: tunnels without one end, and what the endpoint started for them stops. */
  reconcile(): void {
    // The editor check's control: engine rights changes leave tunnels as they are.
    if (engineControl('no-reconcile')) return
    this.tunnels.reconcile()
  }
}
