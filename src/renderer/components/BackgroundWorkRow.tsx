import { Fragment, useEffect, useState, type ComponentType, type ReactNode } from 'react'
import { Activity, Bell, ChevronDown, ChevronRight, Clock, Stop, Terminal, X } from '../lib/icons'
import { isRunningSubagent, type SubagentSummary } from '../../shared/subagents'
import {
  PROVIDER_BACKGROUND_ID,
  backgroundCounts,
  backgroundHeadline,
  type BackgroundCounts,
  type BackgroundWorkItem,
  type ThreadBackgroundWork
} from '../../shared/backgroundWork'
import type { SubagentCardModel } from '../chat/adapters/subagentCards'
import { formatElapsed, isCardRunning } from '../chat/components/agent-elements/tools/subagent-card-logic'
import { CopyIconButton } from '../chat/components/agent-elements/tools/copy-icon-button'
import { codeHighlighter } from '../chat/components/agent-elements/code-highlighter'
import { linePieces } from '../chat/components/agent-elements/code-colours'
import { lineageModelLabel, lineageSubagentName, nativeSubagentLabel } from './sideCard/lineageLogic'
import { subagentBadgeTone, subagentIconId, type SubagentBadgeTone } from './subagentStatus'
import { SubagentAvatar, useThreadProviderId } from './SubagentAvatar'
import { useNativeSubagents } from '../hooks/useNativeSubagents'
import { useNativeSubagentViewStore } from '../stores/nativeSubagentViewStore'
import { openThread } from '../lib/openThread'
import './backgroundWorkRow.css'

/** What a line's leading mark is: a subagent's provider circle, or the kind of work it is. */
export type BackgroundLineMark =
  | { kind: 'avatar'; providerId: string; tone: SubagentBadgeTone }
  | { kind: 'command' | 'monitor' | 'waiting' | 'wake' }

/** One line of the Details list: what it is, a word for its kind, what hovering tells, and how it is opened or stopped. */
export interface BackgroundLine {
  key: string
  title: string
  kind: string
  tooltip: string
  mark: BackgroundLineMark
  /** Where it runs (a subagent's model, a native subagent's kind of agent), next to its title. */
  detail?: string
  /** The command or script it runs, shown in full under its title. Only work items have one; none of them opens. */
  command?: string
  /** When it started (ms), for the running time a subagent line shows. */
  since?: number
  /** Opens its own view: a subagent's thread, a native subagent's page. */
  open?: () => void
  /** Stops only it; none for a native subagent, which only its agent (or the thread's Stop) can end. */
  stop?: () => void
}

const KIND_WORDS: Record<BackgroundWorkItem['kind'], string> = {
  command: 'Monitor',
  url: 'Monitor',
  background: 'Command',
  keep_working: 'Waiting',
  wake: 'Wake-up'
}

const KIND_MARKS: Record<BackgroundWorkItem['kind'], 'command' | 'monitor' | 'waiting' | 'wake'> = {
  command: 'monitor',
  url: 'monitor',
  background: 'command',
  keep_working: 'waiting',
  wake: 'wake'
}

const MARK_ICONS: Record<'command' | 'monitor' | 'waiting' | 'wake', ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean | 'true' }>> = {
  command: Terminal,
  monitor: Activity,
  waiting: Clock,
  wake: Bell
}

const clock = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
/** A time, with its day when it is not today (a wake-up may be days ahead). */
const when = (iso: string): string => {
  const at = new Date(iso)
  return at.toDateString() === new Date().toDateString() ? clock(iso) : at.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}
const msOf = (iso: string | null | undefined): number | undefined => {
  const ms = iso ? Date.parse(iso) : NaN
  return Number.isFinite(ms) ? ms : undefined
}

export interface BackgroundLineActions {
  stopSubagent: (childThreadId: string) => void
  stopItem: (id: string) => void
  openSubagent?: (childThreadId: string) => void
  openNative?: (toolCallId: string) => void
}

export interface BackgroundLineSources {
  /** The thread's native subagents (Claude Code's `Agent` calls); only running ones are listed. */
  native?: readonly SubagentCardModel[]
  /** The provider the thread runs on, for subagents that inherited it. */
  inheritedProvider?: string | null
}

/**
 * The Details list: running subagents first (Mousse's, then the runtime's own), then the thread's own background
 * work, then the provider's. The provider's line stands for its background agents and shells; while one of its
 * agents is listed by name, that line is left out, since the agent is what it was.
 */
export function backgroundLines(
  subagents: readonly SubagentSummary[],
  work: ThreadBackgroundWork | undefined,
  actions: BackgroundLineActions,
  sources: BackgroundLineSources = {}
): BackgroundLine[] {
  const inherited = sources.inheritedProvider ?? null
  const native = (sources.native ?? []).filter(isCardRunning)
  return [
    ...subagents.filter(isRunningSubagent).map((subagent): BackgroundLine => {
      const detail = lineageModelLabel(subagent)
      const since = msOf(subagent.tasks?.at(-1)?.createdAt ?? subagent.createdAt)
      return {
        key: `subagent:${subagent.childThreadId}`,
        title: lineageSubagentName(subagent),
        kind: 'Subagent',
        tooltip: `Open ${lineageSubagentName(subagent)}`,
        mark: { kind: 'avatar', providerId: subagentIconId(subagent.provider, inherited), tone: subagentBadgeTone(subagent) },
        ...(detail ? { detail } : {}),
        ...(since !== undefined ? { since } : {}),
        ...(actions.openSubagent ? { open: () => actions.openSubagent!(subagent.childThreadId) } : {}),
        stop: () => actions.stopSubagent(subagent.childThreadId)
      }
    }),
    ...native.map((card): BackgroundLine => {
      const detail = nativeSubagentLabel(card.native)
      return {
        key: `native:${card.toolCallId}`,
        title: lineageSubagentName(card),
        kind: 'Native subagent',
        tooltip: `Watch ${lineageSubagentName(card)}`,
        mark: { kind: 'avatar', providerId: subagentIconId(card.provider, inherited), tone: subagentBadgeTone(card) },
        ...(detail ? { detail } : {}),
        ...(card.createdAt !== null ? { since: card.createdAt } : {}),
        ...(actions.openNative ? { open: () => actions.openNative!(card.toolCallId) } : {})
      }
    }),
    ...(work?.items ?? []).map((item): BackgroundLine => ({
      key: item.id,
      title: item.description,
      kind: KIND_WORDS[item.kind],
      mark: { kind: KIND_MARKS[item.kind] },
      tooltip: item.kind === 'wake'
        ? (item.waitsFor ? `Wakes ${item.waitsFor}, or at ${when(item.until)} at the latest` : `Wakes at ${when(item.until)}`)
        : [item.url, `Ends by ${clock(item.until)} at the latest`].filter(Boolean).join('\n'),
      ...(item.command ? { command: item.command } : {}),
      stop: () => actions.stopItem(item.id)
    })),
    ...(work?.providerWork && !native.length
      ? [{
          key: PROVIDER_BACKGROUND_ID,
          title: 'Agent background work',
          kind: 'Command',
          mark: { kind: 'command' as const },
          tooltip: 'Background agents or shells the agent started',
          stop: () => actions.stopItem(PROVIDER_BACKGROUND_ID)
        }]
      : [])
  ]
}

/**
 * The counts the headline names. The runtime's running subagents count as subagents, and while any is listed the
 * provider's background work is them, not another command.
 */
export function stripCounts(work: ThreadBackgroundWork | undefined, runningSubagents: number, runningNative: number): BackgroundCounts {
  const counts = backgroundCounts(work, runningSubagents + runningNative)
  return runningNative && work?.providerWork ? { ...counts, commands: Math.max(0, counts.commands - 1) } : counts
}

/**
 * What the closed row names after its count: the work that reported last, by its description (never the line it
 * printed), or the one thing that runs; nothing when several run and none has reported.
 */
export function rowNames(lines: readonly BackgroundLine[], work: ThreadBackgroundWork | undefined): string | undefined {
  const reported = work?.latest ? work.items.find((item) => item.id === work.latest!.id) : undefined
  return reported?.description || (lines.length === 1 ? lines[0]!.title : undefined)
}

/** Most provider circles stacked at the start of the closed row. */
const STACK_LIMIT = 3

function LineMark({ mark }: { mark: BackgroundLineMark }) {
  if (mark.kind === 'avatar') return <SubagentAvatar providerId={mark.providerId} tone={mark.tone} size={12} chip />
  const Icon = MARK_ICONS[mark.kind]
  return (
    <span className="background-work-mark" data-kind={mark.kind} aria-hidden="true">
      <Icon size={13} aria-hidden="true" />
    </span>
  )
}

type CommandTokens = ReturnType<typeof codeHighlighter.highlight>

/** One line of a command: its text in the chat's code colours once they are known, plain until then. */
function commandLine(text: string, tokens: NonNullable<CommandTokens>['tokens'][number] | undefined): ReactNode {
  const pieces = tokens ? linePieces(tokens, text) : null
  if (!pieces) return text
  return pieces.map((piece, index) => (piece.colour ? <span key={index} className={piece.colour}>{piece.text}</span> : piece.text))
}

/** A command as the terminal panel shows one: on its background, after a prompt, in the chat's code colours, with Copy. */
function CommandBlock({ command }: { command: string }) {
  const [tokens, setTokens] = useState<CommandTokens>(null)
  useEffect(() => {
    let current = true
    setTokens(codeHighlighter.highlight({ code: command, language: 'shellscript' as never, themes: codeHighlighter.getThemes() }, (later) => {
      if (current) setTokens(later)
    }))
    return () => {
      current = false
    }
  }, [command])
  return (
    <span className="background-work-command">
      <span className="background-work-prompt" aria-hidden="true">$</span>
      <span className="background-work-command-text">
        {command.split('\n').map((text, index) => (
          <Fragment key={index}>
            {index > 0 && '\n'}
            {commandLine(text, tokens?.tokens[index])}
          </Fragment>
        ))}
      </span>
      <CopyIconButton text={command} label="Copy command" />
    </span>
  )
}

/** The current time every second while `enabled`, for running times. */
function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [enabled])
  return now
}

interface BackgroundWorkRowViewProps {
  headline: string
  /** The work the line names after its count (`rowNames`). */
  names?: string
  lines: readonly BackgroundLine[]
  open: boolean
  onToggle: () => void
  onStopAll: () => void
  /** Current time, for subagents' running times; the list shows none without it. */
  now?: number
}

/**
 * Top of the composer while the thread waits on background work: the provider circles of its subagents (or a mark for
 * what runs), one line counting what it waits on and naming the work that reported last, Details (the list: subagents
 * open their thread or page, commands show in full, everything else has its own Stop) and Stop (all of it, as the
 * thread's Stop). Nothing on the closed row moves; it changes only when the work does.
 */
export function BackgroundWorkRowView({ headline, names, lines, open, onToggle, onStopAll, now }: BackgroundWorkRowViewProps) {
  const avatars = lines.filter((line) => line.mark.kind === 'avatar')
  const shown = avatars.slice(0, STACK_LIMIT)
  const extra = avatars.length - shown.length
  const onlyWakes = lines.length > 0 && lines.every((line) => line.mark.kind === 'wake')
  return (
    <div className="composer-banner background-work" role="status" aria-label="Background work" data-open={open || undefined}>
      <div className="background-work-head">
        <button type="button" className="background-work-summary" aria-expanded={open} title={open ? 'Hide details' : 'Show details'} onClick={onToggle}>
          {shown.length ? (
            <span className="background-work-stack" aria-hidden="true">
              {shown.map((line) => <LineMark key={line.key} mark={line.mark} />)}
              {extra > 0 && <span className="background-work-more">+{extra}</span>}
            </span>
          ) : (
            <span className="background-work-pulse" data-idle={onlyWakes || undefined} aria-hidden="true" />
          )}
          <span className="background-work-text" title={names ? `${headline}\n${names}` : headline}>
            {headline}
            {names && <span className="background-work-latest"> · {names}</span>}
          </span>
          <span className="background-work-toggle" aria-hidden="true">
            <span className="background-work-toggle-word">Details</span>
            <ChevronDown size={14} className="background-work-chevron" aria-hidden="true" />
          </span>
        </button>
        <button type="button" className="background-work-icon-btn is-stop" aria-label="Stop" title="Stop all background work" onClick={onStopAll}>
          <Stop size={14} aria-hidden="true" />
        </button>
      </div>
      {open && (
        <ul className="background-work-list" aria-label="What runs in the background">
          {lines.map((line) => {
            const elapsed = line.since !== undefined && now !== undefined ? formatElapsed(Math.max(0, now - line.since)) : null
            const body = (
              <>
                <LineMark mark={line.mark} />
                <span className="background-work-body">
                  <span className="background-work-heading">
                    <span className="background-work-title">{line.title}</span>
                    {line.detail && <span className="background-work-detail">{line.detail}</span>}
                  </span>
                  {line.command && <CommandBlock command={line.command} />}
                </span>
                {elapsed ? <span className="background-work-elapsed">{elapsed}</span> : <span className="background-work-kind">{line.kind}</span>}
              </>
            )
            return (
              <li key={line.key} className="background-work-line" data-mark={line.mark.kind} data-command={line.command ? '' : undefined} title={line.tooltip}>
                {line.open ? (
                  <button type="button" className="background-work-open" aria-label={line.tooltip} onClick={line.open}>
                    {body}
                    <ChevronRight size={14} className="background-work-go" aria-hidden="true" />
                  </button>
                ) : (
                  <span className="background-work-open is-static">{body}</span>
                )}
                {line.stop ? (
                  <button type="button" className="background-work-icon-btn is-line" aria-label={`Stop ${line.title}`} title="Stop" onClick={line.stop}>
                    <X size={13} aria-hidden="true" />
                  </button>
                ) : (
                  // Keeps the chevrons of lines without a Stop in line with the rest.
                  <span className="background-work-icon-btn is-line is-blank" aria-hidden="true" />
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/**
 * The row for a thread, from its subagents (Mousse's and its runtime's own), and the background work the daemon
 * pushed; nothing while none runs.
 */
export function BackgroundWorkRow({ threadId, subagents, work, onStopAll }: {
  threadId: string
  subagents: readonly SubagentSummary[]
  work: ThreadBackgroundWork | undefined
  onStopAll: () => void
}) {
  const [open, setOpen] = useState(false)
  const native = useNativeSubagents(threadId)
  const inheritedProvider = useThreadProviderId(threadId)
  const showNative = useNativeSubagentViewStore((state) => state.show)
  const runningNative = native.filter(isCardRunning).length
  const counts = stripCounts(work, subagents.filter(isRunningSubagent).length, runningNative)
  const headline = backgroundHeadline(counts)
  const lines = headline
    ? backgroundLines(subagents, work, {
        stopSubagent: (childThreadId) => void window.mousse.orchestrator.abort(childThreadId),
        stopItem: (id) => void window.mousse.threads.stopBackground(threadId, id),
        openSubagent: (childThreadId) => void openThread(childThreadId),
        openNative: (toolCallId) => showNative({ threadId, toolCallId })
      }, { native, inheritedProvider })
    : []
  const now = useNow(open && lines.some((line) => line.since !== undefined))
  if (!headline) return null
  const names = rowNames(lines, work)
  return (
    <BackgroundWorkRowView
      headline={headline}
      {...(names ? { names } : {})}
      lines={lines}
      open={open}
      onToggle={() => setOpen((value) => !value)}
      onStopAll={onStopAll}
      now={now}
    />
  )
}
