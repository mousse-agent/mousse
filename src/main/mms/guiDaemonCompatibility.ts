import type { LocalMmsClient } from '../../mms/protocol/client'
import { MMS_PROTOCOL_VERSION, type ProtocolHelloOk } from '../../mms/protocol/types'

/** APIs used by the current task shell. Add required APIs when the shell adopts them. */
export const GUI_REQUIRED_METHODS = [
  'profiles.bind', 'profiles.status', 'thread.snapshot', 'queue.list',
  'agents.listNamed', 'agents.createNamed', 'agents.recallNamed', 'agents.integrateNamed', 'agents.reviewNamed',
  'workspace.getStatus', 'workspace.restore', 'actions.list', 'actions.undoLatest', 'actions.redo',
  'actions.revertCode', 'actions.fork', 'actions.activateBranch', 'actions.getAffectedFiles',
  'actions.sweepRetention', 'actions.configureRetention', 'actions.pin',
  'operations.get', 'operations.abort', 'operations.recover', 'publish.status', 'publish.start',
  'threads.inventory', 'threads.trash', 'threads.restore', 'threads.purge', 'threads.configureTrash'
] as const

export async function assertGuiDaemonCompatible(client: LocalMmsClient, hello: ProtocolHelloOk, homeDir: string): Promise<void> {
  const recovery = `The running Mousse service is incompatible with this app or its API support could not be verified. Let active tasks finish, then run mousse-cli service stop --home ${JSON.stringify(homeDir)} (or, from a source checkout, node out/cli/index.js service stop --home ${JSON.stringify(homeDir)}), then reopen Mousse. The service has not been stopped automatically.`
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
