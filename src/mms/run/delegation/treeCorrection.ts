import { createHash, randomUUID } from 'node:crypto'
import type { SteerStrategy } from '../CommandPolicy'
import { json, type Row } from '../db/rows'
import { Delegations } from '../Delegations'
import { Inbox } from '../Inbox'
import { stableStringify } from '../json'
import { noteDelivery, type SendDelivery } from '../mcp/appTools/threadNotes'
import type { RunEngine } from '../RunEngine'
import type { RunStore } from '../RunStore'
import { isAgentNoteRow, type AgentNotePayload, type InboxRecord, type RunRecord } from '../types'
import { correctionText } from './notice'

/**
 * Corrections (docs/plans/tool-api.md §2.5). When the person steers a thread whose subagents still work, and asks for it
 * ("Also tell subagents"), Mousse records a tree instruction revision and relays the correction to every live
 * descendant as a note from that thread (`from: 'person'`). It carries none of the person's authority: it is an inbox
 * notice, which answers and approves nothing, and it waits while a descendant waits on a question or approval.
 */

/** Where the correction stands for one subagent. */
export interface TreeDelivery {
  threadId: string
  title: string | null
  /** `delivered`: its turn has it. `pending`: it waits, and `how` says for what. `not_sent`: `how` says why. */
  state: 'delivered' | 'pending' | 'not_sent'
  how: SendDelivery | 'starts_with_it' | 'inherited' | 'on_another_computer' | 'next_step' | 'refused'
}

export interface TreeRevision {
  revisionId: string
  threadId: string
  /** The thread's title when the person corrected it. */
  title: string | null
  /** The thread's run the correction reached; null when none ran. */
  runId: string | null
  text: string
  createdAt: string
  deliveries: TreeDelivery[]
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 32)

/** The one inbox row of a revision for one thread: a retry or a second inheritance never posts it twice. */
export function correctionInboxId(revisionId: string, threadId: string): string {
  return `inbox:correction:${sha(`${revisionId}\n${threadId}`)}`
}

export function isCorrectionRow(row: Pick<InboxRecord, 'kind' | 'payload'>): boolean {
  return isAgentNoteRow(row) && (row.payload as AgentNotePayload).from === 'person'
}

/**
 * Subagents with a running delegation below `threadId`, at every depth, nearest first. A bot's work subagents are not
 * among them: the bot port corrects those (`BotEngine.noteSubagents`), never this.
 */
export function liveDescendants(delegations: Delegations, threadId: string): Array<{ threadId: string; direct: boolean }> {
  const found: Array<{ threadId: string; direct: boolean }> = []
  const seen = new Set([threadId])
  const walk = (parent: string, direct: boolean): void => {
    for (const row of delegations.listForParentThread(parent)) {
      if (row.status !== 'running' || row.bot || seen.has(row.childThreadId)) continue
      seen.add(row.childThreadId)
      found.push({ threadId: row.childThreadId, direct })
    }
  }
  walk(threadId, true)
  for (let index = 0; index < found.length; index++) walk(found[index].threadId, false)
  return found
}

function toRevision(row: Row): TreeRevision {
  return {
    revisionId: String(row.revision_id),
    threadId: String(row.thread_id),
    title: typeof row.title === 'string' ? row.title : null,
    runId: typeof row.run_id === 'string' ? row.run_id : null,
    text: String(row.text),
    createdAt: String(row.created_at),
    deliveries: json<TreeDelivery[]>(row.deliveries) ?? []
  }
}

export function getRevision(store: RunStore, revisionId: string): TreeRevision | null {
  const row = store.db.statement('SELECT * FROM tree_revisions WHERE revision_id = ?').get(revisionId)
  return row ? toRevision(row) : null
}

function saveDeliveries(store: RunStore, revisionId: string, deliveries: TreeDelivery[]): void {
  store.db.statement('UPDATE tree_revisions SET deliveries = ? WHERE revision_id = ?').run(stableStringify(deliveries), revisionId)
}

/**
 * Posts the correction to one subagent. A subagent with no turn running and its next turn not started yet (its
 * `turn.start` still pending) starts with it: the row is that turn's, which reads it into its first message
 * (`correctionsStartingWith`). Otherwise it is delivered as any note (§2.2). Null when the row was already there.
 */
function postCorrection(store: RunStore, revision: Omit<TreeRevision, 'deliveries'>, target: { threadId: string; direct: boolean }): { row: InboxRecord; startsWith: boolean } | null {
  const inbox = new Inbox(store)
  const inboxId = correctionInboxId(revision.revisionId, target.threadId)
  if (inbox.get(inboxId)) return null
  const payload: AgentNotePayload = {
    kind: 'agent_note', senderThreadId: revision.threadId, senderRunId: revision.runId ?? '', senderTitle: revision.title,
    senderAccess: 'agent', from: 'person', text: revision.text, attention: 'needed', revisionId: revision.revisionId, direct: target.direct
  }
  const active = store.getActiveRun(target.threadId)
  const row = inbox.append({ inboxId, threadId: target.threadId, runId: active?.runId ?? null, kind: 'reconcile_notice', payload })
  const start = active ? undefined : store.db
    .statement(
      `SELECT e.effect_id FROM effects e JOIN runs r ON r.run_id = e.run_id
       WHERE r.thread_id = ? AND r.status = 'queued' AND e.kind = 'turn.start' AND e.status = 'pending' AND json_extract(e.payload, '$.kind') IS NULL
       ORDER BY r.ordinal LIMIT 1`
    )
    .get(target.threadId)
  if (typeof start?.effect_id === 'string') inbox.markDelivered([inboxId], start.effect_id)
  return { row, startsWith: typeof start?.effect_id === 'string' }
}

/** The corrections a subagent's turn starts with: the rows its `turn.start` took, as the text its first message ends with. */
export function correctionsStartingWith(store: RunStore, effectId: string): string[] {
  return new Inbox(store).getMany(
    store.db.statement(`SELECT inbox_id FROM inbox WHERE delivered_by = ? AND status = 'delivered' ORDER BY created_at, rowid`).all(effectId).map((row) => String(row.inbox_id))
  ).filter(isCorrectionRow).map((row) => {
    const payload = row.payload as AgentNotePayload
    return correctionText(payload.senderTitle, payload.text, payload.direct !== false)
  })
}

/** The revisions of `threadIds` recorded since `since` (a run's start), oldest first. */
function revisionsSince(store: RunStore, threadIds: readonly string[], since: string): TreeRevision[] {
  return store.db
    .statement(`SELECT * FROM tree_revisions WHERE thread_id IN (${threadIds.map(() => '?').join(',')}) AND created_at >= ? ORDER BY created_at, rowid`)
    .all(...threadIds, since)
    .map(toRevision)
}

/** Records that a subagent started after the revision inherited it, unless its delivery is recorded already. */
function recordInherited(store: RunStore, revision: TreeRevision, childThreadId: string): void {
  if (revision.deliveries.some((entry) => entry.threadId === childThreadId)) return
  saveDeliveries(store, revision.revisionId, [...revision.deliveries, { threadId: childThreadId, title: null, state: 'pending', how: 'inherited' }])
}

/**
 * A subagent started later from a run older than a revision of its parent or of a thread above it inherits that revision
 * (§2.5): it starts with the correction. Only parent-to-subagent edges lead up: a fork's subagents inherit nothing of its
 * source. Called in the delegation's transaction, with the child's new `turn.start`.
 */
export function inheritRevisions(store: RunStore, input: { parentThreadId: string; parentRun: RunRecord; childThreadId: string; startEffectId: string }): void {
  const above = [input.parentThreadId]
  const delegations = new Delegations(store)
  for (let lineage = delegations.getLineage(input.parentThreadId); lineage?.relationship === 'subagent' && !above.includes(lineage.parentThreadId); lineage = delegations.getLineage(lineage.parentThreadId))
    above.push(lineage.parentThreadId)
  const inbox = new Inbox(store)
  for (const revision of revisionsSince(store, above, input.parentRun.requestedAt)) {
    const posted = postCorrection(store, revision, { threadId: input.childThreadId, direct: revision.threadId === input.parentThreadId })
    if (!posted) continue
    if (!posted.startsWith) inbox.markDelivered([posted.row.inboxId], input.startEffectId)
    recordInherited(store, revision, input.childThreadId)
  }
}

/**
 * A bot work's subagent as its turn starts (`BotEngine.prepareDelegatedSubagent`): the owner's corrections of the work
 * since the run that started it, which it could not take in while it waited, as its work's messages to start with.
 */
export function botSubagentStartsWith(store: RunStore, input: { workThreadId: string; parentRun: RunRecord; childThreadId: string }): string[] {
  return revisionsSince(store, [input.workThreadId], input.parentRun.requestedAt)
    .filter((revision) => !revision.deliveries.some((entry) => entry.threadId === input.childThreadId && entry.how === 'next_step'))
    .map((revision) => {
      recordInherited(store, revision, input.childThreadId)
      return revision.text
    })
}

/** What the thread's own agent, and the person in its chat, read of where the correction went. */
const HOW_WORDS: Record<TreeDelivery['how'], string> = {
  presented: 'delivered into its running turn',
  started: 'delivered: it started a turn with it',
  waiting_for_boundary: 'waits for its next Mousse tool call, or its next turn',
  waiting_on_command: 'waits for its running command to finish',
  queued: 'waits for its next turn',
  after_answer: 'waits until its question or approval is answered',
  runtime_owned: 'not sent: its runtime owns it',
  starts_with_it: 'its next turn starts with it',
  inherited: 'started after the correction and starts with it',
  on_another_computer: 'not sent: it runs on another computer',
  next_step: 'waits for its next step',
  refused: 'not sent: it takes no message while it works'
}

export function deliveryRecordText(deliveries: readonly TreeDelivery[]): string {
  return deliveries.map((entry) => `${entry.title ? `"${entry.title}"` : 'A subagent'} (thread ${entry.threadId}): ${HOW_WORDS[entry.how]}.`).join('\n')
}

/** Records a revision a bot's work relayed through its own port (`BotEngine.noteSubagents`). */
export function recordRevision(store: RunStore, input: Pick<TreeRevision, 'threadId' | 'title' | 'text' | 'deliveries'>): string {
  const revisionId = `revision:${randomUUID()}`
  store.db
    .statement('INSERT INTO tree_revisions(revision_id, thread_id, title, run_id, text, deliveries, created_at) VALUES(?, ?, ?, NULL, ?, ?, ?)')
    .run(revisionId, input.threadId, input.title, input.text.trim(), stableStringify(input.deliveries), new Date(store.db.clock()).toISOString())
  return revisionId
}

/**
 * Records the revision and relays the correction to the thread's live descendants, then waits briefly to tell how each
 * delivery stands (`noteDelivery`) and gives the thread's agent the record as a quiet note. Replays by `clientRequestId`.
 */
export async function reviseTree(engine: RunEngine, input: {
  threadId: string
  text: string
  clientRequestId: string
  titleOf(threadId: string): string | null
  strategyOf(threadId: string): SteerStrategy | null
  /** The thread waits on a person's answer to a question or an approval: the correction waits until it comes. */
  waitsOnPerson(threadId: string): boolean
  signal?: AbortSignal
}): Promise<{ revision: TreeRevision; replayed: boolean }> {
  const store = engine.store
  const revisionId = `revision:${sha(input.clientRequestId)}`
  const prior = getRevision(store, revisionId)
  if (prior) return { revision: prior, replayed: true }
  const base = { revisionId, threadId: input.threadId, title: input.titleOf(input.threadId), runId: engine.getActiveRun(input.threadId)?.runId ?? null, text: input.text.trim(), createdAt: new Date(store.db.clock()).toISOString() }
  const posted = store.db.transaction(() => {
    store.db
      .statement('INSERT INTO tree_revisions(revision_id, thread_id, title, run_id, text, deliveries, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
      .run(base.revisionId, base.threadId, base.title, base.runId, base.text, '[]', base.createdAt)
    return liveDescendants(engine.delegations, input.threadId).map((target) => {
      const remote = engine.remoteSubagents.listForChildThread(target.threadId).length > 0
      return { ...target, remote, posted: remote ? null : postCorrection(store, base, target) }
    })
  })
  const signal = input.signal ?? new AbortController().signal
  const deliveries = await Promise.all(posted.map(async (target): Promise<TreeDelivery> => {
    const title = input.titleOf(target.threadId)
    if (target.remote) return { threadId: target.threadId, title, state: 'not_sent', how: 'on_another_computer' }
    if (target.posted?.startsWith) return { threadId: target.threadId, title, state: 'pending', how: 'starts_with_it' }
    if (input.waitsOnPerson(target.threadId)) return { threadId: target.threadId, title, state: 'pending', how: 'after_answer' }
    const inboxId = correctionInboxId(revisionId, target.threadId)
    const { delivery } = await noteDelivery(engine, { threadId: target.threadId, inboxId, attention: 'needed', strategy: () => input.strategyOf(target.threadId), signal })
    return { threadId: target.threadId, title, state: delivery === 'presented' || delivery === 'started' ? 'delivered' : 'pending', how: delivery }
  }))
  store.db.transaction(() => {
    // An inheritance written meanwhile is kept.
    const inherited = (getRevision(store, revisionId)?.deliveries ?? []).filter((entry) => !deliveries.some((own) => own.threadId === entry.threadId))
    saveDeliveries(store, revisionId, [...deliveries, ...inherited])
    if (deliveries.length === 0) return
    const record: AgentNotePayload = {
      kind: 'agent_note', senderThreadId: input.threadId, senderRunId: base.runId ?? '', senderTitle: null, senderAccess: 'agent', from: 'relay',
      text: `What the person just told you also went to your subagents:\n${deliveryRecordText(deliveries)}`, attention: 'none', revisionId
    }
    new Inbox(store).append({ inboxId: correctionInboxId(revisionId, input.threadId), threadId: input.threadId, runId: base.runId, kind: 'reconcile_notice', payload: record })
  })
  return { revision: getRevision(store, revisionId)!, replayed: false }
}
