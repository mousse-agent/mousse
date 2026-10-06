/**
 * Versioned MMS local protocol envelopes (transport-independent).
 * No Electron imports.
 */

import type { BrowserWorkerRequest, BrowserWorkerResponse } from '../../shared/browser/types'

export const MMS_PROTOCOL_CHUNK_CAPABILITY = 'envelope-chunks.v1'
export const MMS_PROTOCOL_CHUNK_BYTES = 256 * 1024
export const MMS_PROTOCOL_MAX_ENVELOPE_BYTES = 32 * 1024 * 1024
export const MMS_PROTOCOL_VERSION = 1
export const MMS_PROTOCOL_MAX_FRAME_BYTES = 4 * 1024 * 1024 // 4 MiB
export const MMS_PROTOCOL_DEFAULT_REQUEST_TIMEOUT_MS = 60_000
/** Interactive provider login waits for browser consent or pasted credentials. */
export const MMS_PROTOCOL_LOGIN_TIMEOUT_MS = 15 * 60_000
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
/** Outstanding reverse commands on one authenticated connection. */
export const MMS_PROTOCOL_MAX_CONNECTION_COMMANDS = 8
/** Outstanding reverse commands across the daemon. */
export const MMS_PROTOCOL_MAX_GLOBAL_COMMANDS = 32
/**
 * Serialized inner request/result bound. Must stay under the 4 MiB frame and
 * 2 MiB outbound backlog.
 */
export const MMS_PROTOCOL_MAX_COMMAND_PAYLOAD_BYTES = 1024 * 1024
/** Bounded duplicate-command cache per connection (non-destructive). */
export const MMS_PROTOCOL_MAX_COMMAND_SEEN_IDS = 256
export const MMS_PROTOCOL_COMMAND_DEFAULT_TIMEOUT_MS = 60_000

export type ProtocolClientType = 'cli' | 'gui' | 'test' | 'unknown'

export type EnvelopeKind =
  | 'hello'
  | 'hello_ok'
  | 'hello_err'
  | 'req'
  | 'res'
  | 'event'
  | 'error'
  | 'server_req'
  | 'client_res'
  | 'server_cancel'
  | 'connection_event'

export interface ProtocolHello {
  kind: 'hello'
  protocolVersion: number
  ownerToken: string
  clientType: ProtocolClientType
  clientBuild?: string
  requestedCapabilities?: string[]
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

export type ProtocolErrorBody = import('../../shared/errors').AppErrorShape

export interface ProtocolEvent {
  kind: 'event'
  sequence: number
  type: string
  threadId?: string
  profileId?: string
  epoch?: number
  data: unknown
  ts: string
}

/** One authenticated socket's live display lane. Never sequenced or replayed. */
export interface ProtocolConnectionEvent {
  kind: 'connection_event'
  type: 'bridge.hub.thread'
  profileId: string
  profileEpoch: number
  data: unknown
}
export const MMS_PROTOCOL_MAX_CONNECTION_EVENT_BYTES = 64 * 1024

export interface ProtocolTransportError {
  kind: 'error'
  code: string
  message: string
}

/**
 * Daemon → targeted GUI reverse command. Never sequenced, subscribed, or
 * replayed. The only allowlisted method is `browser.attached.dispatch`.
 */
export interface ProtocolServerCommandRequest {
  kind: 'server_req'
  id: string
  method: 'browser.attached.dispatch'
  registrationId: string
  registrationEpoch: number
  profileId: string
  profileEpoch: number
  request: BrowserWorkerRequest
}

/**
 * GUI → daemon settlement for one reverse command. Correlation must match the
 * originating socket, command id, registration, and inner request id.
 */
export interface ProtocolClientCommandResponse {
  kind: 'client_res'
  id: string
  registrationId: string
  registrationEpoch: number
  requestId: string
  ok: boolean
  result?: BrowserWorkerResponse
  error?: ProtocolErrorBody
}

/** Best-effort cancel. Not proof the remote handler or page effect stopped. */
export interface ProtocolServerCommandCancel {
  kind: 'server_cancel'
  id: string
  registrationId: string
  registrationEpoch: number
}

export interface ProtocolEnvelopeChunk {
  kind: 'envelope_chunk'
  transferId: string
  index: number
  totalBytes: number
  data: string
}

export type ProtocolEnvelope =
  | ProtocolEnvelopeChunk
  | ProtocolHello
  | ProtocolHelloOk
  | ProtocolHelloErr
  | ProtocolRequest
  | ProtocolResponse
  | ProtocolEvent
  | ProtocolTransportError
  | ProtocolServerCommandRequest
  | ProtocolClientCommandResponse
  | ProtocolServerCommandCancel
  | ProtocolConnectionEvent

/**
 * Allowlisted methods Phase 2–5 (full GUI/CLI local protocol).
 * Remote/HTTP is out of scope.
 */
export const PROTOCOL_METHODS = [
  'health',
  'capabilities',
  'projects.list',
  'chatReferences.resolve',
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
  'threads.setWorktreeEnabled',
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
  'agents.createNamed',
  'agents.recallNamed',
  'agents.integrateNamed',
  'agents.listNamed',
  'agents.reviewNamed',
  'agents.stop',
  'workspace.getStatus',
  'workspace.restore',
  'actions.list',
  'actions.sweepRetention',
  'actions.configureRetention',
  'actions.pin',
  'actions.getAffectedFiles',
  'actions.undoLatest',
  'actions.revertCode',
  'actions.redo',
  'actions.fork',
  'actions.activateBranch',
  'operations.get',
  'operations.abort',
  'operations.recover',
  'publish.start',
  'publish.status',
  'threads.inventory',
  'threads.trash',
  'threads.restore',
  'threads.purge',
  'threads.configureTrash',
  'tasks.list',
  'tasks.create',
  'tasks.update',
  'mousseAgent.getMessages',
  'mousseAgent.getAssignment',
  'mousseAgent.contextUsage',
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
  'stats.usage',
  'stats.lineEdits',
  'stats.recordManualEdits',
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
  'providers.getSubscriptionUsage',
  'providers.getLoginOptions',
  'providers.refreshModels',
  'providers.getAmbientInfo',
  'providers.setApiKey',
  'providers.verifyAmbient',
  'providers.logout',
  'providers.loginOAuth',
  'providers.loginApiKey',
  'providers.loginRespond',
  'providers.loginCancel',
  'webTools.getCredentialStatus',
  'webTools.setApiKey',
  'webTools.clearApiKey',
  'workspace.getStatus',
  'workspace.restore',
  'actions.list',
  'actions.sweepRetention',
  'actions.configureRetention',
  'actions.pin',
  'actions.getAffectedFiles',
  'actions.undoLatest',
  'actions.revertCode',
  'actions.redo',
  'actions.fork',
  'actions.activateBranch',
  'operations.get',
  'operations.abort',
  'operations.recover',
  'publish.status',
  'publish.start',
  'threads.inventory',
  'threads.trash',
  'threads.restore',
  'threads.purge',
  'threads.configureTrash',
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
  'github.status',
  'github.createRepository',
  'github.cloneRepository',

  'daemon.shutdown',
  'events.subscribe',
  'gui.devtoolsPoll',
  'gui.devtoolsRespond'
] as const

export type ProtocolMethod = (typeof PROTOCOL_METHODS)[number]

export const PROTOCOL_CAPABILITIES = [
  MMS_PROTOCOL_CHUNK_CAPABILITY,
  'errors.v1',
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
  'events',
  'devgui',
  'profiles-v1'
] as const

export type ProtocolEventType =
  | 'net.updated'
  | 'projects.updated'
  | 'threads.updated'
  | 'thread.title-generation-failed'
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
  | 'stats.lineEdits.updated'
  | 'settings.changed'
  | 'providers.changed'
  | 'providers.login-event'
  | 'mcp.changed'
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
  | 'ui.quick-action-created'
  | 'ui.open-path'
  | 'ui.notify'
  | 'server.shutdown'
