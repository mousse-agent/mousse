import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  acknowledgementOf,
  BOT_SCHEDULE_SKIP_TEXT,
  DEFAULT_BOT_ACTIVE_MS,
  ENDED_ACTIVATION_STATUSES,
  type BotAcknowledgement,
  type BotActivationSummary,
  type BotApprovalView,
  type BotDefinitionV1 as BotDefinition,
  type BotPermissionLine,
  type BotSummaryV1 as BotSummary
} from '../../../shared/bots/personal/definition'
import { ChevronRight, Plus } from '../../lib/icons'
import { Modal } from '../ui/Modal'
import { Select } from '../ui/Select'
import { Switch } from '../settings/SettingsRow'
import type { BotEscalationAnswer, BotEscalationSummary } from '../../../shared/bots/personal/escalation'
import { NEUTRAL_TOOLS, type NeutralTool } from '../../../shared/harness/tools'
import type { LlmProviderOption } from '../../../shared/settings'
import { modelLabel } from '../../../shared/modelChoice'
import { resolveModelChoice } from '../../lib/modelChoice'
import { openThread } from '../../lib/openThread'
import { errorText, type BotDefinitionEntryView, type PersonalBotsClient } from '../../services/personalBotsClient'
import './bots.css'

/**
 * Automations → Bots (PR 6): personal bots, their one-time approval, runs and the inbox of walls
 * they wait at. Everything goes through the daemon; nothing here decides what a bot may do.
 */

export interface BotsWorkspaceProps {
  client: PersonalBotsClient
  providers: LlmProviderOption[]
  skills: Array<{ id: string; name: string; available: boolean }>
  active?: boolean
}

const TOOL_LABELS: Record<NeutralTool, string> = {
  read: 'Read files',
  list: 'List folders',
  search: 'Search files',
  edit: 'Edit files',
  write: 'Create and overwrite files',
  shell: 'Run shell commands in a sandbox',
  web_fetch: 'Fetch web pages',
  web_search: 'Search the web'
}

const STATUS_WORDS: Record<BotActivationSummary['status'], string> = {
  queued: 'Waiting to start',
  running: 'Running',
  waiting_grant: 'Waiting for you',
  paused: 'Paused',
  blocked: 'Blocked',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Stopped'
}

const minutes = (ms: number): string => {
  const value = ms / 60_000
  return value >= 1 ? `${Math.round(value * 10) / 10} min` : `${Math.round(ms / 1000)} s`
}

const slug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'bot'

const requestId = (): string => `gui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

/** A new bot's starting definition: read-only, no tools, 15 minutes of work. */
export function newBotDefinition(name: string, provider: LlmProviderOption | undefined): BotDefinition {
  return {
    id: slug(name),
    name,
    role: '',
    main: {
      key: 'main',
      title: 'Main',
      agent: { instructions: '' },
      selection: { instanceId: provider?.instanceId ?? provider?.id ?? '', model: provider?.models[0]?.id ?? '' }
    },
    context: [],
    permissions: { tools: [], appTools: [], mcp: [], skills: [], workspace: null, budget: { maxActiveMs: DEFAULT_BOT_ACTIVE_MS }, audience: 'owner' },
    triggers: { manual: true }
  }
}

export function BotsWorkspace({ client, providers, skills, active = true }: BotsWorkspaceProps) {
  const [bots, setBots] = useState<BotSummary[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [entry, setEntry] = useState<(BotDefinitionEntryView & { summary: BotSummary; approval: BotApprovalView | null }) | null>(null)
  const [editing, setEditing] = useState<{ definition: BotDefinition; draftHash?: string } | null>(null)
  const [activations, setActivations] = useState<BotActivationSummary[]>([])
  const [escalations, setEscalations] = useState<BotEscalationSummary[]>([])
  const [approving, setApproving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const ticket = useRef(0)

  const refresh = useCallback(async () => {
    const mine = ++ticket.current
    try {
      const [list, open] = await Promise.all([client.list(), client.escalations()])
      if (mine !== ticket.current) return
      setBots(list)
      setEscalations(open.filter((item) => item.status === 'open'))
      const id = selected && list.some((bot) => bot.id === selected) ? selected : null
      if (id !== selected) setSelected(id)
      if (id) {
        const [detail, runs] = await Promise.all([client.get(id), client.activations(id)])
        if (mine !== ticket.current) return
        setEntry(detail)
        setActivations(runs)
      } else {
        setEntry(null)
        setActivations([])
      }
    } catch (cause) {
      if (mine === ticket.current) setError(errorText(cause))
    }
  }, [client, selected])

  useEffect(() => { if (active) void refresh() }, [active, refresh])
  useEffect(() => window.mousse.personalBots?.onChanged(() => { void refresh() }), [refresh])
  useEffect(() => window.mousse.personalBots?.onEscalation(() => { void refresh() }), [refresh])

  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(null)
    try {
      await action()
      await refresh()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }
  const run = (action: () => Promise<unknown>): void => { void perform(action) }

  const names = useMemo(() => new Map(bots.map((bot) => [bot.id, bot.name])), [bots])

  if (editing) {
    return <BotEditor
      definition={editing.definition}
      isNew={!editing.draftHash}
      providers={providers}
      skills={skills}
      busy={busy}
      error={error}
      onCancel={() => { setEditing(null); setError(null) }}
      onSave={(definition, publish) => run(async () => {
        const saved = await client.save(definition, editing.draftHash)
        if (publish) await client.publish(saved.id, saved.draftHash)
        setSelected(saved.id)
        setEditing(null)
      })}
    />
  }

  return <div className="bots" data-bots-workspace="">
    <aside className="bots__list" aria-label="Bots">
      <div className="bots__list-head">
        <h2>Bots</h2>
        <button type="button" className="btn" data-action="new-bot" onClick={() => setEditing({ definition: newBotDefinition('New bot', providers[0]) })}>
          <Plus size={14} /> New bot
        </button>
      </div>
      {bots.length === 0 && <p className="bots__muted">No bots yet. Bots run tasks within their granted permissions.</p>}
      <ul>
        {bots.map((bot) => <li key={bot.id}>
          <button type="button" className="bots__row" aria-current={bot.id === selected ? 'true' : undefined} onClick={() => setSelected(bot.id)}>
            <span className="bots__row-name">{bot.name}</span>
            <span className="bots__muted">{!bot.revision ? 'Draft' : bot.needsApproval.length ? 'Needs approval' : bot.grant ? 'Approved' : 'Not approved'}</span>
            {bot.openEscalations > 0 && <span className="bots__badge" aria-label={`${bot.openEscalations} waiting for you`}>{bot.openEscalations}</span>}
          </button>
        </li>)}
      </ul>
    </aside>
    <main className="bots__main">
      {error && <p className="bots__error" role="alert">{error}</p>}
      {escalations.length > 0 && <section className="bots__inbox" aria-label="Waiting for you">
        <h3>Waiting for you</h3>
        {escalations.map((item) => <EscalationRow key={item.id} escalation={item} botName={names.get(item.botId)} busy={busy}
          onAnswer={(answer, amount) => run(() => client.respond(item.id, answer, amount))} />)}
      </section>}
      {entry ? <BotDetail
        entry={entry}
        activations={activations}
        busy={busy}
        onEdit={() => setEditing({ definition: entry.draft, draftHash: entry.draftHash })}
        onPublish={() => run(() => client.publish(entry.id, entry.draftHash))}
        onReview={() => setApproving(true)}
        onRevoke={() => run(() => client.revoke(entry.id))}
        onDelete={() => run(() => client.remove(entry.id))}
        onActivate={(input) => run(() => client.activate(entry.id, input, requestId()))}
        onStop={(id) => run(() => client.stop(id))}
        onContinue={(id, ack) => run(() => client.continue(id, ack))}
        onMarkDone={(id, ack) => run(() => client.markDone(id, ack))}
        onResetContext={(key) => run(() => client.resetContext(entry.id, key))}
      /> : bots.length > 0 ? <p className="bots__muted bots__empty">Choose a bot.</p> : null}
    </main>
    {approving && entry?.approval && <ApprovalDialog
      name={entry.summary.name}
      approval={entry.approval}
      busy={busy}
      onClose={() => setApproving(false)}
      onApprove={() => run(async () => { await client.approve(entry.id, entry.approval!.digest); setApproving(false) })}
    />}
  </div>
}

function BotDetail(props: {
  entry: BotDefinitionEntryView & { summary: BotSummary; approval: BotApprovalView | null }
  activations: BotActivationSummary[]
  busy: boolean
  onEdit(): void
  onPublish(): void
  onReview(): void
  onRevoke(): void
  onDelete(): void
  onActivate(input: string): void
  onStop(id: string): void
  onContinue(id: string, acknowledge: BotAcknowledgement | undefined): void
  onMarkDone(id: string, acknowledge: BotAcknowledgement | undefined): void
  onResetContext(key: string): void
}) {
  const { entry, busy } = props
  const [input, setInput] = useState('')
  const [confirming, setConfirming] = useState<{ kind: 'delete' } | { kind: 'reset'; key: string; title: string } | null>(null)
  const summary = entry.summary
  // A revision is named by its content hash: a draft that differs from it is unpublished.
  const unpublished = !entry.published || entry.published.revision !== entry.draftHash
  const canRun = Boolean(summary.revision && summary.grant && summary.needsApproval.length === 0)
  return <section className="bots__detail" aria-label={summary.name}>
    <header className="bots__detail-head">
      <h2>{summary.name}</h2>
      <div className="bots__actions">
        <button type="button" className="btn btn-sm" disabled={busy} onClick={props.onEdit}>Edit</button>
        {(!summary.revision || unpublished) && <button type="button" className="btn btn-sm" disabled={busy} onClick={props.onPublish}>Publish</button>}
        {summary.revision && (summary.needsApproval.length > 0 || !summary.grant) && <button type="button" className="btn btn-sm btn-primary" disabled={busy || !entry.approval} onClick={props.onReview}>Review and approve</button>}
        {summary.grant && <button type="button" className="btn btn-sm" disabled={busy} onClick={props.onRevoke}>Revoke</button>}
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setConfirming({ kind: 'delete' })}>Delete</button>
      </div>
    </header>
    {summary.role && <p className="bots__role">{summary.role}</p>}
    {!summary.revision && <p className="bots__muted">Publish this bot, then approve its permissions, before it can run.</p>}
    {summary.revision && summary.needsApproval.length > 0 && <div className="bots__notice">
      <p>This revision asks for more than you approved:</p>
      <ul>{summary.needsApproval.map((line) => <li key={line.text}>{line.text}</li>)}</ul>
    </div>}
    {(summary.schedules ?? []).length > 0 && <ul className="bots__muted" aria-label="Schedules">
      {(summary.schedules ?? []).map((schedule) => <li key={schedule.id}>
        Schedule {schedule.id}: {schedule.nextRunAt ? `next ${new Date(schedule.nextRunAt).toLocaleString()}` : 'does not run again'}
        {schedule.skipped && <> · {new Date(schedule.skipped.at).toLocaleString()} {BOT_SCHEDULE_SKIP_TEXT[schedule.skipped.reason] ?? `skipped (${schedule.skipped.reason})`}</>}
      </li>)}
    </ul>}
    <form className="bots__run" onSubmit={(event) => {
      event.preventDefault()
      if (!input.trim()) return
      props.onActivate(input.trim())
      setInput('')
    }}>
      <label htmlFor="bots-run-input">Give it something to do</label>
      <textarea id="bots-run-input" rows={2} value={input} disabled={!canRun || busy} onChange={(event) => setInput(event.target.value)} placeholder={canRun ? 'For example: fix the broken links on the docs site' : 'Approve this bot first'} />
      <button type="submit" className="btn btn-sm btn-primary" disabled={!canRun || busy || !input.trim()}>Run</button>
    </form>
    {(entry.published?.context.length ?? 0) > 0 && <section className="bots__contexts" aria-label="Context threads">
      <h3>Context threads</h3>
      <ul>{entry.published!.context.map((thread) => <li key={thread.key}>
        <span>{thread.title}</span>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setConfirming({ kind: 'reset', key: thread.key, title: thread.title })}>Reset context</button>
      </li>)}</ul>
    </section>}
    <h3>Activity</h3>
    {props.activations.length === 0 && <p className="bots__muted">No runs yet.</p>}
    <ul className="bots__activity">
      {props.activations.map((activation) => <ActivationRow key={activation.id} activation={activation} busy={busy}
        onStop={() => props.onStop(activation.id)}
        onContinue={(ack) => props.onContinue(activation.id, ack)}
        onMarkDone={(ack) => props.onMarkDone(activation.id, ack)} />)}
    </ul>
    {confirming?.kind === 'delete' && <BotConfirmDialog
      title={`Delete “${summary.name}”?`}
      body="Its runs stop and its threads go to the trash."
      confirmLabel="Delete"
      onCancel={() => setConfirming(null)}
      onConfirm={() => { setConfirming(null); props.onDelete() }}
    />}
    {confirming?.kind === 'reset' && <BotConfirmDialog
      title={`Reset “${confirming.title}”?`}
      body="The bot's next consult in this context starts with no history."
      confirmLabel="Reset context"
      onCancel={() => setConfirming(null)}
      onConfirm={() => { const key = confirming.key; setConfirming(null); props.onResetContext(key) }}
    />}
  </section>
}

export function ActivationRow({ activation, busy, onStop, onContinue, onMarkDone }: {
  activation: BotActivationSummary
  busy: boolean
  onStop(): void
  onContinue(acknowledge: BotAcknowledgement | undefined): void
  onMarkDone(acknowledge: BotAcknowledgement | undefined): void
}) {
  const pending = activation.unknownCalls.filter((call) => !call.acknowledged)
  const shown = acknowledgementOf(activation)
  // The box belongs to the exact set shown: a new pause, a changed list or a refresh clears it.
  const shownKey = JSON.stringify([activation.status, shown?.calls ?? [], shown?.uncertainRunId ?? null])
  const [checkedFor, setCheckedFor] = useState<string | null>(null)
  const checked = checkedFor === shownKey
  const needsCheck = shown !== undefined
  const ended = ENDED_ACTIVATION_STATUSES.has(activation.status)
  const blockedByCheck = needsCheck && !checked
  return <li className="bots__activation" data-status={activation.status}>
    <div className="bots__activation-head">
      <strong>{STATUS_WORDS[activation.status]}</strong>
      <span className="bots__muted">{activation.trigger.input.split('\n')[0]}</span>
    </div>
    <div className="bots__muted bots__counters">
      {activation.counters.requests} requests · {activation.counters.toolCalls} tool calls · {minutes(activation.counters.activeMs)} of work
      {activation.endReason && <> · {activation.endReason.replace(/_/g, ' ')}</>}
    </div>
    {activation.openEscalation && <p className="bots__muted">Waiting for you to answer: {activation.openEscalation.permissionText}</p>}
    {activation.result && <p className="bots__result">{activation.result}</p>}
    {needsCheck && !ended && <div className="bots__unknown">
      <p>{activation.uncertain ? 'Mousse stopped while this bot was working, so the outcome of its last tool calls is unknown.' : 'These tool calls were cut off, so their outcome is unknown:'}</p>
      {pending.length > 0 && <ul>{pending.map((call) => <li key={call.invocationId}><code>{call.tool}</code> ({call.role === 'main' ? 'main thread' : 'context thread'}, run {call.runId.slice(0, 8)})</li>)}</ul>}
      <label className="bots__ack"><input type="checkbox" checked={checked} onChange={(event) => setCheckedFor(event.target.checked ? shownKey : null)} /> I've checked what these calls did</label>
    </div>}
    <div className="bots__actions">
      {activation.threadId && <button type="button" className="btn btn-sm" onClick={() => void openThread(activation.threadId!)}>Open thread</button>}
      {!ended && <button type="button" className="btn btn-sm" disabled={busy} onClick={onStop}>Stop</button>}
      {activation.canContinue && <button type="button" className="btn btn-sm btn-primary" disabled={busy || blockedByCheck} onClick={() => { setCheckedFor(null); onContinue(shown) }}>Continue</button>}
      {activation.canMarkDone && <button type="button" className="btn btn-sm" disabled={busy || blockedByCheck} onClick={() => { setCheckedFor(null); onMarkDone(shown) }}>Mark done</button>}
    </div>
  </li>
}

export function EscalationRow({ escalation, botName, busy, onAnswer }: {
  escalation: BotEscalationSummary
  botName: string | undefined
  busy: boolean
  onAnswer(answer: BotEscalationAnswer, amount?: number): void
}) {
  const budget = 'budget' in escalation.permission ? escalation.permission.budget : null
  const isTime = budget?.key === 'maxActiveMs'
  const [more, setMore] = useState(() => budget?.amount !== undefined ? (isTime ? Math.max(1, Math.round(budget.amount / 60_000)) : budget.amount) : (isTime ? 15 : 10))
  const [showMore, setShowMore] = useState(false)
  const optionsId = useId()
  // A limit that names no amount has no "once" answer: the owner says how much, so the amount shows at once.
  const canAllowOnce = !budget || budget.amount !== undefined
  const allowMore = budget ? <>
    <label className="bots__more">
      <input type="number" min={1} value={more} onChange={(event) => setMore(Math.max(1, Number(event.target.value) || 1))} aria-label={isTime ? 'Minutes' : 'Amount'} />
      {isTime ? 'minutes' : ''}
    </label>
    <button type="button" className={`btn btn-sm${canAllowOnce ? '' : ' btn-primary'}`} disabled={busy} title="Only for this run" onClick={() => onAnswer('allow_more', isTime ? more * 60_000 : more)}>Allow {more}{isTime ? ' min' : ''} more this time</button>
  </> : null
  return <div className="bots__escalation">
    <div>
      <strong>{botName ?? escalation.botId}</strong> asks: {escalation.permissionText}
    </div>
    {escalation.reason && <p className="bots__muted">{escalation.reason}</p>}
    <p className="bots__muted">Waits until {new Date(escalation.expiresAt).toLocaleString()}</p>
    <div className="bots__actions">
      {canAllowOnce
        ? <button type="button" className="btn btn-sm btn-primary" disabled={busy} title={`Only for this run: ${escalation.permissionText}`} onClick={() => budget ? onAnswer('allow_once', budget.amount) : onAnswer('allow_once')}>Allow once</button>
        : allowMore}
      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onAnswer('deny')}>Deny</button>
      {canAllowOnce && <button type="button" className="bots__disclosure" aria-expanded={showMore} aria-controls={optionsId} onClick={() => setShowMore((open) => !open)}>
        <ChevronRight size={12} aria-hidden="true" className="bots__disclosure-chevron" />More options
      </button>}
    </div>
    {canAllowOnce && showMore && <div className="bots__actions" id={optionsId}>
      {budget
        ? allowMore
        : <button type="button" className="btn btn-sm" disabled={busy} title={`Adds “${escalation.permissionText}” to what this bot may always do`} onClick={() => onAnswer('allow_bot')}>Allow for this bot</button>}
    </div>}
  </div>
}

/** The approval's lines by what they cover, so tools, folders (with read or edit access) and limits read apart. */
const APPROVAL_GROUPS: Array<{ title: string; kinds: BotPermissionLine['kind'][] }> = [
  { title: 'Tools', kinds: ['tool', 'app_tool', 'mcp', 'skill'] },
  { title: 'Folders', kinds: ['workspace'] },
  { title: 'Limits per run', kinds: ['budget'] }
]

export function ApprovalDialog({ name, approval, busy, onApprove, onClose }: {
  name: string
  approval: BotApprovalView
  busy: boolean
  onApprove(): void
  onClose(): void
}) {
  const allPass = approval.threads.every((thread) => thread.ok)
  return <Modal
    open
    title={`Approve ${name}`}
    className="bots-dialog"
    onClose={onClose}
    footer={<>
      <button type="button" className="btn btn-sm" onClick={onClose}>Cancel</button>
      <button type="button" className="btn btn-sm btn-primary" disabled={busy || !allPass} onClick={onApprove}>Approve</button>
    </>}
  >
    <div className="bots__approval">
      <p>Once approved, the bot works inside these permissions without asking. It asks again only when it needs more.</p>
      {approval.added.length === 0 && <p className="bots__muted">Nothing new to approve.</p>}
      {APPROVAL_GROUPS.map((group) => {
        const lines = approval.added.filter((line) => group.kinds.includes(line.kind))
        return lines.length > 0 && <section key={group.title} aria-label={group.title}>
          <h4>{group.title}</h4>
          <ul>{lines.map((line) => <li key={line.text}>{line.text}</li>)}</ul>
        </section>
      })}
      <section aria-label="Where it runs">
        <h4>Where it runs</h4>
        <ul>{approval.threads.map((thread) => <li key={thread.key} data-ok={thread.ok ? 'true' : 'false'}>
          {thread.instanceId} · {modelLabel(resolveModelChoice({ instanceId: thread.instanceId, provider: thread.instanceId, model: thread.model }))}: {thread.ok ? 'can hold these permissions' : thread.reason ?? 'cannot hold these permissions'}
        </li>)}</ul>
      </section>
      {!allPass && <p className="bots__error">Every thread's runtime must be able to hold these permissions before you can approve.</p>}
    </div>
  </Modal>
}

/** Delete and Reset context ask in the app's dialog; Escape and Cancel change nothing. */
function BotConfirmDialog({ title, body, confirmLabel, onCancel, onConfirm }: {
  title: string
  body: string
  confirmLabel: string
  onCancel(): void
  onConfirm(): void
}) {
  return <Modal
    open
    title={title}
    className="bots-dialog"
    onClose={onCancel}
    footer={<>
      <button type="button" className="btn btn-sm" onClick={onCancel}>Cancel</button>
      <button type="button" className="btn btn-sm btn-danger" data-action="confirm" onClick={onConfirm}>{confirmLabel}</button>
    </>}
  >
    <p>{body}</p>
  </Modal>
}

/** The note the editor shows next to the shell permission (PR 6 §3). */
export function shellNote(roots: readonly string[]): string {
  const where = roots.length ? roots.join(', ') : 'the bot\'s folders'
  return `Commands can't see the rest of your home folder. That includes your Git settings (~/.gitconfig), SSH keys, and tools installed in your home folder, such as nvm, pyenv or cargo. Tools installed system-wide, or inside ${where}, still work.`
}

function BotEditor({ definition, isNew, providers, skills, busy, error, onCancel, onSave }: {
  definition: BotDefinition
  isNew: boolean
  providers: LlmProviderOption[]
  skills: Array<{ id: string; name: string; available: boolean }>
  busy: boolean
  error: string | null
  onCancel(): void
  onSave(definition: BotDefinition, publish: boolean): void
}) {
  const [draft, setDraft] = useState<BotDefinition>(definition)
  const [roots, setRoots] = useState((definition.permissions.workspace?.roots ?? []).join('\n'))
  const fieldId = useId()
  const instructions = 'instructions' in draft.main.agent ? draft.main.agent.instructions : ''
  const permissions = draft.permissions
  const providerKey = draft.main.selection.instanceId
  const provider = providers.find((option) => (option.instanceId ?? option.id) === providerKey)
  const setPermissions = (patch: Partial<BotDefinition['permissions']>) => setDraft((current) => ({ ...current, permissions: { ...current.permissions, ...patch } }))
  const setBudget = (key: 'maxTurns' | 'maxToolCalls', value: string) => {
    const budget = { ...permissions.budget }
    const number = Number(value)
    if (!value.trim() || !Number.isFinite(number) || number <= 0) delete budget[key]
    else budget[key] = Math.round(number)
    setPermissions({ budget })
  }
  const build = (): BotDefinition => {
    const rootList = roots.split('\n').map((line) => line.trim()).filter(Boolean)
    return {
      ...draft,
      id: isNew ? slug(draft.name) : draft.id,
      permissions: {
        ...permissions,
        workspace: rootList.length ? keepFolderAccess(rootList, permissions.workspace) : null
      }
    }
  }
  const rootList = roots.split('\n').map((line) => line.trim()).filter(Boolean)
  return <form className="bots bots--editor" aria-label="Bot editor" onSubmit={(event) => { event.preventDefault(); onSave(build(), false) }}>
    <header className="bots__detail-head">
      <h2>{isNew ? 'New bot' : `Edit ${definition.name}`}</h2>
      <div className="bots__actions">
        <button type="button" className="btn btn-sm" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn btn-sm" disabled={busy}>Save draft</button>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => onSave(build(), true)}>Save and publish</button>
      </div>
    </header>
    {error && <p className="bots__error" role="alert">{error}</p>}
    <div className="bots__fields">
      <label>Name<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
      <label>Role<textarea rows={2} value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value })} placeholder="What this bot is for" /></label>
      <label>Instructions<textarea rows={5} value={instructions} onChange={(event) => setDraft({ ...draft, main: { ...draft.main, agent: { instructions: event.target.value } } })} /></label>
      <div className="bots__field">
        <span id={`${fieldId}-provider`}>Runs on</span>
        <Select
          ariaLabelledBy={`${fieldId}-provider`}
          value={providerKey}
          placeholder="Choose a provider"
          onChange={(value) => {
            const next = providers.find((option) => (option.instanceId ?? option.id) === value)
            setDraft({ ...draft, main: { ...draft.main, selection: { instanceId: value, model: next?.models[0]?.id ?? '' } } })
          }}
          options={[
            // A provider that is no longer listed stays visible as the current value.
            ...(!provider && providerKey ? [{ value: providerKey, label: providerKey }] : []),
            ...providers.map((option) => ({ value: option.instanceId ?? option.id, label: option.label }))
          ]}
        />
      </div>
      <div className="bots__field">
        <span id={`${fieldId}-model`}>Model</span>
        <Select
          ariaLabelledBy={`${fieldId}-model`}
          value={draft.main.selection.model}
          placeholder="Choose a model"
          onChange={(model) => setDraft({ ...draft, main: { ...draft.main, selection: { ...draft.main.selection, model } } })}
          options={[
            ...(draft.main.selection.model && !provider?.models.some((model) => model.id === draft.main.selection.model)
              ? [{ value: draft.main.selection.model, label: modelLabel(resolveModelChoice({ instanceId: draft.main.selection.instanceId, provider: draft.main.selection.instanceId, model: draft.main.selection.model })) }]
              : []),
            ...(provider?.models.map((model) => ({ value: model.id, label: model.label })) ?? [])
          ]}
        />
      </div>
      <fieldset>
        <legend>Tools</legend>
        {NEUTRAL_TOOLS.map((tool) => <SwitchRow
          key={tool}
          label={TOOL_LABELS[tool]}
          checked={permissions.tools.includes(tool)}
          onChange={(on) => setPermissions({ tools: on ? [...permissions.tools, tool] : permissions.tools.filter((item) => item !== tool) })}
        />)}
        {permissions.tools.includes('shell') && <p className="bots__note">{shellNote(rootList)}</p>}
      </fieldset>
      <fieldset>
        <legend>Folders</legend>
        <label>One folder per line (absolute paths)<textarea rows={3} value={roots} onChange={(event) => setRoots(event.target.value)} /></label>
        <div className="bots__field">
          <span id={`${fieldId}-access`}>Access</span>
          <Select<'read' | 'write'>
            ariaLabelledBy={`${fieldId}-access`}
            value={permissions.workspace?.access ?? 'read'}
            onChange={(access) => setPermissions({ workspace: keepFolderAccess(rootList, { roots: rootList, access, ...(permissions.workspace?.rootAccess ? { rootAccess: permissions.workspace.rootAccess } : {}) }) })}
            options={[{ value: 'read', label: 'Read only' }, { value: 'write', label: 'Read and edit' }]}
          />
        </div>
      </fieldset>
      {skills.length > 0 && <fieldset>
        <legend>Skills</legend>
        {skills.filter((skill) => skill.available || permissions.skills.includes(skill.id)).map((skill) => <SwitchRow
          key={skill.id}
          label={skill.name}
          checked={permissions.skills.includes(skill.id)}
          onChange={(on) => setPermissions({ skills: on ? [...permissions.skills, skill.id] : permissions.skills.filter((item) => item !== skill.id) })}
        />)}
      </fieldset>}
      <fieldset>
        <legend>Limits per run</legend>
        <label>Work time (minutes)<input type="number" min={1} max={1440} value={Math.round(permissions.budget.maxActiveMs / 60_000)} onChange={(event) => setPermissions({ budget: { ...permissions.budget, maxActiveMs: Math.max(1, Math.min(1440, Math.round(Number(event.target.value) || 1))) * 60_000 } })} /></label>
        <label>Model requests per run, retries included (optional)<input type="number" min={1} value={permissions.budget.maxTurns ?? ''} onChange={(event) => setBudget('maxTurns', event.target.value)} /></label>
        <label>Tool calls per run (optional)<input type="number" min={1} value={permissions.budget.maxToolCalls ?? ''} onChange={(event) => setBudget('maxToolCalls', event.target.value)} /></label>
      </fieldset>
    </div>
  </form>
}

/** One permission as a row: its name, and the shared switch on the right. */
function SwitchRow({ label, checked, onChange }: { label: string; checked: boolean; onChange(on: boolean): void }) {
  return <div className="bots__switch-row">
    <span>{label}</span>
    <Switch checked={checked} onChange={onChange} label={label} />
  </div>
}

/** The folders as edited, keeping each remaining folder's own access (an answer may have set it). */
export function keepFolderAccess(roots: string[], workspace: BotDefinition['permissions']['workspace']): NonNullable<BotDefinition['permissions']['workspace']> {
  const access = workspace?.access ?? 'read'
  const own = Object.entries(workspace?.rootAccess ?? {}).filter(([root, value]) => roots.includes(root) && value !== access)
  return own.length ? { roots, access, rootAccess: Object.fromEntries(own) } : { roots, access }
}
