import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus } from '../../lib/icons'
import { describePermissionMode, isStricter, narrowPermissionMode, PERMISSION_MODES, type PermissionMode } from '../../../shared/permissionMode'
import { offlineText } from '../../../shared/automations'
import type { BotComputerChoice } from '../../../shared/bots/personal/methods'
import type { BotSchedule } from '../../../shared/bots/personal/definition'
import type { CreateScheduledJobInput, JobSchedule } from '../../../shared/types'
import { workflowCommandText, workflowInputsReady } from '../../../shared/workflows/workflowCommand'
import { Select, type SelectOption } from '../ui/Select'
import { errorText, nameFromPrompt, SCHEDULE_PRESETS } from '../scheduled/scheduledLabels'
import type { ScheduledCatalog } from '../scheduled/jobDraft'
import { parseWhen } from './parseWhen'
import { firstRunInZone, nextBeforeAdd } from './automationTime'
import { computerOptions, computersForProject, projectOnComputer, projectsOn, type ComputerChoice } from './computerChoice'
import { botComputerOptions } from '../bots/BotAboutPanel'
import { describeSchedule } from '../../../shared/scheduleLabel'
import { botWhen, matchWorkflows, parseWhoKey, whoKey, whoName, whoOptions, type AutomationLibrary, type Who, type WorkflowChoice } from './whoDo'
import { DoPicker, useWorkflowFields, WorkflowInputs } from './WhoDoPickers'
import { parseThreadEvent } from './parseThreadEvent'
import { THREAD_EVENT_CHOICES, threadEventChoice, threadEventText } from '../../../shared/threadEvents'
import type { Thread, ThreadEventKind } from '../../../shared/types'

/** A When the person picked from the chip; it wins over what the text says. */
type Picked = { key: string; schedule: JobSchedule; label: string }

const PICKS: Picked[] = [
  ...SCHEDULE_PRESETS.map((preset) => ({ key: preset.value, schedule: preset.schedule as JobSchedule, label: preset.label })),
  // On demand exists only when picked: text never makes one.
  { key: 'manual', schedule: { kind: 'manual' }, label: 'On demand' }
]

/** "When a thread…": the thread whose pull request wakes it, and what on it. */
type EventPick = { threadId: string; choice: string }

/** The local threads with a pull request linked: the ones a thread-event automation can wake on. */
export function pullRequestThreads(threads: readonly Thread[]): Thread[] {
  return threads.filter((thread) => thread.pullRequest && !thread.botOwned && !thread.node)
}

/** The thread #number is linked to, preferring one in the chosen project. */
export function threadForPullRequest(threads: readonly Thread[], number: number, projectId: string): Thread | undefined {
  const linked = pullRequestThreads(threads).filter((thread) => thread.pullRequest!.number === number)
  return linked.find((thread) => thread.projectId === projectId) ?? linked[0]
}

/** What another surface opens the create row with (Automate…, Repeat this…). */
export interface CreatePrefill {
  /** Bumped for each request, so the same prefill can open the row twice. */
  nonce: number
  prompt?: string
  projectId?: string
  who?: Who
  workflowId?: string
}

export interface CreateRowProps {
  profileId: string
  catalog: ScheduledCatalog
  library: AutomationLibrary
  /** The default agent's name, for the Who chip. */
  defaultName: string
  /**
   * This computer first, then the person's other computers. With two or more the Computer chip shows: the automation
   * is stored and run by the one picked, on its clock.
   */
  computers: ComputerChoice[]
  /** This computer's zone. */
  viewerZone: string
  /** The project the page opens with. */
  initialProjectId: string
  /** The May a new automation gets (the profile's default mode, held to its ceiling). */
  defaultMay: PermissionMode
  /** The most it may have: the mode the person holds. */
  ceiling: PermissionMode
  isGitRepo: (projectId: string) => Promise<boolean>
  /** `node`: the other computer that owns it; absent, this one. */
  create: (input: CreateScheduledJobInput, node?: string) => Promise<void>
  /** With a bot as Who, the bot gets the schedule (it stays the bot's, and it runs in the bot's chat); `model` is one picked by hand. */
  addBotSchedule: (botId: string, when: BotSchedule['when'], prompt: string, model?: string) => Promise<void>
  /** What a bot may run on, picked by hand (#673): the models that can hold it here, and the computers it can run on. */
  botChoices?: (botId: string) => Promise<{ models: Array<{ model: string; label: string }>; computers: BotComputerChoice[] }>
  /** Opens the bot's chat, where its grant (its May) is shown. */
  onOpenBot: (botId: string) => void
  /** Bumped by ⌘N on the page: the row opens and takes focus. */
  openRequest: number
  prefill?: CreatePrefill | null
  /** The quiet row's tooltip, with its shortcut. */
  title: string
}

/**
 * The quiet "+ New automation…" row. It opens in place: one line of what to do and when ("every weekday at 9 review
 * open PRs"), the When · Who · Do · Where chips, and a line that says what Add authorizes: the next run on the owning
 * computer's clock and the effective May. An unread When says Choose when and keeps Add off. Typing `/` offers the
 * workflows; a workflow swaps the prompt for its inputs and the Who chip goes, since a workflow runs itself.
 */
export function CreateRow({ profileId, catalog, library, defaultName, computers, viewerZone, initialProjectId, defaultMay, ceiling, isGitRepo, create, addBotSchedule, botChoices, onOpenBot, openRequest, prefill, title }: CreateRowProps) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [picked, setPicked] = useState<Picked | null>(null)
  const [eventPick, setEventPick] = useState<EventPick | null>(null)
  const [projectId, setProjectId] = useState(initialProjectId)
  // The computer that will own it: '' is this one.
  const [node, setNode] = useState('')
  const [may, setMay] = useState<PermissionMode>(defaultMay)
  const [who, setWho] = useState<Who>({ kind: 'default' })
  const [workflowId, setWorkflowId] = useState('')
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [repo, setRepo] = useState<Record<string, boolean>>({})
  const inputRef = useRef<HTMLInputElement>(null)

  const manyComputers = computers.length > 1
  const owner = computers.find((computer) => computer.node === node) ?? computers[0] ?? { node: '', name: 'This computer', timeZone: viewerZone }
  // Another computer runs it with its own default agent: this computer's models, saved agents, workflows and bots are not there.
  const remote = node !== ''
  const workflow: WorkflowChoice | undefined = remote ? undefined : library.workflows.find((entry) => entry.id === workflowId)
  const { fields, loading: fieldsLoading } = useWorkflowFields(profileId, workflow)

  const focusInput = () => requestAnimationFrame(() => inputRef.current?.focus())
  useEffect(() => { setMay(defaultMay) }, [defaultMay])
  useEffect(() => { if (!open) { setProjectId(initialProjectId); setNode('') } }, [initialProjectId, open])
  useEffect(() => {
    if (openRequest === 0) return
    setOpen(true)
    focusInput()
  }, [openRequest])
  // Automate… and Repeat this… open the row with what they carry.
  useEffect(() => {
    if (!prefill) return
    setOpen(true)
    setPicked(null)
    setError(null)
    setText(prefill.prompt ?? '')
    setWho(prefill.who ?? { kind: 'default' })
    setWorkflowId(prefill.workflowId ?? '')
    setInputs({})
    if (prefill.projectId !== undefined) setProjectId(prefill.projectId)
    focusInput()
  }, [prefill])
  useEffect(() => {
    if (!projectId || projectId in repo) return
    let live = true
    isGitRepo(projectId).then((answer) => { if (live) setRepo((current) => ({ ...current, [projectId]: answer })) }, () => { if (live) setRepo((current) => ({ ...current, [projectId]: false })) })
    return () => { live = false }
  }, [projectId, repo, isGitRepo])

  const now = new Date()
  const parsed = useMemo(() => parseWhen(text, new Date()), [text])
  const eventParse = useMemo(() => parseThreadEvent(text), [text])
  // A thread-event automation: picked from When ("When a thread…"), or typed ("when #712 gets a review…").
  const typedEvent = !picked && !eventPick && eventParse.kind === 'ok' ? eventParse : null
  const eventThread = eventPick ? catalog.threads.find((thread) => thread.id === eventPick.threadId) : typedEvent ? threadForPullRequest(catalog.threads, typedEvent.number, projectId) : undefined
  const eventKinds: ThreadEventKind[] | null = eventPick ? THREAD_EVENT_CHOICES.find((choice) => choice.value === eventPick.choice)?.events ?? null : typedEvent ? typedEvent.events : null
  const onEvent = Boolean(eventPick || typedEvent)
  const eventNumber = eventThread?.pullRequest?.number ?? typedEvent?.number
  const eventLabel = eventKinds && eventNumber !== undefined ? `When ${threadEventText(eventNumber, eventKinds)}` : null
  // "when #712 gets a review every day at 9" says two things.
  const timeAndEvent = Boolean(typedEvent && parsed.kind === 'ok')
  const when: Pick<Picked, 'schedule' | 'label'> | null = onEvent
    ? eventKinds && eventThread && eventLabel && !timeAndEvent ? { schedule: { kind: 'manual' }, label: eventLabel } : null
    : picked ?? (parsed.kind === 'ok' ? { schedule: parsed.schedule, label: parsed.label } : null)
  const typed = (typedEvent ? typedEvent.prompt : picked || eventPick || parsed.kind !== 'ok' ? text : parsed.prompt).trim()
  const suggestions = workflow ? [] : matchWorkflows(text, library.workflows)
  const prompt = workflow ? workflowCommandText(workflow.slug, inputs, fields) : typed
  const bot = who.kind === 'bot' && !workflow && !remote ? library.bots.find((entry) => entry.id === who.id) : undefined
  const botSchedule = bot && when ? botWhen(when.schedule) : null
  // A bot runs by usage unless a model is picked by hand; it runs on this computer for now.
  const [botModel, setBotModel] = useState('')
  const [runsOn, setRunsOn] = useState<{ models: Array<{ model: string; label: string }>; computers: Array<{ id: string; name: string }> } | null>(null)
  const botId = bot?.id
  useEffect(() => {
    setBotModel('')
    setRunsOn(null)
    if (!botId || !botChoices) return
    let live = true
    botChoices(botId).then((choices) => { if (live) setRunsOn(choices) }, () => undefined)
    return () => { live = false }
  }, [botId, botChoices])
  const savedAgent = who.kind === 'agent' && !workflow && !remote ? library.agents.find((entry) => entry.id === who.id) : undefined
  // Next follows the owning computer's clock.
  const first = when ? firstRunInZone(when.schedule, now, owner.timeZone || viewerZone) : null
  const ready = workflow ? !fieldsLoading && workflowInputsReady(fields, inputs) : Boolean(typed) && !typed.startsWith('/')
  const eventBlock = !onEvent ? null
    : timeAndEvent ? 'Say one: a time or the pull request.'
      : !eventThread ? (typedEvent ? `No thread here has #${typedEvent.number} linked. Link it from its thread first.` : 'Pick the thread whose pull request wakes it.')
        : bot ? 'A bot runs on its schedule. Pick another Who.'
          : remote ? 'The pull request’s thread is on this computer. Pick it in Computer.'
            : null
  const blocked = eventBlock ?? (botSchedule && !botSchedule.ok ? botSchedule.reason : owner.offline ? offlineText(owner) : null)
  const canAdd = Boolean(when && ready && !busy && !blocked)
  const whenTitle = !when && eventParse.kind === 'ambiguous' ? eventParse.reason : !when && parsed.kind === 'ambiguous' ? parsed.reason : !when ? 'Say when in the text, like "every weekday at 9" or "when #712 gets a review", or pick one' : when.label

  const reset = () => {
    setText('')
    setPicked(null)
    setEventPick(null)
    setWho({ kind: 'default' })
    setWorkflowId('')
    setInputs({})
  }
  const close = () => {
    setOpen(false)
    setError(null)
  }
  const chooseWorkflow = (id: string) => {
    setWorkflowId(id)
    setInputs({})
    // The `/slug` typed to find it goes; the rest of the line is When.
    if (id && /^\/\S*$/.test(text.trim())) setText('')
    setError(null)
    focusInput()
  }

  const add = async () => {
    if (!when || !ready || blocked) return
    setBusy(true)
    setError(null)
    try {
      if (onEvent && eventThread?.pullRequest && eventKinds) {
        // It runs on the pull request's thread, in that thread's own workspace.
        const model = who.kind === 'model' && !workflow ? catalog.models.flatMap((group) => group.choices).find((choice) => choice.key === who.key) : undefined
        await create({
          name: workflow ? workflow.name : nameFromPrompt(prompt) || 'Automation',
          prompt,
          schedule: { kind: 'manual' },
          threadEvent: { threadId: eventThread.id, number: eventThread.pullRequest.number, events: eventKinds },
          threadId: eventThread.id,
          ...(eventThread.projectId ? { projectId: eventThread.projectId } : {}),
          ...(savedAgent ? { agent: { definitionId: savedAgent.id } } : {}),
          ...(model ? { selection: model.selection } : {}),
          ...(!savedAgent ? { permissionMode: may } : {}),
          tellMe: 'news'
        })
      } else if (bot && botSchedule?.ok) {
        await addBotSchedule(bot.id, botSchedule.when, prompt, botModel || undefined)
      } else {
        const gitProject = projectId ? (repo[projectId] ?? await isGitRepo(projectId).catch(() => false)) : false
        const model = who.kind === 'model' && !workflow && !remote ? catalog.models.flatMap((group) => group.choices).find((choice) => choice.key === who.key) : undefined
        await create({
          name: workflow ? workflow.name : nameFromPrompt(prompt) || 'Automation',
          prompt,
          schedule: when.schedule,
          createThread: true,
          ...(projectId ? { projectId } : {}),
          ...(projectId && gitProject ? { workspace: { kind: 'newWorktree' as const } } : {}),
          ...(savedAgent ? { agent: { definitionId: savedAgent.id } } : {}),
          ...(model ? { selection: model.selection } : {}),
          ...(!savedAgent ? { permissionMode: may } : {}),
          tellMe: 'news'
        }, remote ? node : undefined)
      }
      reset()
      setOpen(false)
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="automation-create-quiet"
        data-testid="automation-create"
        title={title}
        onClick={() => { setOpen(true); focusInput() }}
      >
        <Plus size={14} aria-hidden="true" /> New automation…
      </button>
    )
  }

  // With two or more computers, Where offers the chosen computer's projects.
  const projectOptions: SelectOption[] = [
    { value: '', label: 'No project' },
    ...(manyComputers ? projectsOn(catalog.projects, node) : catalog.projects).map((project) => ({ value: project.id, label: project.name }))
  ]
  const computerChoices = computersForProject(computers, catalog.projects, projectId)
  if (!computerChoices.some((computer) => computer.node === owner.node)) computerChoices.push(owner)
  const chooseComputer = (next: string) => {
    setNode(next)
    // The same repository there, when that computer has it.
    setProjectId(projectOnComputer(catalog.projects, projectId, next))
    // Another computer lets this one run at most what it allows (Auto-accept edits unless raised there).
    setMay(next ? narrowPermissionMode(defaultMay, 'accept_edits') : defaultMay)
    setError(null)
  }
  const mayOptions: SelectOption<PermissionMode>[] = PERMISSION_MODES.map((mode) => ({ value: mode, label: describePermissionMode(mode), disabled: isStricter(ceiling, mode) }))
  const whoKeyNow = whoKey(who)
  const naming = { defaultName, models: catalog.models, library }

  return (
    <div
      className="automation-create"
      data-testid="automation-create"
      data-open="true"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault()
          event.stopPropagation()
          close()
        }
      }}
    >
      <input
        ref={inputRef}
        className="automation-create-input"
        data-testid="automation-create-input"
        aria-label="New automation"
        placeholder={workflow ? `When does /${workflow.slug} run? every weekday at 9` : 'every weekday at 9 review open PRs · / for a workflow'}
        value={text}
        onChange={(event) => { setText(event.target.value); setError(null) }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            if (suggestions.length === 1) chooseWorkflow(suggestions[0]!.id)
            else if (canAdd) void add()
          }
        }}
      />
      {suggestions.length ? (
        <ul className="automation-do-suggestions" role="listbox" aria-label="Workflows" data-testid="automation-do-suggestions">
          {suggestions.map((entry) => (
            <li key={entry.id} role="option" aria-selected="false">
              <button type="button" className="automation-do-suggestion" title={entry.description ?? entry.name} onClick={() => chooseWorkflow(entry.id)}>
                <span className="scheduled-mono">/{entry.slug}</span>
                <span className="automation-do-suggestion-name">{entry.name}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {workflow ? <WorkflowInputs fields={fields} values={inputs} loading={fieldsLoading} onChange={(key, value) => setInputs((current) => ({ ...current, [key]: value }))} /> : null}
      <div className="automation-create-chips">
        <Select
          ariaLabel="When"
          className={`automation-chip-select when${when ? '' : ' unresolved'}`}
          size="small"
          title={whenTitle}
          value={eventPick ? 'thread' : picked?.key ?? 'text'}
          options={[
            { value: 'text', label: typedEvent && eventLabel ? eventLabel : parsed.kind === 'ok' ? parsed.label : 'Choose when', disabled: !typedEvent && parsed.kind !== 'ok' },
            ...PICKS.map((pick) => ({ value: pick.key, label: pick.label })),
            { value: 'thread', label: 'When a thread…' }
          ]}
          renderValue={() => <span data-testid="automation-create-when">{when ? when.label : eventLabel ?? 'Choose when'}</span>}
          onChange={(key) => {
            if (key === 'thread') {
              const linked = pullRequestThreads(catalog.threads)
              const first = (typedEvent ? eventThread : undefined) ?? linked.find((thread) => !projectId || thread.projectId === projectId) ?? linked[0]
              setPicked(null)
              setEventPick({ threadId: first?.id ?? '', choice: (typedEvent ? threadEventChoice(typedEvent.events) : '') || 'review' })
              return
            }
            setEventPick(null)
            setPicked(PICKS.find((pick) => pick.key === key) ?? null)
          }}
        />
        {eventPick ? (
          <>
            <Select
              ariaLabel="Thread"
              className="automation-chip-select"
              size="small"
              value={eventPick.threadId}
              options={pullRequestThreads(catalog.threads).length
                ? pullRequestThreads(catalog.threads).map((thread) => ({ value: thread.id, label: `#${thread.pullRequest!.number} · ${thread.name}` }))
                : [{ value: '', label: 'No thread has a pull request', disabled: true }]}
              title="The thread whose pull request wakes it; it runs there"
              renderValue={() => <span data-testid="automation-create-thread">{eventThread?.pullRequest ? `#${eventThread.pullRequest.number} · ${eventThread.name}` : 'Pick a thread'}</span>}
              onChange={(threadId) => setEventPick({ ...eventPick, threadId })}
            />
            <Select
              ariaLabel="Event"
              className="automation-chip-select"
              size="small"
              value={eventPick.choice}
              options={THREAD_EVENT_CHOICES.map((choice) => ({ value: choice.value, label: choice.label }))}
              title="What on the pull request wakes it"
              onChange={(choice) => setEventPick({ ...eventPick, choice })}
            />
          </>
        ) : null}
        {remote ? (
          <span className="automation-chip readonly" data-testid="automation-create-who" title={`${owner.name}'s default agent. Saved agents, workflows and bots stay on the computer that keeps them.`}>{`${owner.name}'s default agent`}</span>
        ) : workflow ? null : (
          <Select
            ariaLabel="Who"
            className="automation-chip-select"
            size="small"
            value={whoKeyNow}
            options={whoOptions({ ...naming, withBots: true })}
            title="Who does it: your default agent, a model, a saved agent or a bot"
            renderValue={() => <span data-testid="automation-create-who">{whoName(who, naming)}</span>}
            onChange={(key) => setWho(parseWhoKey(key))}
          />
        )}
        {bot && runsOn ? (
          <>
            <Select
              ariaLabel="Model"
              className="automation-chip-select"
              size="small"
              value={botModel}
              options={[{ value: '', label: 'By usage' }, ...runsOn.models.map((choice) => ({ value: choice.model, label: choice.label }))]}
              title={`What ${bot.name} runs on: by usage picks a ready model each run, or pick one`}
              renderValue={() => <span data-testid="automation-create-model">{botModel ? runsOn.models.find((choice) => choice.model === botModel)?.label ?? botModel : 'By usage'}</span>}
              onChange={setBotModel}
            />
            {runsOn.computers.length > 1 ? (
              <Select
                ariaLabel="Computer"
                className="automation-chip-select"
                size="small"
                value={runsOn.computers[0]!.id}
                options={botComputerOptions(runsOn.computers)}
                title={`${bot.name} runs on the computer that holds it`}
                onChange={() => undefined}
              />
            ) : null}
          </>
        ) : null}
        {remote ? null : <DoPicker value={workflowId} workflows={library.workflows} onChange={chooseWorkflow} />}
        {bot || onEvent ? null : (
          <Select
            ariaLabel="Where"
            className="automation-chip-select"
            size="small"
            value={projectId}
            options={projectOptions}
            onChange={setProjectId}
          />
        )}
        {manyComputers && !bot ? (
          <Select
            ariaLabel="Computer"
            className="automation-chip-select"
            size="small"
            value={node}
            options={computerOptions(computerChoices)}
            title="The computer that stores and runs it, on its own clock"
            renderValue={() => <span data-testid="automation-create-computer">{owner.name}</span>}
            onChange={chooseComputer}
          />
        ) : null}
        {picked || eventPick ? <button type="button" className="scheduled-link-btn" onClick={() => { setPicked(null); setEventPick(null) }} title="Read When from the text again">Use text</button> : null}
      </div>
      <div className="automation-create-line">
        <span data-testid="automation-create-next">
          {onEvent
            ? when && eventThread ? `Runs on ${eventThread.name} · at most every 10 min` : 'Choose when'
            : when
            ? when.schedule.kind === 'manual'
              ? 'Runs when you run it'
              : first ? `Next ${nextBeforeAdd(first.toISOString(), now, owner)}` : `${describeSchedule(when.schedule, now)}`
            : 'Choose when'}
        </span>
        <span aria-hidden="true">·</span>
        {bot ? (
          <span className="automation-create-may" data-testid="automation-create-may">
            {`May: ${bot.name}'s grant`}
            <button type="button" className="scheduled-link-btn" onClick={() => onOpenBot(bot.id)} title={`What ${bot.name} may do is set by asking it, in its chat`}>View</button>
          </span>
        ) : savedAgent ? (
          <span className="automation-create-may" data-testid="automation-create-may" title="A saved agent keeps to what it may use, set in the Library">
            {`May: what ${savedAgent.name} may use`}
          </span>
        ) : (
          <span className="automation-create-may">
            May:
            <Select<PermissionMode>
              ariaLabel="May"
              className="automation-inline-select"
              size="small"
              value={may}
              options={mayOptions}
              title="What a run may do without asking. Your default mode for new threads, never more than you hold."
              onChange={setMay}
            />
          </span>
        )}
        <span className="automation-create-spacer" />
        <button type="button" className="settings-btn" onClick={close}>Cancel</button>
        <button type="button" className="settings-btn primary" data-testid="automation-create-add" disabled={!canAdd} onClick={() => void add()} title={blocked ?? 'Add (Enter)'}>
          Add ⏎
        </button>
      </div>
      {blocked ? <p className="scheduled-note warn" data-testid="automation-create-blocked">{blocked}</p> : null}
      {error ? <p className="scheduled-item-error" role="alert">{error}</p> : null}
    </div>
  )
}
