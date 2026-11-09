// UI MOCK-UP of the agreed Automations layout (fable-layout.md option A + project dot, with Sol's and Fable's fixes):
// the Runs list in the Chats sidebar's place, the ordinary thread view beside it. Static data only (./data.ts);
// nothing is sent to the daemon. Shown when localStorage `mousse.automationsMock` is `1` or `empty`.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useCommand } from '../../../commands/commandRegistry'
import {
  Bot, ChevronRight, Coins, Folder, LayoutGrid, Play, Repeat, Search, Settings, Sparkles, Undo2, User, X, Clock
} from '../../../lib/icons'
import { MOCK_COST_LABEL, MOCK_EMPTY_AUTOMATION, MOCK_RUNS } from './data'
import { automationOf, groupOf, inboxGroups, rowKey, type GroupKey, type ListRow } from './inboxModel'
import { AssigneeChip, ComputerChip, PrChip, RunIcon, TriggerIcon } from './RunParts'
import { RunThread } from './RunThread'
import { ManageTable } from './ManageTable'
import {
  closeManage, openManage, openRun, resolveRun, setInboxFilter, undoResolve, useInboxMock, type InboxFilter
} from './store'
import './inbox.css'

const isMac = () => /mac/i.test(globalThis.navigator?.platform ?? '')
const newKey = () => (isMac() ? '⌘N' : 'Ctrl+N')

export const INBOX_KEYS: Array<[string, string]> = [
  ['j / k', 'Next / previous'],
  ['Enter', 'Open, or unfold'],
  ['e', 'Resolve'],
  ['u', 'Undo resolve'],
  ['1–4', 'Jump to a level'],
  ['/', 'Filter'],
  ['?', 'These keys']
]

const LEVEL_KEYS: Record<string, GroupKey> = { 1: 'needs_you', 2: 'look', 3: 'fyi', 4: 'quiet' }

function editable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
}

export function AutomationsInbox({ active }: { active: boolean }) {
  const mode = useInboxMock((s) => s.mode)
  const filter = useInboxMock((s) => s.filter)
  const resolved = useInboxMock((s) => s.resolved)
  const openRunId = useInboxMock((s) => s.openRunId)
  const manage = useInboxMock((s) => s.manage)
  const automations = useInboxMock((s) => s.automations)
  const [folds, setFolds] = useState({ bots: false, quiet: false })
  const [cursor, setCursor] = useState<string | null>(openRunId)
  const [keysOpen, setKeysOpen] = useState(false)
  const [searching, setSearching] = useState(false)
  const composerRef = useRef<HTMLInputElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const empty = mode === 'empty'

  const groups = useMemo(() => (empty ? [] : inboxGroups(filter, resolved, folds)), [empty, filter, resolved, folds])
  const rows = useMemo(() => groups.flatMap((group) => group.rows), [groups])
  const openRunRecord = MOCK_RUNS.find((run) => run.id === openRunId)
  const lastResolved = resolved.length ? MOCK_RUNS.find((run) => run.id === resolved[resolved.length - 1]) : undefined

  useCommand('thread.new', () => composerRef.current?.focus(), () => active && Boolean(document.querySelector('[data-automations-workspace]:not([hidden])')?.contains(document.activeElement)), { keysOnly: true })

  const activate = (row: ListRow) => {
    setCursor(rowKey(row))
    if (row.kind === 'run') openRun(row.run.id)
    else if (row.kind === 'fold') setFolds((value) => ({ ...value, [row.fold]: !value[row.fold] }))
  }

  // Moving the cursor onto a run opens it, as in Mail; a fold opens with Enter.
  const focusRow = (row: ListRow) => {
    setCursor(rowKey(row))
    if (row.kind === 'run') openRun(row.run.id)
  }

  // The inbox keys: only while the page is open and nothing editable has focus.
  useEffect(() => {
    if (!active) return
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      if (editable(event.target)) return
      if (document.querySelector('[role="dialog"], [role="menu"], .ui-select-list')) return
      const index = rows.findIndex((row) => rowKey(row) === cursor)
      const move = (delta: number) => {
        const next = rows[Math.max(0, Math.min(rows.length - 1, (index < 0 ? (delta > 0 ? -1 : rows.length) : index) + delta))]
        if (next) focusRow(next)
      }
      const key = event.key
      if (key === 'j' || key === 'ArrowDown') move(1)
      else if (key === 'k' || key === 'ArrowUp') move(-1)
      else if (key === 'Enter') { const row = rows[index]; if (row) activate(row); else return }
      else if (key === 'e') {
        // The row under the cursor, else the open run: only an unresolved Needs you item of the person's.
        const row = rows[index]
        const run = row?.kind === 'run' ? row.run : MOCK_RUNS.find((entry) => entry.id === openRunId)
        if (run && !run.assignee && groupOf(run, resolved) === 'needs_you') resolveRun(run.id)
      } else if (key === 'u') undoResolve()
      else if (LEVEL_KEYS[key]) {
        const first = rows.find((row) => row.group === LEVEL_KEYS[key])
        if (first) focusRow(first)
      } else if (key === '/') { setSearching(true); requestAnimationFrame(() => searchRef.current?.focus()) }
      else if (key === '?') setKeysOpen((value) => !value)
      else if (key === 'Escape' && (keysOpen || manage.open)) { setKeysOpen(false); closeManage(); event.stopPropagation() }
      else return
      event.preventDefault()
    }
    // Capture, so Esc closes Manage or the keys before it closes the page.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active, rows, cursor, openRunId, resolved, keysOpen, manage.open])

  useEffect(() => {
    listRef.current?.querySelector(`[data-row-key="${cursor}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const setText = (text: string | undefined) => setInboxFilter({ ...filter, text })
  const onSearchKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') { setText(undefined); setSearching(false); event.currentTarget.blur() }
  }

  return (
    <div className="inbox" data-testid="automations-inbox" data-mode={mode}>
      <aside className="inbox-list" aria-label="Runs">
        <div className="inbox-head">
          <label className="inbox-composer" title={`New automation · ${newKey()}`}>
            <Sparkles size={14} strokeWidth={1.8} aria-hidden="true" />
            <input ref={composerRef} data-testid="inbox-composer" placeholder="Describe an automation…" aria-label="Describe an automation" />
          </label>
          {!empty && (
            <button type="button" className="inbox-icon-btn" data-testid="inbox-manage-btn" aria-pressed={manage.open} title="Manage automations" aria-label="Manage automations" onClick={() => (manage.open ? closeManage() : openManage())}>
              <LayoutGrid size={15} strokeWidth={1.8} />
            </button>
          )}
          <div className="inbox-keys-anchor">
            <button type="button" className="inbox-icon-btn inbox-keys-btn" data-testid="inbox-keys-btn" aria-pressed={keysOpen} aria-label="Keyboard shortcuts" onClick={() => setKeysOpen((value) => !value)}>?</button>
            {keysOpen && <KeysPopover onClose={() => setKeysOpen(false)} />}
          </div>
        </div>

        <FilterHeader filter={filter} />

        {(searching || filter.text) && (
          <label className="inbox-search">
            <Search size={13} strokeWidth={1.8} aria-hidden="true" />
            <input ref={searchRef} placeholder="Filter runs" aria-label="Filter runs" value={filter.text ?? ''} onChange={(event) => setText(event.target.value)} onKeyDown={onSearchKey} />
            <button type="button" className="inbox-icon-btn small" title="Clear filter" aria-label="Clear filter" onClick={() => { setText(undefined); setSearching(false) }}><X size={12} /></button>
          </label>
        )}

        <div className="inbox-scroll" ref={listRef} role="listbox" aria-label="Runs" data-testid="inbox-runs">
          {groups.map((group) => (
            <div key={group.key} className="inbox-group" data-group={group.key} role="group" aria-label={group.label}>
              {group.key !== 'live' && group.key !== 'quiet' && (
                <div className="inbox-group-head"><span>{group.label}</span>{group.count > 0 && <span className="inbox-group-count">{group.count}</span>}</div>
              )}
              {group.rows.map((row) => (
                <InboxRow key={rowKey(row)} row={row} cursor={cursor === rowKey(row)} open={row.kind === 'run' && row.run.id === openRunId && !manage.open} folds={folds} onActivate={() => activate(row)} />
              ))}
            </div>
          ))}
        </div>

        {lastResolved && !empty && (
          <div className="inbox-undo" role="status" data-testid="inbox-undo">
            <CheckLine name={automationOf(lastResolved.automationId)?.name ?? ''} />
            <button type="button" className="inbox-text-btn" title="Undo · u" onClick={undoResolve}><Undo2 size={13} strokeWidth={1.8} aria-hidden="true" />Undo</button>
          </div>
        )}
      </aside>

      <section className="inbox-pane" aria-label={manage.open ? 'Manage automations' : 'Run'}>
        {empty ? <EmptyState /> : manage.open ? <ManageTable automations={automations} expanded={manage.expanded} /> : openRunRecord ? <RunThread key={openRunRecord.id} run={openRunRecord} /> : null}
      </section>
    </div>
  )
}

function CheckLine({ name }: { name: string }) {
  return <span className="inbox-undo-text">Resolved · <strong>{name}</strong></span>
}

function InboxRow({ row, cursor, open, folds, onActivate }: { row: ListRow; cursor: boolean; open: boolean; folds: { bots: boolean; quiet: boolean }; onActivate: () => void }) {
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
  if (row.kind === 'quiet') {
    const automation = automationOf(row.automationId)
    return (
      <div className="inbox-quiet-row" role="option" aria-selected={cursor} data-row-key={key} data-cursor={cursor || undefined}>
        <span className="inbox-run-icon" data-tone="quiet" aria-hidden="true"><TriggerIcon kind={automation?.trigger.kind ?? 'schedule'} size={13} /></span>
        <span className="inbox-quiet-name">{automation?.name}</span>
        <time>{row.time}</time>
      </div>
    )
  }
  const { run } = row
  const automation = automationOf(run.automationId)
  const noReport = run.level === 'none' && run.state === 'done'
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
          <button
            type="button"
            className="inbox-row-name"
            title={`Only ${automation?.name}`}
            onClick={(event) => { event.stopPropagation(); setInboxFilter({ automationId: run.automationId }) }}
          >{automation?.name}</button>
          {run.pr && <span className="inbox-row-chips"><PrChip pr={run.pr} /></span>}
          <time className="inbox-row-time">{run.time}</time>
        </div>
        <div className="inbox-row-bottom">
          <span className={`inbox-row-summary${noReport ? ' is-none' : ''}`}>{run.summary}</span>
          {run.assignee && <AssigneeChip name={run.assignee} />}
          <ComputerChip name={run.computer} iconOnly />
        </div>
      </div>
    </div>
  )
}

/** The list scoped to one automation (its identity, compact) or to one project. */
function FilterHeader({ filter }: { filter: InboxFilter }) {
  const automations = useInboxMock((s) => s.automations)
  const automation = filter.automationId ? automations.find((entry) => entry.id === filter.automationId) : undefined
  const clear = () => setInboxFilter({ ...(filter.text ? { text: filter.text } : {}) })
  if (automation) {
    return (
      <div className="inbox-filter" data-testid="inbox-filter-automation">
        <div className="inbox-filter-top">
          <span className="inbox-filter-icon"><TriggerIcon kind={automation.trigger.kind} size={14} /></span>
          <strong className="inbox-filter-name">{automation.name}</strong>
          <button type="button" className="inbox-icon-btn small" title="Settings" aria-label={`Settings for ${automation.name}`} onClick={() => openManage(automation.id)}><Settings size={13} strokeWidth={1.8} /></button>
          <button type="button" className="inbox-icon-btn small" title="All runs" aria-label="Show all runs" onClick={clear}><X size={13} strokeWidth={1.8} /></button>
        </div>
        <div className="inbox-filter-meta">
          <span title="When"><Repeat size={12} strokeWidth={1.8} aria-hidden="true" />{automation.trigger.text}</span>
          <span title="Next run"><Clock size={12} strokeWidth={1.8} aria-hidden="true" />{automation.next}</span>
          <span title={`Who: ${automation.who.name}`}>{automation.who.kind === 'bot' ? <Bot size={12} strokeWidth={1.8} aria-hidden="true" /> : <User size={12} strokeWidth={1.8} aria-hidden="true" />}{automation.who.name}</span>
          <span title={`Cost this month · ${MOCK_COST_LABEL}. Usage on subscriptions is not included.`}><Coins size={12} strokeWidth={1.8} aria-hidden="true" />{automation.costMonth}<small>{MOCK_COST_LABEL}</small></span>
        </div>
      </div>
    )
  }
  if (filter.project) {
    return (
      <div className="inbox-filter inbox-filter-project" data-testid="inbox-filter-project">
        <span className="inbox-filter-icon"><Folder size={14} strokeWidth={1.8} aria-hidden="true" /></span>
        <strong className="inbox-filter-name">{filter.project}</strong>
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

/** One automation, no runs yet: it, its next run, and Run now. */
function EmptyState() {
  const automation = MOCK_EMPTY_AUTOMATION
  return (
    <div className="inbox-empty" data-testid="inbox-empty">
      <div className="inbox-empty-card">
        <span className="inbox-empty-icon"><TriggerIcon kind={automation.trigger.kind} size={18} /></span>
        <div className="inbox-empty-text">
          <strong>{automation.name}</strong>
          <span title={automation.trigger.text}>Next run · {automation.next}</span>
        </div>
        {/* Mock: does nothing. */}
        <button type="button" className="inbox-primary-btn" title="Run it once now" onClick={() => undefined}><Play size={13} strokeWidth={2} aria-hidden="true" />Run now</button>
      </div>
    </div>
  )
}
