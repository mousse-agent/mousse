/**
 * Versioned MMS local protocol envelopes (transport-independent).
 * No Electron imports.
 */

export const MMS_PROTOCOL_VERSION = 1
export const MMS_PROTOCOL_MAX_FRAME_BYTES = 4 * 1024 * 1024 // 4 MiB
export const MMS_PROTOCOL_DEFAULT_REQUEST_TIMEOUT_MS = 60_000
/** Agent turns legitimately run longer than the default control-request timeout. */
export const MMS_PROTOCOL_ORCHESTRATOR_SEND_TIMEOUT_MS = 30 * 60_000
export const MMS_PROTOCOL_REPLAY_RING_SIZE = 512
export const MMS_PROTOCOL_MAX_PENDING_REQUESTS = 64
/** Per-connection outbound write backlog before disconnecting a slow client. */
export const MMS_PROTOCOL_MAX_OUTBOUND_QUEUED_BYTES = 2 * 1024 * 1024 // 2 MiB
/** Bounded completed-response cache size per connection (duplicate id handling). */
export const MMS_PROTOCOL_MAX_COMPLETED_REQUEST_IDS = 256
export const MMS_PROTOCOL_MAX_ID_LENGTH = 128
export const MMS_PROTOCOL_MAX_METHOD_LENGTH = 96
export const MMS_PROTOCOL_MAX_TEXT_LENGTH = 512 * 1024
export const MMS_PROTOCOL_MAX_OWNER_TOKEN_LENGTH = 256
export const MMS_PROTOCOL_MAX_ORDERED_IDS = 10_000
export const MMS_PROTOCOL_MAX_IMAGES = 16
/** Base64 image data length bound (well under max frame). */
export const MMS_PROTOCOL_MAX_IMAGE_DATA_CHARS = 3 * 1024 * 1024

export type ProtocolClientType = 'cli' | 'gui' | 'test' | 'unknown'

export type EnvelopeKind = 'hello' | 'hello_ok' | 'hello_err' | 'req' | 'res' | 'event' | 'error'

export interface ProtocolHello {
  kind: 'hello'
  protocolVersion: number
  ownerToken: string
  clientType: ProtocolClientType
  clientBuild?: string
}

export interface ProtocolHelloOk {
  kind: 'hello_ok'
  protocolVersion: number
  serverVersion?: string
  serverBuild?: string
  instanceId: string
  capabilities: string[]
  globalSequence: number
}

export interface ProtocolHelloErr {
  kind: 'hello_err'
  code: string
  message: string
}

export interface ProtocolRequest {
  kind: 'req'
  id: string
  method: string
  params?: unknown
}

export interface ProtocolResponse {
  kind: 'res'
  id: string
  ok: boolean
  result?: unknown
  error?: ProtocolErrorBody
}

export interface ProtocolErrorBody {
  code: string
  message: string
  details?: unknown
}

export interface ProtocolEvent {
  kind: 'event'
  sequence: number
  type: string
  threadId?: string
  data: unknown
  ts: string
}

export interface ProtocolTransportError {
  kind: 'error'
  code: string
  message: string
}

export type ProtocolEnvelope =
  | ProtocolHello
  | ProtocolHelloOk
  | ProtocolHelloErr
  | ProtocolRequest
  | ProtocolResponse
  | ProtocolEvent
  | ProtocolTransportError

/**
 * Allowlisted methods Phase 2–5 (full GUI/CLI local protocol).
 * Remote/HTTP is out of scope.
 */
export const PROTOCOL_METHODS = [
  'health',
  'capabilities',
  'projects.list',
  'projects.open',
  'projects.remove',
  'projects.rename',
  'projects.pin',
  'projects.reorder',
  'threads.list',
  'threads.get',
  'threads.create',
  'threads.delete',
  'threads.rename',
  'threads.pin',
  'threads.settle',
  'threads.reorder',
  'threads.search',
  'threads.regenerateTitle',
  'threads.setModel',
  'thread.snapshot',
  'orchestrator.send',
  'orchestrator.abort',
  'orchestrator.steer',
  'orchestrator.retry',
  'orchestrator.isTurnActive',
  'orchestrator.contextUsage',
  'orchestrator.answerQuestions',
  'orchestrator.dismissQuestions',
  'orchestrator.pendingQuestions',
  'queue.list',
  'queue.enqueue',
  'queue.reorder',
  'queue.remove',
  'queue.promoteToSteer',
  'agents.list',
  'agents.spawn',
  'agents.stop',
  'tasks.list',
  'tasks.create',
  'tasks.update',
  'mousseAgent.getMessages',
  'mousseAgent.getAssignment',
  'mousseAgent.send',
  'mousseAgent.retry',
  'mousseAgent.abort',
  'pty.list',
  'pty.create',
  'pty.write',
  'pty.resize',
  'pty.kill',
  'pty.isAlive',
  'pty.lookup',
  'pty.scrollback',
  'pty.outputSince',
  'activity.get',
  'activity.snapshot',
  'scheduled.list',
  'scheduled.get',
  'scheduled.create',
  'scheduled.update',
  'scheduled.delete',
  'scheduled.pause',
  'scheduled.resume',
  'scheduled.run',
  'scheduled.status',
  'channels.getSnapshot',
  'channels.getConfig',
  'channels.updateConfig',
  'channels.connect',
  'channels.disconnect',
  'channels.listPairingRequests',
  'channels.approvePairing',
  'channels.rejectPairing',
  'channels.sendTest',
  'channels.getActivity',
  'mcp.listServers',
  'mcp.listTools',
  'mcp.testServer',
  'mcp.authenticate',
  'mcp.restartServer',
  'mcp.getConfigSources',
  'mcp.writeCursorConfig',
  'mcp.openConfigIntent',
  'skills.list',
  'skills.read',
  'skills.refresh',
  'skills.openFolderIntent',
  'settings.get',
  'settings.set',
  'settings.getOptions',
  'providers.listConfigured',
  'providers.getUsage',
  'providers.getLoginOptions',
  'providers.getAmbientInfo',
  'providers.setApiKey',
  'providers.verifyAmbient',
  'providers.logout',
  'providers.loginOAuth',
  'providers.loginApiKey',
  'providers.loginRespond',
  'providers.loginCancel',
  'workspace.getStatus',
  'workspace.restore',
  'actions.list',
  'actions.getAffectedFiles',
  'actions.undoLatest',
  'actions.revertCode',
  'actions.redo',
  'actions.fork',
  'actions.activateBranch',
  'operations.get',
  'operations.abort',
  'publish.status',
  'publish.start',
  'threads.trash',
  'threads.restore',
  'threads.purge',
  'files.list',
  'files.read',
  'files.write',
  'files.stat',
  'git.status',
  'git.diff',
  'git.log',
  'git.branches',
  'git.checkout',
  'git.commit',
  'git.push',
  'connections.info',
  'connections.config',
  'connections.configure',
  'daemon.shutdown',
  'events.subscribe'
] as const

export type ProtocolMethod = (typeof PROTOCOL_METHODS)[number]

export const PROTOCOL_CAPABILITIES = [
  'health',
  'projects',
  'threads',
  'orchestrator',
  'queue',
  'agents',
  'tasks',
  'pty',
  'questions',
  'scheduled',
  'channels',
  'mcp',
  'skills',
  'settings',
  'providers',
  'connections',
  'events'
] as const

export type ProtocolEventType =
  | 'projects.updated'
  | 'threads.updated'
  | 'thread.message'
  | 'thread.message-updated'
  | 'thread.messages'
  | 'queue.updated'
  | 'turn.started'
  | 'turn.completed'
  | 'turn.interrupted'
  | 'turn.aborted'
  | 'turn.steered'
  | 'connection.failed'
  | 'activity'
  | 'activity.snapshot'
  | 'agents.updated'
  | 'tasks.updated'
  | 'agent.spawned'
  | 'agent.activated'
  | 'terminal.activated'
  | 'questions.pending'
  | 'questions.cleared'
  | 'mousse-agent.message'
  | 'mousse-agent.message-updated'
  | 'mousse-agent.messages-sync'
  | 'mousse-agent.complete'
  | 'mousse-agent.connection-failed'
  | 'pty.data'
  | 'pty.exit'
  | 'pty.created'
  | 'scheduled.updated'
  | 'scheduled.status'
  | 'channels.updated'
  | 'channels.activity'
  | 'settings.changed'
  | 'providers.changed'
  | 'providers.login-event'
  | 'mcp.changed'
  | 'ui.focus-intent'
  | 'ui.document-open'
  | 'ui.open-path'
  | 'ui.notify'
  | 'server.shutdown'
