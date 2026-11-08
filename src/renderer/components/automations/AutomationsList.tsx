import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search, X } from '../../lib/icons'
import { listingServes } from '../../../shared/providerInstances'
import { normalizePermissionMode, type PermissionMode } from '../../../shared/permissionMode'
import type { LlmProviderOption, MousseSettings } from '../../../shared/settings'
import type { AutomationIndex, AutomationItem } from '../../../shared/automations'
import type { CreateScheduledJobInput, ScheduledJob, SchedulerStatus } from '../../../shared/types'
import { createAutomationsClient } from '../../services/automationsClient'
import { useCommand, useShortcutTitle } from '../../commands/commandRegistry'
import { openThread } from '../../lib/openThread'
import { closeRailPages } from '../../lib/railPages'
import { useAppStore } from '../../stores/appStore'
import { useChatsStore } from '../../stores/chatsStore'
import { Modal } from '../ui/Modal'
import type { RowMenuItem } from '../integrations/RowMenu'
import { WebhookDialog, type WebhookApi } from '../scheduled/WebhookDialog'
import { draftFromJob, EMPTY_CATALOG, isUnchanged, modelGroups, patchOf, type ScheduledCatalog } from '../scheduled/jobDraft'
import { errorText } from '../scheduled/scheduledLabels'
import { AutomationDetail } from './AutomationDetail'
import { AutomationRow, glyphOf, PausePicker } from './AutomationRows'
import { CreateRow, type CreatePrefill } from './CreateRow'
import { takeAutomationCreate, useAutomationCreate, type AutomationCreateRequest } from '../../stores/automationCreateStore'
import { modelKeyOf } from '../scheduled/jobDraft'
import { useAutomationLibrary } from './WhoDoPickers'
import { createPersonalBotsClient } from '../../services/personalBotsClient'
import { defaultMay, groupAutomations, matchesSearch, primaryOf, recentRuns, runText, SEARCH_AFTER_ROWS, type MetaContext } from './automationList'
import { ownedWhenText, viewerTimeZone } from './automationTime'
import { AGENT_JOB_LIMIT_DEFAULTS } from '../../../shared/agentJobLimits'

/** How often the open page reads the list again, for sources that send no change event (bots' next runs, watches). */
const POLL_MS = 15_000

function browserWebhookApi(): WebhookApi {
  const webhook = window.mousse.scheduled.webhook
  return {
    enable: (id) => webhook.enable(id),
    rotate: (id) => webhook.rotate(id),
    disable: (id) => webhook.disable(id),
    deliveries: (id) => webhook.deliveries(id),
    copy: (text) => navigator.clipboard.writeText(text)
  }
}

/** Whether focus is on the Automations page (the list, its create row or its detail), not elsewhere in the window. */
export function pageHasFocus(doc: Pick<Document, 'activeElement' | 'querySelector'> | undefined = typeof document === 'undefined' ? undefined : document): boolean {
  const page = doc?.querySelector('[data-automations-workspace]:not([hidden])')
  const focused = doc?.activeElement
  return Boolean(page && focused && page.contains(focused))
}

/** What the create row opens with for a request from another surface: its Who matched to the pickers' lists. */
export function prefillOf(request: AutomationCreateRequest, catalog: ScheduledCatalog, providers: LlmProviderOption[]): CreatePrefill {
  const modelKey = request.selection ? modelKeyOf(request.selection, catalog.models, providers) : ''
  const known = modelKey !== '' && catalog.models.some((group) => group.choices.some((choice) => choice.key === modelKey))
  return {
    nonce: request.nonce,
    ...(request.prompt ? { prompt: request.prompt } : {}),
    ...(request.projectId !== undefined ? { projectId: request.projectId } : {}),
    ...(request.workflowId ? { workflowId: request.workflowId } : {}),
    who: request.agentId ? { kind: 'agent', id: request.agentId } : known ? { kind: 'model', key: modelKey } : { kind: 'default' }
  }
}

/** The name the page gives an agent: the provider instance's label (Claude, Codex), else the model. */
function agentNameOf(providers: LlmProviderOption[], selection: { instanceId?: string; llmProvider?: string; model?: string } | undefined): string | undefined {
  if (!selection) return undefined
  return providers.find((provider) => listingServes(provider, selection))?.label
}

/**
 * The Automations list: the create row, then Needs you, Today, Upcoming, Watching and On demand, with Paused and Recent
 * folded at the end. Rows open their detail (a scheduled job), their bot chat or their thread. ⇧/⌘-click and ⌘A select
 * rows for Pause…, Resume and Delete.
 */
export function AutomationsList({ active, onOpenLibrary }: { active: boolean; onOpenLibrary: () => void }) {
  const client = useMemo(() => createAutomationsClient(window.mousse.platformRequest), [])
  const [index, setIndex] = useState<AutomationIndex | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [jobs, setJobs] = useState<ScheduledJob[]>([])
  const [status, setStatus] = useState<SchedulerStatus | null>(null)
  const [catalog, setCatalog] = useState<ScheduledCatalog>(EMPTY_CATALOG)
  const [providers, setProviders] = useState<LlmProviderOption[]>([])
  const [settings, setSettings] = useState<MousseSettings | null>(null)
  const [extendDays, setExtendDays] = useState<number>(AGENT_JOB_LIMIT_DEFAULTS.lifetimeDays)
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [anchor, setAnchor] = useState<string | null>(null)
  const [detail, setDetail] = useState<string | null>(null)
  const [pausing, setPausing] = useState<string[] | null>(null)
  const [deleting, setDeleting] = useState<string[] | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [pausedOpen, setPausedOpen] = useState(false)
  const [recentOpen, setRecentOpen] = useState(false)
  const [webhookJobId, setWebhookJobId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [createRequest, setCreateRequest] = useState(0)
  const [prefill, setPrefill] = useState<CreatePrefill | null>(null)
  const automateRequest = useAutomationCreate((state) => state.request)
  const listRef = useRef<HTMLDivElement>(null)
  const webhookApi = useMemo(browserWebhookApi, [])
  const viewerZone = useMemo(viewerTimeZone, [])
  const activeProjectId = useAppStore((state) => state.threads.find((thread) => thread.id === state.activeThreadId)?.projectId ?? '')
  const profileId = useAppStore((state) => state.profileId)
  const { library, reload: reloadLibrary } = useAutomationLibrary(profileId)
  // ⌘N is New thread everywhere else; on this page it opens the create row.
  const createTitle = useShortcutTitle('New automation', 'thread.new')

  const refresh = useCallback(async () => {
    try {
      setIndex(await client.list())
      setLoadError(null)
    } catch (cause) {
      setLoadError(errorText(cause))
    }
  }, [client])

  const loadCatalog = useCallback(async () => {
    try {
      const [options, projects, threads, current] = await Promise.all([
        window.mousse.settings.getOptions(),
        window.mousse.projects.list(),
        window.mousse.threads.listAll(),
        window.mousse.settings.get()
      ])
      setProviders(options.llmProviders)
      setSettings(current)
      setCatalog({
        models: modelGroups(options.llmProviders),
        projects,
        threads: threads.filter((thread) => !thread.lineage && !thread.settledAt),
        defaultPermissionMode: normalizePermissionMode(current.permissions?.defaultMode)
      })
    } catch {
      // The page still works with the defaults; a model or project it cannot list is not offered.
    }
  }, [])

  useEffect(() => {
    void refresh()
    void loadCatalog()
    void window.mousse.scheduled.list().then(setJobs, () => undefined)
    void window.mousse.scheduled.status().then(setStatus, () => undefined)
    void window.mousse.scheduled.settings.get().then((value) => setExtendDays(value.agentJobLifetimeDays), () => undefined)
    const offJobs = window.mousse.scheduled.onUpdated((next) => { setJobs(next); void refresh() })
    const offStatus = window.mousse.scheduled.onStatus(setStatus)
    const offBots = window.mousse.personalBots?.onChanged?.(() => { void refresh() }) ?? (() => undefined)
    return () => { offJobs(); offStatus(); offBots() }
  }, [refresh, loadCatalog])

  // The page polls only while it is showing; the Library may have changed while it was away.
  useEffect(() => {
    if (!active) return
    reloadLibrary()
    void refresh()
    const timer = setInterval(() => { void refresh() }, POLL_MS)
    return () => clearInterval(timer)
  }, [active, refresh, reloadLibrary])

  // ⌘N is page-scoped: while focus is on this page, the key press opens the create row. The palette and the menu
  // keep New thread, and anywhere else ⌘N is New thread too.
  useCommand('thread.new', () => { setDetail(null); setCreateRequest((count) => count + 1) }, () => active && pageHasFocus(), { keysOnly: true })

  // Automate… and Repeat this…: once the pickers' lists are read, the create row opens with the request.
  useEffect(() => {
    if (!automateRequest || !settings) return
    setDetail(null)
    setPrefill(prefillOf(automateRequest, catalog, providers))
    takeAutomationCreate()
  }, [automateRequest, settings, catalog, providers])

  const items = useMemo(() => index?.items ?? [], [index])
  const detailItem = detail ? items.find((item) => item.key === detail) : undefined
  const detailJob = detailItem?.link.kind === 'job' ? jobs.find((job) => job.id === (detailItem.link as { jobId: string }).jobId) : undefined
  const detailInitial = useMemo(() => (detailJob ? draftFromJob(detailJob, catalog, providers) : null), [detailJob, catalog, providers])
  const shown = useMemo(() => (query.trim() ? items.filter((item) => matchesSearch(item, query)) : items), [items, query])
  const now = new Date()
  const groups = useMemo(() => groupAutomations(shown, new Date()), [shown])
  const pausedGroup = groups.find((group) => group.key === 'paused')
  const visibleGroups = groups.filter((group) => group.key !== 'paused')
  const recent = useMemo(() => recentRuns(shown), [shown])
  const ordered = useMemo(() => [...visibleGroups.flatMap((group) => group.items), ...(pausedOpen ? pausedGroup?.items ?? [] : [])], [visibleGroups, pausedGroup, pausedOpen])
  const jobOf = (item: AutomationItem) => (item.link.kind === 'job' ? jobs.find((job) => job.id === (item.link as { jobId: string }).jobId) : undefined)
  const owner = index?.computer ?? { name: 'This computer', timeZone: viewerZone }
  const manyComputers = new Set(items.map((item) => item.computer.name)).size > 1
  const defaultAgent = settings ? agentNameOf(providers, { instanceId: settings.provider.instanceId, llmProvider: settings.provider.llmProvider }) ?? 'Default agent' : 'Default agent'
  const modelName = (item: AutomationItem) => {
    const job = jobOf(item)
    if (item.who.kind === 'saved_agent') return item.who.name
    if (item.who.kind !== 'agent') return undefined
    return agentNameOf(providers, job?.selection) ?? (job?.selection ? job.selection.model : defaultAgent)
  }
  const ctx: MetaContext = { now, viewerZone, manyComputers, modelName }
  const profileMode = settings?.permissions?.defaultMode ? normalizePermissionMode(settings.permissions.defaultMode) : undefined
  const ceiling: PermissionMode = profileMode ?? 'ask'

  // A selection keeps only rows that still exist and that it can act on (scheduled jobs).
  useEffect(() => {
    setSelected((current) => current.filter((key) => items.some((item) => item.key === key && item.kind === 'job')))
  }, [items])

  // ⌘A selects every scheduled job showing, unless a field has focus.
  useEffect(() => {
    if (!active || detail) return
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'a' || event.shiftKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable="true"], .monaco-editor')) return
      if (!listRef.current?.isConnected || listRef.current.closest('[hidden]')) return
      event.preventDefault()
      setSelected(ordered.filter((item) => item.kind === 'job').map((item) => item.key))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, detail, ordered])

  const act = async (action: () => Promise<unknown>) => {
    setActionError(null)
    try {
      await action()
    } catch (cause) {
      setActionError(errorText(cause))
    }
    void refresh()
  }

  const idsOf = (keys: string[]) => keys.flatMap((key) => {
    const item = items.find((entry) => entry.key === key)
    return item?.link.kind === 'job' ? [item.link.jobId] : []
  })

  const openBot = (botId: string) => {
    closeRailPages()
    void useChatsStore.getState().openBot(botId)
  }
  const goThread = (threadId: string) => { void openThread(threadId) }

  const openItem = (item: AutomationItem) => {
    setSelected([])
    if (item.link.kind === 'bot') openBot(item.link.botId)
    else if (item.link.kind === 'thread') goThread(item.link.threadId)
    else { setDetail(item.key); void loadCatalog() }
  }

  const runNow = (jobId: string) => act(() => window.mousse.scheduled.run(jobId))
  const resume = (jobIds: string[]) => act(async () => { for (const id of jobIds) await window.mousse.scheduled.resume(id) })

  const primary = (item: AutomationItem) => {
    const kind = primaryOf(item).kind
    if (kind === 'open') {
      const thread = item.attention?.threadId ?? item.active?.threadId
      if (item.kind === 'job' && thread) goThread(thread)
      else openItem(item)
      return
    }
    if (item.link.kind !== 'job') return
    if (kind === 'resume') void resume([item.link.jobId])
    else void runNow(item.link.jobId)
  }

  const menuOf = (item: AutomationItem): RowMenuItem[] => {
    if (item.link.kind === 'bot') return [{ label: 'Open bot chat', onSelect: () => openBot((item.link as { botId: string }).botId) }]
    if (item.link.kind === 'thread') return [{ label: 'Open thread', onSelect: () => goThread((item.link as { threadId: string }).threadId) }]
    const jobId = item.link.jobId
    const kind = primaryOf(item).kind
    const thread = item.active?.threadId ?? item.last?.threadId
    return [
      ...(kind !== 'run' && kind !== 'retry' ? [{ label: 'Run now', disabled: Boolean(item.active && item.active.state !== 'waiting'), onSelect: () => void runNow(jobId) }] : []),
      item.paused ? { label: 'Resume', onSelect: () => void resume([jobId]) } : { label: 'Pause…', onSelect: () => setPausing([item.key]) },
      { label: 'Edit', onSelect: () => openItem(item) },
      ...(thread ? [{ label: 'Open last thread', onSelect: () => goThread(thread) }] : []),
      { label: 'Delete', danger: true, onSelect: () => setDeleting([item.key]) }
    ]
  }

  const select = (item: AutomationItem, mode: 'range' | 'toggle') => {
    if (item.kind !== 'job') return
    if (mode === 'toggle' || !anchor) {
      setSelected((current) => (current.includes(item.key) ? current.filter((key) => key !== item.key) : [...current, item.key]))
      setAnchor(item.key)
      return
    }
    const keys = ordered.map((entry) => entry.key)
    const [from, to] = [keys.indexOf(anchor), keys.indexOf(item.key)].sort((a, b) => a - b)
    if (from < 0) { setSelected([item.key]); setAnchor(item.key); return }
    setSelected(ordered.slice(from, to + 1).filter((entry) => entry.kind === 'job').map((entry) => entry.key))
  }

  const pause = async (keys: string[], until: string | undefined) => {
    setActionError(null)
    for (const id of idsOf(keys)) await window.mousse.scheduled.pause(id, undefined, until)
    setPausing(null)
    setSelected([])
    void refresh()
  }

  const confirmDelete = async () => {
    if (!deleting) return
    setDeleteBusy(true)
    setActionError(null)
    try {
      for (const id of idsOf(deleting)) await window.mousse.scheduled.delete(id)
      if (detail && deleting.includes(detail)) setDetail(null)
      setSelected([])
      setDeleting(null)
    } catch (cause) {
      setActionError(errorText(cause))
    } finally {
      setDeleteBusy(false)
      void refresh()
    }
  }

  const create = async (input: CreateScheduledJobInput) => {
    await window.mousse.scheduled.create(input)
    await refresh()
  }

  const webhookJob = webhookJobId ? jobs.find((job) => job.id === webhookJobId) : undefined
  const schedulerDown = status !== null && !status.running
  const rowCount = items.length

  const dialogs = (
    <>
      {webhookJob ? <WebhookDialog job={webhookJob} api={webhookApi} onClose={() => setWebhookJobId(null)} /> : null}
      {pausing ? <PausePicker count={pausing.length} onCancel={() => setPausing(null)} onPause={(until) => pause(pausing, until)} /> : null}
      {deleting ? (
        <Modal
          open
          title={deleting.length === 1 ? `Delete “${items.find((item) => item.key === deleting[0])?.name ?? 'automation'}”?` : `Delete ${deleting.length} automations?`}
          onClose={() => { if (!deleteBusy) setDeleting(null) }}
          closeDisabled={deleteBusy}
          footer={
            <>
              <button type="button" className="settings-btn" disabled={deleteBusy} onClick={() => setDeleting(null)}>Cancel</button>
              <button type="button" className="settings-btn danger" data-testid="automation-delete-confirm" disabled={deleteBusy} onClick={() => void confirmDelete()}>Delete</button>
            </>
          }
        >
          <p className="scheduled-note">Their run history goes too; the threads they ran in stay.</p>
        </Modal>
      ) : null}
    </>
  )

  if (detail && detailItem && detailJob && detailInitial) {
    const initial = detailInitial
    return (
      <div className="automations-scroll">
        <div className="automations-column">
          <AutomationDetail
            key={`${detailJob.id}:${detailJob.updatedAt}:${catalog.models.length}`}
            job={detailJob}
            item={detailItem}
            initial={initial}
            catalog={catalog}
            library={library}
            defaultName={defaultAgent}
            profileId={profileId}
            viewerZone={viewerZone}
            save={async (draft) => {
              const change = patchOf(initial, draft, catalog)
              if (!isUnchanged(change)) await window.mousse.scheduled.update(detailJob.id, change)
              await refresh()
            }}
            onBack={() => setDetail(null)}
            onRunNow={() => void runNow(detailJob.id)}
            onPause={() => setPausing([detailItem.key])}
            onResume={() => void resume([detailJob.id])}
            onDelete={() => setDeleting([detailItem.key])}
            onWebhook={() => setWebhookJobId(detailJob.id)}
            onExtend={() => void act(() => window.mousse.scheduled.extend(detailJob.id))}
            extendDays={extendDays}
            onOpenThread={goThread}
          />
          {actionError ? <p className="scheduled-action-error" role="alert">{actionError}</p> : null}
        </div>
        {dialogs}
      </div>
    )
  }

  return (
    <div className="automations-list" data-testid="automations-list">
      <header className="rail-page-header automations-header">
        <h1>Automations</h1>
        <span className="automations-header-spacer" />
        <button type="button" className="automations-link" data-testid="automations-library-link" onClick={onOpenLibrary} title="Saved agents and workflows">Library</button>
        {rowCount > SEARCH_AFTER_ROWS ? (
          searchOpen || query ? (
            <span className="automations-search">
              <Search size={13} aria-hidden="true" />
              <input
                autoFocus
                aria-label="Search automations"
                data-testid="automations-search"
                placeholder="Search · agent: computer:"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Escape') { setQuery(''); setSearchOpen(false) } }}
              />
              <button type="button" className="settings-icon-btn" aria-label="Clear search" onClick={() => { setQuery(''); setSearchOpen(false) }}><X size={12} /></button>
            </span>
          ) : (
            <button type="button" className="settings-icon-btn automations-search-btn" aria-label="Search automations" title="Search (agent: and computer: work too)" onClick={() => setSearchOpen(true)}>⌕</button>
          )
        ) : null}
      </header>

      <div className="automations-scroll">
        <div className="automations-column" ref={listRef}>
          <CreateRow
            profileId={profileId}
            catalog={catalog}
            library={library}
            defaultName={defaultAgent}
            owner={owner}
            initialProjectId={activeProjectId}
            defaultMay={defaultMay(profileMode, ceiling)}
            ceiling={ceiling}
            isGitRepo={async (projectId) => (await window.mousse.git.status({ projectId, workspaceThreadId: null })).isRepo}
            create={create}
            addBotSchedule={async (botId, when, prompt) => {
              await createPersonalBotsClient(window.mousse.platformRequest).addSchedule(botId, when, prompt)
              await refresh()
            }}
            onOpenBot={openBot}
            openRequest={createRequest}
            prefill={prefill}
            title={createTitle}
          />

          {schedulerDown ? <p className="scheduled-warning" data-testid="scheduler-state"><span className="settings-status-warn">Scheduler stopped. Nothing will run.</span></p> : null}
          {loadError ? (
            <p className="scheduled-warning" role="alert">
              <span className="settings-status-warn" title={loadError}>Automations did not load.</span>
              <button type="button" className="scheduled-line-link" onClick={() => void refresh()}>Retry</button>
            </p>
          ) : null}
          {index?.unavailable.length ? <p className="scheduled-note" title="Those rows are missing, not empty.">{`${index.unavailable.map((source) => (source === 'bots' ? 'Bot schedules' : 'Pull request watches')).join(' and ')} could not be read.`}</p> : null}
          {actionError ? <p className="scheduled-action-error" role="alert">{actionError}</p> : null}

          {selected.length ? (
            <div className="automations-selection" data-testid="automation-selection-bar" role="toolbar" aria-label="Selected automations">
              <span>{`${selected.length} selected`}</span>
              <button type="button" className="settings-btn" onClick={() => setPausing(selected)}>Pause…</button>
              <button type="button" className="settings-btn" onClick={() => void resume(idsOf(selected)).then(() => setSelected([]))}>Resume</button>
              <button type="button" className="settings-btn danger" onClick={() => setDeleting(selected)}>Delete</button>
              <button type="button" className="settings-icon-btn" aria-label="Clear selection" title="Clear selection" onClick={() => setSelected([])}><X size={12} /></button>
            </div>
          ) : null}

          {visibleGroups.map((group) => (
            <section key={group.key} className="automation-group" data-testid="automation-group" data-group={group.key} aria-label={group.label}>
              <h2 className="automation-group-head">{group.key === 'needs' ? `${group.label} · ${group.items.length}` : group.label}</h2>
              <div className="automation-rows" role="listbox" aria-multiselectable="true" aria-label={group.label}>
                {group.items.map((item) => (
                  <AutomationRow
                    key={item.key}
                    item={item}
                    selected={selected.includes(item.key)}
                    ctx={ctx}
                    menu={menuOf(item)}
                    onOpen={() => openItem(item)}
                    onSelect={(mode) => select(item, mode)}
                    onPrimary={() => primary(item)}
                  />
                ))}
              </div>
            </section>
          ))}

          {index && items.length === 0 ? <p className="scheduled-empty">Nothing runs on its own yet.</p> : null}
          {index && items.length > 0 && shown.length === 0 ? <p className="scheduled-empty">No automation matches.</p> : null}

          {pausedGroup || recent.length ? (
            <div className="automation-folds">
              {pausedGroup ? (
                <button type="button" className="automation-fold" data-testid="automation-group" data-group="paused" aria-expanded={pausedOpen} onClick={() => setPausedOpen((open) => !open)}>
                  {`Paused · ${pausedGroup.items.length} ${pausedOpen ? '▾' : '▸'}`}
                </button>
              ) : null}
              {recent.length ? (
                <button type="button" className="automation-fold" data-testid="automation-recent" aria-expanded={recentOpen} onClick={() => setRecentOpen((open) => !open)}>
                  {`Recent ${recentOpen ? '▾' : '▸'}`}
                </button>
              ) : null}
            </div>
          ) : null}

          {pausedOpen && pausedGroup ? (
            <section className="automation-group" data-group="paused-rows" aria-label="Paused">
              <div className="automation-rows" role="listbox" aria-multiselectable="true" aria-label="Paused">
                {pausedGroup.items.map((item) => (
                  <AutomationRow key={item.key} item={item} selected={selected.includes(item.key)} ctx={ctx} menu={menuOf(item)} onOpen={() => openItem(item)} onSelect={(mode) => select(item, mode)} onPrimary={() => primary(item)} />
                ))}
              </div>
            </section>
          ) : null}

          {recentOpen && recent.length ? (
            <section className="automation-group" data-testid="automation-recent-runs" aria-label="Recent runs">
              <ul className="automation-recent">
                {recent.map(({ item, run }, at) => (
                  <li key={`${item.key}-${run.at}-${at}`} className="automation-run" data-state={run.state}>
                    <span className={`automation-glyph ${glyphOf(item).kind}`} aria-hidden="true">{glyphOf(item).glyph}</span>
                    <span className="automation-run-name">{item.name}</span>
                    <span className="automation-run-text">{runText(run, now, item.computer, viewerZone).replace(/ · (just now|\d+ (min|h|d) ago)$/, '')}</span>
                    <span className="automation-run-when">{ownedWhenText(run.at, now, item.computer, viewerZone)}</span>
                    {run.threadId ? <button type="button" className="scheduled-link-btn" onClick={() => goThread(run.threadId!)}>Open thread</button> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </div>
      {dialogs}
    </div>
  )
}
