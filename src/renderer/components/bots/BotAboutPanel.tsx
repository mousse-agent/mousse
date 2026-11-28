import { useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react'
import {
  Activity, Automations, Bell, BookOpen, BrainMemory, BrowserTab, ChevronRight, CircleGauge, Clock, Coins, Cpu, ExternalLink, FileText, Folder,
  FolderSearch, GitPullRequest, Globe, Lock, MessagesSquare, Monitor, Palette, Pause, Pencil, Play, Plug, Search, ShieldCheck, Sparkles, Terminal, Trash2, X, Zap
} from '../../lib/icons'
import type { BotContextSummary, BotDetail, BotPermissionItem, BotReminderItem, BotRunItem, BotSummary, BotTurnUsageSummary } from '../../../shared/bots/personal/chat'
import type { BotModelPick } from '../../../shared/bots/personal/definition'
import { BOT_FULL_TRUST_PERMISSION } from '../../../shared/bots/personal/manifest'
import type { BotShownRows, BotsPersonalV2Result } from '../../../shared/bots/personal/methods'
import { botFaceState, botsClient, useBotsStore } from '../../stores/botsStore'
import { Switch } from '../settings/SettingsRow'
import { ConfirmRemoveButton } from '../settings/IconButtons'
import { useAppStore } from '../../stores/appStore'
import { errorText } from '../../services/personalBotsClient'
import { BotComputerSelect, BotModelRows, BotModelSelect } from './BotRunsOn'
import { BotFace } from './face/BotFace'
import { BotDevicesRow } from './BotDevices'
import { memorySplitText } from './BotMemoryDialog'
import { BotPrompt } from './BotPrompt'
import { promptCacheState, shortDuration, useMinuteClock } from '../../lib/promptCache'
import { profilePreferenceKey } from '../../lib/profilePreferences'
import { centerWithin } from '../../lib/shellScroll'
import { motionOff } from '../../lib/motion'
import { Collapse } from '../ui/Collapse'
import { canonicalModelName, modelNameFromId, shortModelName } from '../../../shared/modelNames'

type Icon = ComponentType<{ size?: number; strokeWidth?: number; className?: string; 'aria-hidden'?: boolean }>

/** About's Runs on section, which a bot's Pick a model scrolls to. */
export const RUNS_ON_ID = 'bot-about-runs-on'

/** "Mon 09:00" for a run's next time; today's runs show the time alone. */
export function nextRunText(at: string, now = new Date()): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return date.toDateString() === now.toDateString() ? time : `${date.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

/** A reminder's line in About → Runs: "Reminds: 18:42", "Starts: …", a wake's "Follows up: 18:42" or "Follows up when acme/app#12 merges". */
export function reminderWhenLine(reminder: BotReminderItem, now = new Date()): string {
  if (reminder.wake) return `Follows up ${reminder.wake}`
  return `${reminder.work ? 'Starts' : reminder.wake === '' ? 'Follows up' : 'Reminds'}: ${reminderWhenText(reminder.dueAt, now)}`
}

/** When a reminder fires: like a run's next time within the week, else "14 Nov 09:00". */
export function reminderWhenText(at: string, now = new Date()): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  if (date.getTime() - now.getTime() < 6 * 24 * 60 * 60_000) return nextRunText(at, now)
  return `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

/** A token count as About shows it: `850`, `12k`, `1.2M`. */
function tokensText(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens))
  if (tokens < 1_000_000) return `${tokens < 10_000 ? (tokens / 1000).toFixed(1).replace(/\.0$/, '') : Math.round(tokens / 1000)}k`
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/** What a chat turn costs, as one quiet line: input a turn and the share read from the cache; the rest in its tooltip. */
export function usageLine(usage: BotTurnUsageSummary): { text: string; title: string } {
  return {
    text: `${tokensText(usage.inputPerTurn)} tokens a turn · ${Math.round(usage.cachedShare * 100)}% from cache`,
    title: `Chat turns in the last 7 days: ${usage.turns}. Input a turn includes cache reads and writes; output a turn: ${tokensText(usage.outputPerTurn)}.`
  }
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** "every weekday · 09:00" → "Every weekday at 09:00". */
function scheduleText(label: string): string {
  return capital(label.replace(' · ', ' at '))
}

/** "4m ago", "2h ago", "yesterday", "6d ago". */
function agoText(at: string, now: number): string {
  const ms = now - Date.parse(at)
  if (!Number.isFinite(ms)) return ''
  if (ms < 60_000) return 'just now'
  if (ms >= 24 * 3_600_000 && ms < 48 * 3_600_000) return 'yesterday'
  return `${shortDuration(ms).split(' ')[0]} ago`
}

/**
 * A permission's own glyph, from what it gives: files, the web, commands, threads, an MCP server's tools, a limit. The
 * shield stays only for what has no closer picture.
 */
export function permissionIcon(item: Pick<BotPermissionItem, 'title'>): Icon {
  const title = item.title.toLowerCase()
  if (/github|pull request/.test(title)) return GitPullRequest
  if (/^use your .+ tools|^use .+'s new tools|mcp servers/.test(title)) return Plug
  if (/search the web/.test(title)) return Search
  if (/web pages/.test(title)) return Globe
  if (/browser/.test(title)) return BrowserTab
  if (/the computer/.test(title)) return Monitor
  if (/run commands/.test(title)) return Terminal
  if (/threads/.test(title)) return MessagesSquare
  if (/search in files|look through folders/.test(title)) return FolderSearch
  if (/edit files|create files/.test(title)) return Pencil
  if (/files|folder/.test(title)) return title.includes('folder') ? Folder : FileText
  if (/memory/.test(title)) return BrainMemory
  if (/spend/.test(title)) return Coins
  if (/steps|per run|keep working|each run/.test(title)) return Activity
  if (/schedule|automation/.test(title)) return Clock
  if (/secret/.test(title)) return Lock
  if (/quick action/.test(title)) return Zap
  if (/looks/.test(title)) return Palette
  if (/profiler/.test(title)) return CircleGauge
  if (/skill/.test(title)) return Sparkles
  if (/model|thinks/.test(title)) return Cpu
  return ShieldCheck
}

// ---------------------------------------------------------------------------------------------------------------
// Folds, kept per profile. The panel's width is the side panel's (BotSidePanel).

const OPEN_KEY = 'mousse:bot-about-open'

type FoldId = 'context' | 'prompt' | 'permissions' | 'automations' | 'reminders' | 'setup'
/** What opens by default: what the bot is spending; everything else waits for a click. */
const DEFAULT_OPEN: FoldId[] = ['context']

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? JSON.parse(raw) as T : fallback
  } catch {
    return fallback
  }
}

function useFolds(profileId: string) {
  const key = profileId ? profilePreferenceKey(profileId, OPEN_KEY) : OPEN_KEY
  const [open, setOpen] = useState<FoldId[]>(() => readJson(key, DEFAULT_OPEN))
  const set = (id: FoldId, shown: boolean) => setOpen((current) => {
    if (current.includes(id) === shown) return current
    const next = shown ? [...current, id] : current.filter((item) => item !== id)
    window.localStorage.setItem(key, JSON.stringify(next))
    return next
  })
  return [open, (id: FoldId) => set(id, !open.includes(id)), (id: FoldId) => set(id, true)] as const
}

/**
 * One section of About, as Settings folds its sections (`.settings-fold`): a bare 15px glyph, the title, and while it is
 * closed one quiet line of what is inside, so a closed panel still reads at a glance. Its content opens and closes with
 * the shared `Collapse` (height and fade) as the chevron turns; with motion off, at once.
 */
function Fold({ id, icon: Glyph, title, summary, open, onToggle, children }: {
  id: FoldId
  icon: Icon
  title: string
  summary?: ReactNode
  open: boolean
  onToggle: (id: FoldId) => void
  children: ReactNode
}) {
  return <section className={`bot-about-fold${open ? ' is-open' : ''}`} aria-labelledby={`bot-about-${id}`}>
    <button type="button" id={`bot-about-${id}`} className="bot-about-fold-head" aria-expanded={open} onClick={() => onToggle(id)}>
      <Glyph size={15} strokeWidth={1.8} aria-hidden className="bot-about-fold-icon" />
      <span className="bot-about-fold-title">{title}</span>
      {summary ? <span className="bot-about-fold-summary">{summary}</span> : null}
      <ChevronRight size={14} aria-hidden className="bot-about-fold-chevron" />
    </button>
    <Collapse open={open} className="bot-about-fold-body" animate={!motionOff()}>{children}</Collapse>
  </section>
}

/** A row on a section's surface, in Settings' row anatomy: an identifying glyph, title and line, then its controls. */
function Row({ icon: Glyph, title, desc, status, children, className, titleTip, testId }: {
  icon?: Icon
  title: ReactNode
  desc?: ReactNode
  status?: { text: string; tone: 'ok' | 'warn' | 'bad' | 'quiet' }
  children?: ReactNode
  className?: string
  titleTip?: string
  testId?: string
}) {
  return <div className={`settings-item bot-about-item${className ? ` ${className}` : ''}`} data-testid={testId}>
    {Glyph ? <div className="settings-item-lead" aria-hidden="true"><Glyph size={16} strokeWidth={1.6} /></div> : null}
    <div className="settings-item-text">
      <span className="settings-item-title" title={titleTip}>
        {title}
        {status ? <span className={`bot-about-status is-${status.tone}`}>{status.text}</span> : null}
      </span>
      {desc ? <span className="settings-item-desc">{desc}</span> : null}
    </div>
    {children ? <div className="settings-item-control">{children}</div> : null}
  </div>
}

// ---------------------------------------------------------------------------------------------------------------
// Runs on: read once for the header's model and the Runs on section.

function useRunsOn(botId: string, refresh: string) {
  const [choices, setChoices] = useState<BotsPersonalV2Result<'bots.model.get'> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const client = botsClient()
  // Saves in flight: a read that answers meanwhile is older than what the owner sees.
  const saving = useRef(0)
  const read = useCallback(() => {
    let live = true
    client.model(botId).then((next) => { if (live && !saving.current) setChoices(next) }, (cause) => { if (live) setError(errorText(cause)) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId])
  useEffect(read, [read, refresh])
  // A pick in the header's model menu reads the rows into the store: Runs on shows them too.
  const shared = useBotsStore((state) => state.modelInfo[botId])
  useEffect(() => { if (shared && !saving.current) setChoices(shared) }, [shared])
  const pick = async (model: string | null) => {
    if (!choices) return
    setError(null)
    try {
      await client.setModel(botId, model)
      setChoices({ ...choices, model })
    } catch (cause) {
      setError(errorText(cause))
    }
  }
  const save = async (shown: BotShownRows, change: Parameters<typeof client.setSlots>[1]) => {
    if (!choices) return
    const before = choices
    setError(null)
    setChoices({ ...choices, slots: shown, model: shown.talk?.model ?? null })
    saving.current += 1
    try {
      await client.setSlots(botId, change)
    } catch (cause) {
      setChoices(before)
      setError(errorText(cause))
    } finally {
      saving.current -= 1
    }
    read()
    // The header's model button shows the same rows.
    void useBotsStore.getState().loadModelInfo(botId)
  }
  const saveImage = async (image: BotModelPick | null) => {
    if (!choices) return
    const before = choices
    setError(null)
    setChoices({ ...choices, image })
    saving.current += 1
    try {
      await client.setImage(botId, image)
    } catch (cause) {
      setChoices(before)
      setError(errorText(cause))
    } finally {
      saving.current -= 1
    }
    read()
  }
  return { choices, error, pick, save, saveImage }
}

type RunsOnState = ReturnType<typeof useRunsOn>

/** "Opus 5.5, high" for the Talk row's pick, from the entry that offers it; null when nothing is picked. */
function talkModelText(choices: RunsOnState['choices']): string | null {
  const pick = choices?.slots?.talk
  if (!pick || !choices?.providers) return null
  const listing = choices.providers.find((provider) => provider.instanceId === pick.instanceId)
  const model = listing?.models.find((option) => option.id === pick.model)
  if (!model) return shortModelName(modelNameFromId(pick.model))
  return `${shortModelName(canonicalModelName(model.label, model.id))}${pick.effort ? `, ${pick.effort}` : ''}`
}

function RunsOn({ name, state }: { name: string; state: RunsOnState }) {
  const { choices, error } = state
  if (!choices) return error ? <p className="bot-about-empty" role="alert">{error}</p> : null
  const slots = choices.slots
  return <>
    {slots && choices.providers
      ? <div id={RUNS_ON_ID} className="bot-about-models">
        <BotModelRows
          name={name}
          providers={choices.providers}
          unavailableProviders={choices.unavailableProviders}
          slots={slots}
          borrows
          {...(choices.named ? { named: choices.named } : {})}
          {...(choices.notes ? { notes: choices.notes } : {})}
          {...(choices.imageProviders ? {
            image: {
              providers: choices.imageProviders,
              pick: choices.image ?? null,
              ...(choices.imagesMissing ? { missing: choices.imagesMissing } : {}),
              ...(choices.images ? { usage: choices.images } : {}),
              onPick: (image) => void state.saveImage(image)
            }
          } : {})}
          onPick={(rows, picked) => {
            const changed = Object.fromEntries(rows.map((row) => [row, picked])) as Partial<BotShownRows>
            void state.save({ ...slots, ...changed }, { slots: changed })
          }}
          onOneWork={() => void state.save({ ...slots, light: slots.medium, hard: slots.medium }, { oneWork: true })}
        />
      </div>
      : <div className="bot-about-line" data-testid="bot-about-model">
        <span>Model</span>
        <BotModelSelect ariaLabel={`${name}'s model`} models={choices.models} value={choices.model} onChange={(model) => void state.pick(model)} />
      </div>}
    {choices.computers.length > 1 ? (
      <div className="bot-about-line" data-testid="bot-about-computer">
        <span>Computer</span>
        <BotComputerSelect ariaLabel={`${name}'s computer`} title={`${name} runs on the computer that holds it`} choices={choices} />
      </div>
    ) : null}
    {error ? <p className="bot-about-empty" role="alert">{error}</p> : null}
  </>
}

// ---------------------------------------------------------------------------------------------------------------
// Context and cache.

interface CacheWords { text: string; tone: 'ok' | 'warn' | 'quiet'; line: string }

/** How full the chat's context is, and how the last turn's input split, as shares scaled to the bar. */
interface BotContextView {
  percent: number
  used: number
  window: number
  parts: Array<{ label: string; color: string; share: number; tokens: number }>
}

/** The context bar and legend from what the latest chat turn measured; null without a token count or a window. */
function botContextView(context: BotContextSummary | undefined): BotContextView | null {
  if (!context?.used || !context.window) return null
  const { cacheRead, cacheWrite, fresh } = context.turn
  const input = cacheRead + cacheWrite + fresh
  const parts = [
    { label: 'Read from cache', color: 'var(--success)', tokens: cacheRead },
    { label: 'Written to cache', color: 'var(--warning)', tokens: cacheWrite },
    { label: 'Sent fresh', color: 'var(--accent)', tokens: fresh }
  ].filter((part) => part.tokens > 0).map((part) => ({ ...part, share: input > 0 ? part.tokens / input : 0 }))
  return { percent: Math.min(100, Math.round((context.used / context.window) * 100)), used: context.used, window: context.window, parts }
}

/** The prompt cache in words, for the header and the Context section: warm with time left, expired, or idle. */
function cacheWords(context: BotContextSummary | undefined, now: number): CacheWords | null {
  if (!context) return null
  const state = promptCacheState({ lastRequestAt: context.lastRequestAt, ...(context.cacheTtlMs ? { ttlMs: context.cacheTtlMs } : {}) }, now)
  const size = context.used ? `${tokensText(context.used)} ` : ''
  if (state.kind === 'warm') return { text: `Warm, ${shortDuration(state.leftMs, 'up')} left`, tone: 'ok', line: `Next message reads ${size}from cache.` }
  if (state.kind === 'expired') return { text: `Expired ${shortDuration(state.agoMs)} ago`, tone: 'warn', line: `Next message sends ${size ? `all ${size}` : 'everything '}again.` }
  return { text: `Idle ${shortDuration(state.idleMs)}`, tone: 'quiet', line: 'The provider gives no cache lifetime.' }
}

function ContextSection({ view, usage, cache }: { view: BotContextView | null; usage: BotTurnUsageSummary | undefined; cache: CacheWords | null }) {
  return <div className="settings-group-rows bot-about-surface">
    {view ? <div className="settings-item bot-about-context" data-testid="bot-about-context">
      <div className="bot-about-context-top">
        <span className="bot-about-context-share">{view.percent}%</span>
        <span className="bot-about-context-of">{tokensText(view.used)} of {tokensText(view.window)} tokens</span>
      </div>
      <div className="context-usage-bar" role="img" aria-label={`Context ${view.percent}% full`}>
        {view.parts.map((part) => <div key={part.label} className="context-usage-bar-segment"
          style={{ width: `${part.share * (view.used / view.window) * 100}%`, backgroundColor: part.color }} />)}
      </div>
      {view.parts.length ? <ul className="context-usage-breakdown bot-about-breakdown" aria-label="Last turn's input">
        {view.parts.map((part) => <li key={part.label} className="context-usage-item" title={`${tokensText(part.tokens)} tokens over the last turn`}>
          <span className="context-usage-swatch" style={{ backgroundColor: part.color }} />
          <span className="context-usage-item-label">{part.label}</span>
          <span className="context-usage-item-value">{Math.round(part.share * 100)}%</span>
        </li>)}
      </ul> : null}
    </div> : <Row title="Context" desc="Measured after its next message." />}
    {cache ? <Row title="Prompt cache" desc={cache.line}><span className={`bot-about-value is-${cache.tone}`}>{cache.text}</span></Row> : null}
    {usage ? <Row testId="bot-about-usage" title="Last 7 days" desc={`${usage.turns} turns · ${tokensText(usage.inputPerTurn)} in, ${tokensText(usage.outputPerTurn)} out a turn`} titleTip={usageLine(usage).title}>
      <span className="bot-about-value">{Math.round(usage.cachedShare * 100)}% cached</span>
    </Row> : null}
  </div>
}

// ---------------------------------------------------------------------------------------------------------------

/**
 * What the bot remembers, as one row: how many entries every turn carries, the owner's wishes and its own notes. It
 * opens the Memory dialog. Read again whenever the bot's detail reloads (after each of its turns), so an entry it just
 * saved is counted.
 */
function Memory({ botId, detail }: { botId: string; detail: unknown }) {
  const entries = useBotsStore((s) => s.memory[botId])
  const error = useBotsStore((s) => s.memoryError[botId])
  useEffect(() => { void useBotsStore.getState().loadMemory(botId) }, [botId, detail])
  return <button type="button" className="bot-about-memory" data-testid="bot-about-memory" onClick={() => useBotsStore.getState().openMemory(botId)}>
    <BrainMemory size={15} strokeWidth={1.8} aria-hidden className="bot-about-fold-icon" />
    <span className="bot-about-fold-title">Memory</span>
    <span className="bot-about-fold-summary">{entries ? memorySplitText(entries) : error ?? 'Loading…'}</span>
    <ChevronRight size={14} aria-hidden className="bot-about-fold-chevron" />
  </button>
}

/** What the bot does now, in words: its work, its chat turn, paused, stuck, or free since its last message. */
function doingText(bot: BotSummary, now: number): string {
  if (bot.state === 'paused') return 'Paused'
  const work = bot.work?.find((item) => item.status === 'running') ?? bot.work?.[0]
  if (work) return capital(work.title)
  if (bot.chat) return bot.chat.offline ? 'Waiting for the internet' : 'Writing a reply'
  if (bot.error) return bot.stateText || 'Stuck'
  if (bot.needsOwner) return bot.stateText || 'Waiting for you'
  return bot.last ? `Free · last message ${agoText(bot.last.at, now)}` : 'Free'
}

/** What "Allow everything" gives and what still holds, for its tooltip. */
const FULL_TRUST_TIP = 'Every tool and permission a bot can be given, without asking. What you switch off here, Settings and Labs still apply, and tools that ask first still ask.'

function permissionsSummary(detail: BotDetail | undefined): string | undefined {
  if (!detail) return undefined
  const off = detail.permissions.filter((item) => item.enabled === false || (item.mark && !item.asksFirst) || item.gone).length
  const on = detail.permissions.length - off
  if (!detail.permissions.length) return 'Asks when it needs something'
  return off ? `${on} on · ${off} off` : `${on} on`
}

function automationsSummary(runs: BotRunItem[]): string {
  if (!runs.length) return 'None'
  const next = runs.filter((run) => run.nextAt && !run.paused).map((run) => run.nextAt!).sort()[0]
  return next ? `${runs.length} · next ${nextRunText(next)}` : `${runs.length} · paused`
}

/**
 * About this bot (bot-ui §4.8), in the app's own language: the mouse beside a short header of what it does now, its model
 * and its context; then folds in Settings' pattern, of which only Context opens by default: context and cache,
 * instructions, what it can use (each with its own glyph, a switch and Remove), its automations by name and schedule,
 * reminders, memory, and what it runs on. In the side panel (`inPanel`, its Agent settings view) the panel's strip
 * closes it and the panel sets its width; on its own it has a Close.
 */
export function BotAboutPanel({ bot, inPanel = false }: { bot: BotSummary; inPanel?: boolean }) {
  const detail = useBotsStore((s) => s.details[bot.id])
  const happy = useBotsStore((s) => s.happy[bot.id])
  const profileId = useAppStore((s) => s.profileId)
  useEffect(() => { void useBotsStore.getState().loadDetail(bot.id) }, [bot.id])
  const store = useBotsStore.getState
  const paused = bot.state === 'paused'
  const [open, toggle, unfold] = useFolds(profileId)
  // Pick a model opens Runs on, then brings the rows to the middle of the panel; only the panel scrolls
  // (scrollIntoView also moved every box around it, the app's own included).
  const focus = useBotsStore((s) => s.aboutFocus)
  const scroller = useRef<HTMLDivElement>(null)
  const setupOpen = open.includes('setup')
  useEffect(() => {
    if (focus !== 'runs-on') return
    if (!setupOpen) { unfold('setup'); return }
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(RUNS_ON_ID) ?? document.getElementById('bot-about-setup')
      if (target && scroller.current?.contains(target)) centerWithin(scroller.current, target)
      useBotsStore.setState({ aboutFocus: null })
    })
    return () => window.cancelAnimationFrame(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, setupOpen])
  const runsOn = useRunsOn(bot.id, `${bot.last?.at ?? ''}|${bot.error?.text ?? ''}`)
  const context = detail?.context
  const now = useMinuteClock(true, context?.lastRequestAt)
  const cache = cacheWords(context, now)
  const view = botContextView(context)
  const model = talkModelText(runsOn.choices) ?? (context?.model ? shortModelName(modelNameFromId(context.model)) : null)
  const runs = detail?.runs ?? []
  const reminders = detail?.reminders ?? []

  // What the bot may use and which devices reach it are changed here: while the panel is open a theme's CSS is off
  // (its colors stay), so it cannot relabel them.
  return <aside className={`bot-about settings-scope${inPanel ? ' is-in-panel' : ''}`} data-mousse-guarded="" aria-label={`About ${bot.name}`}>
    <div className="bot-about-scroll" ref={scroller}>
      <header className="bot-about-head">
        <BotFace look={bot.look} state={botFaceState(bot, happy)} size={76} view="full" />
        <div className="bot-about-id">
          <div className="bot-about-name">
            <h2>{bot.name}</h2>
            {inPanel ? null : <button type="button" className="settings-icon-btn bot-about-close" aria-label="Close About" title="Close" onClick={() => useBotsStore.setState({ aboutOpen: false })}><X size={14} /></button>}
          </div>
          <p className="bot-about-doing" title={doingText(bot, now)}>{doingText(bot, now)}</p>
          <dl className="bot-about-facts">
            {model ? <><dt>Model</dt><dd>{model}</dd></> : null}
            {view ? <><dt>Context</dt><dd>{view.percent}% of {tokensText(view.window)} used</dd></> : null}
            {cache ? <><dt>Cache</dt><dd className={`is-${cache.tone}`}>{cache.text}</dd></> : null}
          </dl>
        </div>
      </header>

      <Fold id="context" icon={CircleGauge} title="Context and cache" open={open.includes('context')} onToggle={toggle}
        summary={view ? `${view.percent}%${cache ? ` · ${cache.tone === 'ok' ? 'warm' : cache.tone === 'warn' ? 'expired' : 'idle'}` : ''}` : undefined}>
        <ContextSection view={view} usage={detail?.usage} cache={cache} />
      </Fold>

      <Fold id="prompt" icon={BookOpen} title="Instructions" open={open.includes('prompt')} onToggle={toggle} summary={bot.promptEdited ? 'Edited' : undefined}>
        <BotPrompt bot={bot} />
      </Fold>

      <Fold id="permissions" icon={ShieldCheck} title="Can use" open={open.includes('permissions')} onToggle={toggle} summary={detail?.fullTrust ? 'Everything' : permissionsSummary(detail)}>
        {detail?.permissions.length || detail?.fullTrust !== undefined
          ? <div className="settings-group-rows bot-about-surface">
            {/* Allow everything: on asks first in a dialog, as any grant is approved; off narrows at once. */}
            {detail.fullTrust !== undefined && <Row icon={ShieldCheck} title="Allow everything" titleTip={FULL_TRUST_TIP} testId="bot-full-trust">
              <span title={FULL_TRUST_TIP}><Switch label="Allow everything" checked={detail.fullTrust} onChange={(on) => {
                if (on) useBotsStore.setState({ dialog: { kind: 'fullTrust', botId: bot.id }, error: null })
                else void store().setPermission(bot.id, BOT_FULL_TRUST_PERMISSION, false)
              }} /></span>
            </Row>}
            {detail.permissions.map((item) => {
              const off = item.mark ?? (item.gone ? 'Gone from Mousse' : undefined)
              return <Row key={item.id} icon={permissionIcon(item)} className={`bot-about-permission${item.enabled === false ? ' is-off' : ''}${item.under ? ' indent' : ''}`}
                title={capital(item.title)} titleTip={item.note || undefined}
                {...(item.note ? { desc: item.note } : {})}
                {...(off ? { status: { text: off, tone: 'warn' as const } } : {})}>
                {item.enabled !== undefined && <span title={item.note}><Switch label={item.title} checked={item.enabled} onChange={(enabled) => void store().setPermission(bot.id, item.id, enabled)} /></span>}
                {item.builtIn || item.fromFullTrust ? null : <ConfirmRemoveButton label={`Remove ${item.title}`} onRemove={() => void store().revokePermission(bot.id, item.id)} />}
              </Row>
            })}
          </div>
          : <p className="bot-about-empty">{detail ? 'Nothing yet. It asks in the chat the first time it needs something.' : 'Loading…'}</p>}
      </Fold>

      <Fold id="automations" icon={Automations} title="Automations" open={open.includes('automations')} onToggle={toggle} summary={detail ? automationsSummary(runs) : undefined}>
        {runs.length
          ? <div className="settings-group-rows bot-about-surface">
            {runs.map((run) => <Row key={run.id} icon={Clock} className="bot-about-automation"
              title={run.name ?? scheduleText(run.label)}
              {...(run.paused ? { status: { text: 'Paused', tone: 'warn' as const } } : {})}
              desc={<>
                <span className="bot-about-when">{scheduleText(run.label)}{run.nextAt && !run.paused ? ` · next ${nextRunText(run.nextAt)}` : ''}</span>
                {run.does ? <span className="bot-about-does">{run.does}</span> : null}
                {run.lastAt ? <span className="bot-about-when">Last ran {agoText(run.lastAt, now)}{run.lastOutcome === 'failed' ? ', failed' : run.lastOutcome === 'stopped' ? ', stopped' : ''}</span> : null}
              </>}>
              {/* A bot of another computer runs its automations there: this computer's Automations doesn't list them. */}
              {!bot.lives && <button type="button" className="settings-icon-btn" aria-label={`Open ${run.name ?? run.label} in Automations`} title="Open in Automations" onClick={() => useAppStore.getState().setScheduledOpen(true)}><ExternalLink size={14} /></button>}
              <ConfirmRemoveButton label={`Remove ${run.name ?? run.label}`} onRemove={() => void store().removeSchedule(bot.id, run.id)} />
            </Row>)}
          </div>
          : <p className="bot-about-empty">{detail ? 'Only when you message it. Ask it to run on a schedule.' : 'Loading…'}</p>}
      </Fold>

      {reminders.length
        ? <Fold id="reminders" icon={Bell} title="Reminders" open={open.includes('reminders')} onToggle={toggle} summary={`${reminders.length} · next ${reminderWhenText(reminders[0]!.dueAt)}`}>
          <div className="settings-group-rows bot-about-surface">
            {reminders.map((reminder) => <Row key={reminder.id} icon={reminder.wake !== undefined ? Clock : Bell} title={<span className="bot-about-clamp">{reminder.text}</span>} titleTip={reminder.text}
              desc={<span title={reminder.wake ? `Gives up: ${reminderWhenText(reminder.dueAt)}` : undefined}>{reminderWhenLine(reminder)}</span>}>
              <ConfirmRemoveButton label={`Cancel reminder: ${reminder.text}`} confirmLabel="Confirm cancel" onRemove={() => void store().cancelReminder(bot.id, reminder.id)} />
            </Row>)}
          </div>
        </Fold>
        : null}

      <Memory botId={bot.id} detail={detail} />

      <Fold id="setup" icon={Cpu} title="Runs on" open={open.includes('setup')} onToggle={toggle} summary={model ?? undefined}>
        <div className="settings-group-rows bot-about-surface bot-about-setup">
          <div className="settings-item bot-about-setup-body">
            <RunsOn name={bot.name} state={runsOn} />
            <BotDevicesRow botId={bot.id} name={bot.name} reach={bot.reach} {...(bot.lives ? { home: bot.lives.name } : {})} />
          </div>
        </div>
      </Fold>
    </div>
    <div className="bot-about-foot">
      <button type="button" className="settings-btn" onClick={() => void (paused ? store().resume(bot.id) : store().pause(bot.id))}>
        {paused ? <Play size={14} aria-hidden /> : <Pause size={14} aria-hidden />}{paused ? 'Resume' : 'Pause'}
      </button>
      <button type="button" className="settings-btn danger" onClick={() => useBotsStore.setState({ dialog: { kind: 'delete', botId: bot.id }, error: null })}>
        <Trash2 size={14} aria-hidden />Delete bot
      </button>
    </div>
  </aside>
}
