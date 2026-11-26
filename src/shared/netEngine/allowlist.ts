import { ROUTED_METHODS, routedNetMethod } from '../bridge/routed'
import { UPDATE_NET_METHODS } from '../remoteUpdates'

/**
 * The daemon methods an engine pairing with the `owner` role may call on this computer: the routed thread,
 * terminal and editor calls, the routed transport it needs (private streams, pages, staging), the request artifacts
 * that staging uses, and `net.info` for version negotiation. Spaces, chats and bots are not on it (Teams).
 */
export const ENGINE_OWNER_METHODS: ReadonlySet<string> = new Set([
  // The editor rows (the folder a remote editor opens, the ask to allow one) are held to the engine editor refusal
  // too (`NetEngineService.authorizeEngine`); their tunnels ride `mousse.tunnel` (Phase 1b §9.2).
  ...Object.keys(ROUTED_METHODS).map(routedNetMethod),
  routedNetMethod('stream.open'),
  routedNetMethod('stream.close'),
  routedNetMethod('page'),
  routedNetMethod('stage'),
  'bridge.artifacts.open',
  'net.info',
  // What this computer lets the pairing do here (its Devices summary), and a dispatched agent task (§9.1).
  'bridge.access.mine',
  'bridge.dispatch',
  // Updating this computer from a paired one; held to Full control by `checkNodePolicy`.
  ...UPDATE_NET_METHODS
])
