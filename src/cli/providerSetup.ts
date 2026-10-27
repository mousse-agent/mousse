import type { InstanceSnapshot } from '../shared/harness/status'
import type { ProviderAddOption } from '../shared/harness/types'

/** The part of the daemon client the provider commands use. */
export interface ProviderRequester {
  request<T = unknown>(method: string, params?: unknown): Promise<T>
}

/** What Add provider offers (`providers.catalog.addOptions`). */
export async function providerAddOptions(client: ProviderRequester): Promise<ProviderAddOption[]> {
  return (await client.request<{ options: ProviderAddOption[] }>('providers.catalog.addOptions')).options
}

async function deviceSnapshots(client: ProviderRequester): Promise<InstanceSnapshot[]> {
  return (await client.request<{ snapshots: InstanceSnapshot[] }>('providers.snapshots', { scope: { kind: 'device' } })).snapshots
}

function addCommand(providerId: string): string {
  return `mousse config providers --provider ${providerId} --api-key …`
}

/**
 * `mousse config providers`: adds the provider (adding it again returns the entry, so a second run
 * changes nothing), then saves `apiKey` as its key. `configured` is whether the entry is signed in.
 */
export async function addProvider(
  client: ProviderRequester,
  providerId: string,
  apiKey: string | undefined,
  options?: ProviderAddOption[]
): Promise<{ instanceId: string; configured: boolean }> {
  const option = (options ?? (await providerAddOptions(client))).find((entry) => entry.id === providerId)
  if (!option) throw new Error(`Mousse cannot add the model provider "${providerId}".`)
  const { snapshot } = await client.request<{ snapshot: InstanceSnapshot }>('providers.instances.add', option.add)
  if (apiKey) await client.request('providers.instances.setSecret', { instanceId: snapshot.instanceId, value: apiKey })
  const current = (await deviceSnapshots(client)).find((entry) => entry.instanceId === snapshot.instanceId)
  return { instanceId: snapshot.instanceId, configured: current?.auth.state === 'signed_in' }
}

/**
 * The global `--api-key` with `--provider`: replaces the key of an entry that is already added. It
 * never adds one, so a provider removed from the profile stays removed.
 */
export async function setProviderKey(client: ProviderRequester, providerId: string, apiKey: string): Promise<void> {
  const option = (await providerAddOptions(client)).find((entry) => entry.id === providerId)
  const snapshots = await deviceSnapshots(client)
  const instanceId = option?.instanceId ?? providerId
  const entry = snapshots.find((snapshot) => snapshot.instanceId === instanceId)
  if (!entry) throw new Error(`${option?.label ?? providerId} is not added. Run \`${addCommand(providerId)}\`.`)
  await client.request('providers.instances.setSecret', { instanceId: entry.instanceId, value: apiKey })
}
