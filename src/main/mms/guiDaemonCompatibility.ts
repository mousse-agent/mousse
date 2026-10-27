import { isProtocolVersionMismatch, type LocalMmsClient } from '../../mms/protocol/client'
import { MMS_PROTOCOL_VERSION, type ProtocolHelloOk } from '../../mms/protocol/types'
import { BOTS_PERSONAL_METHODS } from '../../shared/bots/personal/methods'

/** APIs used by the current task shell. Add required APIs when the shell adopts them. */
export const GUI_REQUIRED_METHODS = [
  'profiles.bind', 'profiles.status', 'thread.snapshot', 'queue.list',
  'workspace.getStatus', 'workspace.restore', 'actions.list', 'actions.undoLatest', 'actions.redo',
  'actions.revertCode', 'actions.fork', 'actions.activateBranch', 'actions.getAffectedFiles',
  'actions.sweepRetention', 'actions.configureRetention', 'actions.pin',
  'review.files', 'review.file',
  'operations.get', 'operations.abort', 'operations.recover', 'publish.status', 'publish.start',
  'threads.inventory', 'threads.trash', 'threads.restore', 'threads.purge', 'threads.configureTrash',
  'storage.policy', 'storage.configure', 'storage.reviewDismiss', 'storage.cleanup.plan', 'storage.cleanup.run', 'storage.cleanup.lastReport',
  'storage.usage',
  'subagents.list',
  // Settings → Providers runs on the harness gateway; an older service lacks it.
  'providers.snapshots', 'providers.catalog.addOptions', 'providers.instances.add', 'providers.instances.setSecret',
  'providers.instances.remove', 'providers.instances.configure',
  'providers.instances.setEnabled', 'providers.instances.install', 'providers.instances.cancelInstall',
  'providers.instances.update', 'providers.instances.signIn', 'providers.instances.respondSignIn',
  'providers.instances.signOut', 'providers.instances.recheck', 'providers.instances.refreshModels', 'providers.instances.refreshAllModels',
  'providers.instances.setModelPrefs', 'providers.instances.move', 'providers.instances.removeInstall',
  'providers.registry.search',
  // The Files panel and composer search through the daemon; an older service lacks it.
  'files.search',
  'files.grep',
  // Automations → Bots: personal bots, profile-bound; an older service lacks them.
  ...BOTS_PERSONAL_METHODS
] as const

function recoveryText(homeDir: string): string {
  return `The running Mousse service is incompatible with this app or its API support could not be verified. Let active tasks finish, then run mousse-cli service stop --home ${JSON.stringify(homeDir)} (or, from a source checkout, node out/cli/index.js service stop --home ${JSON.stringify(homeDir)}), then reopen Mousse. The service has not been stopped automatically.`
}

/**
 * Connects and checks the service: one that refuses this app's protocol version (an older or newer
 * service) gets the same recovery text as one that lacks an API.
 */
export async function connectGuiClient(client: LocalMmsClient, homeDir: string): Promise<ProtocolHelloOk> {
  let hello: ProtocolHelloOk
  try {
    hello = await client.connect()
  } catch (error) {
    if (isProtocolVersionMismatch(error)) throw new Error(`${recoveryText(homeDir)} The service uses another protocol version than this app (${MMS_PROTOCOL_VERSION}).`)
    throw error
  }
  await assertGuiDaemonCompatible(client, hello, homeDir)
  return hello
}

export async function assertGuiDaemonCompatible(client: LocalMmsClient, hello: ProtocolHelloOk, homeDir: string): Promise<void> {
  const recovery = recoveryText(homeDir)
  if (hello.protocolVersion !== MMS_PROTOCOL_VERSION) throw new Error(`${recovery} Incompatible protocol version ${hello.protocolVersion}.`)
  let result: { protocolVersion?: unknown; methods?: unknown }
  try { result = await client.request('capabilities') }
  catch { throw new Error(`${recovery} Could not verify the service's supported APIs.`) }
  if (!result || result.protocolVersion !== MMS_PROTOCOL_VERSION || !Array.isArray(result.methods) || !result.methods.every(method => typeof method === 'string')) {
    throw new Error(`${recovery} The service returned an invalid API capability description.`)
  }
  const methods = new Set(result.methods)
  const missing = GUI_REQUIRED_METHODS.filter(method => !methods.has(method))
  if (missing.length) throw new Error(`${recovery} Missing APIs: ${missing.join(', ')}.`)
}
