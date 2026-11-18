import { ROUTED_METHODS, routedNetMethod } from '../bridge/routed'
import { methodAccess } from '../net/accessClasses'

/**
 * The daemon methods an engine pairing with the `owner` role may call on this computer: the routed thread and
 * terminal calls, the routed transport it needs (private streams, pages, staging), the request artifacts that
 * staging uses, and `net.info` for version negotiation. Editor, tunnel and Spaces methods are not on it.
 */
export const ENGINE_OWNER_METHODS: ReadonlySet<string> = new Set([
  // The routed editor rows (the folder a remote editor opens, the ask to allow one) need v1's editor tunnels.
  ...Object.keys(ROUTED_METHODS)
    .map(routedNetMethod)
    .filter((method) => methodAccess(method) !== 'editor'),
  routedNetMethod('stream.open'),
  routedNetMethod('stream.close'),
  routedNetMethod('page'),
  routedNetMethod('stage'),
  'bridge.artifacts.open',
  'net.info'
])
