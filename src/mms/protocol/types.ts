import { KEEP_AWAKE_CAPABILITY } from '../../shared/keepAwake'
import { BOT_TELLING_CAPABILITY } from '../../shared/bots/personal/telling'
import { IMAGE_MAX_DATA_CHARS, MESSAGE_IMAGES_MAX_DATA_CHARS, MESSAGE_MAX_IMAGES } from '../../shared/imageLimits'
/**
 * Versioned MMS local protocol envelopes (transport-independent).
 * No Electron imports.
 */

import type { BrowserWorkerRequest, BrowserWorkerResponse } from '../../shared/browser/types'
import type { Thread, ThreadListVersion } from '../../shared/types'

export const MMS_PROTOCOL_CHUNK_CAPABILITY = 'envelope-chunks.v1'
/**
 * The client may send a request larger than one frame as envelope chunks (the same `envelope_chunk` frames the
 * service sends), up to `MMS_PROTOCOL_MAX_INBOUND_ENVELOPE_BYTES`. A client sends chunks only to a service that
 * advertised this, so an older service never receives one.
 */
export const MMS_PROTOCOL_INBOUND_CHUNK_CAPABILITY = 'envelope-chunks-inbound.v1'
export const MMS_PROTOCOL_CHUNK_BYTES = 256 * 1024
/** One envelope the service sends a client in chunks. */
export const MMS_PROTOCOL_MAX_ENVELOPE_BYTES = 32 * 1024 * 1024
/**
 * One request a client sends the service in chunks: a message with the most images it may carry (80 MiB as base64,
 * about 107 MiB) and its text, with room for the JSON around them.
 */
export const MMS_PROTOCOL_MAX_INBOUND_ENVELOPE_BYTES = 128 * 1024 * 1024
/**
 * Bytes of chunked requests the service holds while they arrive, across all connections: two full requests. A transfer
 * that would take more closes its connection, so what arrives in chunks stays bounded however many clients send.
 */
export const MMS_PROTOCOL_MAX_INBOUND_IN_FLIGHT_BYTES = 2 * MMS_PROTOCOL_MAX_INBOUND_ENVELOPE_BYTES
/**
 * 2: the old provider methods (`providers.listConfigured`, `setApiKey`, `login*`, ...) and the
 * `providers.changed` / `providers.login-event` events are gone; clients use `providers.instances.*`,
 * `providers.catalog.addOptions` and `providers.snapshots`.
 */
export const MMS_PROTOCOL_VERSION = 2
export const MMS_PROTOCOL_MAX_FRAME_BYTES = 4 * 1024 * 1024 // 4 MiB
export const MMS_PROTOCOL_DEFAULT_REQUEST_TIMEOUT_MS = 60_000
/** Interactive provider login waits for browser consent or pasted credentials. */
export const MMS_PROTOCOL_LOGIN_TIMEOUT_MS = 15 * 60_000
/** Agent turns legitimately run longer than the default control-request timeout. */
export const MMS_PROTOCOL_ORCHESTRATOR_SEND_TIMEOUT_MS = 30 * 60_000
/** Git mutations can wait on hooks, credential helpers or a slow remote; Git itself decides when they are stuck. */
export const MMS_PROTOCOL_GIT_OPERATION_TIMEOUT_MS = 30 * 60_000
/** How long `/compact` waits for a runtime's own compaction; after it the compaction stops and the full history stays. */
export const CONTEXT_COMPACTION_TIME_LIMIT_MS = 5 * 60_000
/**
 * `threads.compact` answers once the compaction ended, which the service limits to `CONTEXT_COMPACTION_TIME_LIMIT_MS`
 * plus Mousse's own cut when the runtime's failed. The caller waits that long and a little more, so it never gives up
 * on a compaction that is still running.
 */
export const MMS_PROTOCOL_COMPACT_TIMEOUT_MS = CONTEXT_COMPACTION_TIME_LIMIT_MS + 2 * 60_000
export const MMS_PROTOCOL_REPLAY_RING_SIZE = 512
/**
 * The most a profile's replay ring holds, by its size estimate. Past it the oldest events leave, and a client that
 * needed them sees a gap and takes a fresh snapshot. A subscribe replays at most 1 MiB anyway (half the outbound
 * backlog), so this only bounds what a client that fell a little behind can catch up on.
 */
export const MMS_PROTOCOL_REPLAY_RING_BYTES = 8 * 1024 * 1024
export const MMS_PROTOCOL_MAX_PENDING_REQUESTS = 64
/** Per-connection outbound write backlog before disconnecting a slow client. */
export const MMS_PROTOCOL_MAX_OUTBOUND_QUEUED_BYTES = 2 * 1024 * 1024 // 2 MiB
export const MMS_PROTOCOL_MAX_ID_LENGTH = 128
export const MMS_PROTOCOL_MAX_METHOD_LENGTH = 96
export const MMS_PROTOCOL_MAX_TEXT_LENGTH = 512 * 1024
export const MMS_PROTOCOL_MAX_OWNER_TOKEN_LENGTH = 256
export const MMS_PROTOCOL_MAX_ORDERED_IDS = 10_000
export const MMS_PROTOCOL_MAX_IMAGES = MESSAGE_MAX_IMAGES
/** Base64 characters in one image. A request past one frame goes in chunks (`MMS_PROTOCOL_INBOUND_CHUNK_CAPABILITY`). */
export const MMS_PROTOCOL_MAX_IMAGE_DATA_CHARS = IMAGE_MAX_DATA_CHARS
/** Base64 characters in all of one message's images. */
export const MMS_PROTOCOL_MAX_MESSAGE_IMAGE_DATA_CHARS = MESSAGE_IMAGES_MAX_DATA_CHARS
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

/**
 * `bridge` is a person on another of the user's computers. The daemon assigns it to a routed call
 * (`OwnerRoutes`); a client can never say it in a hello, and it is never `gui`, so everything that
 * is only for a window on this computer (files panel, direct saves, browser host) refuses it.
 */
export type ProtocolClientType = 'cli' | 'gui' | 'bridge' | 'test' | 'unknown'

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

/**
 * What a connection event can carry: bridge display, MCP sign-in, the live output of the Git action this socket started,
 * and the pictures of a bot's browser, or of a thread's browser without a window, this socket watches.
 */
export type ProtocolConnectionEventType = 'bridge.hub.thread' | 'mcp.auth-url' | 'git.operation' | 'bots.browser.frame' | 'browser.view.frame'
export const PROTOCOL_CONNECTION_EVENT_TYPES: readonly ProtocolConnectionEventType[] = ['bridge.hub.thread', 'mcp.auth-url', 'git.operation', 'bots.browser.frame', 'browser.view.frame']

/** Granted to every session: it may receive `git.operation` events for the Git actions it starts. */
export const GIT_OPERATIONS_CAPABILITY = 'git.operations.v1'

/**
 * Asked for by a window that binds the first message of a chat made for it (`Thread.firstSendPending`) to the settings
 * it shows. The service refuses such a window's unbound first send as a lost update ("send it again"), and an older
 * window's as one it cannot make ("update Mousse").
 */
export const FIRST_SEND_BINDING_CAPABILITY = 'threads.firstSendBinding.v1'

/** A local editor can bind reads and saves to the resolved thread workspace. */
export const FILE_WORKSPACE_BINDING_CAPABILITY = 'files.workspaceBinding.v1'

/**
 * Asked for by a window that applies `threads.row`: a change to one thread is sent as that thread's row (or its
 * removal), with the list version it belongs to, instead of the whole list. A session without it is sent the whole
 * list (`threads.updated`) for every such change, as before.
 */
export const THREAD_ROWS_CAPABILITY = 'threads.rows.v1'

/**
 * `threads.row`'s data: the changed thread's row as the list has it now, or `removed` when it left the list (or became
 * a personal bot's), and the version of the list snapshot it was read from (`ThreadListVersion`).
 */
export interface ThreadRowEventData {
  thread?: Thread
  removed?: string
  version: ThreadListVersion
}

/** One authenticated socket's live display lane. Never sequenced or replayed. */
export interface ProtocolConnectionEvent {
  kind: 'connection_event'
  type: ProtocolConnectionEventType
  profileId: string
  profileEpoch: number
  data: unknown
}
export const MMS_PROTOCOL_MAX_CONNECTION_EVENT_BYTES = 64 * 1024
/** A watched browser's picture (a bot's, or a thread's) is a JPEG of up to 960 px (a sharp one included), in base64. */
export const MMS_PROTOCOL_MAX_FRAME_EVENT_BYTES = 1024 * 1024
/** The largest connection event of a type. */
export function maxConnectionEventBytes(type: ProtocolConnectionEventType): number {
  return type === 'bots.browser.frame' || type === 'browser.view.frame' ? MMS_PROTOCOL_MAX_FRAME_EVENT_BYTES : MMS_PROTOCOL_MAX_CONNECTION_EVENT_BYTES
}

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
  'applets.get', 'applets.state.get', 'applets.state.save', 'applets.export',
  'health',
  'capabilities',
  'projects.list',
  'chatReferences.resolve',
  'projects.open',
  'projects.identity',
  'projects.remove',
  'projects.rename',
  'projects.pin',
  'projects.reorder',
  'projects.trustGitSettings',
  'projects.icon',
  'projects.setIcon',
  'projects.setPath',
  'appearance.wallpaperImport',
  'appearance.wallpaperImportBytes',
  'appearance.wallpaperRead',
  'appearance.wallpaperSaveCopy',
  'threads.list',
  'threads.get',
  'threads.create',
  'threads.delete',
  'threads.rename',
  'threads.pin',
  'threads.setHidden',
  'threads.archive',
  'threads.settle',
  'threads.focus',
  'bots.focus',
  'bots.remote.list',
  'bots.remote.file',
  'bots.remote.applet',
  'bots.remote.appletState',
  'bots.marks.list',
  'bots.marks.set',
  'threads.markSeen',
  'threads.reorder',
  'threads.search',
  'threads.regenerateTitle',
  'threads.clearContext',
  'threads.compact',
  'threads.stopCompaction',
  'threads.setModel',
  'threads.setWorktreeEnabled',
  'threads.setPermissionMode',
  'threads.setExpiry',
  'threads.approvalRules',
  'threads.clearApprovalRules',
  'threads.approvalRequests',
  'thread.snapshot',
  'thread.messages',
  'thread.messageImage',
  'thread.changesSince',
  'orchestrator.send',
  'orchestrator.sendAccepted',
  'orchestrator.abort',
  'orchestrator.steer',
  'orchestrator.steerNow',
  'orchestrator.correctSubagents',
  'orchestrator.retry',
  'orchestrator.retrySetup',
  'orchestrator.isTurnActive',
  'orchestrator.contextUsage',
  'runs.list',
  'runs.get',
  'runs.events',
  'runs.wait',
  'runs.effects',
  'runs.credentials',
  'runs.transfers',
  'runs.handoffs',
  'runs.resumeNow',
  'runs.cancelPause',
  'threads.goal',
  'threads.chainHold',
  'thread.fork',
  'thread.mergeBack',
  'orchestrator.answerQuestions',
  'orchestrator.dismissQuestions',
  'orchestrator.pendingQuestions',
  'subagents.list',
  'subagents.stopAll',
  'threads.backgroundWork',
  'threads.stopBackground',
  'queue.list',
  'queue.enqueue',
  'queue.edit',
  'queue.reorder',
  'queue.remove',
  'queue.promoteToSteer',
  'agents.list',
  'agents.spawn',
  'agents.stop',
  'workspace.getStatus',
  'workspace.restore',
  'workspace.discardPendingChanges',
  'editor.folder',
  'editor.ask',
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
  'tasks.list',
  'tasks.create',
  'tasks.update',
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
  'scheduled.settings.get',
  'scheduled.settings.set',
  'scheduled.extend',
  'scheduled.webhook.enable',
  'scheduled.webhook.rotate',
  'scheduled.webhook.disable',
  'scheduled.webhook.deliveries',
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
  'settings.titleOptions',
  'providers.getUsage',
  'providers.getSubscriptionUsage',
  'providers.usageSlots',
  'providers.limitTrends',
  'providers.watchUsage',
  'usage.history',
  'providers.getUsageFor',
  'providers.useLimitReset',
  'providers.setUsageProxyKey',
  'providers.clearUsageProxyKey',
  'providers.synthesizeSpeech',
  'providers.transcribeAudio',
  // Harness gateway: instance snapshots and commands. Long operations return an operation id
  // and report through `providers.operation` events.
  'providers.snapshots',
  'providers.events',
  'providers.instances.add',
  'providers.instances.setSecret',
  'providers.instances.remove',
  'providers.instances.configure',
  'providers.instances.setEnabled',
  'providers.instances.install',
  'providers.instances.removeInstall',
  'providers.instances.cancelInstall',
  'providers.instances.update',
  'providers.instances.signIn',
  'providers.instances.respondSignIn',
  'providers.instances.signOut',
  'providers.instances.allowKnownProblem',
  'providers.instances.recheck',
  'providers.instances.vendorSettings',
  'providers.instances.setVendorSetting',
  'providers.instances.refreshModels',
  'providers.instances.refreshAllModels',
  'providers.instances.setModelPrefs',
  'providers.instances.move',
  'providers.registry.search',
  'providers.catalog.addOptions',
  // Local model servers (Add provider → Local models): detection on request, connect, a model's window, the tool check.
  'providers.local.detect',
  'providers.local.connect',
  'providers.local.setModel',
  'providers.local.checkTools',
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
  'storage.policy',
  'storage.configure',
  'storage.reviewDismiss',
  'storage.worktreeFolder',
  'storage.setWorktreeFolder',
  'storage.cleanup.run',
  'storage.cleanup.plan',
  'storage.cleanup.lastReport',
  'storage.usage',
  'storage.exportThreadJson',
  'files.list',
  'files.read',
  'files.write',
  'files.stat',
  'files.root',
  'files.drives',
  'files.readAsset',
  'files.writeDirect',
  'files.search',
  'files.grep',
  'git.status',
  'git.heads',
  'git.diff',
  'review.files',
  'review.file',
  'review.turnFile',
  'git.log',
  'git.branches',
  'git.diffStats',
  'git.lastCommitMessage',
  'git.checkUpstream',
  'git.checkout',
  'git.commit',
  'git.suggestCommitMessage',
  'git.push',
  'git.stage',
  'git.unstage',
  'git.discard',
  'git.fetch',
  'git.pull',
  'git.abortInProgress',
  'git.continueInProgress',
  'git.createBranch',
  'git.renameBranch',
  'git.deleteBranch',
  'git.init',
  'git.cancelOperation',
  'git.changes',
  'git.include',
  'git.undoLastCommit',
  'git.revert',
  'git.restoreReverted',
  'git.revertedList',
  'github.status',
  'github.createRepository',
  'github.cloneRepository',
  'pullRequests.get',
  'pullRequests.detail',
  'pullRequests.view',
  'pullRequests.draft',
  'pullRequests.create',
  'pullRequests.merge',
  'pullRequests.close',
  'pullRequests.baseBranches',
  'pullRequests.mergeMethod',
  'pullRequests.link',
  'pullRequests.unlink',
  'pullRequests.list',
  'pullRequests.resolve',
  'pullRequests.startThread',
  'pullRequests.pushTarget',
  'pullRequests.watch',
  'pullRequests.watchStatus',

  'daemon.shutdown',
  'events.subscribe',
  'gui.devtoolsPoll',
  'gui.devtoolsRespond'
] as const

export type ProtocolMethod = (typeof PROTOCOL_METHODS)[number]

export const PROTOCOL_CAPABILITIES = [
  FILE_WORKSPACE_BINDING_CAPABILITY,
  KEEP_AWAKE_CAPABILITY,
  BOT_TELLING_CAPABILITY,
  MMS_PROTOCOL_CHUNK_CAPABILITY,
  MMS_PROTOCOL_INBOUND_CHUNK_CAPABILITY,
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
  'mcp',
  'skills',
  'settings',
  'providers',
  'events',
  'devgui',
  'profiles-v1',
  GIT_OPERATIONS_CAPABILITY
] as const

export type ProtocolEventType =
  | 'net.updated'
  | 'bots.changed'
  | 'chats.changed'
  | 'bots.message'
  | 'bots.activity'
  | 'bots.reply'
  | 'run.event'
  | 'run.stop-requested'
  | 'run.steer-accepted'
  | 'run.interrupted-on-boot'
  | 'projects.updated'
  | 'threads.updated'
  | 'threads.row'
  | 'threads.touched'
  | 'pullRequests.updated'
  | 'git.selectionChanged'
  | 'git.headsChanged'
  | 'thread.title-generation-failed'
  | 'subagents.updated'
  | 'thread.backgroundWork'
  | 'thread.message'
  | 'thread.message-updated'
  | 'thread.messages'
  | 'queue.updated'
  | 'turn.started'
  | 'turn.completed'
  | 'turn.interrupted'
  | 'turn.aborted'
  | 'turn.paused'
  | 'turn.steered'
  | 'steer.now'
  | 'connection.failed'
  | 'activity'
  | 'activity.snapshot'
  | 'agents.updated'
  | 'tasks.updated'
  | 'agent.spawned'
  | 'terminal.activated'
  | 'questions.pending'
  | 'questions.cleared'
  | 'secrets.requests.changed'
  | 'computerUse.setupRequest.changed'
  | 'secrets.changed'
  | 'pty.data'
  | 'pty.exit'
  | 'pty.created'
  | 'scheduled.updated'
  | 'scheduled.status'
  | 'scheduled.runEnded'
  | 'stats.lineEdits.updated'
  | 'settings.changed'
  | 'providers.install-event'
  | 'providers.snapshots'
  | 'providers.operation'
  | 'providers.usage'
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
  | 'terminal.activated'
  | 'questions.pending'
  | 'questions.cleared'
  | 'secrets.requests.changed'
  | 'computerUse.setupRequest.changed'
  | 'secrets.changed'
  | 'pty.data'
  | 'pty.exit'
  | 'pty.created'
  | 'scheduled.updated'
  | 'scheduled.status'
  | 'settings.changed'
  | 'mcp.changed'
  | 'ui.focus-intent'
  | 'ui.quick-action-created'
  | 'ui.open-path'
  | 'ui.notify'
  | 'server.shutdown'
