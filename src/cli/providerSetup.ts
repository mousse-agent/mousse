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

/** A provider Mousse runs as an agent is added and keyed in Settings → Providers, as that agent. */
function runsAsAgent(option: ProviderAddOption): Error {
  return new Error(`Mousse runs ${option.label} through its agent (${option.runsAs}). Add it, or replace its key, in Settings → Providers.`)
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
  if (option.runsAs) throw runsAsAgent(option)
  // Cloud credentials (no key to paste) are checked before the entry is added; a failed check adds nothing.
  const ambient = !apiKey && option.methods.includes('ambient') && !option.methods.includes('api_key')
  const { snapshot } = await client.request<{ snapshot: InstanceSnapshot }>('providers.instances.add', ambient ? { ...option.add, signIn: 'ambient' } : option.add)
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
  if (!option) throw new Error(`Mousse has no model provider "${providerId}" that takes an API key.`)
  const entry = (await deviceSnapshots(client)).find((snapshot) => snapshot.instanceId === option.instanceId)
  if (!entry && option.runsAs) throw runsAsAgent(option)
  if (!entry) throw new Error(`${option.label} is not added. Run \`${addCommand(providerId)}\`.`)
  await client.request('providers.instances.setSecret', { instanceId: entry.instanceId, value: apiKey })
}
