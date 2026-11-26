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
  /**
   * A change that is numbered instead of recorded in the ledger (terminal input and resizes). The call carries
   * `seq`, the owner applies each `(caller, terminal, seq)` once, and nothing is kept on disk for it. The row is
   * not durable, so a lost reply is answered by sending the same number again, never by a fresh request.
   */
  sequenced?: true
  /** Only a call that names an absolute `path` of the owner (`projects.open`, a clone's folder, browsing folders) may. */
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
const GIT_READ = ['workspaceGeneration', 'attempt'] as const
const gitReadV2 = { version: 2, since: { workspaceGeneration: 2, attempt: 2 } }
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
 * On a routed send, set by the calling computer's router (never by a window): a window sent it, and whether that window
 * binds a chat's first message (`'binds'`) or is older (`'older'`). The owner holds such a send to the rule for its own
 * windows (`Thread.firstSendPending`). An owner from before it is sent the call without it (`ROUTED_DROPPABLE_KEYS`).
 */
export const ROUTED_SEND_WINDOW_KEY = 'window'

/** Optional behavior an older owner can omit while still providing its original answer. */
export const ROUTED_DROPPABLE_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'orchestrator.send': [ROUTED_SEND_WINDOW_KEY],
  // An owner from before it shows every thread; it never had a way to hide one.
  'threads.create': ['hidden'],
  'git.status': GIT_READ,
  'git.diff': GIT_READ,
  'git.log': GIT_READ,
  'git.branches': GIT_READ,
  'git.diffStats': GIT_READ
})

/**
 * On the seven rows below (and on `threads.archive` from `ROUTED_AGENT_ARCHIVE_SINCE`), set only by the calling computer's
 * daemon for an agent's call:
 * `{ thread, run, title, hops, mode }`, the sending thread and run by their ids there, its title, the count of agent
 * messages in a row this one is, and the mode the sender runs in. The owner handles a marked call as an agent's, never
 * as a person's: run source `mcp`, the narrowest mode, its own limits, an envelope it builds, and an audit row with actor
 * `agent` (`bridge/routed/remoteAgent.ts`). A window never sets it (`ThreadRouter` refuses it), nor does a phone.
 *
 * It is never droppable: a caller whose owner's row predates it is refused (`RoutedClient.unsupportedKey`), so an
 * agent's message is never delivered as a person's. The field names avoid `…Id`, so the id rewriting leaves them alone.
 *
 * Any change to the key's shape or meaning raises the version of all seven rows.
 */
export const ROUTED_AGENT_KEY = 'agent'

/**
 * The rows of a remote subagent's calls that take `agent`, and the version of each that added it: a computer that has them
 * all takes a subagent's calls marked (`takesAgentMark`). `threads.archive` takes it too, apart (`ROUTED_AGENT_ARCHIVE_SINCE`).
 */
export const ROUTED_AGENT_METHODS: Readonly<Record<string, number>> = Object.freeze({
  'threads.create': 2,
  'threads.setModel': 3,
  'threads.setPermissionMode': 4,
  'orchestrator.send': 7,
  'orchestrator.steer': 3,
  'queue.enqueue': 3,
  'orchestrator.abort': 2
})

/**
 * On an agent's `orchestrator.send` (with `agent`), set only by the calling computer's daemon: the minutes of running
 * time the run it starts may use (a remote subagent's `maxMinutes`, issue #685), a whole number of at least 1. The owner
 * counts the time the run works, not the time it waits on a person, stops the run when it is used up, and answers with
 * the same key when it took the limit. A caller sends it only to an owner whose row is at `ROUTED_DEADLINE_SINCE`;
 * an older owner is stopped by the caller after that many minutes instead.
 */
export const ROUTED_DEADLINE_KEY = 'deadlineMinutes'
/** The version of `orchestrator.send` that added `deadlineMinutes`. */
export const ROUTED_DEADLINE_SINCE = 8

/**
 * The version of `threads.archive` that takes `agent`. It is not one of `ROUTED_AGENT_METHODS`: those decide whether a
 * remote subagent's calls are marked at all (`takesAgentMark`), and a computer from before this one still takes every
 * other marked call. A caller checks this version before an agent's archive and never sends one to an older owner.
 */
export const ROUTED_AGENT_ARCHIVE_SINCE = 2

/** What the `agent` key carries. */
export interface RoutedAgentMark {
  /** The sending thread, by its id on the calling computer. */
  thread: string
  /** The sending run, by its id on the calling computer. */
  run: string
  /** The sending thread's title; the owner cleans and cuts it (`ROUTED_AGENT_TITLE_MAX`). */
  title: string
  /** How many agent messages in a row this call is (the sender's own count plus one). The owner takes the larger of it and its own. */
  hops: number
  /** The mode the sender runs in. The owner narrows it further and never widens anything by it. */
  mode: string
}

/**
 * `runs.wait`: the longest one call waits on the owner, and the deadline the caller gives the call. The deadline is above
 * the wait (the owner answers at its end) and below the minute an MCP client waits on a tool call.
 */
export const ROUTED_RUN_WAIT_MAX_MS = 40_000
export const ROUTED_RUN_WAIT_DEADLINE_MS = 50_000

/**
 * What an agent's read of a thread on another computer asks for (`thread.messages` with `index`): the most characters of
 * one message, and the bytes of rows the owner sends for one page. The caller's tool cuts its own response to the same.
 */
export const ROUTED_AGENT_READ = Object.freeze({ textMax: 16_384, pageBytes: 64 * 1024 })

/** The longest sender title an envelope carries. */
export const ROUTED_AGENT_TITLE_MAX = 80
/** The longest message an agent on another computer may send (an agent on the same computer may send 100,000). */
export const ROUTED_AGENT_BODY_MAX = 16_000

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
  'expectedProfileId',
  // The folder the Files panel of a window on the computer itself browses (any folder of that computer).
  'root'
] as const

export const ROUTED_METHODS: Readonly<Record<string, RoutedRow>> = Object.freeze({
  // ---------------------------------------------------------------- thread reads
  'threads.get': read('thread', ['threadId']),
  // A window of the caller opened the thread: its Done clears on the owner, and so in every window. Anyone who may
  // read the thread may see it.
  'threads.markSeen': read('thread', ['threadId']),
  // `transcript: false` leaves out what a computer that reads the thread's stream already has (the
  // messages and the queue), so a snapshot of a long thread is not sent a second time.
  'thread.snapshot': read('thread', ['threadId', 'transcript'], {
    version: 2,
    since: { transcript: 2 }
  }),
  // Older messages of a long thread, a page at a time, newest first from `before` (a message id).
  // Version 3: `index`, `textOffset` and `textMax`, the page an agent's `thread_read` reads on another computer: from
  // the message at `index`, each message's text cut to `textMax` characters (the first one from `textOffset`), so only
  // what the tool returns crosses (`ROUTED_AGENT_READ`).
  'thread.messages': read('thread', ['threadId', 'before', 'after', 'limit', 'index', 'textOffset', 'textMax'], {
    version: 3,
    since: { after: 2, index: 3, textOffset: 3, textMax: 3 }
  }),
  'thread.changesSince': read('thread', ['threadId', 'seq', 'epoch']),
  // The image of one message or queued message, by its place in it (the stream carries only the newest images' data).
  'thread.messageImage': read('thread', ['threadId', 'messageId', 'queueItemId', 'index'], {
    required: ['index']
  }),
  'orchestrator.isTurnActive': read('thread', ['threadId']),
  'orchestrator.contextUsage': read('thread', ['threadId', 'draftInput', 'mode']),
  'orchestrator.pendingQuestions': read('thread', ['threadId']),
  // Whether the owner accepted a send or steer with this request id: a window asks after a steer whose answer was lost.
  'orchestrator.sendAccepted': read('thread', ['threadId', 'clientRequestId'], {
    required: ['clientRequestId']
  }),
  'queue.list': read('thread', ['threadId']),
  'runs.list': read('thread', ['threadId', 'limit']),
  'runs.get': read('thread', ['threadId', 'runId'], {
    required: ['runId'],
    owned: { runId: 'run' }
  }),
  'runs.events': read('thread', ['threadId', 'afterSeq', 'limit']),
  // Waits up to `timeoutMs` (at most `ROUTED_RUN_WAIT_MAX_MS`) for a run of the thread to end or to wait on a person,
  // answered from the owner's run events: `thread_wait` on a thread of another computer (issue #1160). Without `runId`,
  // the run that is active or paused now; a thread with a run that is preparing or a message waiting in its queue is
  // never answered idle.
  'runs.wait': read('thread', ['threadId', 'runId', 'timeoutMs'], { owned: { runId: 'run' } }),
  'activity.get': read('thread', ['threadId']),
  'subagents.list': read('thread', ['threadId']),
  'threads.backgroundWork': read('thread', ['threadId']),
  'agents.list': read('thread', ['threadId']),
  'tasks.list': read('thread', ['threadId']),
  'workspace.getStatus': read('thread', ['threadId', GEN]),
  // The folder an editor on the calling computer opens for the thread: its ready worktree, else its project's
  // folder, resolved here from the thread. The call carries no path, and the reply names this computer's system
  // so the caller can build a Remote-SSH address (`editorFolder.ts`).
  'editor.folder': read('thread', ['threadId']),
  // Asks a person on the computer (named by `node`, which only routes the call) to allow editor connections from the
  // calling computer. It takes nothing and changes no setting there: the switch is turned on by a person on that
  // computer, never by this call (`shared/bridge/editorAsk.ts`). It is not a ledger row; the computer keeps one pending
  // ask per device and the audit row of each ask that reached a person.
  'editor.ask': read('computer', []),
  'threads.approvalRules': read('thread', ['threadId']),
  // The thread's saved approval requests and their answers, which its transcript shows where they were asked.
  'threads.approvalRequests': read('thread', ['threadId']),
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
  'git.status': read('folder', [...FOLDER, ...GIT_READ], gitReadV2),
  // How far the branch and its upstream are apart on the remote now, read on the computer that has the folder.
  'git.checkUpstream': read('folder', [...FOLDER]),
  // HEAD → working tree as hunks, with what the next commit takes. A large answer is paged.
  'git.changes': read('folder', [...FOLDER, 'paths']),
  // The reverts of the folder its copies still let the person restore.
  'git.revertedList': read('folder', [...FOLDER]),
  'git.diff': read('folder', [...FOLDER, 'path', 'staged', ...GIT_READ], { ...gitReadV2, required: ['path'] }),
  'git.log': read('folder', [...FOLDER, 'limit', ...GIT_READ], gitReadV2),
  'git.branches': read('folder', [...FOLDER, ...GIT_READ], gitReadV2),
  'git.diffStats': read('folder', [...FOLDER, ...GIT_READ], gitReadV2),
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
  'pullRequests.mergeMethod': read('folder', [...FOLDER]),
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
  // Terminals: all of them are also behind the device's terminal switch on the owner. Output is not here: it travels
  // on the terminal's own stream (`routed.stream.open { kind: 'terminal' }`), one record per chunk.
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
      ROUTED_STAGED_KEY,
      'refuseWhilePaused',
      'conversationBranchId',
      'expect',
      ROUTED_SEND_WINDOW_KEY,
      ROUTED_AGENT_KEY,
      ROUTED_DEADLINE_KEY
    ],
    // Version 3: `refuseWhilePaused`, a parent's follow-up to a subagent, which a thread paused by a usage limit refuses.
    // Version 4: `conversationBranchId`, the branch an edited prompt must land on.
    // Version 5: `expect`, the model, mode and settings revision the sender saw; the owner runs nothing on other ones.
    // Version 6: `window`, set by the calling computer: a window sent this (`ROUTED_SEND_WINDOW_KEY`).
    // Version 7: `agent`, an agent's message (`ROUTED_AGENT_KEY`).
    // Version 8: `deadlineMinutes`, the running time an agent's task may use there (`ROUTED_DEADLINE_KEY`).
    { required: ['content'], ...staging(['content', 'images']), version: 8, since: { [ROUTED_STAGED_KEY]: 2, refuseWhilePaused: 3, conversationBranchId: 4, expect: 5, [ROUTED_SEND_WINDOW_KEY]: 6, [ROUTED_AGENT_KEY]: 7, [ROUTED_DEADLINE_KEY]: ROUTED_DEADLINE_SINCE } }
  ),
  // Version 3 (both): `agent`, an agent's steer or Stop (`ROUTED_AGENT_KEY`).
  'orchestrator.steer': chat(
    'thread',
    ['threadId', 'text', 'runId', 'clientRequestId', ROUTED_STAGED_KEY, ROUTED_AGENT_KEY],
    {
      required: ['text'],
      owned: { runId: 'run' },
      ...staging(['text']),
      version: 3,
      since: { [ROUTED_STAGED_KEY]: 2, [ROUTED_AGENT_KEY]: 3 }
    }
  ),
  'orchestrator.abort': chat('thread', ['threadId', 'clearQueue', 'runId', 'clientRequestId', ROUTED_AGENT_KEY], {
    owned: { runId: 'run' },
    version: 2,
    since: { [ROUTED_AGENT_KEY]: 2 }
  }),
  // Send now on a held steer: the run and hold the click was shown for, and the held queue items.
  'orchestrator.steerNow': chat('thread', ['threadId', 'runId', 'holdGeneration', 'itemIds', 'clientRequestId'], {
    required: ['runId', 'holdGeneration', 'itemIds'],
    owned: { runId: 'run' }
  }),
  'orchestrator.retry': chat('thread', ['threadId']),
  // Retry on a thread whose worktree could not be set up: sends the message it kept again.
  'orchestrator.retrySetup': chat('thread', ['threadId']),
  'threads.clearContext': chat('thread', ['threadId']),
  'threads.compact': chat('thread', ['threadId', 'focus']),
  'threads.stopCompaction': chat('thread', ['threadId']),
  // Version 2: `attachments`, images sent with the answers by question id, which may be staged.
  'orchestrator.answerQuestions': chat('thread', ['threadId', 'requestId', 'answers', 'attachments', ROUTED_STAGED_KEY], {
    required: ['requestId', 'answers'],
    owned: { requestId: 'question' },
    ...staging(['attachments']),
    since: { attachments: 2, [ROUTED_STAGED_KEY]: 2 }
  }),
  'orchestrator.dismissQuestions': chat('thread', ['threadId', 'requestId'], {
    required: ['requestId'],
    owned: { requestId: 'question' }
  }),
  // Version 3: `agent`, a message an agent queues (`ROUTED_AGENT_KEY`).
  'queue.enqueue': chat(
    'thread',
    ['threadId', 'content', 'mode', 'images', 'requestId', ROUTED_STAGED_KEY, ROUTED_AGENT_KEY],
    { required: ['content'], ...staging(['content', 'images']), version: 3, since: { [ROUTED_STAGED_KEY]: 2, [ROUTED_AGENT_KEY]: 3 } }
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
  // `ifRevision` (version 2): applied only while the thread's settings revision is that one. An owner from before it is
  // never sent the call without it: the caller refuses it as outdated (`RoutedClient.unsupportedKey`).
  // Version 3: `agent` (`ROUTED_AGENT_KEY`).
  'threads.setModel': chat('thread', ['threadId', 'model', 'ifRevision', ROUTED_AGENT_KEY], { version: 3, since: { ifRevision: 2, [ROUTED_AGENT_KEY]: 3 } }),
  // Version 2 accepts `mode: 'auto'` (issue #419); a caller sends an older owner `accept_edits` instead
  // (`routedParamsForOwner`).
  // Version 4: `agent` (`ROUTED_AGENT_KEY`); a marked call never sets a mode above the one the thread was held to.
  'threads.setPermissionMode': chat('thread', ['threadId', 'mode', 'ifRevision', ROUTED_AGENT_KEY], { required: ['mode'], version: 4, since: { ifRevision: 3, [ROUTED_AGENT_KEY]: 4 } }),
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
  'threads.stopBackground': chat('thread', ['threadId', 'id'], { required: ['id'] }),
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
  // Version 2: `allowWorktreeConfig`. A version 1 caller never sends it, so a repository with the setting off is refused.
  'pullRequests.startThread': chat(
    'project',
    ['projectId', 'number', 'reference', 'send', 'message', 'allowClosed', 'allowDuplicate', 'allowWorktreeConfig'],
    { version: 2, since: { allowWorktreeConfig: 2 } }
  ),

  // ---------------------------------------------------------------- thread writes
  'threads.rename': write('thread', ['threadId', 'name'], { required: ['name'] }),
  'threads.pin': write('thread', ['threadId', 'pinned']),
  // Version 2: `agent`, an agent's archive (`ROUTED_AGENT_ARCHIVE_SINCE`): a remote subagent's thread when its stand-in is
  // archived, and `thread_archive` of a thread there. An owner from before it is never sent one (the caller checks).
  'threads.archive': write('thread', ['threadId', 'archived', ROUTED_AGENT_KEY], { version: 2, since: { [ROUTED_AGENT_KEY]: 2 } }),
  // Legacy: `threads.archive` under its old name. An owner keeps it for a caller that runs an older Mousse; a caller
  // sends it only to an owner that does not advertise `threads.archive` (`ROUTED_RENAMED_METHODS`).
  'threads.settle': write('thread', ['threadId', 'settled']),
  'threads.delete': write('thread', ['threadId', 'operationId', 'expectedGeneration']),
  'threads.regenerateTitle': write('thread', ['threadId']),
  'threads.setWorktreeEnabled': write('thread', ['threadId', 'enabled']),
  // When the thread archives itself, or null for never; the owner's daemon archives it.
  'threads.setExpiry': write('thread', ['threadId', 'expiresAt', 'stopsRun']),
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
    ['threadId', 'conversationBranchId', 'actionId', 'name', 'codeMode', 'at', 'activate', GEN],
    {
      required: ['actionId'],
      version: 2,
      since: { at: 2, activate: 2 }
    }
  ),
  'actions.pin': write('thread', ['threadId', 'actionId', 'pinned', 'reason', GEN], {
    required: ['actionId', 'pinned']
  }),
  'actions.configureRetention': write('thread', ['threadId', 'policy', 'acknowledgeClock', GEN]),
  'actions.sweepRetention': write('thread', ['threadId', GEN]),
  'workspace.restore': write('thread', ['threadId', 'conversationBranchId', GEN]),
  // Discard on a conflict in the thread worktree; it keeps a copy and needs `confirmed`.
  'workspace.discardPendingChanges': write('thread', ['threadId', 'confirmed'], {
    required: ['confirmed']
  }),
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
  // `selection` (version 2): an owner from before it refuses the key (`computerOutdated`), so a chosen commit never
  // becomes a commit of everything there.
  'git.commit': write('folder', [...FOLDER, 'operationId', 'message', 'amend', 'expectedBranch', 'selection'], {
    required: ['message'],
    version: 2,
    since: { selection: 2 }
  }),
  'git.push': write('folder', [...FOLDER, 'operationId', 'expectedBranch']),
  'git.suggestCommitMessage': write('folder', [...FOLDER, 'expectedBranch', 'selection'], { version: 2, since: { selection: 2 } }),
  'git.include': write('folder', [...FOLDER, 'path', 'version', 'include', 'hunks', 'lines', 'all'], { required: ['include'] }),
  'git.undoLastCommit': write('folder', [...FOLDER, 'expectedHead'], { required: ['expectedHead'] }),
  // Small answers: the tab reads the file again with `git.changes`; a restore that finds changes names blob ids, never contents.
  'git.revert': write('folder', [...FOLDER, 'path', 'version', 'hunks', 'lines'], { required: ['path', 'version'] }),
  'git.restoreReverted': write('folder', [...FOLDER, 'revertId'], { required: ['revertId'] }),
  'git.stage': write('folder', [...FOLDER, 'all', 'paths']),
  'git.unstage': write('folder', [...FOLDER, 'all', 'paths']),
  'git.discard': write('folder', [...FOLDER, 'paths'], { required: ['paths'] }),
  'git.fetch': write('folder', [...FOLDER, 'operationId']),
  'git.pull': write('folder', [...FOLDER, 'operationId', 'strategy']),
  'git.abortInProgress': write('folder', [...FOLDER, 'kind'], { required: ['kind'] }),
  'git.continueInProgress': write('folder', [...FOLDER, 'kind', 'operationId'], { required: ['kind'] }),
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
  // `method` is the one the person confirmed; an owner from before version 2 picks its own.
  'pullRequests.merge': write('folder', [...FOLDER, 'number', 'headSha', 'method'], { required: ['number'], version: 2, since: { method: 2 } }),
  'pullRequests.close': write('folder', [...FOLDER, 'number'], { required: ['number'] }),
  'pullRequests.link': write('thread', ['threadId', 'number'], { required: ['number'] }),
  'pullRequests.unlink': write('thread', ['threadId']),
  'pullRequests.pushTarget': write('thread', ['threadId']),
  'pullRequests.watch': write('thread', ['threadId', 'watch', 'number']),

  // ---------------------------------------------------------------- terminals
  // A terminal starts in the thread's own folder (or the thread's terminal workspace when it has none), in the
  // owner's default shell and environment: the caller names no folder, shell, arguments or variables.
  'pty.create': write('thread', ['threadId', 'agentId'], {
    terminal: true,
    required: ['agentId']
  }),
  'pty.kill': write('thread', ['threadId', 'ptyId'], {
    terminal: true,
    required: ['ptyId'],
    owned: { ptyId: 'pty' }
  }),
  // Input and resizes are numbered and kept out of the ledger: a resend of the same number is not applied twice.
  'pty.write': write('thread', ['threadId', 'ptyId', 'seq', 'data'], {
    terminal: true,
    sequenced: true,
    durable: false,
    required: ['ptyId', 'seq', 'data'],
    owned: { ptyId: 'pty' }
  }),
  'pty.resize': write('thread', ['threadId', 'ptyId', 'seq', 'cols', 'rows'], {
    terminal: true,
    sequenced: true,
    durable: false,
    required: ['ptyId', 'seq'],
    owned: { ptyId: 'pty' }
  }),

  // ---------------------------------------------------------------- projects and the computer
  // A new thread records the computer that asked (`startedFrom`), as for a phone.
  // Version 2: `agent` (`ROUTED_AGENT_KEY`), accepted from another computer's daemon only, never from a phone.
  // Version 3: `hidden`, read only with `agent`: a thread an agent starts is out of the sidebar unless it is false.
  'threads.create': write(
    'computer',
    ['name', 'projectId', 'worktreeEnabled', 'startedFromProjectId', ROUTED_AGENT_KEY, 'hidden'],
    {
      via: 'backend',
      required: ['name'],
      version: 3,
      since: { [ROUTED_AGENT_KEY]: 2, hidden: 3 }
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

  // ---------------------------------------------------------------- providers of the computer
  // Settings → Providers of another computer: its entries, switches, models, installs and sign-ins, kept and run
  // there. A key or a pasted sign-in answer travels in this call only and is saved on the owner; the caller keeps
  // nothing of it. The caller's page reads with `providers.events` what happened to the operations it started
  // (progress, sign-in prompts) and whether the entries changed: answered from memory, never written to disk on either
  // computer. A provider's own settings file and moving an entry stay with a window of the computer itself. Checking an
  // entry again keeps nothing in the ledger but starts its agent, so it needs the work grant (`METHOD_ACCESS`); what
  // picks the program an agent runs, or removes its install, needs terminal access too (`choosesProgram`).
  'providers.events': read('computer', ['after']),
  'providers.catalog.addOptions': read('computer', []),
  'providers.registry.search': read('computer', ['query']),
  'providers.instances.recheck': read('computer', ['instanceId'], { required: ['instanceId'] }),
  'providers.instances.add': write('computer', ['driver', 'config', 'slug', 'signIn'], { required: ['driver'] }),
  'providers.instances.setSecret': write('computer', ['instanceId', 'value'], { required: ['instanceId', 'value'] }),
  'providers.instances.remove': write('computer', ['instanceId'], { required: ['instanceId'] }),
  'providers.instances.configure': write('computer', ['instanceId', 'patch'], { required: ['instanceId', 'patch'] }),
  'providers.instances.setEnabled': write('computer', ['instanceId', 'enabled'], { required: ['instanceId', 'enabled'] }),
  'providers.instances.install': write('computer', ['instanceId'], { required: ['instanceId'] }),
  'providers.instances.removeInstall': write('computer', ['instanceId', 'force'], { required: ['instanceId'] }),
  'providers.instances.cancelInstall': write('computer', ['operationId'], { required: ['operationId'] }),
  'providers.instances.update': write('computer', ['instanceId'], { required: ['instanceId'] }),
  'providers.instances.signIn': write('computer', ['instanceId', 'method'], { required: ['instanceId'] }),
  'providers.instances.respondSignIn': write('computer', ['operationId', 'response'], { required: ['operationId', 'response'] }),
  'providers.instances.signOut': write('computer', ['instanceId'], { required: ['instanceId'] }),
  'providers.instances.allowKnownProblem': write('computer', ['instanceId', 'version'], { required: ['instanceId', 'version'] }),
  'providers.instances.refreshModels': write('computer', ['instanceId'], { required: ['instanceId'] }),
  'providers.instances.refreshAllModels': write('computer', []),
  'providers.instances.setModelPrefs': write('computer', ['instanceId', 'patch'], { required: ['instanceId', 'patch'] }),
  'skills.list': read('computer', []),
  'skills.read': read('computer', ['skillId'], { required: ['skillId'] }),
  'github.status': read('computer', []),
  // Settings → Source control of the owner, and New project's Clone on it: its GitHub account, the account's
  // repositories, Connect (install GitHub CLI when it is missing and sign it in; the owner also needs terminal access
  // for the caller, `OwnerRoutes`) with the one-time code relayed by `sourceControl.status`, and a clone into a folder
  // there that becomes a project there. The owner checks the folder as it checks `projects.open`.
  'sourceControl.status': read('computer', ['refresh'], { via: 'domain' }),
  'sourceControl.repositories': read('computer', ['provider', 'refresh'], { via: 'domain', required: ['provider'] }),
  'sourceControl.connect': write('computer', ['provider'], { via: 'domain', required: ['provider'] }),
  'sourceControl.cancel': write('computer', ['provider'], { via: 'domain', required: ['provider'] }),
  'sourceControl.clone': write('computer', ['provider', 'repository', 'path', 'branch'], {
    via: 'domain',
    required: ['provider', 'repository', 'path'],
    absolutePath: true
  }),
  // The folders of the owner by name, to pick where a clone goes by browsing: never files, hidden folders, the Mousse
  // data folder or folders that hold credentials (`folderBrowse.ts`).
  'folders.browse': read('computer', ['path'], { via: 'domain', absolutePath: true }),
  'pullRequests.list': read('project', ['projectId', 'limit', 'force']),
  'pullRequests.resolve': read('project', ['projectId', 'reference'], { required: ['reference'] }),

  // ---------------------------------------------------------------- automations
  // An automation is stored and run by the one computer that owns it; another computer lists, adds and edits it
  // there, never in its own store. The list answers only automations another computer may see: no bot's, and none
  // bound to (or added by) a private thread. Adding or editing one starts turns on the owner, so it is chat, like a
  // send; the owner holds the job's ceiling to the limit it set for the calling computer.
  'automations.list': read('computer', [], { via: 'domain' }),
  'scheduled.create': chat('computer', ['input'], { required: ['input'] }),
  'scheduled.update': chat('computer', ['id', 'patch'], { required: ['id', 'patch'] }),
  'scheduled.run': chat('computer', ['id'], { required: ['id'] }),
  'scheduled.pause': write('computer', ['id', 'reason', 'until'], { required: ['id'] }),
  'scheduled.resume': write('computer', ['id'], { required: ['id'] }),
  'scheduled.delete': write('computer', ['id'], { required: ['id'] })
} as Record<string, RoutedRow>)

/** The routed rows that name one automation (a scheduled job) of the owner by `id`. */
export const ROUTED_JOB_METHODS: readonly string[] = [
  'scheduled.update',
  'scheduled.run',
  'scheduled.pause',
  'scheduled.resume',
  'scheduled.delete'
]

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
  'thread.changesSince',
  'files.read',
  'files.readAsset',
  'git.diff',
  'git.changes',
  'review.file',
  'runs.events'
]
export const ROUTED_LARGE_READS_PER_CALLER = 2

/**
 * What a computer says when this device's terminals are off there. A window cannot read the reason of an
 * error that crossed the process boundary, only its text, so the terminal panel recognises this one to say
 * how to turn terminals on.
 */
export const terminalOffMessage = (computer: string): string =>
  `Terminals from this device are off on ${computer}.`
export function parseTerminalOffMessage(message: string): { computer: string } | undefined {
  const found = /Terminals from this device are off on (.+)\.\s*$/m.exec(message)
  return found ? { computer: found[1] } : undefined
}

/** Terminals one computer may have open on another at once (the same number as its terminal streams). */
export const ROUTED_TERMINALS_PER_NODE = 4
/** The most one numbered input call carries; the caller cuts a longer paste into calls of this size, in order. */
export const ROUTED_PTY_INPUT_MAX_CHARS = 16 * 1024
/**
 * The most one paste into a terminal may carry, in bytes: what a device's input budget holds at once. A longer one is
 * refused whole, before any of it is sent, instead of being cut where the budget runs out.
 */
export const ROUTED_PTY_PASTE_MAX_BYTES = 512 * 1024
/** The terminal sizes a call may ask for (the same bounds a window's `pty.resize` has). */
export const ROUTED_PTY_MAX_COLS = 512
export const ROUTED_PTY_MAX_ROWS = 256

/** Newest part of a transcript a snapshot carries, and the most a page of older messages carries. */
export const ROUTED_SNAPSHOT_MESSAGE_BYTES = 16 * 1024 * 1024
export const ROUTED_MESSAGES_PAGE_BYTES = 8 * 1024 * 1024
/**
 * Newest part of a transcript a phone's snapshot carries. A phone holds 8-10 times a snapshot's size while it
 * assembles it, and keeps a saved copy of up to 8 MiB; `earlier` counts the older messages left on the computer.
 */
export const PHONE_SNAPSHOT_MESSAGE_BYTES = 8 * 1024 * 1024
/**
 * Most a phone's page of older messages (`thread.messages`) carries, images included; the newest message before the
 * cursor always comes, whatever its size. A page larger than one RPC reply comes as a paged reply (`reply.page`).
 */
export const PHONE_MESSAGES_PAGE_BYTES = 512 * 1024

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
export const ROUTED_LOCAL_LIST_FIELDS = ['threads', 'all', 'projects', 'jobs'] as const
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

/**
 * Rows that were renamed: by new name, the old row and the call as the old row takes it. A caller sends the old row to
 * an owner that advertises it but not the new one (an owner that runs an older Mousse); the owner keeps the old row
 * for callers that run an older Mousse.
 */
export const ROUTED_RENAMED_METHODS: Readonly<
  Record<string, { legacy: string; params: (params: Record<string, unknown>) => Record<string, unknown> }>
> = Object.freeze({
  // Archived threads were called settled.
  'threads.archive': {
    legacy: 'threads.settle',
    params: ({ archived, ...rest }: Record<string, unknown>) => ({ ...rest, settled: archived })
  }
})

/**
 * The params of a call as an owner at `version` of the row takes them, for a row whose newer version
 * accepts a value an older one rejects. An owner from before the Auto permission mode (`threads.setPermissionMode`
 * below version 2) is sent Auto-accept edits for Auto: the mode Auto runs as on an agent without an auto mode,
 * so the thread never gets more than its person chose. Other calls are unchanged.
 */
export function routedParamsForOwner(method: string, version: number, params: Record<string, unknown>): Record<string, unknown> {
  if (method === 'threads.setPermissionMode' && version < 2 && params.mode === 'auto') return { ...params, mode: 'accept_edits' }
  const row = ROUTED_METHODS[method]
  const dropped = (ROUTED_DROPPABLE_KEYS[method] ?? []).filter((key) => key in params && (row?.since?.[key] ?? 1) > version)
  if (dropped.length) {
    const kept = { ...params }
    for (const key of dropped) delete kept[key]
    return kept
  }
  return params
}

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
    methods: ['pullRequests.view'],
    reason: 'Reads a GitHub pull request linked in a chat message through this computer’s GitHub CLI without binding to a remote project folder.'
  },
  {
    methods: ['git.heads'],
    reason: 'The sidebar batches IDs owned by its local profile. Remote workspaces are looked up individually on their owners.'
  },
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
    methods: ['threads.goal'],
    reason: 'A goal is set and changed from the desktop composer of the computer that runs the thread (issue #1207).'
  },
  {
    methods: ['threads.setHidden'],
    reason: "Show in sidebar is offered on the computer that runs a hidden thread: in its bot's chat, or in the top bar of a thread an agent started there (issue #1217)."
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
    methods: ['projects.identity', 'projects.trustGitSettings'],
    reason:
      'Repository identity and trust of a folder are about a local folder; other computers match projects through projects.match.'
  },
  {
    methods: ['projects.icon', 'projects.setIcon'],
    reason: 'A project icon is an image file on the computer itself; a project of another computer shows the folder glyph.'
  },
  {
    methods: ['projects.setPath'],
    reason: "A project's folder is chosen in the folder picker of the computer itself; another computer opens a folder there with projects.open."
  },
  {
    methods: ['appearance.wallpaperImport', 'appearance.wallpaperImportBytes', 'appearance.wallpaperRead', 'appearance.wallpaperSaveCopy'],
    reason: 'A theme wallpaper is an image kept in the profile of the computer itself; a window of another computer shows the theme without it.'
  },
  {
    methods: ['files.root', 'files.writeDirect'],
    reason:
      'They are the Files panel of a window on the computer itself: a routed call names the thread and gets the daemon search, listing and Undo-able save instead.'
  },
  {
    methods: ['review.turnFile'],
    reason:
      'A file a thread’s agent wrote outside its folder is read from a window on that computer only; another computer reviews the thread’s own changes.'
  },
  {
    methods: ['files.drives'],
    reason: 'The drives of a computer are browsed from a window on that computer only; another computer sees the thread’s folder.'
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
    methods: ['github.createRepository', 'github.cloneRepository'],
    reason:
      'They use the computer’s own GitHub sign-in or take a raw folder path; they are not thread features.'
  },
  {
    methods: ['sourceControl.signOut'],
    reason: 'Signing a computer out of GitHub is done from Settings → Source control on that computer.'
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
    methods: ['usage.history'],
    prefixes: ['settings.', 'stats.', 'storage.', 'scheduled.', 'mcp.', 'webTools.'],
    reason: 'Settings and services of the computer, not thread features.'
  },
  {
    prefixes: ['computerUse.'],
    reason: 'Cua Driver is found and installed on the computer itself; only a person at a window of that computer installs software.'
  },
  {
    methods: ['automations.asks.answer', 'automations.keep'],
    reason: 'An agent’s ask and Keep are answered on the computer that holds them.'
  },
  {
    methods: ['secrets.requests.list', 'secrets.requests.answer', 'secrets.requests.useSaved', 'secrets.requests.decline', 'secrets.list', 'secrets.delete', 'secrets.keepPasted'],
    reason: 'A secret is typed and kept on the computer that runs the thread; it never travels to another computer.'
  },
  {
    methods: ['bugReports.draft','bugReports.file', 'bugReports.list', 'bugReports.revoke', 'bugReports.pending', 'bugReports.answer'],
    reason: 'A bug report is drafted, filed and kept on the computer whose window shows it, with that computer’s logs and GitHub login.'
  },
  {
    methods: ['automations.request.resend', 'automations.keys.list', 'automations.keys.set'],
    reason: 'A request’s stored payload and the saved keys stay on the computer that runs the automation.'
  },
  {
    methods: ['automations.drafts.turnOn', 'automations.drafts.discard', 'automations.drafts.create', 'automations.drafts.answered', 'automations.drafts.setWho', 'automations.drafts.nextWho', 'automations.manager.thread', 'automations.manager.turn'],
    reason: 'Drafts and the Automation manager’s thread belong to the computer whose manager wrote them; Turn on happens there.'
  },
  {
    methods: ['automations.inbox.list', 'automations.inbox.counts', 'automations.inbox.resolve', 'automations.inbox.undo', 'automations.inbox.calibrate', 'automations.tuning.remove'],
    reason: 'The inbox (runs, Needs you and Tuning notes) is kept by the computer that runs the automations, and read and changed there.'
  },
  {
    methods: ['providers.instances.vendorSettings', 'providers.instances.setVendorSetting', 'providers.instances.move'],
    reason:
      "A provider's own settings file is read and changed from a window of its computer only, and so is moving an entry, which can copy a saved key."
  },
  {
    prefixes: ['providers.'],
    reason:
      'Usage, limits and speech belong to the computer that holds the sign-ins; Settings → Providers of another computer uses the providers.instances rows.'
  },
  {
    prefixes: ['net.', 'netEngine.', 'bridge.', 'profiles.', 'speech.host.'],
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
