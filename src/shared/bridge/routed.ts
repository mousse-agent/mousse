/**
 * The methods another of the user's computers may call on the computer that runs a thread.
 *
 * This table is the security boundary of the routed API: a method that is not a row here is not
 * reachable. Each row is registered on the owner as its own Net method `routed.<method>` with a fixed
 * capability, and the owner accepts exactly the row's keys before the protocol handler sees the
 * request (many handlers do not reject unknown keys themselves).
 *
 * Changing a row's keys needs a version bump: `net.info` advertises each row's version, a caller
 * sends only the keys the owner's version knows, and `tests/net/bridge/routed/table.test.ts` fails
 * when the keys of a version change.
 */
import type { NodeCapability } from '../net/capabilities'

/** What a row acts on. */
export type RoutedTarget =
  /** One thread of the owner's profile (`threadId`, or the id fields named by `threadIds`). */
  | 'thread'
  /** A thread (`threadId`) or a project (`projectId`), exactly one of them. */
  | 'folder'
  /** One project of the owner's profile (`projectId`). */
  | 'project'
  /** The owner computer itself: its lists, picker options and registered folders. */
  | 'computer'

/** Where the owner runs a row. */
export type RoutedVia =
  /** The local protocol handler, as a Mousse window on the owner would call it. */
  | 'protocol'
  /** A domain method (`ctx.mms.domains`); the owner adds the profile binding. */
  | 'domain'
  /** The Bridge backend, which already carries the checks written for devices (`MmsRemoteBackend`). */
  | 'backend'

/** What a secondary id has to be, in the thread the call names. */
export type RoutedOwnedId =
  /** A question or approval request that was asked in the thread. */
  | 'question'
  /** A run of the thread. */
  | 'run'
  /** A workflow run of the thread. */
  | 'workflowRun'
  /** A terminal of the thread. */
  | 'pty'
  /** Another thread of this profile. */
  | 'thread'

export interface RoutedRow {
  /** The Net capability the caller needs besides "Works on threads". */
  capability: Extract<NodeCapability, 'read' | 'chat' | 'write'>
  /**
   * Durable rows go through the request ledger (`idem`, replay, "may have happened"); the rest run
   * outside it and keep nothing on disk. Every row that changes something is durable.
   */
  durable: boolean
  /** Raised whenever `keys` or `since` change. */
  version: number
  target: RoutedTarget
  /** Every key the owner accepts at `version`. */
  keys: readonly string[]
  /** Keys that must be present. The target's id keys are always checked as well. */
  required?: readonly string[]
  /** The version that added a key; a key not listed here has been there since version 1. */
  since?: Readonly<Record<string, number>>
  /** The params that name the thread the call acts on; the first is the thread. Default `threadId`. */
  threadIds?: readonly string[]
  /** Params that name something that must belong to that thread. */
  owned?: Readonly<Record<string, RoutedOwnedId>>
  /** Params the owner removes before it runs the handler (they only route the call). */
  routeOnly?: readonly string[]
  via: RoutedVia
  /** The device's terminal switch on the owner must be on. */
  terminal?: true
  /** Only the call that names an absolute `path` (`projects.open`) may. */
  absolutePath?: true
  /**
   * Keys whose value may be sent ahead through `routed.stage` instead of inline (a large message, an
   * image, a file's content) and named in `stagedValues`. The owner puts the value back before it checks
   * the call, so a staged call is held to the row's keys exactly like an inline one.
   */
  stageable?: readonly string[]
}

const FOLDER = ['threadId', 'projectId'] as const
const GEN = 'expectedJournalGeneration'
/** The key of a call that names its staged values: `{ stagedValues: { content: 'stg_…' } }`. */
export const ROUTED_STAGED_KEY = 'stagedValues'

/** A row whose large values may be staged: the key is new at version 2, so an older owner never sees it. */
const staging = (values: readonly string[]): Partial<RoutedRow> => ({
  version: 2,
  since: { [ROUTED_STAGED_KEY]: 2 },
  stageable: values
})

function row(
  capability: RoutedRow['capability'],
  target: RoutedTarget,
  keys: readonly string[],
  extra: Partial<Omit<RoutedRow, 'capability' | 'target' | 'keys'>> = {}
): RoutedRow {
  return {
    capability,
    durable: capability !== 'read',
    version: 1,
    target,
    keys,
    via: 'protocol',
    ...extra
  }
}
const read = (target: RoutedTarget, keys: readonly string[], extra?: Partial<RoutedRow>) =>
  row('read', target, keys, extra)
const chat = (target: RoutedTarget, keys: readonly string[], extra?: Partial<RoutedRow>) =>
  row('chat', target, keys, extra)
const write = (target: RoutedTarget, keys: readonly string[], extra?: Partial<RoutedRow>) =>
  row('write', target, keys, extra)

/**
 * Keys no routed call may ever carry, whatever a row says: they would name a folder, a command or
 * an identity of the caller instead of a thread of the owner.
 */
export const ROUTED_FORBIDDEN_KEYS = [
  'cwd',
  'env',
  'command',
  'shellArgs',
  'source',
  'projectPath',
  'profileId',
  'expectedProfileId'
] as const

export const ROUTED_METHODS: Readonly<Record<string, RoutedRow>> = Object.freeze({
  // ---------------------------------------------------------------- thread reads
  'threads.get': read('thread', ['threadId']),
  // `transcript: false` leaves out what a computer that reads the thread's stream already has (the
  // messages and the queue), so a snapshot of a long thread is not sent a second time.
  'thread.snapshot': read('thread', ['threadId', 'transcript'], {
    version: 2,
    since: { transcript: 2 }
  }),
  // Older messages of a long thread, a page at a time, newest first from `before` (a message id).
  'thread.messages': read('thread', ['threadId', 'before', 'limit']),
  // The image of one message or queued message, by its place in it (the stream carries only the newest images' data).
  'thread.messageImage': read('thread', ['threadId', 'messageId', 'queueItemId', 'index'], {
    required: ['index']
  }),
  'orchestrator.isTurnActive': read('thread', ['threadId']),
  'orchestrator.contextUsage': read('thread', ['threadId', 'draftInput', 'mode']),
  'orchestrator.pendingQuestions': read('thread', ['threadId']),
  'queue.list': read('thread', ['threadId']),
  'runs.list': read('thread', ['threadId', 'limit']),
  'runs.get': read('thread', ['threadId', 'runId'], {
    required: ['runId'],
    owned: { runId: 'run' }
  }),
  'runs.events': read('thread', ['threadId', 'afterSeq', 'limit']),
  'activity.get': read('thread', ['threadId']),
  'subagents.list': read('thread', ['threadId']),
  'agents.list': read('thread', ['threadId']),
  'tasks.list': read('thread', ['threadId']),
  'workspace.getStatus': read('thread', ['threadId', GEN]),
  'threads.approvalRules': read('thread', ['threadId']),
  'actions.list': read('thread', ['threadId', GEN]),
  'actions.getAffectedFiles': read('thread', ['threadId', 'actionId', GEN], {
    required: ['actionId']
  }),
  'operations.get': read('thread', ['threadId', 'operationId', GEN], { required: ['operationId'] }),
  'publish.status': read('thread', ['threadId', GEN]),
  'review.files': read('folder', [...FOLDER, 'scope'], { required: ['scope'] }),
  'review.file': read('folder', [...FOLDER, 'scope', 'path', 'oldPath'], {
    required: ['scope', 'path']
  }),
  'git.status': read('folder', [...FOLDER]),
  'git.diff': read('folder', [...FOLDER, 'path', 'staged'], { required: ['path'] }),
  'git.log': read('folder', [...FOLDER, 'limit']),
  'git.branches': read('folder', [...FOLDER]),
  'git.diffStats': read('folder', [...FOLDER]),
  'git.lastCommitMessage': read('folder', [...FOLDER]),
  'files.list': read('folder', [...FOLDER, 'path']),
  'files.read': read('folder', [...FOLDER, 'path'], { required: ['path'] }),
  'files.readAsset': read('folder', [...FOLDER, 'path', 'offset', 'length'], {
    required: ['path']
  }),
  'files.stat': read('folder', [...FOLDER, 'path'], { required: ['path'] }),
  'files.search': read('folder', [...FOLDER, 'query', 'limit', 'kinds']),
  'files.grep': read(
    'folder',
    [...FOLDER, 'query', 'regex', 'caseSensitive', 'wholeWord', 'limit', 'timeoutMs'],
    {
      required: ['query']
    }
  ),
  'pullRequests.get': read('folder', [...FOLDER, 'branch', 'force']),
  'pullRequests.detail': read('folder', [...FOLDER, 'number', 'force'], { required: ['number'] }),
  'pullRequests.baseBranches': read('folder', [...FOLDER]),
  'pullRequests.watchStatus': read('thread', ['threadId']),
  'applets.get': read('thread', ['threadId', 'appletId', 'revisionId'], {
    required: ['appletId', 'revisionId']
  }),
  'applets.state.get': read('thread', ['threadId', 'appletId', 'revisionId'], {
    required: ['appletId', 'revisionId']
  }),
  'applets.export': read('thread', ['threadId', 'appletId', 'revisionId', 'format', 'appearance'], {
    required: ['appletId', 'revisionId', 'format']
  }),
  'workflowRuns.list': read('thread', ['threadId', 'definitionId', 'before', 'limit'], {
    via: 'domain'
  }),
  'workflowRuns.get': read('thread', ['threadId', 'runId'], {
    via: 'domain',
    required: ['runId'],
    owned: { runId: 'workflowRun' },
    routeOnly: ['threadId']
  }),
  'workflowRuns.trace': read('thread', ['threadId', 'runId', 'afterSequence', 'limit'], {
    via: 'domain',
    required: ['runId'],
    owned: { runId: 'workflowRun' },
    routeOnly: ['threadId']
  }),
  // Terminal output and state: also behind the device's terminal switch on the owner.
  'pty.list': read('thread', ['threadId'], { terminal: true }),
  'pty.lookup': read('thread', ['threadId', 'ptyId'], {
    terminal: true,
    required: ['ptyId'],
    owned: { ptyId: 'pty' }
  }),
  'pty.scrollback': read('thread', ['threadId', 'ptyId'], {
    terminal: true,
    owned: { ptyId: 'pty' }
  }),
  'pty.isAlive': read('thread', ['threadId', 'ptyId'], {
    terminal: true,
    required: ['ptyId'],
    owned: { ptyId: 'pty' }
  }),
  'pty.outputSince': read('thread', ['threadId', 'ptyId', 'afterSequence'], {
    terminal: true,
    required: ['ptyId'],
    owned: { ptyId: 'pty' }
  }),

  // ---------------------------------------------------------------- chat
  // The owner always answers a send once the turn is admitted (`await: 'ack'`); a send never carries
  // `source` (it is `gui`) or a workflow receipt (the owner makes those).
  'orchestrator.send': chat(
    'thread',
    [
      'threadId',
      'content',
      'forceQueue',
      'mode',
      'images',
      'requestId',
      'clientRequestId',
      'continuationOfRunId',
      'acknowledgeUncertain',
      ROUTED_STAGED_KEY
    ],
    { required: ['content'], ...staging(['content', 'images']) }
  ),
  'orchestrator.steer': chat(
    'thread',
    ['threadId', 'text', 'runId', 'clientRequestId', ROUTED_STAGED_KEY],
    {
      required: ['text'],
      owned: { runId: 'run' },
      ...staging(['text'])
    }
  ),
  'orchestrator.abort': chat('thread', ['threadId', 'clearQueue', 'runId', 'clientRequestId'], {
    owned: { runId: 'run' }
  }),
  'orchestrator.retry': chat('thread', ['threadId']),
  'orchestrator.answerQuestions': chat('thread', ['threadId', 'requestId', 'answers'], {
    required: ['requestId', 'answers'],
    owned: { requestId: 'question' }
  }),
  'orchestrator.dismissQuestions': chat('thread', ['threadId', 'requestId'], {
    required: ['requestId'],
    owned: { requestId: 'question' }
  }),
  'queue.enqueue': chat(
    'thread',
    ['threadId', 'content', 'mode', 'images', 'requestId', ROUTED_STAGED_KEY],
    { required: ['content'], ...staging(['content', 'images']) }
  ),
  'queue.edit': chat(
    'thread',
    ['threadId', 'itemId', 'content', 'mode', 'expectedRevision', ROUTED_STAGED_KEY],
    { required: ['itemId'], ...staging(['content']) }
  ),
  'queue.reorder': chat('thread', ['threadId', 'orderedIds', 'expectedRevision'], {
    required: ['orderedIds']
  }),
  'queue.remove': chat('thread', ['threadId', 'itemId', 'expectedRevision'], {
    required: ['itemId']
  }),
  'queue.promoteToSteer': chat(
    'thread',
    ['threadId', 'itemId', 'expectedRevision', 'expectedRunId'],
    {
      required: ['itemId']
    }
  ),
  'threads.setModel': chat('thread', ['threadId', 'model']),
  'threads.setPermissionMode': chat('thread', ['threadId', 'mode'], { required: ['mode'] }),
  'threads.clearApprovalRules': chat('thread', ['threadId', 'ruleId']),
  'runs.resumeNow': chat('thread', ['threadId', 'runId'], {
    required: ['runId'],
    owned: { runId: 'run' }
  }),
  'runs.cancelPause': chat('thread', ['threadId', 'runId'], {
    required: ['runId'],
    owned: { runId: 'run' }
  }),
  'subagents.stopAll': chat('thread', ['threadId']),
  'agents.stop': chat('thread', ['threadId', 'agentId', 'merge'], { required: ['agentId'] }),
  'tasks.create': chat('thread', ['threadId', 'description', 'agentId', 'status'], {
    required: ['description']
  }),
  'tasks.update': chat(
    'thread',
    ['threadId', 'id', 'status', 'progress', 'description', 'message', 'summary', 'agentId'],
    { required: ['id'] }
  ),
  'applets.state.save': chat('thread', ['threadId', 'appletId', 'revisionId', 'state'], {
    required: ['appletId', 'revisionId', 'state']
  }),
  'workflowRuns.pause': chat('thread', ['threadId', 'runId'], {
    via: 'domain',
    required: ['runId'],
    owned: { runId: 'workflowRun' },
    routeOnly: ['threadId']
  }),
  'workflowRuns.resume': chat('thread', ['threadId', 'runId'], {
    via: 'domain',
    required: ['runId'],
    owned: { runId: 'workflowRun' },
    routeOnly: ['threadId']
  }),
  'workflowRuns.cancel': chat('thread', ['threadId', 'runId', 'reason'], {
    via: 'domain',
    required: ['runId'],
    owned: { runId: 'workflowRun' },
    routeOnly: ['threadId']
  }),
  'workflowRuns.approve': chat(
    'thread',
    ['threadId', 'runId', 'approvalId', 'nodeId', 'instanceKey', 'attempt', 'approved'],
    {
      via: 'domain',
      required: ['runId', 'approvalId', 'nodeId', 'instanceKey', 'attempt', 'approved'],
      owned: { runId: 'workflowRun' },
      routeOnly: ['threadId']
    }
  ),
  'workflowRuns.answer': chat('thread', ['threadId', 'runId', 'nodeId', 'instanceKey', 'data'], {
    via: 'domain',
    required: ['runId', 'nodeId', 'instanceKey', 'data'],
    owned: { runId: 'workflowRun' },
    routeOnly: ['threadId']
  }),
  // Starting a thread from a pull request can send a first message, so it is chat, not only write.
  'pullRequests.startThread': chat('project', [
    'projectId',
    'number',
    'reference',
    'send',
    'message',
    'allowClosed',
    'allowDuplicate'
  ]),

  // ---------------------------------------------------------------- thread writes
  'threads.rename': write('thread', ['threadId', 'name'], { required: ['name'] }),
  'threads.pin': write('thread', ['threadId', 'pinned']),
  'threads.settle': write('thread', ['threadId', 'settled']),
  'threads.delete': write('thread', ['threadId', 'operationId', 'expectedGeneration']),
  'threads.trash': write('thread', ['threadId', 'operationId', 'expectedGeneration']),
  'threads.restore': write('thread', ['threadId', 'operationId', 'expectedGeneration']),
  'threads.regenerateTitle': write('thread', ['threadId']),
  'threads.setWorktreeEnabled': write('thread', ['threadId', 'enabled']),
  'thread.fork': write(
    'thread',
    ['sourceThreadId', 'atRunOrdinal', 'title', 'clientRequestId', 'seedFrom'],
    { threadIds: ['sourceThreadId'] }
  ),
  'thread.mergeBack': write('thread', ['forkThreadId', 'clientRequestId'], {
    threadIds: ['forkThreadId']
  }),
  'actions.undoLatest': write('thread', ['threadId', 'expectedTurnId', 'reviewedDiffSha', GEN]),
  'actions.redo': write('thread', ['threadId', 'conversationBranchId', GEN]),
  'actions.revertCode': write('thread', ['threadId', 'actionId', 'reviewedDiffSha', GEN], {
    required: ['actionId']
  }),
  'actions.activateBranch': write('thread', ['threadId', 'conversationBranchId', GEN], {
    required: ['conversationBranchId']
  }),
  'actions.fork': write(
    'thread',
    ['threadId', 'conversationBranchId', 'actionId', 'name', 'codeMode', GEN],
    {
      required: ['actionId']
    }
  ),
  'actions.pin': write('thread', ['threadId', 'actionId', 'pinned', 'reason', GEN], {
    required: ['actionId', 'pinned']
  }),
  'actions.configureRetention': write('thread', ['threadId', 'policy', 'acknowledgeClock', GEN]),
  'actions.sweepRetention': write('thread', ['threadId', GEN]),
  'workspace.restore': write('thread', ['threadId', 'conversationBranchId', GEN]),
  'operations.abort': write('thread', ['threadId', 'operationId', GEN], {
    required: ['operationId']
  }),
  'operations.recover': write('thread', ['threadId', GEN]),
  // A save from another computer is an action the owner can Undo; it names the thread, never a folder.
  'files.write': write('thread', ['threadId', 'path', 'content', ROUTED_STAGED_KEY], {
    required: ['path', 'content'],
    ...staging(['content'])
  }),
  'publish.start': write(
    'thread',
    ['threadId', 'targetBranch', 'expectedSourceSha', 'expectedTargetSha', GEN, 'operationId'],
    { required: ['targetBranch'] }
  ),
  'git.checkout': write('folder', [...FOLDER, 'operationId', 'dirty', 'branch'], {
    required: ['branch']
  }),
  'git.commit': write('folder', [...FOLDER, 'operationId', 'message', 'amend', 'expectedBranch'], {
    required: ['message']
  }),
  'git.push': write('folder', [...FOLDER, 'operationId', 'expectedBranch']),
  'git.suggestCommitMessage': write('folder', [...FOLDER, 'expectedBranch']),
  'git.stage': write('folder', [...FOLDER, 'all', 'paths']),
  'git.unstage': write('folder', [...FOLDER, 'all', 'paths']),
  'git.discard': write('folder', [...FOLDER, 'paths'], { required: ['paths'] }),
  'git.fetch': write('folder', [...FOLDER, 'operationId']),
  'git.pull': write('folder', [...FOLDER, 'operationId', 'strategy']),
  'git.abortInProgress': write('folder', [...FOLDER, 'kind'], { required: ['kind'] }),
  'git.createBranch': write('folder', [...FOLDER, 'name', 'from', 'checkout'], {
    required: ['name']
  }),
  'git.renameBranch': write('folder', [...FOLDER, 'name', 'newName'], {
    required: ['name', 'newName']
  }),
  'git.deleteBranch': write('folder', [...FOLDER, 'name', 'force'], { required: ['name'] }),
  // Stops a Git action the same connection started; another connection is told it is not running.
  // A Git action on a project's folder is stopped by naming the project; one on a thread's, by the thread.
  'git.cancelOperation': write('folder', [...FOLDER, 'operationId'], {
    required: ['operationId'],
    version: 2,
    since: { projectId: 2 }
  }),
  'git.init': write('project', ['projectId']),
  'pullRequests.create': write(
    'folder',
    [...FOLDER, 'originThreadId', 'expectedBranch', 'title', 'body', 'base', 'draft'],
    { owned: { originThreadId: 'thread' } }
  ),
  'pullRequests.draft': write('folder', [...FOLDER, 'originThreadId', 'expectedBranch', 'base'], {
    owned: { originThreadId: 'thread' }
  }),
  'pullRequests.link': write('thread', ['threadId', 'number'], { required: ['number'] }),
  'pullRequests.unlink': write('thread', ['threadId']),
  'pullRequests.pushTarget': write('thread', ['threadId']),
  'pullRequests.watch': write('thread', ['threadId', 'watch', 'number']),

  // ---------------------------------------------------------------- projects and the computer
  // A new thread records the computer that asked (`startedFrom`), as for a phone.
  'threads.create': write(
    'computer',
    ['name', 'projectId', 'worktreeEnabled', 'startedFromProjectId'],
    {
      via: 'backend',
      required: ['name']
    }
  ),
  'projects.rename': write('project', ['projectId', 'name'], { required: ['name'] }),
  'projects.pin': write('project', ['projectId', 'pinned']),
  'projects.remove': write('project', ['projectId']),
  // The one call that names a path of the owner; the backend refuses what a device may not open.
  'projects.open': write('computer', ['path'], {
    via: 'backend',
    required: ['path'],
    absolutePath: true
  }),
  'projects.match': read('computer', ['roots', 'remotes'], { via: 'backend', required: ['roots'] }),
  'composer.options': read('computer', ['threadId'], { via: 'backend' }),
  'projects.list': read('computer', []),
  'threads.list': read('computer', ['projectId']),
  'threads.search': read('computer', ['query', 'limit'], { required: ['query'] }),
  'threads.inventory': read('computer', ['threadId']),
  'activity.snapshot': read('computer', []),
  'chatReferences.resolve': read('computer', ['reference'], { required: ['reference'] }),
  'providers.snapshots': read('computer', ['scope']),
  'skills.list': read('computer', []),
  'skills.read': read('computer', ['skillId'], { required: ['skillId'] }),
  'github.status': read('computer', []),
  'pullRequests.list': read('project', ['projectId', 'limit', 'force']),
  'pullRequests.resolve': read('project', ['projectId', 'reference'], { required: ['reference'] })
} as Record<string, RoutedRow>)

/** A refusal of the owner, with the code and details the owner's own window would show. */
export interface RoutedRefusal {
  code: string
  message: string
  details?: unknown
}

/**
 * What every routed row answers. A refusal (`thread_not_found`, `queue_conflict`,
 * `permission_mode_above_ceiling`...) is a completed `{ ok: false }`, never `outcome_uncertain`: the
 * caller rethrows it as the same error a local call would have raised. Only a crash after the
 * handler started leaves the outcome unknown.
 */
export type RoutedReply = { ok: true; result: unknown } | { ok: false; error: RoutedRefusal }

export const isRoutedReply = (value: unknown): value is RoutedReply => {
  if (!value || typeof value !== 'object') return false
  const reply = value as { ok?: unknown; error?: unknown }
  if (reply.ok === true) return true
  const error = reply.error as { code?: unknown; message?: unknown } | undefined
  return reply.ok === false && typeof error?.code === 'string' && typeof error.message === 'string'
}

/** An ephemeral read larger than this does not fit one RPC reply: it is held for the caller and fetched in pages. */
export const ROUTED_REPLY_MAX_BYTES = 63 * 1024
/**
 * Raw bytes in one page. A page travels as base64 inside one RPC reply (63 KiB at most), so 48 KiB of
 * raw bytes would not fit; 45 KiB becomes 60 KiB of text.
 */
export const ROUTED_PAGE_BYTES = 45 * 1024
/** How long a paged result waits for the caller to fetch it. */
export const ROUTED_PAGES_TTL_MS = 60_000
/** Results held for one caller at once, and their bytes. A newer one pushes out the oldest. */
export const ROUTED_PAGES_PER_CALLER = 4
export const ROUTED_PAGES_CALLER_BYTES = 32 * 1024 * 1024

/** Staged values: one at most 25 MiB (the blob store's bound), per caller and in total, and how long each is kept. */
export const ROUTED_STAGE_ITEM_BYTES = 25 * 1024 * 1024
export const ROUTED_STAGE_CALLER_BYTES = 64 * 1024 * 1024
export const ROUTED_STAGE_TOTAL_BYTES = 256 * 1024 * 1024
export const ROUTED_STAGE_TTL_MS = 60 * 60 * 1000
/** Values one call may stage. */
export const ROUTED_STAGED_MAX_PER_CALL = 4
export const isStageId = (value: unknown): value is string =>
  typeof value === 'string' && /^stg_[0-9a-f]{32}$/.test(value)

/**
 * Reads whose result can be megabytes, and so are built in several copies before they are paged. A
 * computer may have this many of them under way at once; the next is refused `rate_limited`.
 */
export const ROUTED_LARGE_READS: readonly string[] = [
  'thread.snapshot',
  'thread.messages',
  'thread.messageImage',
  'files.read',
  'files.readAsset',
  'git.diff',
  'review.file',
  'runs.events'
]
export const ROUTED_LARGE_READS_PER_CALLER = 2

/** Newest part of a transcript a snapshot carries, and the most a page of older messages carries. */
export const ROUTED_SNAPSHOT_MESSAGE_BYTES = 16 * 1024 * 1024
export const ROUTED_MESSAGES_PAGE_BYTES = 8 * 1024 * 1024

/**
 * A reply too large for one RPC reply. The owner keeps the whole `RoutedReply` for a minute; the
 * caller fetches `pages` pieces with `routed.page` and checks the hash.
 */
export interface RoutedPaged {
  id: string
  /** Bytes of the whole reply, as JSON. */
  bytes: number
  pages: number
  /** Hex SHA-256 of the whole reply. */
  sha256: string
}
export type RoutedPagedReply = { ok: true; paged: RoutedPaged }
export const isRoutedPagedReply = (value: unknown): value is RoutedPagedReply => {
  if (!value || typeof value !== 'object') return false
  const reply = value as { ok?: unknown; paged?: Partial<RoutedPaged> }
  return (
    reply.ok === true &&
    typeof reply.paged?.id === 'string' &&
    Number.isSafeInteger(reply.paged.bytes) &&
    Number.isSafeInteger(reply.paged.pages) &&
    typeof reply.paged.sha256 === 'string'
  )
}

/** What `routed.page` answers: one page of a paged reply. */
export interface RoutedPage {
  index: number
  /** The page's bytes, base64. */
  data: string
}

/** A durable routed result larger than this is kept in the ledger as its hash only (a retry is "may have happened"). */
export const ROUTED_LEDGER_RESULT_MAX_BYTES = 16 * 1024

/**
 * The lists a local handler returns beside the thing it changed (`threads`, `all`, `projects`) are
 * the owner's own complete lists. A routed write drops them: the caller merges the owner's rows into
 * its lists itself, and the ledger keeps small results.
 */
export const ROUTED_LOCAL_LIST_FIELDS = ['threads', 'all', 'projects'] as const
/**
 * A queue write returns the whole queue beside the item it changed (with any image data). The caller
 * gets the queue from `queue.updated` or `queue.list`, so a routed `queue.*` write drops it too.
 */
export const ROUTED_QUEUE_LIST_FIELD = 'items'

/** The Net method a routed row is registered as. */
export const routedNetMethod = (method: string): string => `routed.${method}`
export const isRoutedNetMethod = (name: string): boolean => name.startsWith('routed.')
export const routedMethodOf = (name: string): string | undefined =>
  isRoutedNetMethod(name) ? name.slice('routed.'.length) : undefined

/** The keys a row has at `version`; a caller sends no key its owner's version does not know. */
export function routedKeysAt(rowOf: RoutedRow, version: number): string[] {
  return rowOf.keys.filter((key) => (rowOf.since?.[key] ?? 1) <= version)
}

/**
 * The Net methods that carry the routed API itself rather than one protocol method: they open a
 * private stream, fetch a page of a large reply, and stage a large value. Each is registered as
 * `routed.<name>` with the same checks as a row, and advertised in `net.info` beside the rows.
 */
export interface RoutedTransportRow {
  capability: Extract<NodeCapability, 'read' | 'chat' | 'write'>
  version: number
  keys: readonly string[]
  required: readonly string[]
}
export const ROUTED_TRANSPORT_METHODS: Readonly<Record<string, RoutedTransportRow>> = Object.freeze(
  {
    /** A stream only the calling computer may read: `thread`, `lists`, `channel` or `terminal`. */
    'stream.open': {
      capability: 'read',
      version: 1,
      keys: ['kind', 'threadId', 'ptyId'],
      required: ['kind']
    },
    /** Lets go of a stream this computer opened and no longer reads, to make room for another. */
    'stream.close': {
      capability: 'read',
      version: 1,
      keys: ['kind', 'threadId', 'ptyId'],
      required: ['kind']
    },
    page: { capability: 'read', version: 1, keys: ['id', 'index'], required: ['id', 'index'] },
    /** Takes a value uploaded as a request artifact and keeps it for the call that names it in `stagedValues`. */
    stage: { capability: 'chat', version: 1, keys: ['input'], required: ['input'] }
  }
)

/** The kinds of private stream a computer can open. */
export const ROUTED_STREAM_KINDS = ['thread', 'lists', 'channel', 'terminal'] as const
export type RoutedStreamKind = (typeof ROUTED_STREAM_KINDS)[number]

/** What `routed.stream.open` answers. */
export interface RoutedStreamOpened {
  descriptor: unknown
  head: { epoch: number; seq: number }
  kind: RoutedStreamKind
  /** The `threadId` every record of the stream carries in its body. */
  subject: string
}

/** `{ [method]: version }`, as `net.info` advertises it. */
export function routedVersions(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [method, definition] of Object.entries(ROUTED_METHODS))
    out[method] = definition.version
  for (const [method, definition] of Object.entries(ROUTED_TRANSPORT_METHODS))
    out[method] = definition.version
  return out
}

export interface RoutedLocalRule {
  /** Exact method names. */
  methods?: readonly string[]
  /** Every method that starts with one of these. */
  prefixes?: readonly string[]
  /** Why the method stays on the computer it is called on. */
  reason: string
}

/**
 * Protocol and domain methods that never route. Each one says why, so a new method has to be
 * classified deliberately: either a row above, or a rule here.
 */
export const ROUTED_LOCAL_METHODS: readonly RoutedLocalRule[] = [
  {
    methods: [
      'health',
      'capabilities',
      'events.subscribe',
      'daemon.shutdown',
      'gui.devtoolsPoll',
      'gui.devtoolsRespond'
    ],
    reason: 'They describe or control the daemon a window is connected to, not a thread.'
  },
  {
    methods: ['threads.purge'],
    reason:
      'Permanent delete cannot be undone, so it stays on the computer that runs the thread; Restore is routed.'
  },
  {
    methods: ['threads.focus'],
    reason:
      'A window asks its own daemon to keep a thread of another computer in view; the router answers it.'
  },
  {
    methods: ['threads.reorder', 'projects.reorder'],
    reason: 'Sidebar order is an overlay each computer keeps for itself.'
  },
  {
    methods: ['threads.configureTrash'],
    reason: 'The trash policy is a setting of the computer it is set on.'
  },
  {
    methods: ['projects.identity', 'projects.trustGitSettings'],
    reason:
      'Repository identity and trust of a folder are about a local folder; other computers match projects through projects.match.'
  },
  {
    methods: ['files.root', 'files.writeDirect'],
    reason:
      'They are the Files panel of a window on the computer itself: a routed call names the thread and gets the daemon search, listing and Undo-able save instead.'
  },
  {
    methods: [
      'runs.effects',
      'runs.credentials',
      'runs.transfers',
      'runs.handoffs',
      'agents.spawn',
      'stats.recordManualEdits'
    ],
    reason: 'Diagnostics or retired methods that no window calls for a thread.'
  },
  {
    methods: ['pty.create', 'pty.write', 'pty.resize', 'pty.kill'],
    reason:
      'Terminals are routed with their own output stream and sequenced input in the change that adds terminals; until then they stay on the computer.'
  },
  {
    methods: ['github.createRepository', 'github.cloneRepository'],
    reason:
      'They use the computer’s own GitHub sign-in or take a raw folder path; they are not thread features.'
  },
  {
    methods: ['skills.refresh', 'skills.openFolderIntent'],
    reason: 'They rescan or open folders on the computer they run on.'
  },
  {
    methods: ['workflowRuns.start', 'workflowRuns.reconcile'],
    reason:
      'A workflow starts from a /workflow command in a routed send, and reconciling an uncertain effect is decided on the computer that ran it.'
  },
  {
    prefixes: ['settings.', 'stats.', 'storage.', 'scheduled.', 'channels.', 'mcp.', 'webTools.'],
    reason: 'Settings and services of the computer, not thread features.'
  },
  {
    prefixes: ['providers.'],
    reason:
      'Providers, accounts and usage belong to the computer that holds the sign-ins; the picker reads providers.snapshots.'
  },
  {
    prefixes: ['net.', 'bridge.', 'profiles.', 'speech.host.'],
    reason: 'Networking, devices, profiles and speech relay are managed on each computer itself.'
  },
  {
    prefixes: ['browser.', 'chatResources.', 'integrations.'],
    reason: 'They need the window of the computer that hosts them.'
  },
  {
    prefixes: ['chats.', 'spaces.', 'bots.'],
    reason: 'Shared chats, spaces and bots are their own Net features with their own routing.'
  },
  {
    prefixes: ['agentDefinitions.', 'workflows.'],
    methods: [
      'skills.archive',
      'skills.create',
      'skills.editor',
      'skills.enable',
      'skills.exportPackage',
      'skills.importPackage',
      'skills.update'
    ],
    reason: 'Definitions and skills are edited on the computer that holds them.'
  }
]

export type RoutedClassification =
  { kind: 'routed'; row: RoutedRow } | { kind: 'local'; reason: string }

/**
 * Every method is either a row (a row wins over a prefix rule) or matches a local rule; anything
 * else is a gap that the table test reports.
 */
export function classifyRoutedMethod(method: string): RoutedClassification | undefined {
  const found = ROUTED_METHODS[method]
  if (found) return { kind: 'routed', row: found }
  for (const rule of ROUTED_LOCAL_METHODS)
    if (
      rule.methods?.includes(method) ||
      rule.prefixes?.some((prefix) => method.startsWith(prefix))
    )
      return { kind: 'local', reason: rule.reason }
  return undefined
}
