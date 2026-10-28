/**
 * What another of the user's computers did on this one, as the Devices screen shows it.
 *
 * The owner's audit (`bridge_audit`) keeps one row per change a device made here, and the totals of
 * what it read. This file is the shape of what the Devices screen asks for, and the words it uses.
 * It never carries a path of this computer: a folder a device asked to open is kept as a hash in the
 * audit, and shown here only as "a folder".
 */
import type { ApprovalRuleInfo } from '../types'
import type { NodeId } from '../net/ids'

/**
 * Local methods of this computer's windows. They read this computer's own records (and let a person here answer an
 * ask for editor connections) and are never routed.
 */
export const BRIDGE_ACTIVITY_METHODS = [
  'bridge.activity',
  'bridge.clearDeviceRules',
  'bridge.messageSenders',
  'bridge.editorAsks',
  'bridge.editorAsk.answer'
] as const
export type BridgeActivityMethod = (typeof BRIDGE_ACTIVITY_METHODS)[number]

/** How far back the counts in the one-line summary reach. */
export const DEVICE_ACTIVITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/** Rows of the list under the summary. */
export const DEVICE_ACTIVITY_ROWS = 40

/** One call a device made here, with the names of the thread and project it was about. */
export interface DeviceActivityEntry {
  at: number
  /** The protocol method (`files.write`), or a notice row (`thread.first_use`, `pty.first_open`, `project.first_open`, `pty.close`). */
  method: string
  kind: 'change' | 'refused'
  /** `ok`, `uncertain`, the code a refusal gave, or for a closed terminal how it ended and how much went through. */
  outcome: string
  /** A thread of this computer; `name` is null when it is gone since. Opens the thread's transcript. */
  thread?: { id: string; name: string | null }
  /** The project the call was about, by name. A folder that was refused is never named. */
  project?: { name: string | null }
}

export interface DeviceActivityCount {
  method: string
  count: number
}

export interface DeviceReadHour {
  /** Whole hours since 1970. */
  hour: number
  calls: number
  bytes: number
}

/** A standing "Always for this thread" rule a person on the device made, with the thread it applies to. */
export interface DeviceRuleView {
  threadId: string
  threadName: string | null
  rule: ApprovalRuleInfo
}

export interface DeviceActivity {
  node: NodeId
  /** The counts cover changes since this time. */
  since: number
  /** Changes that went through, per method. */
  counts: DeviceActivityCount[]
  /** Changes that may have happened (the daemon stopped in the middle of them). */
  uncertain: number
  /** Calls this computer refused since `since`. */
  refused: number
  /** Newest first. */
  entries: DeviceActivityEntry[]
  /** What it read, an hour at a time, newest first, and the totals of those hours. */
  reads: { calls: number; bytes: number; hours: DeviceReadHour[] }
  rules: DeviceRuleView[]
}

export interface BridgeActivityParams {
  'bridge.activity': { node: NodeId }
  /** One rule (`threadId` and `ruleId`), or every rule the device made. */
  'bridge.clearDeviceRules': { node: NodeId; threadId?: string; ruleId?: string }
  'bridge.messageSenders': { threadId: string }
  /** The asks for editor connections that wait for a person on this computer. */
  'bridge.editorAsks': Record<string, never>
  /** Allow turns "Editor connections from this device" on here; Not now records a refusal. */
  'bridge.editorAsk.answer': { node: NodeId; allow: boolean }
}

export interface DeviceRulesCleared {
  removed: number
  rules: DeviceRuleView[]
}

/** The computers that sent turns in one thread of this computer, by the run each turn started. */
export interface MessageSenders {
  /** Run id to the computer whose person sent it. The messages of a turn carry the run id as `turnId`. */
  runs: Record<string, { node: NodeId; name: string }>
}

// ---------------------------------------------------------------- words

interface Phrase {
  /** The one-line summary: "started 3 turns". */
  summary(count: number): string
  /** One row of the list: "Started a turn". */
  row: string
}

const plural = (count: number, one: string, many: string): string =>
  count === 1 ? one : many.replace('{n}', String(count))

const phrase = (row: string, one: string, many: string): Phrase => ({
  row,
  summary: (count) => plural(count, one, many)
})

const TURN: Phrase = phrase('Started a turn', 'started a turn', 'started {n} turns')
const STEER: Phrase = phrase('Steered a turn', 'steered a turn', 'steered {n} turns')
const STOP: Phrase = phrase('Stopped a turn', 'stopped a turn', 'stopped {n} turns')
const RETRY: Phrase = phrase('Retried a turn', 'retried a turn', 'retried {n} turns')
const QUEUED: Phrase = phrase('Queued a message', 'queued a message', 'queued {n} messages')
const QUEUE_EDIT: Phrase = phrase('Changed the message queue', 'changed the message queue', 'changed the message queue {n} times')
const ANSWER: Phrase = phrase('Answered an approval or question', 'answered an approval or question', 'answered {n} approvals or questions')
const DISMISS: Phrase = phrase('Dismissed an approval or question', 'dismissed an approval or question', 'dismissed {n} approvals or questions')
const MODEL: Phrase = phrase('Changed the model', 'changed the model', 'changed the model {n} times')
const MODE: Phrase = phrase('Changed the permission mode', 'changed the permission mode', 'changed the permission mode {n} times')
const RULES: Phrase = phrase('Cleared "Always" rules', 'cleared "Always" rules', 'cleared "Always" rules {n} times')
const PAUSE: Phrase = phrase('Resumed or cancelled a paused turn', 'resumed or cancelled a paused turn', 'resumed or cancelled {n} paused turns')
const AGENTS: Phrase = phrase('Stopped subagents', 'stopped subagents', 'stopped subagents {n} times')
const TASKS: Phrase = phrase('Changed a task', 'changed a task', 'changed {n} tasks')
const APPLET: Phrase = phrase('Saved an applet', 'saved an applet', 'saved {n} applets')
const WORKFLOW: Phrase = phrase('Worked on a workflow run', 'worked on a workflow run', 'worked on workflow runs {n} times')
const RENAME: Phrase = phrase('Renamed a thread', 'renamed a thread', 'renamed {n} threads')
const ORGANIZE: Phrase = phrase('Pinned or settled a thread', 'pinned or settled a thread', 'pinned or settled {n} threads')
const DELETE: Phrase = phrase('Moved a thread to Recently deleted', 'moved a thread to Recently deleted', 'moved {n} threads to Recently deleted')
const RESTORE: Phrase = phrase('Restored a thread', 'restored a thread', 'restored {n} threads')
const THREAD_SETTING: Phrase = phrase('Changed a thread setting', 'changed a thread setting', 'changed thread settings {n} times')
const FORK: Phrase = phrase('Forked a thread', 'forked a thread', 'forked {n} threads')
const MERGE_BACK: Phrase = phrase('Merged a thread back', 'merged a thread back', 'merged {n} threads back')
const UNDO: Phrase = phrase('Undid a turn', 'undid a turn', 'undid {n} turns')
const REDO: Phrase = phrase('Redid a turn', 'redid a turn', 'redid {n} turns')
const REVERT: Phrase = phrase('Reverted code', 'reverted code', 'reverted code {n} times')
const HISTORY: Phrase = phrase('Changed the thread’s history', 'changed a thread’s history', 'changed a thread’s history {n} times')
const WORKSPACE: Phrase = phrase('Restored a workspace', 'restored a workspace', 'restored a workspace {n} times')
const OPERATION: Phrase = phrase('Handled a Git operation in progress', 'handled a Git operation in progress', 'handled Git operations in progress {n} times')
const SAVE: Phrase = phrase('Saved a file', 'saved a file', 'saved {n} files')
const PUBLISH: Phrase = phrase('Published a thread’s changes', 'published a thread’s changes', 'published a thread’s changes {n} times')
const STAGE: Phrase = phrase('Changed staged files', 'changed staged files', 'changed staged files {n} times')
const DISCARD: Phrase = phrase('Discarded changes', 'discarded changes', 'discarded changes {n} times')
const COMMIT: Phrase = phrase('Made a commit', 'made a commit', 'made {n} commits')
const PUSH: Phrase = phrase('Pushed to a remote', 'pushed to a remote', 'pushed to a remote {n} times')
const SYNC: Phrase = phrase('Fetched or pulled', 'fetched or pulled', 'fetched or pulled {n} times')
const BRANCH: Phrase = phrase('Changed branches', 'changed branches', 'changed branches {n} times')
const GIT_INIT: Phrase = phrase('Started a Git repository', 'started a Git repository', 'started {n} Git repositories')
const COMMIT_MESSAGE: Phrase = phrase('Asked for a commit message', 'asked for a commit message', 'asked for {n} commit messages')
const PULL_REQUEST: Phrase = phrase('Worked on a pull request', 'worked on a pull request', 'worked on pull requests {n} times')
const PR_THREAD: Phrase = phrase('Started a thread from a pull request', 'started a thread from a pull request', 'started {n} threads from pull requests')
const TERMINAL: Phrase = phrase('Opened a terminal', 'opened a terminal', 'opened {n} terminals')
const TERMINAL_KILL: Phrase = phrase('Closed a terminal', 'closed a terminal', 'closed {n} terminals')
const CREATE: Phrase = phrase('Created a thread', 'created a thread', 'created {n} threads')
const PROJECT: Phrase = phrase('Changed a project', 'changed a project', 'changed projects {n} times')
const PROJECT_OPEN: Phrase = phrase('Opened a folder as a project', 'opened a folder as a project', 'opened {n} folders as projects')
const OTHER: Phrase = phrase('Made a change', 'made a change', 'made {n} other changes')

/** A change that is a notice to the owner, not a thing to count. */
export const DEVICE_NOTICE_METHODS = [
  'thread.first_use',
  'pty.first_open',
  'project.first_open',
  'pty.close',
  'editor.open',
  'editor.close',
  'editor.check',
  'editor.ask',
  'editor.ask.allowed',
  'editor.ask.declined'
] as const

const NOTICE_ROWS: Record<string, string> = {
  'thread.first_use': 'First change from this computer',
  'pty.first_open': 'Opened its first terminal here',
  'project.first_open': 'Opened its first folder as a project here',
  'pty.close': 'A terminal ended',
  'editor.open': 'Opened its editor here',
  'editor.close': 'An editor connection ended',
  'editor.check': 'Checked an editor connection',
  'editor.ask': 'Asked to open its editor here',
  'editor.ask.allowed': 'Asked to open its editor here, and you allowed it',
  'editor.ask.declined': 'Asked to open its editor here, and you said Not now'
}

const PHRASES: Record<string, Phrase> = {
  'orchestrator.send': TURN,
  'orchestrator.steer': STEER,
  'orchestrator.abort': STOP,
  'orchestrator.retry': RETRY,
  'orchestrator.answerQuestions': ANSWER,
  'orchestrator.dismissQuestions': DISMISS,
  'queue.enqueue': QUEUED,
  'queue.edit': QUEUE_EDIT,
  'queue.reorder': QUEUE_EDIT,
  'queue.remove': QUEUE_EDIT,
  'queue.promoteToSteer': QUEUE_EDIT,
  'threads.setModel': MODEL,
  'threads.setPermissionMode': MODE,
  'threads.clearApprovalRules': RULES,
  'runs.resumeNow': PAUSE,
  'runs.cancelPause': PAUSE,
  'subagents.stopAll': AGENTS,
  'agents.stop': AGENTS,
  'tasks.create': TASKS,
  'tasks.update': TASKS,
  'applets.state.save': APPLET,
  'workflowRuns.pause': WORKFLOW,
  'workflowRuns.resume': WORKFLOW,
  'workflowRuns.cancel': WORKFLOW,
  'workflowRuns.approve': WORKFLOW,
  'workflowRuns.answer': WORKFLOW,
  'pullRequests.startThread': PR_THREAD,
  'threads.rename': RENAME,
  'threads.pin': ORGANIZE,
  'threads.settle': ORGANIZE,
  'threads.delete': DELETE,
  'threads.trash': DELETE,
  'threads.restore': RESTORE,
  'threads.regenerateTitle': RENAME,
  'threads.setWorktreeEnabled': THREAD_SETTING,
  'thread.fork': FORK,
  'thread.mergeBack': MERGE_BACK,
  'actions.undoLatest': UNDO,
  'actions.redo': REDO,
  'actions.revertCode': REVERT,
  'actions.activateBranch': HISTORY,
  'actions.fork': HISTORY,
  'actions.pin': HISTORY,
  'actions.configureRetention': HISTORY,
  'actions.sweepRetention': HISTORY,
  'workspace.restore': WORKSPACE,
  'operations.abort': OPERATION,
  'operations.recover': OPERATION,
  'files.write': SAVE,
  'publish.start': PUBLISH,
  'git.checkout': BRANCH,
  'git.commit': COMMIT,
  'git.push': PUSH,
  'git.suggestCommitMessage': COMMIT_MESSAGE,
  'git.stage': STAGE,
  'git.unstage': STAGE,
  'git.discard': DISCARD,
  'git.fetch': SYNC,
  'git.pull': SYNC,
  'git.abortInProgress': OPERATION,
  'git.createBranch': BRANCH,
  'git.renameBranch': BRANCH,
  'git.deleteBranch': BRANCH,
  'git.cancelOperation': OPERATION,
  'git.init': GIT_INIT,
  'pullRequests.create': PULL_REQUEST,
  'pullRequests.draft': PULL_REQUEST,
  'pullRequests.link': PULL_REQUEST,
  'pullRequests.unlink': PULL_REQUEST,
  'pullRequests.pushTarget': PULL_REQUEST,
  'pullRequests.watch': PULL_REQUEST,
  'pty.create': TERMINAL,
  'pty.kill': TERMINAL_KILL,
  'threads.create': CREATE,
  'projects.rename': PROJECT,
  'projects.pin': PROJECT,
  'projects.remove': PROJECT,
  'projects.open': PROJECT_OPEN
}

/** Every method the owner audits as a change that has words of its own; the test checks it against the routed table. */
export const AUDITED_CHANGE_METHODS: readonly string[] = Object.keys(PHRASES)

const phraseOf = (method: string): Phrase => PHRASES[method] ?? OTHER

/**
 * The one-line summary of what a device did, from the per-method counts: "Started 3 turns, answered
 * 2 approvals or questions, made a commit, opened a terminal". Methods with the same words are added
 * together, and the order is the order of the most common first.
 */
export function describeDeviceActivity(counts: readonly DeviceActivityCount[]): string {
  const totals = new Map<Phrase, number>()
  for (const { method, count } of counts) {
    if ((DEVICE_NOTICE_METHODS as readonly string[]).includes(method) || count <= 0) continue
    const phrase = phraseOf(method)
    totals.set(phrase, (totals.get(phrase) ?? 0) + count)
  }
  const parts = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([phrase, count]) => phrase.summary(count))
  if (!parts.length) return ''
  const text = parts.join(', ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

const TERMINAL_ENDS: Record<string, string> = {
  exited: 'the shell ended',
  killed: 'the device closed it',
  owner_stopped: 'stopped on this computer',
  blocked: 'the device was blocked',
  terminal_off: 'terminals were switched off for the device',
  setting_off: 'other computers were switched off',
  access_lost: 'the device lost access',
  net_off: 'networking was turned off',
  device_away: 'the device was away',
  create_failed: 'it could not finish starting'
}

const EDITOR_REFUSALS: Record<string, string> = {
  editor_off: 'editor connections are off for the device',
  blocked: 'the device is blocked',
  capability: 'the device lost Works on threads',
  setting_off: 'other computers are switched off',
  net_off: 'networking is off',
  no_ssh_server: 'this computer has no SSH server running',
  no_host_key: 'its SSH host key could not be read',
  host_untrusted: 'its SSH server could not be shown to be the system’s own',
  limit: 'too many editor connections',
  rate_limited: 'too many at once',
  declined_recently: 'you said Not now a short while ago'
}

const CODE_WORDS: Record<string, string> = {
  thread_not_found: 'the thread was gone',
  permission_mode_above_ceiling: 'above the highest permission mode set for the device',
  queue_conflict: 'the queue had changed',
  forbidden: 'not allowed',
  rate_limited: 'too many at once',
  bad_request: 'not a valid request'
}

/** "End; in 12 B; out 1.2 KiB" as the audit keeps it, in words. */
function closedTerminal(outcome: string): string {
  const [reason = '', input, output] = outcome.split('; ')
  const ended = TERMINAL_ENDS[reason] ?? reason.replaceAll('_', ' ')
  const bytes = (part: string | undefined, label: string): string => {
    const match = /^(?:in|out) (\d+) B$/.exec(part ?? '')
    return match ? `${label} ${formatBytes(Number(match[1]))}` : ''
  }
  const traffic = [bytes(input, 'typed'), bytes(output, 'shown')].filter(Boolean).join(', ')
  return traffic ? `${ended} (${traffic})` : ended
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MiB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`
}

/** One row of the list, in plain words. A refusal says why it was refused, and a lost outcome says it may have happened. */
export function describeActivityEntry(entry: Pick<DeviceActivityEntry, 'method' | 'kind' | 'outcome'>): string {
  // A refused editor connection or ask says so; the same words as an open or an ask that went through would mislead.
  if (entry.kind === 'refused' && (entry.method === 'editor.open' || entry.method === 'editor.ask' || entry.method === 'editor.check')) {
    const why = EDITOR_REFUSALS[entry.outcome] ?? entry.outcome.replaceAll('_', ' ')
    if (entry.method === 'editor.check') return `Checked an editor connection (refused: ${why})`
    return entry.method === 'editor.open'
      ? `Tried to open its editor here (refused: ${why})`
      : `Asked to open its editor here (not passed on: ${why})`
  }
  const notice = NOTICE_ROWS[entry.method]
  if (notice) return entry.method === 'pty.close' ? `${notice}: ${closedTerminal(entry.outcome)}` : notice
  const row = phraseOf(entry.method).row
  if (entry.kind === 'refused') return `${row} (refused: ${CODE_WORDS[entry.outcome] ?? entry.outcome.replaceAll('_', ' ')})`
  if (entry.outcome === 'uncertain') return `${row} (may have happened)`
  return row
}
