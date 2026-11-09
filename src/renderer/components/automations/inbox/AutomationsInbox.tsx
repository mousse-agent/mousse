// The Automations page: the Runs list in the Chats sidebar's place (live runs, Needs you with Assigned to bots, Worth a
// look, FYI and the quiet ones folded), and beside it the open run's thread as the ordinary thread view (the workspace),
// or Manage, Edit details or the drafts. Keys: j/k, Enter, e, u, 1–4, / and ?.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { openForPerson, type InboxRun } from '../../../../shared/automationInbox'
import type { AutomationItem } from '../../../../shared/automations'
import { useCommand } from '../../../commands/commandRegistry'
import { Bot, ChevronRight, Clock, Coins, FileText, Folder, LayoutGrid, Play, Repeat, Search, Settings, Undo2, User, X } from '../../../lib/icons'
import { useAppStore } from '../../../stores/appStore'
import { answerAttention } from '../../../services/automationsClient'
import { createPersonalBotsClient } from '../../../services/personalBotsClient'
import { ownedWhenText, viewerTimeZone } from '../automationTime'
import { DeleteConfirm } from '../AutomationDialogs'
import { useAutomationLibrary } from '../WhoDoPickers'
import { DraftsPane } from './DraftsPane'
import { EditDetailsPane } from './EditDetailsPane'
import { InboxComposer, newKey, type InboxComposerHandle } from './InboxComposer'
import {
  automationsById, groupOf, inboxGroups, LEVEL_KEYS, moveCursor, noReport, resolvable, rowKey, runLine, runName, runTime,
  costText, tokensText, type ListRow
} from './inboxModel'
import { ManageTable, whenColumn } from './ManageTable'
import { AssigneeChip, botNameOf, RunIcon, RunPrChip, TriggerIcon, LEVEL_VIEW } from './RunParts'
import {
  closePane, openManage, openRun, refreshInbox, resolveRun, runAutomationNow, setInboxFilter, toggleFold, undoResolve,
  useInboxShowsThread, useInboxStore, openEdit, openDrafts, type InboxFilter
} from './inboxStore'
import './inbox.css'

/** How often the open page reads again, for what sends no change event (bots' runs, next runs). */
const POLL_MS = 15_000

export const INBOX_KEYS: Array<[string, string]> = [
  ['j / k', 'Next / previous'],
  ['Enter', 'Open, or unfold'],
  ['e', 'Resolve'],
  ['u', 'Undo resolve'],
  ['1–4', 'Jump to a level'],
  ['/', 'Filter'],
  ['?', 'These keys']
]

function editable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || Boolean(target.closest('.xterm, .monaco-editor')))
}

/** Whether focus is on the Automations page (its list or its pane), not elsewhere in the window. */
export function pageHasFocus(doc: Pick<Document, 'activeElement' | 'querySelector'> | undefined = typeof document === 'undefined' ? undefined : document): boolean {
  const page = doc?.querySelector('[data-automations-workspace]:not([hidden])')
  const focused = doc?.activeElement
  return Boolean(page && focused && page.contains(focused))
}

export function AutomationsInbox({ active }: { active: boolean }) {
  const index = useInboxStore((s) => s.index)
  const inbox = useInboxStore((s) => s.inbox)
  const loadError = useInboxStore((s) => s.loadError)
  const actionError = useInboxStore((s) => s.actionError)
  const filter = useInboxStore((s) => s.filter)
  const openRunId = useInboxStore((s) => s.openRunId)
  const pane = useInboxStore((s) => s.pane)
  const folds = useInboxStore((s) => s.folds)
  const manageExpanded = useInboxStore((s) => s.manageExpanded)
  const editJobId = useInboxStore((s) => s.editJobId)
  const showsThread = useInboxShowsThread()
  const profileId = useAppStore((s) => s.profileId)
  const { library, reload: reloadLibrary } = useAutomationLibrary(profileId)
  const [cursor, setCursor] = useState<string | null>(openRunId)
  const [keysOpen, setKeysOpen] = useState(false)
  const [searching, setSearching] = useState(false)
  const [deleting, setDeleting] = useState<AutomationItem | null>(null)
  const composerRef = useRef<InboxComposerHandle>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const viewerZone = useMemo(viewerTimeZone, [])
  const now = new Date()

  // The daemon's list and runs: read when the page opens, when anything changes, and every few seconds while open.
  useEffect(() => {
    void refreshInbox()
    const offJobs = window.mousse.scheduled.onUpdated(() => { void refreshInbox() })
    const offBots = window.mousse.personalBots?.onChanged?.(() => { void refreshInbox() }) ?? (() => undefined)
    return () => { offJobs(); offBots() }
  }, [])
  useEffect(() => {
    if (!active) return
    void refreshInbox()
    reloadLibrary()
    const timer = setInterval(() => { void refreshInbox() }, POLL_MS)
    return () => clearInterval(timer)
  }, [active, reloadLibrary])

  const automations = useMemo(() => automationsById(index?.items), [index])
  const jobs = useMemo(() => (index?.items ?? []).filter((item) => item.kind === 'job' && !item.draft), [index])
  const drafts = useMemo(() => (index?.items ?? []).filter((item) => item.kind === 'job' && item.draft), [index])
  const asks = useMemo(() => (index?.items ?? []).filter((item) => item.kind === 'ask' && item.attention?.answer), [index])
  const runs = useMemo(() => inbox?.runs ?? [], [inbox])
  const groups = useMemo(() => inboxGroups(runs, filter, automations, folds), [runs, filter, automations, folds])
  const rows = useMemo(() => groups.flatMap((group) => group.rows), [groups])
  const openRunRecord = runs.find((run) => run.id === openRunId)
  const metaOf = (jobId: string) => inbox?.meta.find((entry) => entry.jobId === jobId)

  // A run opens beside the list as soon as there is one (the first that needs the person, else the newest), and a
  // filter that hides the open run opens its own first run.
  useEffect(() => {
    if (!active || pane !== 'run' || !inbox) return
    if (openRunId && rows.some((row) => row.kind === 'run' && row.run.id === openRunId)) return
    if (openRunId && !filter.automationId && !filter.project && !filter.text) return
    const first = rows.find((row) => row.kind === 'run')
    if (first?.kind === 'run') { openRun(first.run); setCursor(first.run.id) }
  }, [active, openRunId, pane, inbox, rows, filter])

  useCommand('thread.new', () => composerRef.current?.focus(), () => active && pageHasFocus(), { keysOnly: true })

  const activate = (row: ListRow) => {
    setCursor(rowKey(row))
    if (row.kind === 'run') openRun(row.run)
    else toggleFold(row.fold)
  }
  // Moving the cursor onto a run opens it, as in Mail; a fold opens with Enter.
  const focusRow = (row: ListRow) => {
    setCursor(rowKey(row))
    if (row.kind === 'run') openRun(row.run)
  }

  // The inbox keys: only while the page is open and nothing editable has focus.
  useEffect(() => {
    if (!active) return
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      if (editable(event.target)) return
      if (document.querySelector('[role="dialog"], [role="menu"], .ui-select-list')) return
      const key = event.key
      if (key === 'j' || key === 'ArrowDown') { const next = moveCursor(rows, cursor, 1); if (next) focusRow(next) }
      else if (key === 'k' || key === 'ArrowUp') { const next = moveCursor(rows, cursor, -1); if (next) focusRow(next) }
      else if (key === 'Enter') { const row = rows.find((entry) => rowKey(entry) === cursor); if (row) activate(row); else return }
      else if (key === 'e') { const run = resolvable(rows, cursor, openRunRecord); if (run) void resolveRun(run.id) }
      else if (key === 'u') void undoResolve()
      else if (LEVEL_KEYS[key]) { const first = rows.find((row) => row.group === LEVEL_KEYS[key]); if (first) focusRow(first) }
      else if (key === '/') { setSearching(true); requestAnimationFrame(() => searchRef.current?.focus()) }
      else if (key === '?') setKeysOpen((value) => !value)
      else if (key === 'Escape' && (keysOpen || pane !== 'run')) { setKeysOpen(false); closePane(); event.stopPropagation() }
      else return
      event.preventDefault()
    }
    // Capture, so Esc closes Manage or the keys before it closes the page.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  useEffect(() => {
    listRef.current?.querySelector(`[data-row-key="${cursor}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [cursor])

  const setText = (text: string | undefined) => setInboxFilter({ ...filter, ...(text ? { text } : { text: undefined }) })
  const onSearchKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') { setText(undefined); setSearching(false); event.currentTarget.blur() }
  }

  const toggleAutomation = (item: AutomationItem, on: boolean) => {
    const work = async () => {
      if (on && item.pausedBy === 'bot' && item.link.kind === 'job' && item.link.botId) await createPersonalBotsClient(window.mousse.platformRequest).resume(item.link.botId)
      else if (on) await window.mousse.scheduled.resume(item.id)
      else await window.mousse.scheduled.pause(item.id)
    }
    void work().catch((cause) => useInboxStore.setState({ actionError: cause instanceof Error ? cause.message : String(cause) })).finally(() => void refreshInbox())
  }

  const editItem = editJobId ? jobs.find((item) => item.id === editJobId) ?? drafts.find((item) => item.id === editJobId) : undefined
  const empty = Boolean(inbox && index) && runs.length === 0
  const lastResolved = inbox?.undo
  const needsCount = groups.find((group) => group.key === 'needs_you')?.count ?? 0

  return (
    <div className="inbox" data-testid="automations-inbox" data-thread={showsThread || undefined}>
      <aside className="inbox-list" aria-label="Runs">
        <div className="inbox-head">
          <InboxComposer ref={composerRef} bots={library.bots} onBotMade={reloadLibrary} />
          <button type="button" className="inbox-icon-btn" data-testid="inbox-manage-btn" aria-pressed={pane === 'manage'} title="Manage automations" aria-label="Manage automations" onClick={() => (pane === 'manage' ? closePane() : openManage())}>
            <LayoutGrid size={15} strokeWidth={1.8} />
          </button>
          <div className="inbox-keys-anchor">
            <button type="button" className="inbox-icon-btn inbox-keys-btn" data-testid="inbox-keys-btn" aria-pressed={keysOpen} aria-label="Keyboard shortcuts" onClick={() => setKeysOpen((value) => !value)}>?</button>
            {keysOpen && <KeysPopover onClose={() => setKeysOpen(false)} />}
          </div>
        </div>

        <FilterHeader filter={filter} automation={filter.automationId ? automations.get(filter.automationId) : undefined} now={now} viewerZone={viewerZone} />

        {(searching || filter.text) && (
          <label className="inbox-search">
            <Search size={13} strokeWidth={1.8} aria-hidden="true" />
            <input ref={searchRef} data-testid="inbox-search" placeholder="Filter runs" aria-label="Filter runs" value={filter.text ?? ''} onChange={(event) => setText(event.target.value)} onKeyDown={onSearchKey} />
            <button type="button" className="inbox-icon-btn small" title="Clear filter" aria-label="Clear filter" onClick={() => { setText(undefined); setSearching(false) }}><X size={12} /></button>
          </label>
        )}

        {loadError ? (
          <p className="inbox-note" role="alert"><span title={loadError}>Automations did not load.</span><button type="button" className="inbox-text-btn" onClick={() => void refreshInbox()}>Retry</button></p>
        ) : null}
        {actionError ? <p className="inbox-note" role="alert">{actionError}</p> : null}

        <div className="inbox-scroll" ref={listRef} role="listbox" aria-label="Runs" data-testid="inbox-runs">
          {drafts.length && !filter.automationId ? (
            <button type="button" className="inbox-fold inbox-drafts-row" data-testid="inbox-drafts-row" aria-pressed={pane === 'drafts'} onClick={() => (pane === 'drafts' ? closePane() : openDrafts())}>
              <FileText size={13} strokeWidth={1.8} aria-hidden="true" /><span>Drafts · {drafts.length}</span>
            </button>
          ) : null}
          {asks.length && !filter.automationId ? (
            <div className="inbox-group" data-group="asks" role="group" aria-label="Asks">
              {!needsCount ? <div className="inbox-group-head"><span>Needs you</span><span className="inbox-group-count">{asks.length}</span></div> : null}
              {asks.map((item) => <AskRow key={item.key} item={item} />)}
            </div>
          ) : null}
          {groups.map((group) => (
            <div key={group.key} className="inbox-group" data-group={group.key} data-testid="inbox-group" role="group" aria-label={group.label}>
              {group.key !== 'live' && group.key !== 'quiet' && (
                <div className="inbox-group-head"><span>{group.label}</span>{group.count + (group.key === 'needs_you' ? asks.length : 0) > 0 && <span className="inbox-group-count">{group.count + (group.key === 'needs_you' ? asks.length : 0)}</span>}</div>
              )}
              {group.rows.map((row) => (
                <InboxRow key={rowKey(row)} row={row} automation={row.kind === 'run' ? automations.get(row.run.jobId) : undefined} automations={automations} cursor={cursor === rowKey(row)} open={row.kind === 'run' && row.run.id === openRunId && pane === 'run'} folds={folds} now={now} onActivate={() => activate(row)} />
              ))}
            </div>
          ))}
          {inbox && runs.length > 0 && rows.length === 0 ? <p className="inbox-note">No run matches.</p> : null}
          {empty ? <p className="inbox-list-empty" data-testid="inbox-no-runs">No runs yet.</p> : null}
        </div>

        {lastResolved ? (
          <div className="inbox-undo" role="status" data-testid="inbox-undo">
            <span className="inbox-undo-text">Resolved · <strong>{automations.get(runs.find((run) => run.id === lastResolved.runId)?.jobId ?? '')?.name ?? lastResolved.jobName}</strong></span>
            <button type="button" className="inbox-text-btn" title="Undo · u" onClick={() => void undoResolve()}><Undo2 size={13} strokeWidth={1.8} aria-hidden="true" />Undo</button>
          </div>
        ) : null}
      </aside>

      {!showsThread ? (
        <section className="inbox-pane" aria-label={pane === 'manage' ? 'Manage automations' : pane === 'drafts' ? 'Drafts' : pane === 'edit' ? 'Edit details' : 'Run'}>
          {pane === 'manage' ? (
            <ManageTable automations={jobs} inbox={inbox} expanded={manageExpanded} now={now} viewerZone={viewerZone} onToggle={toggleAutomation} onDelete={setDeleting} />
          ) : pane === 'drafts' ? (
            <DraftsPane drafts={drafts} meta={metaOf} bots={library.bots} onBotMade={reloadLibrary} />
          ) : pane === 'edit' && editItem ? (
            <EditDetailsPane key={editItem.id} item={editItem} onDelete={setDeleting} />
          ) : empty ? (
            <EmptyState automations={jobs} now={now} viewerZone={viewerZone} />
          ) : openRunRecord ? (
            <RunWithoutThread run={openRunRecord} automation={automations.get(openRunRecord.jobId)} />
          ) : null}
        </section>
      ) : null}

      {deleting ? (
        <DeleteConfirm
          names={[deleting.name]}
          onCancel={() => setDeleting(null)}
          onDelete={async () => {
            await window.mousse.scheduled.delete(deleting.id)
            if (editJobId === deleting.id) closePane()
            setDeleting(null)
            void refreshInbox()
          }}
        />
      ) : null}
    </div>
  )
}

function InboxRow({ row, automation, automations, cursor, open, folds, now, onActivate }: {
  row: ListRow
  automation: AutomationItem | undefined
  automations: ReturnType<typeof automationsById>
  cursor: boolean
  open: boolean
  folds: { bots: boolean; quiet: boolean }
  now: Date
  onActivate: () => void
}) {
  const key = rowKey(row)
  if (row.kind === 'fold') {
    const expanded = folds[row.fold]
    return (
      <div className="inbox-fold" role="option" aria-selected={cursor} aria-expanded={expanded} data-row-key={key} data-cursor={cursor || undefined} data-testid={`inbox-fold-${row.fold}`} onClick={onActivate}>
        <ChevronRight size={12} strokeWidth={2} className="inbox-fold-chevron" aria-hidden="true" />
        {row.fold === 'bots' ? <><Bot size={13} strokeWidth={1.8} aria-hidden="true" /><span>Assigned to bots · {row.count}</span></> : <span>{row.count} quiet</span>}
      </div>
    )
  }
  const { run } = row
  const name = runName(run, automations)
  if (row.group === 'quiet') {
    return (
      <div className="inbox-quiet-row" role="option" aria-selected={open} data-row-key={key} data-open={open || undefined} data-cursor={cursor || undefined} data-testid="inbox-run" data-run-id={run.id} onClick={onActivate}>
        <span className="inbox-run-icon" data-tone="quiet" aria-hidden="true"><TriggerIcon trigger={automation?.trigger} size={13} /></span>
        <span className="inbox-quiet-name">{name}</span>
        <time>{runTime(run.startedAt, now)}</time>
      </div>
    )
  }
  const bot = groupOf(run) === 'needs_you' && !openForPerson(run) ? botNameOf(run, automation) : undefined
  return (
    <div
      className="inbox-row"
      role="option"
      aria-selected={open}
      data-row-key={key}
      data-run-id={run.id}
      data-open={open || undefined}
      data-cursor={cursor || undefined}
      data-group={row.group}
      data-testid="inbox-run"
      onClick={onActivate}
    >
      <RunIcon run={run} automation={automation} resolved={row.resolved} />
      <div className="inbox-row-body">
        <div className="inbox-row-top">
          <button type="button" className="inbox-row-name" title={`Only ${name}`} onClick={(event) => { event.stopPropagation(); setInboxFilter({ automationId: run.jobId }) }}>{name}</button>
          {run.pr ? <span className="inbox-row-chips"><RunPrChip run={run} /></span> : null}
          <time className="inbox-row-time" dateTime={run.startedAt}>{runTime(run.startedAt, now, run.state === 'running')}</time>
        </div>
        <div className="inbox-row-bottom">
          <span className={`inbox-row-summary${noReport(run) ? ' is-none' : ''}`}>{runLine(run, now)}</span>
          {bot ? <AssigneeChip name={bot} /> : null}
        </div>
      </div>
    </div>
  )
}

/** An agent asks to add an automation: Allow makes it, Not now drops the ask (`automations.asks.answer`). */
function AskRow({ item }: { item: AutomationItem }) {
  const [busy, setBusy] = useState(false)
  const answer = (allow: boolean) => {
    const target = item.attention?.answer
    if (!target) return
    setBusy(true)
    void answerAttention(target, allow, {
      transport: window.mousse.platformRequest,
      answerQuestions: (requestId, answers, threadId) => window.mousse.orchestrator.answerQuestionsDetailed(requestId, answers, threadId)
    }).catch((cause) => useInboxStore.setState({ actionError: cause instanceof Error ? cause.message : String(cause) })).finally(() => { setBusy(false); void refreshInbox() })
  }
  return (
    <div className="inbox-ask-row" data-testid="inbox-ask">
      <span className="inbox-run-icon" data-tone="trigger" aria-hidden="true"><User size={14} strokeWidth={1.8} /></span>
      <span className="inbox-row-summary" title={item.attention?.text}>{item.attention?.text ?? item.name}</span>
      <button type="button" className="inbox-text-btn" disabled={busy} onClick={() => answer(true)}>Allow</button>
      <button type="button" className="inbox-text-btn muted" disabled={busy} onClick={() => answer(false)}>Not now</button>
    </div>
  )
}

/** The list scoped to one automation (its identity, compact, with this month's cost) or to one project group. */
function FilterHeader({ filter, automation, now, viewerZone }: { filter: InboxFilter; automation: AutomationItem | undefined; now: Date; viewerZone: string }) {
  const month = useInboxStore((s) => s.inbox?.month)
  const clear = () => setInboxFilter({ ...(filter.text ? { text: filter.text } : {}) })
  if (filter.automationId) {
    const usage = month?.byJob[filter.automationId]
    const name = automation?.name ?? 'Deleted automation'
    return (
      <div className="inbox-filter" data-testid="inbox-filter-automation">
        <div className="inbox-filter-top">
          <span className="inbox-filter-icon"><TriggerIcon trigger={automation?.trigger} size={14} /></span>
          <strong className="inbox-filter-name" title={name}>{name}</strong>
          {automation ? <button type="button" className="inbox-icon-btn small" title="Settings" aria-label={`Settings for ${name}`} onClick={() => openManage(automation.id)}><Settings size={13} strokeWidth={1.8} /></button> : null}
          <button type="button" className="inbox-icon-btn small" title="All runs" aria-label="Show all runs" onClick={clear}><X size={13} strokeWidth={1.8} /></button>
        </div>
        {automation ? (
          <div className="inbox-filter-meta">
            <span title="When"><Repeat size={12} strokeWidth={1.8} aria-hidden="true" />{whenColumn(automation, now)}</span>
            <span title="Next run"><Clock size={12} strokeWidth={1.8} aria-hidden="true" />{automation.paused ? 'Paused' : automation.next ? ownedWhenText(automation.next.at, now, automation.computer, viewerZone) : 'Not scheduled'}</span>
            <span title={`Who: ${automation.who.name}`}>{automation.who.kind === 'bot' ? <Bot size={12} strokeWidth={1.8} aria-hidden="true" /> : <User size={12} strokeWidth={1.8} aria-hidden="true" />}{automation.who.kind === 'bot' ? automation.who.name : 'Default agent'}</span>
            <span className="inbox-filter-cost" data-testid="inbox-filter-cost" title={`This month · ${month?.label ?? ''}. Cost counts only runs whose price is known (API keys); subscription runs count tokens.`}>
              <Coins size={12} strokeWidth={1.8} aria-hidden="true" />{usage?.costUsd ? costText(usage.costUsd) : usage?.tokens ? `${tokensText(usage.tokens)} tokens` : 'Nothing used'}<small>{month?.label}</small>
            </span>
          </div>
        ) : null}
      </div>
    )
  }
  if (filter.project) {
    return (
      <div className="inbox-filter inbox-filter-project" data-testid="inbox-filter-project">
        <span className="inbox-filter-icon"><Folder size={14} strokeWidth={1.8} aria-hidden="true" /></span>
        <strong className="inbox-filter-name">{filter.project.name}</strong>
        <button type="button" className="inbox-icon-btn small" title="All projects" aria-label="Show all projects" onClick={clear}><X size={13} strokeWidth={1.8} /></button>
      </div>
    )
  }
  return null
}

function KeysPopover({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const away = (event: MouseEvent) => { if (!(event.target as Element | null)?.closest?.('.inbox-keys-anchor')) onClose() }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [onClose])
  return (
    <div className="inbox-keys" role="tooltip" data-testid="inbox-keys">
      {[...INBOX_KEYS, [newKey(), 'New automation'] as [string, string]].map(([keys, what]) => (
        <div key={keys} className="inbox-keys-row"><kbd>{keys}</kbd><span>{what}</span></div>
      ))}
    </div>
  )
}

/** No runs yet: the automations there are, each with its next run, Run now and Edit; none: one line. */
function EmptyState({ automations, now, viewerZone }: { automations: AutomationItem[]; now: Date; viewerZone: string }) {
  if (!automations.length) {
    return (
      <div className="inbox-empty" data-testid="inbox-empty">
        <p className="inbox-empty-none">Nothing runs on its own yet. Describe an automation above.</p>
      </div>
    )
  }
  return (
    <div className="inbox-empty" data-testid="inbox-empty">
      {automations.slice(0, 3).map((automation) => (
        <div key={automation.key} className="inbox-empty-card" data-testid="inbox-empty-card">
          <span className="inbox-empty-icon"><TriggerIcon trigger={automation.trigger} size={18} /></span>
          <div className="inbox-empty-text">
            <strong>{automation.name}</strong>
            <span title={whenColumn(automation, now)}>{automation.paused ? 'Paused' : automation.next ? `Next run · ${ownedWhenText(automation.next.at, now, automation.computer, viewerZone)}` : whenColumn(automation, now)}</span>
          </div>
          <button type="button" className="inbox-text-btn" title="Edit details" onClick={() => openEdit(automation.id)}>Edit</button>
          <button type="button" className="inbox-primary-btn" data-testid="inbox-run-now" title="Run it once now" disabled={Boolean(automation.computer.offline)} onClick={() => void runAutomationNow(automation.id)}><Play size={13} strokeWidth={2} aria-hidden="true" />Run now</button>
        </div>
      ))}
    </div>
  )
}

/** A run with no thread (it stopped before its turn): what happened, and Resolve. */
function RunWithoutThread({ run, automation }: { run: InboxRun; automation: AutomationItem | undefined }) {
  const now = new Date()
  const level = run.level ? LEVEL_VIEW[run.level] : undefined
  return (
    <div className="inbox-run-card" data-testid="inbox-run-card">
      <div className="inbox-run-card-head">
        <RunIcon run={run} automation={automation} />
        <strong>{automation?.name ?? run.jobName}</strong>
        <span className="inbox-row-time">{runTime(run.startedAt, now)}</span>
      </div>
      <p className="inbox-run-card-line">{level ? `${level.label}: ` : ''}{runLine(run, now)}</p>
      {openForPerson(run) ? <button type="button" className="inbox-primary-btn" data-testid="inbox-resolve" onClick={() => void resolveRun(run.id)}>Resolve</button> : null}
    </div>
  )
}
