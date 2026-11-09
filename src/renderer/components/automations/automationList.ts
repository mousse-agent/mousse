import { offlineText, type AutomationDelivery, type AutomationItem, type AutomationMoveResult, type AutomationRun } from '../../../shared/automations'
import { deliveryStartedRun } from '../../../shared/requestTrigger'
import { describePermissionMode, normalizePermissionMode, type PermissionMode } from '../../../shared/permissionMode'
import { describeSchedule } from '../../../shared/scheduleLabel'
import { agoText, ownedWhenText, zonedDayOffset } from './automationTime'

/**
 * The Automations list as data: which group each row is in, what its one meta line says, its one primary action, and
 * what search keeps. Pure, so the page and its tests read the same rules.
 */

export type GroupKey = 'needs' | 'today' | 'upcoming' | 'watching' | 'on_demand' | 'paused'

export interface AutomationGroup {
  key: GroupKey
  label: string
  items: AutomationItem[]
}

const GROUP_LABELS: Record<GroupKey, string> = {
  needs: 'Needs you',
  today: 'Today',
  upcoming: 'Upcoming',
  watching: 'Watching',
  on_demand: 'On demand',
  paused: 'Paused'
}

/** The group a row belongs in. Needs you is open asks and runs that ended Failed or Incomplete; a paused row is paused. */
export function groupOf(item: AutomationItem, now: Date): GroupKey {
  // A paused automation's old failure is not news; an open ask still waits for an answer.
  if (item.attention && (!item.paused || item.attention.kind === 'ask')) return 'needs'
  if (item.paused) return 'paused'
  if (item.trigger === 'thread_event' || item.trigger === 'request') return 'watching'
  // A row of an offline computer waits for it on its own time, wherever that falls.
  if (item.active && item.active.reason !== 'offline') return 'today'
  if (item.next) return zonedDayOffset(new Date(item.next.at), now, item.next.timeZone) <= 0 ? 'today' : 'upcoming'
  return 'on_demand'
}

const byNext = (a: AutomationItem, b: AutomationItem) =>
  (a.next ? Date.parse(a.next.at) : Number.MAX_SAFE_INTEGER) - (b.next ? Date.parse(b.next.at) : Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name)
const byLastRun = (a: AutomationItem, b: AutomationItem) => Date.parse(b.last?.at ?? '') - Date.parse(a.last?.at ?? '') || a.name.localeCompare(b.name)

/** The groups in page order, without the empty ones. Paused comes last; the page folds it. */
export function groupAutomations(items: readonly AutomationItem[], now: Date = new Date()): AutomationGroup[] {
  const buckets = new Map<GroupKey, AutomationItem[]>()
  for (const item of items) {
    // One that moved to another computer has no row here; its runs stay in Recent.
    if (item.kind === 'moved') continue
    const key = groupOf(item, now)
    buckets.set(key, [...(buckets.get(key) ?? []), item])
  }
  const order: GroupKey[] = ['needs', 'today', 'upcoming', 'watching', 'on_demand', 'paused']
  return order.flatMap((key) => {
    const list = buckets.get(key)
    if (!list?.length) return []
    const sorted = [...list].sort(key === 'needs' ? byLastRun : key === 'on_demand' || key === 'watching' || key === 'paused' ? (a, b) => a.name.localeCompare(b.name) : byNext)
    return [{ key, label: GROUP_LABELS[key], items: sorted }]
  })
}

/** One line of the Recent fold: a run (with the request that started it, if one did), or a request that started nothing. */
export interface RecentEntry {
  item: AutomationItem
  at: string
  run?: AutomationRun
  delivery?: AutomationDelivery
}

/**
 * Every run of every automation, newest first (the Recent fold). A request automation's refused requests (a rejected
 * signature, the rate limit, a body too large, a replay) are lines of their own, so its delivery log shows here too.
 */
export function recentEntries(items: readonly AutomationItem[], limit = 50): RecentEntry[] {
  return items
    .flatMap((item): RecentEntry[] => {
      const deliveries = item.request?.deliveries ?? []
      const runs = item.runs.map((run) => {
        const delivery = run.request ? deliveries.find((entry) => entry.occurrenceId === run.request!.occurrenceId) : undefined
        return { item, at: run.at, run, ...(delivery ? { delivery } : {}) }
      })
      const ran = new Set(item.runs.flatMap((run) => (run.request ? [run.request.occurrenceId] : [])))
      const alone = deliveries.filter((delivery) => !delivery.occurrenceId || (!ran.has(delivery.occurrenceId) && !deliveryStartedRun(delivery.outcome)))
      return [...runs, ...alone.map((delivery) => ({ item, at: delivery.at, delivery }))]
    })
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, limit)
}

/**
 * Why the selected rows cannot move to another computer, or undefined when they can: only this computer's automations
 * move from here, and a bot's computer changes in its About.
 */
export function moveBlocked(items: readonly AutomationItem[]): string | undefined {
  const other = items.find((item) => !item.computer.local)
  if (other) return `Move it from ${other.computer.name}.`
  if (items.some((item) => item.who.kind === 'bot')) return 'A bot’s computer changes in its About.'
  return undefined
}

/** What Move to computer says when it is done: how many moved, and each one that did not, with why. */
export function moveSummary(result: AutomationMoveResult, to: string): string | null {
  const parts: string[] = []
  const warned = result.moved.filter((entry) => entry.warning)
  if (result.failed.length) parts.push(`${result.moved.length ? `Moved ${result.moved.length} to ${to}. ` : ''}Not moved: ${result.failed.map((entry) => `${entry.name ?? 'an automation'} (${entry.error.replace(/\.$/, '')})`).join('; ')}.`)
  for (const entry of warned) parts.push(entry.warning!)
  return parts.length ? parts.join(' ') : null
}

/** Search appears once the list is this long. */
export const SEARCH_AFTER_ROWS = 12

/**
 * What a search keeps. `agent:<name>` matches who does it, `computer:<name>` the computer that owns it; other words
 * match the name, where, when and who. Every term must match.
 */
export function matchesSearch(item: AutomationItem, query: string): boolean {
  // A quoted value keeps its spaces: computer:"desk pc".
  const terms = (query.trim().toLowerCase().match(/\S+?:"[^"]*"?|"[^"]*"?|\S+/g) ?? []).map((term) => term.replace(/"/g, '')).filter(Boolean)
  return terms.every((term) => {
    const [key, ...rest] = term.split(':')
    const value = rest.join(':')
    if (rest.length && key === 'agent') return item.who.name.toLowerCase().includes(value)
    if (rest.length && key === 'computer') return item.computer.name.toLowerCase().includes(value)
    const haystack = [item.name, item.where?.name, item.whenText, item.who.name, item.schedule ? describeSchedule(item.schedule) : ''].join(' ').toLowerCase()
    return haystack.includes(term)
  })
}

/**
 * Why nothing can be done to a row now: its computer is offline (its row is the last copy that computer sent).
 * Undefined for a row whose computer is reachable.
 */
export function unreachableReason(item: Pick<AutomationItem, 'computer'>): string | undefined {
  return item.computer.offline ? offlineText(item.computer) : undefined
}

/** The mark on a run that stands for repeats missed while its computer was off, with its tooltip. */
export function missedText(run: AutomationRun): { text: string; title: string } | undefined {
  if (!run.missed) return undefined
  const count = run.missed.count
  return {
    text: 'Missed while offline',
    title: count > 1 ? `${count >= 1000 ? '1000+' : count} runs fell while the computer was off. They ran once, late.` : 'It fell while the computer was off. It ran once, late.'
  }
}

/** What one run says on a row: "failed · npm install exited 1", "waiting · usage limit until 14:00". */
export function runText(run: AutomationRun, now: Date, owner: { name: string; timeZone: string }, viewerZone: string): string {
  const when = (iso: string) => ownedWhenText(iso, now, owner, viewerZone)
  switch (run.state) {
    case 'queued':
      return 'starting'
    case 'running':
      return run.detail ? `running · ${run.detail.toLowerCase()}` : 'running'
    case 'waiting':
      if (run.reason === 'usage_limit') return run.until ? `waiting · usage limit until ${when(run.until)}` : 'waiting · usage limit'
      if (run.reason === 'offline') return 'offline'
      if (run.reason === 'behind') return 'waiting · behind another run'
      return run.detail ? `waiting · ${run.detail.toLowerCase()}` : 'waiting'
    case 'failed':
      return run.detail ? `failed · ${firstLine(run.detail)}` : 'failed'
    case 'incomplete':
      return run.detail ? `incomplete · ${firstLine(run.detail).toLowerCase()}` : 'incomplete'
    case 'nothing_new':
      return `nothing new · ${agoText(run.at, now)}`
    case 'done':
      return `done · ${agoText(run.at, now)}`
  }
}

const firstLine = (text: string) => {
  const line = text.trim().split(/\r?\n/)[0] ?? ''
  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

export interface MetaContext {
  now: Date
  viewerZone: string
  /** Show the owning computer: the person has more than one. */
  manyComputers: boolean
  /** How the page names a job's model. */
  modelName?: (item: AutomationItem) => string | undefined
}

/** The parts of a row's one meta line, in order. A bot's face is drawn by the row beside the bot part. */
export function metaParts(item: AutomationItem, ctx: MetaContext): Array<{ key: string; text: string; tone?: 'bad' | 'warn' | 'muted' }> {
  const parts: Array<{ key: string; text: string; tone?: 'bad' | 'warn' | 'muted' }> = []
  const owner = item.computer
  const attention = item.attention
  if (attention && (!item.paused || attention.kind === 'ask')) {
    const text = attention.kind === 'ask' ? attention.text : attention.kind === 'failed' ? `failed · ${firstLine(attention.text)}` : `incomplete · ${firstLine(attention.text).toLowerCase()}`
    parts.push({ key: 'attention', text, tone: attention.kind === 'failed' ? 'bad' : 'warn' })
    return parts
  }
  if (item.paused) {
    parts.push({ key: 'paused', text: item.pausedUntil ? `paused until ${ownedWhenText(item.pausedUntil, ctx.now, owner, ctx.viewerZone)}` : 'paused' })
  } else if (item.trigger === 'thread_event') {
    parts.push({ key: 'when', text: item.whenText })
  } else if (item.trigger === 'request') {
    parts.push({ key: 'when', text: 'on request' })
  } else if (item.next) {
    parts.push({ key: 'when', text: ownedWhenText(item.next.at, ctx.now, owner, ctx.viewerZone) })
  } else if (item.trigger === 'time' && item.schedule) {
    parts.push({ key: 'when', text: describeSchedule(item.schedule, ctx.now) })
  }
  if (item.kind === 'watch') parts.push({ key: 'who', text: 'Notify' })
  else if (item.who.kind === 'bot') parts.push({ key: 'bot', text: item.who.name })
  else if (item.who.kind !== 'none') parts.push({ key: 'who', text: ctx.modelName?.(item) ?? item.who.name })
  if (item.where) parts.push({ key: 'where', text: item.where.name })
  if (ctx.manyComputers) parts.push({ key: 'computer', text: owner.name })
  if (item.active) parts.push({ key: 'run', text: runText(item.active, ctx.now, owner, ctx.viewerZone), tone: item.active.state === 'waiting' ? 'muted' : undefined })
  else if (item.last && item.trigger === 'request') parts.push({ key: 'run', text: agoText(item.last.at, ctx.now) })
  else if (item.last && item.who.kind === 'bot') parts.push({ key: 'run', text: `told you ${agoText(item.last.at, ctx.now)}` })
  if (item.addedBy) parts.push({ key: 'added', text: item.addedBy.threadName ? `added by ${item.addedBy.threadName}` : 'added by an agent' })
  if (item.expiresAt && !item.paused) parts.push({ key: 'expires', text: `ends ${ownedWhenText(item.expiresAt, ctx.now, owner, ctx.viewerZone)}` })
  return parts
}

export type PrimaryKind = 'allow' | 'retry' | 'run' | 'resume' | 'open'

/**
 * A row's one primary action. An open ask Needs you can answer in place is Allow (Not now is in "…"); Retry only on a
 * Failed run; bots and watches open where they live.
 */
export function primaryOf(item: AutomationItem): { kind: PrimaryKind; label: string } {
  if (item.attention?.kind === 'ask' && item.attention.answer) return { kind: 'allow', label: 'Allow' }
  if (item.kind === 'ask') return { kind: 'open', label: 'Open' }
  if (item.who.kind === 'bot' || item.kind === 'watch') return { kind: 'open', label: 'Open' }
  // A paused automation's old failure is not news; an open ask still waits for its answer.
  if (item.paused && item.attention?.kind !== 'ask') return { kind: 'resume', label: 'Resume' }
  if (item.attention?.kind === 'failed') return { kind: 'retry', label: 'Retry' }
  if (item.attention) return { kind: 'open', label: 'Open' }
  if (item.active && (item.active.state === 'running' || item.active.state === 'queued') && item.active.threadId) return { kind: 'open', label: 'Open' }
  return { kind: 'run', label: 'Run now' }
}

/**
 * The May a new automation is created with: the mode the person set as the profile default (the one a new thread
 * gets), held to the ceiling the job will have; Ask before acting when there is none.
 */
export function defaultMay(profileDefault: PermissionMode | undefined, ceiling?: PermissionMode): PermissionMode {
  const mode = profileDefault ? normalizePermissionMode(profileDefault) : 'ask'
  if (!ceiling) return mode
  const order: PermissionMode[] = ['ask', 'accept_edits', 'auto', 'full']
  return order.indexOf(mode) <= order.indexOf(ceiling) ? mode : ceiling
}

export const mayLabel = (mode: PermissionMode) => describePermissionMode(mode)

export type PauseChoice = 'resume' | 'tomorrow' | 'monday' | 'date'

/** When a Pause… choice ends: never (Until I resume), the start of tomorrow, the start of next Monday, or the chosen day. */
export function pauseUntil(choice: PauseChoice, now: Date = new Date(), date?: string): string | undefined {
  if (choice === 'resume') return undefined
  if (choice === 'tomorrow') return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString()
  if (choice === 'monday') {
    const ahead = ((8 - now.getDay()) % 7) || 7
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead).toISOString()
  }
  const match = date ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null
  if (!match) return undefined
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).toISOString()
}
