import type { RoutedStreamKind } from '../bridge/routed'
import type { StreamKind } from './streams'

/**
 * What a call or stream from another device of the user's list does on this computer, as the receiver's per-device
 * switches see it. Every remote method another device can call here (every family: routed, the Bridge remote API,
 * the hub, bots, lists, speech and Net's own) and every stream kind has one class. A test reads the methods a real
 * daemon registers (`tests/net/bridge/routed/accessClasses.test.ts`) and fails on one with no class, or a row here that
 * names none, so a new method is classed when it is added.
 *
 * - `view`: reads threads, lists and what a transcript already shows, and the connection's own traffic. Passes for
 *   every device this computer serves.
 * - `bots_chat`: a bot's chat, its replies, asks and pictures, and dictation; held to the device's Bots switch and each
 *   bot's Devices choice, and runs within the bot's own permissions.
 * - `bots_manage`: makes a bot or changes one (its name, look, permissions, memory, schedules, pause).
 * - `work`: starts, sends to, steers, stops or changes threads, their queue, settings, files and Git, projects,
 *   automations and agent chats; and reads that expose the computer's files (Files, Git, review).
 * - `terminal`: opens, reads or types into a terminal (the device's terminal switch governs it).
 * - `editor`: an editor connection or its folder (the device's editor switch governs it).
 *
 * "Work on threads from this device" off (`net_node_policy.work`) refuses `work` and `bots_manage` in every family,
 * with the reason `work_off`. Kept apart from the rows of `ROUTED_METHODS` and keyed by the Net method name.
 */
export const ACCESS_CLASSES = ['view', 'bots_chat', 'bots_manage', 'work', 'terminal', 'editor'] as const
export type AccessClass = (typeof ACCESS_CLASSES)[number]

const routed = (classes: Record<string, AccessClass>): Record<string, AccessClass> =>
  Object.fromEntries(Object.entries(classes).map(([name, value]) => [`routed.${name}`, value]))

/** Every remote method by its Net name. A routed row is `routed.<row>`; the phone API's rows keep their bare names. */
export const METHOD_ACCESS: Readonly<Record<string, AccessClass>> = Object.freeze({
  // ---------------------------------------------------------------- Net itself
  'net.info': 'view',
  'net.direct.endpoints': 'view',
  'net.direct.webrtc.offer': 'view',
  // What this computer lets the caller do here: the caller's own access, read back.
  'bridge.access.mine': 'view',
  // Moving the keeper role: signed by the user's own keys, and never a thread's or a bot's.
  'authority.transfer.ready': 'view',
  'authority.transfer.import': 'view',
  'authority.transfer.activate': 'view',
  'authority.transfer.ack': 'view',
  'authority.transfer.retirement': 'view',

  // ---------------------------------------------------------------- the Bridge remote API (phones)
  'projects.list': 'view',
  'projects.match': 'view',
  'threads.list': 'view',
  'threads.get': 'view',
  'threads.search': 'view',
  'thread.snapshot': 'view',
  'thread.messages': 'view',
  'reply.page': 'view',
  'orchestrator.isTurnActive': 'view',
  'orchestrator.contextUsage': 'view',
  'orchestrator.pendingQuestions': 'view',
  'composer.options': 'view',
  'queue.list': 'view',
  'storage.usage': 'view',
  'usage.history': 'view',
  'threads.create': 'work',
  'projects.open': 'work',
  'threads.rename': 'work',
  'threads.pin': 'work',
  'threads.archive': 'work',
  // Legacy name of `threads.archive`, from a phone that runs an older Mousse.
  'threads.settle': 'work',
  'threads.regenerateTitle': 'work',
  'threads.setExpiry': 'work',
  'orchestrator.send': 'work',
  'orchestrator.steer': 'work',
  'orchestrator.abort': 'work',
  'orchestrator.answerQuestions': 'work',
  'orchestrator.dismissQuestions': 'work',
  'threads.setModel': 'work',
  // Images for a thread's message or answer; a bot's chat takes none.
  'attachments.stage': 'work',
  'queue.enqueue': 'work',
  'queue.remove': 'work',
  'queue.reorder': 'work',
  'queue.promoteToSteer': 'work',
  // Dictation and read-aloud for any message, a bot's included: runs nothing on a thread.
  'speech.options': 'bots_chat',
  'speech.choose': 'bots_chat',
  'speech.download': 'bots_chat',
  'speech.upload': 'bots_chat',
  'speech.transcribe': 'bots_chat',
  'speech.speak': 'bots_chat',

  // ---------------------------------------------------------------- Bridge: streams, lists, agent chats, hub
  'bridge.thread.open': 'view',
  'bridge.lists.open': 'view',
  // The method an artifact is for is checked again, with its own class, whenever the artifact is opened or read.
  'bridge.artifacts.open': 'view',
  'chats.send': 'work',
  'chats.cancel': 'work',
  'bridge.dispatch': 'work',

  // ---------------------------------------------------------------- personal bots
  'bots.get': 'bots_chat',
  'bots.chat.list': 'bots_chat',
  'bots.chat.attachment': 'bots_chat',
  'bots.memory.list': 'bots_chat',
  'bots.chat.send': 'bots_chat',
  'bots.chat.stop': 'bots_chat',
  'bots.work.stop': 'bots_chat',
  'bots.chat.markRead': 'bots_chat',
  'bots.actions.answer': 'bots_manage',
  'bots.questions.answer': 'bots_chat',
  'bots.reminders.snooze': 'bots_chat',
  // Both choices on a permission ask or held external action require Work; reading the cards stays bots_chat.
  'bots.asks.answer': 'bots_manage',
  'bots.personal.pause': 'bots_manage',
  'bots.personal.resume': 'bots_manage',
  'bots.create': 'bots_manage',
  'bots.update': 'bots_manage',
  'bots.reminders.cancel': 'bots_manage',
  'bots.schedules.remove': 'bots_manage',
  'bots.permissions.set': 'bots_manage',
  'bots.permissions.revoke': 'bots_manage',
  'bots.memory.forget': 'bots_manage',
  'bots.memory.edit': 'bots_manage',

  // ---------------------------------------------------------------- routed: the transport
  ...routed({
    page: 'view',
    // A terminal's stream is held to the terminal switch where it opens and on every record.
    'stream.open': 'view',
    'stream.close': 'view',
    stage: 'work'
  }),

  // ---------------------------------------------------------------- routed: reads
  ...routed({
    'threads.get': 'view',
    'threads.markSeen': 'view',
    'thread.snapshot': 'view',
    'thread.messages': 'view',
    'thread.changesSince': 'view',
    'thread.messageImage': 'view',
    'orchestrator.isTurnActive': 'view',
    'orchestrator.contextUsage': 'view',
    'orchestrator.pendingQuestions': 'view',
    'orchestrator.sendAccepted': 'view',
    'queue.list': 'view',
    'runs.list': 'view',
    'runs.get': 'view',
    'runs.events': 'view',
    'runs.wait': 'view',
    'activity.get': 'view',
    'subagents.list': 'view',
    'threads.backgroundWork': 'view',
    'agents.list': 'view',
    'tasks.list': 'view',
    'threads.approvalRules': 'view',
    'threads.approvalRequests': 'view',
    'actions.list': 'view',
    'operations.get': 'view',
    'publish.status': 'view',
    'applets.get': 'view',
    'applets.state.get': 'view',
    'applets.export': 'view',
    'workflowRuns.list': 'view',
    'workflowRuns.get': 'view',
    'workflowRuns.trace': 'view',
    'pullRequests.get': 'view',
    'pullRequests.detail': 'view',
    'pullRequests.baseBranches': 'view',
    'pullRequests.mergeMethod': 'view',
    'pullRequests.watchStatus': 'view',
    'pullRequests.list': 'view',
    'pullRequests.resolve': 'view',
    'projects.match': 'view',
    'composer.options': 'view',
    'projects.list': 'view',
    'threads.list': 'view',
    'threads.search': 'view',
    'threads.inventory': 'view',
    'activity.snapshot': 'view',
    'chatReferences.resolve': 'view',
    'providers.snapshots': 'view',
    'skills.list': 'view',
    'skills.read': 'view',
    'github.status': 'view',
    'automations.list': 'view',
    // Reads of the computer's files and Git: not a view of the thread.
    'workspace.getStatus': 'work',
    'actions.getAffectedFiles': 'work',
    'review.files': 'work',
    'review.file': 'work',
    'git.status': 'work',
    'git.checkUpstream': 'work',
    'git.changes': 'work',
    'git.revertedList': 'work',
    'git.diff': 'work',
    'git.log': 'work',
    'git.branches': 'work',
    'git.diffStats': 'work',
    'git.lastCommitMessage': 'work',
    'files.list': 'work',
    'files.read': 'work',
    'files.readAsset': 'work',
    'files.stat': 'work',
    'files.search': 'work',
    'files.grep': 'work',
    'editor.folder': 'editor',
    // Asks a person here to turn editor connections on; it changes nothing by itself.
    'editor.ask': 'editor',
    'pty.list': 'terminal',
    'pty.lookup': 'terminal',
    'pty.scrollback': 'terminal',
    'pty.isAlive': 'terminal',
    'pty.outputSince': 'terminal'
  }),

  // ---------------------------------------------------------------- routed: chat and changes
  ...routed({
    'orchestrator.send': 'work',
    'orchestrator.steer': 'work',
    'orchestrator.abort': 'work',
    'orchestrator.steerNow': 'work',
    'orchestrator.retry': 'work',
    'orchestrator.retrySetup': 'work',
    'threads.clearContext': 'work',
    'threads.compact': 'work',
    'threads.stopCompaction': 'work',
    'orchestrator.answerQuestions': 'work',
    'orchestrator.dismissQuestions': 'work',
    'queue.enqueue': 'work',
    'queue.edit': 'work',
    'queue.reorder': 'work',
    'queue.remove': 'work',
    'queue.promoteToSteer': 'work',
    'threads.setModel': 'work',
    'threads.setPermissionMode': 'work',
    'threads.clearApprovalRules': 'work',
    'runs.resumeNow': 'work',
    'runs.cancelPause': 'work',
    'subagents.stopAll': 'work',
    'threads.stopBackground': 'work',
    'agents.stop': 'work',
    'tasks.create': 'work',
    'tasks.update': 'work',
    'applets.state.save': 'work',
    'workflowRuns.pause': 'work',
    'workflowRuns.resume': 'work',
    'workflowRuns.cancel': 'work',
    'workflowRuns.approve': 'work',
    'workflowRuns.answer': 'work',
    'pullRequests.startThread': 'work',
    'threads.rename': 'work',
    'threads.pin': 'work',
    'threads.archive': 'work',
    // Legacy name of `threads.archive`, from a computer that runs an older Mousse.
    'threads.settle': 'work',
    'threads.delete': 'work',
    'threads.regenerateTitle': 'work',
    'threads.setWorktreeEnabled': 'work',
    'threads.setExpiry': 'work',
    'thread.fork': 'work',
    'thread.mergeBack': 'work',
    'actions.undoLatest': 'work',
    'actions.redo': 'work',
    'actions.revertCode': 'work',
    'actions.activateBranch': 'work',
    'actions.fork': 'work',
    'actions.pin': 'work',
    'actions.configureRetention': 'work',
    'actions.sweepRetention': 'work',
    'workspace.restore': 'work',
    'workspace.discardPendingChanges': 'work',
    'operations.abort': 'work',
    'operations.recover': 'work',
    'files.write': 'work',
    'publish.start': 'work',
    'git.checkout': 'work',
    'git.commit': 'work',
    'git.push': 'work',
    'git.suggestCommitMessage': 'work',
    'git.include': 'work',
    'git.undoLastCommit': 'work',
    'git.revert': 'work',
    'git.restoreReverted': 'work',
    'git.stage': 'work',
    'git.unstage': 'work',
    'git.discard': 'work',
    'git.fetch': 'work',
    'git.pull': 'work',
    'git.abortInProgress': 'work',
    'git.continueInProgress': 'work',
    'git.createBranch': 'work',
    'git.renameBranch': 'work',
    'git.deleteBranch': 'work',
    'git.cancelOperation': 'work',
    'git.init': 'work',
    'pullRequests.create': 'work',
    'pullRequests.draft': 'work',
    'pullRequests.merge': 'work',
    'pullRequests.close': 'work',
    'pullRequests.link': 'work',
    'pullRequests.unlink': 'work',
    'pullRequests.pushTarget': 'work',
    'pullRequests.watch': 'work',
    'pty.create': 'terminal',
    'pty.kill': 'terminal',
    'pty.write': 'terminal',
    'pty.resize': 'terminal',
    'threads.create': 'work',
    'projects.rename': 'work',
    'projects.pin': 'work',
    'projects.remove': 'work',
    'projects.open': 'work',
    'scheduled.create': 'work',
    'scheduled.update': 'work',
    'scheduled.run': 'work',
    'scheduled.pause': 'work',
    'scheduled.resume': 'work',
    'scheduled.delete': 'work',
    // Settings → Providers of this computer, from another one: reading it is a view; changing it is work.
    'providers.catalog.addOptions': 'view',
    'providers.registry.search': 'view',
    'providers.instances.recheck': 'view',
    'providers.instances.add': 'work',
    'providers.instances.setSecret': 'work',
    'providers.instances.remove': 'work',
    'providers.instances.configure': 'work',
    'providers.instances.setEnabled': 'work',
    'providers.instances.install': 'work',
    'providers.instances.removeInstall': 'work',
    'providers.instances.cancelInstall': 'work',
    'providers.instances.update': 'work',
    'providers.instances.signIn': 'work',
    'providers.instances.respondSignIn': 'work',
    'providers.instances.signOut': 'work',
    'providers.instances.allowKnownProblem': 'work',
    'providers.instances.refreshModels': 'work',
    'providers.instances.refreshAllModels': 'work',
    'providers.instances.setModelPrefs': 'work'
  })
})

/**
 * Every stream kind. A Space's streams follow its membership; an artifact's stream is checked again against the
 * method it is for, with that method's class.
 */
export const STREAM_ACCESS: Readonly<Record<StreamKind, AccessClass>> = Object.freeze({
  'node.thread': 'view',
  'node.artifact': 'view',
  'space.meta': 'view',
  'space.channel': 'view',
  'space.thread': 'view',
  'space.private': 'view'
})

/** Every kind of private stream one computer opens on another (`routed.stream.open`). */
export const ROUTED_STREAM_ACCESS: Readonly<Record<RoutedStreamKind, AccessClass>> = Object.freeze({
  thread: 'view',
  lists: 'view',
  // A Git action's progress, for the computer that started it.
  channel: 'view',
  terminal: 'terminal'
})

/** A method with no class counts as work: a device that may only view and chat with bots never reaches it. */
export const methodAccess = (method: string): AccessClass =>
  Object.hasOwn(METHOD_ACCESS, method) ? METHOD_ACCESS[method]! : 'work'

/** The classes "Work on threads from this device" governs: off, each is refused. */
export const needsWork = (access: AccessClass): boolean =>
  access === 'work' || access === 'bots_manage'
