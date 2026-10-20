import type { NetStatus, NodeCapability, NodeId } from '../../shared/net'
import type { PlusStatus } from '../../shared/net/local'
import type { PlatformRequestMethod } from '../../shared/platform'
import type { TransportManifest } from '../../mms/net/contracts'

export interface Device {
  node: NodeId
  name: string
  caps: NodeCapability[]
  keyEpoch: number
  expiresAt: number
  self: boolean
  revoked: boolean
  state: 'connecting' | 'open' | 'closed'
}

/**
 * Core device state for the Devices screen. Mousse ID status is read only when this build has
 * the service, and a failing read never holds up the rest.
 */
export async function readDevices(withMousseId: boolean) {
  const request = <T>(method: PlatformRequestMethod, params: unknown) =>
    window.mousse.platformRequest.request<T>(method, params)
  const current = await request<NetStatus>('net.status', {})
  const hosted = withMousseId
    ? await request<PlusStatus>('net.plus.status', {}).catch(() => undefined)
    : undefined
  const listed = current.enabled
    ? await request<{ manifests: TransportManifest[] }>('net.transport.list', {})
    : { manifests: [] }
  // The hosted relay add-on is Mousse ID too; it is offered only with the service.
  const addons = withMousseId
    ? listed
    : { manifests: listed.manifests.filter((manifest) => manifest.id !== 'plus-relay') }
  const nodes =
    current.enabled && current.self && current.keystore === 'unlocked'
      ? (await request<{ nodes: Device[] }>('bridge.nodes', {})).nodes
      : []
  return { current, hosted, addons, nodes }
}
