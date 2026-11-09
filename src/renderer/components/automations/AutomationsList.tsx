import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search, X } from '../../lib/icons'
import { listingServes } from '../../../shared/providerInstances'
import { normalizePermissionMode } from '../../../shared/permissionMode'
import type { LlmProviderOption, MousseSettings } from '../../../shared/settings'
import { managerMessage, type AutomationIndex, type AutomationItem } from '../../../shared/automations'
import { isThreadActivityActive, type ScheduledJob, type SchedulerStatus, type ThreadEventKind } from '../../../shared/types'
import { answerAttention, createAutomationsClient } from '../../services/automationsClient'
import { useCommand } from '../../commands/commandRegistry'
import { openThread } from '../../lib/openThread'
import { closeRailPages } from '../../lib/railPages'
import { useAppStore } from '../../stores/appStore'
import { useChatsStore } from '../../stores/chatsStore'
import { Modal } from '../ui/Modal'
import type { RowMenuItem } from '../integrations/RowMenu'
import { draftFromJob, EMPTY_CATALOG, isUnchanged, modelGroups, patchOf, type ScheduledCatalog } from '../scheduled/jobDraft'
import { errorText } from '../scheduled/scheduledLabels'
import { AutomationDetail } from './AutomationDetail'
import { AutomationRow, glyphOf, MovePicker, PausePicker } from './AutomationRows'
import { AskCard } from '../asks/AskCard'
import { takeAutomationCreate, useAutomationCreate, type AutomationCreateRequest } from '../../stores/automationCreateStore'
import { useAutomationLibrary } from './WhoDoPickers'
import { createPersonalBotsClient } from '../../services/personalBotsClient'
import { groupAutomations, matchesSearch, missedText, moveBlocked, moveSummary, primaryOf, recentEntries, runText, SEARCH_AFTER_ROWS, unreachableReason, type MetaContext } from './automationList'
import { AutomationComposer, MANAGER_KEY, NEW_BOT_KEY, type ComposerSend } from './AutomationComposer'
import { NewBotDialog } from '../bots/NewBotDialog'
import type { AutomationWhoPick } from '../../services/automationsClient'
import { DraftCard } from './DraftCard'
import { AutomationOverview } from './AutomationOverview'
import { deliveryText, type RequestApi } from './RequestTrigger'
import { KeyDialog } from './KeyDialog'
import { ownedWhenText, viewerTimeZone } from './automationTime'
import { computerChoicesOf } from './computerChoice'

/** How often the open page reads the list again, for sources that send no change event (bots' next runs, watches). */
const POLL_MS = 15_000

/** The Who chip's value as the daemon reads it. */
function pickOf(key: string): AutomationWhoPick {
  return key.startsWith('bot:') ? { kind: 'bot', botId: key.slice('bot:'.length) } : { kind: 'default' }
}

function browserRequestApi(): RequestApi {
  const webhook = window.mousse.scheduled.webhook
  return {
    enable: (id) => webhook.enable(id),
    rotate: (id) => webhook.rotate(id),
    disable: (id) => webhook.disable(id),
    copy: (text) => navigator.clipboard.writeText(text)
  }
}

/** Whether focus is on the Automations page (the list, its composer or its detail), not elsewhere in the window. */
export function pageHasFocus(doc: Pick<Document, 'activeElement' | 'querySelector'> | undefined = typeof document === 'undefined' ? undefined : document): boolean {
  const page = doc?.querySelector('[data-automations-workspace]:not([hidden])')
  const focused = doc?.activeElement
  return Boolean(page && focused && page.contains(focused))
}

/** What the composer opens with for Repeat this…: the words to send and the project. */
export function prefillOf(request: AutomationCreateRequest): { nonce: number; text: string; projectId?: string } {
  return { nonce: request.nonce, text: request.prompt?.trim() ?? '', ...(request.projectId !== undefined ? { projectId: request.projectId } : {}) }
}

/** How long the composer says "Setting it up…" for a bot, which reports in its own chat. */
const BOT_WORKING_MS = 90_000

/** The name the page gives an agent: the provider instance's label (Claude, Codex), else the model. */
function agentNameOf(providers: LlmProviderOption[], selection: { instanceId?: string; llmProvider?: string; model?: string } | undefined): string | undefined {
  if (!selection) return undefined
  return providers.find((provider) => listingServes(provider, selection))?.label
}

/**
 * The Automations page: the composer (the manager builds a draft from your words), the drafts, then Needs you, Today,
 * Upcoming, Watching and On demand, with Paused and Recent folded at the end. Rows open their detail (the card, Change
 * it…, runs, and Edit details for the full form), their bot chat or their thread. ⇧/⌘-click and ⌘A select rows for
 * Pause…, Resume and Delete.
 */
export function AutomationsList({ active }: { active: boolean }) {
  const client = useMemo(() => createAutomationsClient(window.mousse.platformRequest), [])
  const [index, setIndex] = useState<AutomationIndex | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [jobs, setJobs] = useState<ScheduledJob[]>([])
  const [status, setStatus] = useState<SchedulerStatus | null>(null)
  const [catalog, setCatalog] = useState<ScheduledCatalog>(EMPTY_CATALOG)
  const [providers, setProviders] = useState<LlmProviderOption[]>([])
  const [settings, setSettings] = useState<MousseSettings | null>(null)
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
  const [actionError, setActionError] = useState<string | null>(null)
  const [moving, setMoving] = useState<string[] | null>(null)
  // Add key: the automation that needs it (its keys gain the name), and the name a run asked for.
  const [addingKey, setAddingKey] = useState<{ jobId?: string; name?: string } | null>(null)
  const [storedKeys, setStoredKeys] = useState<string[]>([])
  const [prefill, setPrefill] = useState<{ nonce: number; text: string; projectId?: string } | null>(null)
  // The draft or automation the detail shows; `editing`: its full form (Edit details).
  const [editing, setEditing] = useState(false)
  // The manager the composer last sent to, and when: the status line follows it.
  const [sent, setSent] = useState<{ builtBy: string; at: number } | null>(null)
  // Who does it, as the person picks it in the composer (`default`, `bot:<id>`); the manager never picks it.
  const [who, setWho] = useState('default')
  // + New bot…: the dialog, prefilled with these words, and where the new bot goes (the composer, or a draft by id).
  const [newBot, setNewBot] = useState<{ text: string; draftId?: string } | null>(null)
  const [managerThreadId, setManagerThreadId] = useState<string | null>(null)
  const [, setTick] = useState(0)
  const automateRequest = useAutomationCreate((state) => state.request)
  const listRef = useRef<HTMLDivElement>(null)
  const requestApi = useMemo(browserRequestApi, [])
  const viewerZone = useMemo(viewerTimeZone, [])
  const activeProjectId = useAppStore((state) => state.threads.find((thread) => thread.id === state.activeThreadId)?.projectId ?? '')
  const profileId = useAppStore((state) => state.profileId)
  const { library, reload: reloadLibrary } = useAutomationLibrary(profileId)
  const managerActivity = useAppStore((state) => (managerThreadId ? state.threadActivity[managerThreadId] : undefined))

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

  // ⌘N is page-scoped: while focus is on this page, the key press goes to the composer. The palette and the menu
  // keep New thread, and anywhere else ⌘N is New thread too.
  useCommand('thread.new', () => {
    setDetail(null)
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.automation-composer-input')?.focus())
  }, () => active && pageHasFocus(), { keysOnly: true })

  // Repeat this…: the composer opens with the request's words.
  useEffect(() => {
    if (!automateRequest || !settings) return
    setDetail(null)
    setPrefill(prefillOf(automateRequest))
    takeAutomationCreate()
  }, [automateRequest, settings])

  const items = useMemo(() => index?.items ?? [], [index])
  const detailItem = detail ? items.find((item) => item.key === detail) : undefined
  // Another computer's automation is edited from the record it sent with its list.
  const allJobs = useMemo(() => [...jobs, ...(index?.remoteJobs ?? [])], [jobs, index])
  const detailJob = detailItem?.link.kind === 'job' ? allJobs.find((job) => job.id === (detailItem.link as { jobId: string }).jobId) : undefined
  const detailInitial = useMemo(() => (detailJob ? draftFromJob(detailJob, catalog, providers) : null), [detailJob, catalog, providers])
  const shown = useMemo(() => (query.trim() ? items.filter((item) => matchesSearch(item, query)) : items), [items, query])
  const now = new Date()
  const groups = useMemo(() => groupAutomations(shown, new Date()), [shown])
  const pausedGroup = groups.find((group) => group.key === 'paused')
  const visibleGroups = groups.filter((group) => group.key !== 'paused')
  const recent = useMemo(() => recentEntries(shown), [shown])
  const ordered = useMemo(() => [...visibleGroups.flatMap((group) => group.items), ...(pausedOpen ? pausedGroup?.items ?? [] : [])], [visibleGroups, pausedGroup, pausedOpen])
  const jobOf = (item: AutomationItem) => (item.link.kind === 'job' ? allJobs.find((job) => job.id === (item.link as { jobId: string }).jobId) : undefined)
  // This computer, then the person's other computers (the Computer chip; names show once there are two).
  const computers = computerChoicesOf(index, viewerZone)
  // Computer names show only when the person has more than one.
  const manyComputers = (index?.computers?.length ?? 0) > 0
  const defaultAgent = settings ? agentNameOf(providers, { instanceId: settings.provider.instanceId, llmProvider: settings.provider.llmProvider }) ?? 'Default agent' : 'Default agent'
  const modelName = (item: AutomationItem) => {
    const job = jobOf(item)
    if (item.who.kind === 'saved_agent') return item.who.name
    if (item.who.kind !== 'agent') return undefined
    return agentNameOf(providers, job?.selection) ?? (job?.selection ? job.selection.model : defaultAgent)
  }
  const ctx: MetaContext = { now, viewerZone, manyComputers, modelName }

  // A selection keeps only rows that still exist and that it can act on (scheduled jobs).
  useEffect(() => {
    setSelected((current) => current.filter((key) => items.some((item) => item.key === key && item.kind === 'job' && !item.computer.offline)))
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
      setSelected(ordered.filter((item) => item.kind === 'job' && !item.computer.offline).map((item) => item.key))
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

  const openItem = (item: AutomationItem, edit = false) => {
    setSelected([])
    if (item.link.kind === 'thread' || item.link.kind === 'ask') goThread(item.link.threadId)
    else { setDetail(item.key); setEditing(edit); void loadCatalog() }
  }

  // ── The manager: the composer's words go to it as a person's message, with the project and computer picked. ──
  const knownManagerThread = managerThreadId ?? items.find((item) => item.draft?.managerThreadId)?.draft?.managerThreadId ?? null
  const botsClient = useMemo(() => createPersonalBotsClient(window.mousse.platformRequest), [])
  const sendToManager = async (send: Omit<ComposerSend, 'who'> & { who?: string; draftId?: string; automationId?: string }) => {
    const project = catalog.projects.find((entry) => entry.id === send.projectId)
    const computer = send.node ? computers.find((entry) => entry.node === send.node)?.name : undefined
    const message = managerMessage({
      text: send.text,
      ...(project ? { project: { id: project.id, name: project.name } } : {}),
      ...(computer ? { computer } : {}),
      ...(send.draftId ? { draftId: send.draftId } : {}),
      ...(send.automationId ? { automationId: send.automationId } : {})
    })
    // The drafts this manager writes next take the Who the person picked.
    if (send.who !== undefined) await client.nextWho(send.builtBy === MANAGER_KEY ? undefined : send.builtBy.slice('bot:'.length), pickOf(send.who))
    if (send.builtBy === MANAGER_KEY) {
      // Asked on every send: it also tells the daemon which project the manager's turn works in.
      const threadId = await client.managerThread(project?.id)
      setManagerThreadId(threadId)
      await window.mousse.orchestrator.sendToThread(threadId, message)
    } else {
      await botsClient.send(send.builtBy.slice('bot:'.length), message, crypto.randomUUID())
    }
    setSent({ builtBy: send.builtBy, at: Date.now() })
  }
  const sentBot = sent && sent.builtBy !== MANAGER_KEY ? sent.builtBy.slice('bot:'.length) : undefined
  const working = Boolean(sent) && (sent!.builtBy === MANAGER_KEY ? isThreadActivityActive(managerActivity) || Date.now() - sent!.at < 4_000 : Date.now() - sent!.at < BOT_WORKING_MS)
  // The status line goes when the manager's turn ends; a bot's after a while (it reports in its chat).
  useEffect(() => {
    if (!sent) return
    const timer = setInterval(() => setTick((count) => count + 1), 2_000)
    return () => clearInterval(timer)
  }, [sent])
  const stopManager = () => {
    if (!sent) return
    if (sentBot) void botsClient.stop(sentBot).catch(() => undefined)
    else if (knownManagerThread) void window.mousse.orchestrator.abort(knownManagerThread)
    setSent(null)
  }
  const openConversation = (item?: AutomationItem) => {
    const botId = item?.draft?.botId ?? sentBot
    if (botId) openBot(botId)
    else if (item?.draft?.managerThreadId ?? knownManagerThread) goThread((item?.draft?.managerThreadId ?? knownManagerThread)!)
  }
  /** A draft's or automation's own manager: the bot that wrote it, else the Automation manager. */
  const builtByOf = (item: AutomationItem) => (item.draft?.botId ? `bot:${item.draft.botId}` : MANAGER_KEY)
  const projectOf = (item: AutomationItem) => item.where?.projectId ?? ''
  const answerDraft = (item: AutomationItem, answer: string) => act(async () => {
    await client.answered(item.id)
    await sendToManager({ text: answer, projectId: projectOf(item), node: '', builtBy: builtByOf(item), draftId: item.id })
  })
  const changeIt = (item: AutomationItem, text: string) => sendToManager({ text, projectId: projectOf(item), node: '', builtBy: builtByOf(item), ...(item.draft ? { draftId: item.id } : { automationId: item.id }) })
  const turnOn = async (item: AutomationItem) => {
    await client.turnOn(item.id)
    await refresh()
  }
  const discard = (item: AutomationItem) => act(async () => {
    await client.discard(item.id)
    if (detail === item.key) setDetail(null)
  })
  const setUpByHand = (projectId: string) => act(async () => {
    const job = await client.createDraft(projectId || undefined)
    setJobs(await window.mousse.scheduled.list())
    await refresh()
    setDetail(`job:${job.id}`)
    setEditing(true)
    void loadCatalog()
  })
  const whoOf = (item: AutomationItem) => {
    const botId = item.draft?.who?.botId
    if (botId) return library.bots.find((bot) => bot.id === botId)?.name ?? 'Bot'
    return item.draft ? 'Default agent' : modelName(item) ?? item.who.name
  }
  // Who on the composer or a draft's card: a bot or the default agent, or + New bot… (the dialog, then back here).
  const chooseWho = (key: string, text: string) => {
    if (key === NEW_BOT_KEY) setNewBot({ text })
    else setWho(key)
  }
  const chooseDraftWho = (item: AutomationItem, key: string) => {
    if (key === NEW_BOT_KEY) { setNewBot({ text: jobOf(item)?.prompt ?? item.name, draftId: item.id }); return }
    void act(() => client.setWho(item.id, pickOf(key)))
  }
  const botMade = (botId: string) => {
    const target = newBot
    setNewBot(null)
    reloadLibrary()
    if (target?.draftId) void act(() => client.setWho(target.draftId!, { kind: 'bot', botId }))
    else setWho(`bot:${botId}`)
  }

  const runNow = (jobId: string) => act(() => window.mousse.scheduled.run(jobId))
  // Needs you answers an ask in place, with the daemon method its own surface uses.
  const answer = (item: AutomationItem, allow: boolean) => {
    const target = item.attention?.answer
    if (!target) return
    void act(() => answerAttention(target, allow, {
      transport: window.mousse.platformRequest,
      answerQuestions: (requestId, answers, threadId) => window.mousse.orchestrator.answerQuestionsDetailed(requestId, answers, threadId)
    }))
  }
  const keep = (jobId: string) => act(() => client.keep(jobId))
  const resend = (jobId: string, occurrenceId: string) => act(() => client.resend(jobId, occurrenceId))
  const openAddKey = (jobId: string | undefined, name?: string) => {
    setAddingKey({ ...(jobId ? { jobId } : {}), ...(name ? { name } : {}) })
    void client.listKeys().then(setStoredKeys, () => setStoredKeys([]))
  }
  // The value goes to the daemon once; the automation then names the key, and the list reads again.
  const saveKey = async (jobId: string | undefined, name: string, value: string) => {
    await client.setKey(name, value)
    const job = jobId ? allJobs.find((entry) => entry.id === jobId) : undefined
    if (job && !(job.keys ?? []).includes(name)) await window.mousse.scheduled.update(job.id, { keys: [...(job.keys ?? []), name] })
    await refresh()
  }
  const resume = (jobIds: string[]) => act(async () => { for (const id of jobIds) await window.mousse.scheduled.resume(id) })
  // A row paused because its bot is paused resumes the bot (all its schedules), as the bot's own Resume does.
  const resumeItem = (item: AutomationItem) => {
    if (item.pausedBy === 'bot' && item.link.kind === 'job' && item.link.botId) {
      const botId = item.link.botId
      return act(() => createPersonalBotsClient(window.mousse.platformRequest).resume(botId))
    }
    return item.link.kind === 'job' ? resume([item.link.jobId]) : Promise.resolve()
  }

  const primary = (item: AutomationItem) => {
    const kind = primaryOf(item).kind
    if (kind === 'allow') { answer(item, true); return }
    if (kind === 'open') {
      const thread = item.attention?.threadId ?? item.active?.threadId
      // A bot's row opens its chat, where its runs report.
      if (item.link.kind === 'job' && item.link.botId) openBot(item.link.botId)
      else if (item.kind === 'job' && thread) goThread(thread)
      else openItem(item)
      return
    }
    if (item.link.kind !== 'job') return
    if (kind === 'resume') void resumeItem(item)
    else if (kind === 'add_key') openAddKey(item.link.jobId, item.attention?.addKey)
    else void runNow(item.link.jobId)
  }

  const menuOf = (item: AutomationItem): RowMenuItem[] => {
    const notNow: RowMenuItem[] = item.attention?.kind === 'ask' && item.attention.answer
      ? [{ label: 'Not now', testId: 'automation-ask-not-now', onSelect: () => answer(item, false) }]
      : []
    const askThread = item.attention?.threadId
    if (item.link.kind === 'ask') return [...notNow, { label: 'Open thread', onSelect: () => goThread((item.link as { threadId: string }).threadId) }]
    if (item.link.kind === 'thread') return [{ label: 'Open thread', onSelect: () => goThread((item.link as { threadId: string }).threadId) }]
    if (item.link.kind === 'moved') return []
    const jobId = item.link.jobId
    // A bot's automation: its runs report in the bot chat; When, Do and Tell me are edited here, Who stays the bot.
    if (item.link.botId) {
      const botId = item.link.botId
      return [
        ...notNow,
        { label: 'Open bot chat', onSelect: () => openBot(botId) },
        item.paused ? { label: 'Resume', onSelect: () => void resumeItem(item) } : { label: 'Pause…', onSelect: () => setPausing([item.key]) },
        { label: 'Edit', onSelect: () => openItem(item, true) },
        { label: 'Delete', danger: true, onSelect: () => setDeleting([item.key]) }
      ]
    }
    const kind = primaryOf(item).kind
    const thread = item.active?.threadId ?? item.last?.threadId
    return [
      ...notNow,
      ...(notNow.length && askThread ? [{ label: 'Open thread', onSelect: () => goThread(askThread) }] : []),
      ...(kind !== 'run' && kind !== 'retry' ? [{ label: 'Run now', disabled: Boolean(item.active && item.active.state !== 'waiting'), onSelect: () => void runNow(jobId) }] : []),
      item.paused ? { label: 'Resume', onSelect: () => void resume([jobId]) } : { label: 'Pause…', onSelect: () => setPausing([item.key]) },
      { label: 'Edit', onSelect: () => openItem(item, true) },
      ...(item.keepable ? [{ label: 'Keep', testId: 'automation-keep-menu', title: 'Remove its end; nothing else about it changes', onSelect: () => void keep(jobId) }] : []),
      ...(thread ? [{ label: 'Open last thread', onSelect: () => goThread(thread) }] : []),
      { label: 'Delete', danger: true, onSelect: () => setDeleting([item.key]) }
    ]
  }

  const select = (item: AutomationItem, mode: 'range' | 'toggle') => {
    // An offline computer's rows are its last copy: nothing can be done to them until it is back.
    if (item.kind !== 'job' || item.computer.offline) return
    if (mode === 'toggle' || !anchor) {
      setSelected((current) => (current.includes(item.key) ? current.filter((key) => key !== item.key) : [...current, item.key]))
      setAnchor(item.key)
      return
    }
    const keys = ordered.map((entry) => entry.key)
    const [from, to] = [keys.indexOf(anchor), keys.indexOf(item.key)].sort((a, b) => a - b)
    if (from < 0) { setSelected([item.key]); setAnchor(item.key); return }
    setSelected(ordered.slice(from, to + 1).filter((entry) => entry.kind === 'job' && !entry.computer.offline).map((entry) => entry.key))
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

  // Move to computer: made there first, removed here once that computer confirmed; what did not move says why.
  const move = async (keys: string[], node: string) => {
    setActionError(null)
    const to = computers.find((computer) => computer.node === node)?.name ?? 'the other computer'
    const result = await client.move(idsOf(keys), node)
    setActionError(moveSummary(result, to))
    setMoving(null)
    setSelected([])
    if (detail && result.moved.some((entry) => keys.includes(`job:${entry.id}`))) setDetail(null)
    void refresh()
  }
  const selectedItems = selected.flatMap((key) => items.filter((item) => item.key === key))
  const moveReason = moveBlocked(selectedItems)

  const schedulerDown = status !== null && !status.running
  const rowCount = items.filter((item) => item.kind !== 'moved').length

  const dialogs = (
    <>
      {newBot ? <NewBotDialog initialDescription={newBot.text} onCreated={(bot) => botMade(bot.id)} onClose={() => setNewBot(null)} /> : null}
      {addingKey ? <KeyDialog {...(addingKey.name ? { name: addingKey.name } : {})} stored={storedKeys} onSave={(name, value) => saveKey(addingKey.jobId, name, value)} onClose={() => setAddingKey(null)} /> : null}
      {moving ? <MovePicker count={moving.length} computers={computers.filter((computer) => computer.node !== '')} onCancel={() => setMoving(null)} onMove={(node) => move(moving, node)} /> : null}
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

  if (detail && detailItem && detailJob && detailInitial && !editing) {
    return (
      <div className="automations-scroll">
        <div className="automations-column">
          <AutomationOverview
            item={detailItem}
            job={detailJob}
            who={whoOf(detailItem)}
            ctx={ctx}
            bots={library.bots}
            onWho={(key) => chooseDraftWho(detailItem, key)}
            onBack={() => setDetail(null)}
            onRunNow={() => void runNow(detailJob.id)}
            onPause={() => setPausing([detailItem.key])}
            onResume={() => void resumeItem(detailItem)}
            onDelete={() => setDeleting([detailItem.key])}
            onTurnOn={() => turnOn(detailItem)}
            onDiscard={() => void discard(detailItem)}
            onAnswer={(answer) => void answerDraft(detailItem, answer)}
            onEditDetails={() => setEditing(true)}
            onChangeIt={(text) => changeIt(detailItem, text)}
            onOpenThread={goThread}
            {...(detailItem.draft ? { onOpenConversation: () => openConversation(detailItem) } : {})}
          />
          {actionError ? <p className="scheduled-action-error" role="alert">{actionError}</p> : null}
        </div>
        {dialogs}
      </div>
    )
  }

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
            computers={computers}
            {...(detailItem.computer.local && !moveBlocked([detailItem]) ? { onMove: (node: string) => void move([detailItem.key], node).catch((cause) => setActionError(errorText(cause))) } : {})}
            save={async (draft) => {
              const change = patchOf(initial, draft, catalog)
              if (!isUnchanged(change)) await window.mousse.scheduled.update(detailJob.id, change)
              await refresh()
            }}
            onBack={() => setEditing(false)}
            onRunNow={() => void runNow(detailJob.id)}
            onPause={() => setPausing([detailItem.key])}
            onResume={() => void resumeItem(detailItem)}
            onDelete={() => setDeleting([detailItem.key])}
            requestApi={requestApi}
            onResend={(occurrenceId) => void resend(detailJob.id, occurrenceId)}
            onKeep={() => void keep(detailJob.id)}
            {...(detailItem.computer.local ? {
              onKeys: (keys: string[]) => void act(() => window.mousse.scheduled.update(detailJob.id, { keys: keys.length ? keys : null })),
              onAddKey: (name?: string) => openAddKey(detailJob.id, name)
            } : {})}
            {...(detailJob.trigger?.threadEvent && detailItem.computer.local ? { onEvents: (events: ThreadEventKind[]) => void act(() => window.mousse.scheduled.update(detailJob.id, { threadEvent: { events } })) } : {})}
            onOpenThread={goThread}
            onOpenBot={openBot}
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
          <AutomationComposer
            projects={catalog.projects}
            computers={computers}
            bots={library.bots}
            initialProjectId={activeProjectId}
            prefill={prefill}
            working={working}
            onSend={sendToManager}
            onStop={stopManager}
            onSetUpByHand={(projectId) => void setUpByHand(projectId)}
            who={who}
            onWho={chooseWho}
            starters={Boolean(index) && rowCount === 0}
            {...(sentBot || knownManagerThread ? { onOpenConversation: () => openConversation() } : {})}
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
              {computers.length > 1 ? (
                <button type="button" className="settings-btn" data-testid="automation-move" disabled={Boolean(moveReason)} title={moveReason ?? 'Move to another of your computers'} onClick={() => setMoving(selected)}>Move to computer…</button>
              ) : null}
              <button type="button" className="settings-btn danger" onClick={() => setDeleting(selected)}>Delete</button>
              <button type="button" className="settings-icon-btn" aria-label="Clear selection" title="Clear selection" onClick={() => setSelected([])}><X size={12} /></button>
            </div>
          ) : null}

          {visibleGroups.map((group) => group.key === 'draft' ? (
            <section key={group.key} className="automation-group automation-drafts" data-testid="automation-group" data-group="draft" aria-label={group.label}>
              {group.items.map((item) => (
                <DraftCard
                  key={item.key}
                  item={item}
                  job={jobOf(item)}
                  who={whoOf(item)}
                  ctx={ctx}
                  bots={library.bots}
                  onWho={(key) => chooseDraftWho(item, key)}
                  onTurnOn={() => turnOn(item)}
                  onEditDetails={() => openItem(item, true)}
                  onDiscard={() => void discard(item)}
                  onAnswer={(answer) => void answerDraft(item, answer)}
                  onOpenConversation={() => openConversation(item)}
                />
              ))}
            </section>
          ) : (
            <section key={group.key} className="automation-group" data-testid="automation-group" data-group={group.key} aria-label={group.label}>
              <h2 className="automation-group-head">{group.key === 'needs' ? `${group.label} · ${group.items.length}` : group.label}</h2>
              <div className="automation-rows" role="listbox" aria-multiselectable="true" aria-label={group.label}>
                {group.items.map((item) => item.attention?.kind === 'ask' && item.attention.answer ? (
                  // Every ask Needs you can answer in place renders through the one ask card.
                  <AskCard
                    key={item.key}
                    layout="row"
                    line={item.attention.text}
                    lineText={item.attention.text}
                    onAnswer={(choice) => answer(item, choice === 'allow')}
                    row={{ name: item.name, key: item.key, kind: item.kind, menu: menuOf(item).filter((entry) => entry.testId !== 'automation-ask-not-now'), onOpen: () => openItem(item) }}
                  />
                ) : (
                  <AutomationRow
                    key={item.key}
                    item={item}
                    selected={selected.includes(item.key)}
                    ctx={ctx}
                    menu={menuOf(item)}
                    unreachable={unreachableReason(item)}
                    onOpen={() => openItem(item)}
                    onSelect={(mode) => select(item, mode)}
                    onPrimary={() => primary(item)}
                    {...(item.link.kind === 'job' && item.link.botId ? { onOpenBot: () => openBot((item.link as { botId: string }).botId) } : {})}
                  />
                ))}
              </div>
            </section>
          ))}

          {index && rowCount === 0 ? <p className="scheduled-empty">Nothing runs on its own yet.</p> : null}
          {index && rowCount > 0 && shown.length === 0 ? <p className="scheduled-empty">No automation matches.</p> : null}

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
                  <AutomationRow key={item.key} item={item} selected={selected.includes(item.key)} ctx={ctx} menu={menuOf(item)} unreachable={unreachableReason(item)} onOpen={() => openItem(item)} onSelect={(mode) => select(item, mode)} onPrimary={() => primary(item)} />
                ))}
              </div>
            </section>
          ) : null}

          {recentOpen && recent.length ? (
            <section className="automation-group" data-testid="automation-recent-runs" aria-label="Recent runs">
              <ul className="automation-recent">
                {recent.map(({ item, at, run, delivery }, index) => {
                  const request = delivery ? deliveryText(delivery) : undefined
                  const occurrenceId = run?.request?.resendable ? run.request.occurrenceId : delivery?.resendable ? delivery.occurrenceId : undefined
                  return (
                    <li key={`${item.key}-${at}-${index}`} className="automation-run" data-state={run?.state ?? 'refused'} data-testid={delivery && !run ? 'automation-recent-delivery' : undefined}>
                      <span className={`automation-glyph ${glyphOf(item).kind}`} aria-hidden="true">{glyphOf(item).glyph}</span>
                      <span className="automation-run-name">{item.kind === 'moved' ? `${item.name} · ${item.whenText}` : item.name}</span>
                      {request ? <span className={`scheduled-outcome${request.refused ? ' refused' : ''}`} title={request.detail || undefined}>{request.word}</span> : null}
                      <span className="automation-run-text">{run ? runText(run, now, item.computer, viewerZone).replace(/ · (just now|\d+ (min|h|d) ago)$/, '') : request?.detail}</span>
                      <span className="automation-run-when">{ownedWhenText(at, now, item.computer, viewerZone)}</span>
                      {run && missedText(run) ? <span className="automation-run-missed" data-testid="automation-run-missed" title={missedText(run)!.title}>{missedText(run)!.text}</span> : null}
                      {run?.threadId ? <button type="button" className="scheduled-link-btn" onClick={() => goThread(run.threadId!)}>Open thread</button> : null}
                      {occurrenceId && item.link.kind === 'job' ? <button type="button" className="scheduled-link-btn" data-testid="automation-recent-resend" title="Run it again with this request's stored body" onClick={() => void resend((item.link as { jobId: string }).jobId, occurrenceId)}>Resend</button> : null}
                    </li>
                  )
                })}
              </ul>
            </section>
          ) : null}
        </div>
      </div>
      {dialogs}
    </div>
  )
}
