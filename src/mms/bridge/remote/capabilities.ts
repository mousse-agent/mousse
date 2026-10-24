import type { NodeCapability } from '../../../shared/net'

/** Pure-data deny-default exposure table. No provider, login, filesystem or local PTY ingress. */
export const BRIDGE_REMOTE_METHODS = {
  'projects.list': { capability: 'read', mutating: false },
  'threads.list': { capability: 'read', mutating: false },
  'threads.get': { capability: 'read', mutating: false },
  'threads.search': { capability: 'read', mutating: false },
  'thread.snapshot': { capability: 'read', mutating: false },
  'threads.create': { capability: 'write', mutating: true },
  'threads.rename': { capability: 'write', mutating: true },
  'threads.pin': { capability: 'write', mutating: true },
  'threads.settle': { capability: 'write', mutating: true },
  'orchestrator.send': { capability: 'chat', mutating: true },
  'orchestrator.steer': { capability: 'chat', mutating: true },
  'orchestrator.abort': { capability: 'chat', mutating: true },
  'orchestrator.isTurnActive': { capability: 'read', mutating: false },
  'orchestrator.contextUsage': { capability: 'read', mutating: false },
  // Composer: model/effort/mode/skill choices, image staging and the thread's message queue.
  'composer.options': { capability: 'read', mutating: false },
  'threads.setModel': { capability: 'chat', mutating: true },
  'attachments.stage': { capability: 'chat', mutating: true },
  'queue.list': { capability: 'read', mutating: false },
  'queue.enqueue': { capability: 'chat', mutating: true },
  'queue.remove': { capability: 'chat', mutating: true },
  'queue.reorder': { capability: 'chat', mutating: true },
  'queue.promoteToSteer': { capability: 'chat', mutating: true }
} as const satisfies Record<string, { capability: NodeCapability; mutating: boolean }>
export type BridgeRemoteMethod = keyof typeof BRIDGE_REMOTE_METHODS
export type BridgeOrdinaryMethod = Exclude<
  BridgeRemoteMethod,
  | 'orchestrator.send'
  | 'orchestrator.steer'
  | 'orchestrator.abort'
  | 'thread.snapshot'
  | 'attachments.stage'
>
