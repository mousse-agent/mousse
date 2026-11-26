import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { UIMessage } from 'ai'
import { ArrowLeft, Lock } from '../lib/icons'
import type { ChatMessage } from '../../shared/types'
import type { SubagentCardModel } from '../chat/adapters/subagentCards'
import { chatStatusFromTurn, mousseToUIMessages } from '../chat/adapters/mousseToUI'
import { GenericTool } from '../chat/components/agent-elements/tools/generic-tool'
import { toolRegistry } from '../chat/components/agent-elements/tools/tool-registry'
import { getToolStatus } from '../chat/components/agent-elements/utils/format-tool'
import { Markdown } from '../chat/components/agent-elements/markdown'
import { cardElapsedLabel, cardStatusLabel, cardTitle, isCardRunning } from '../chat/components/agent-elements/tools/subagent-card-logic'
import { useNativeSubagents } from '../hooks/useNativeSubagents'
import { useAppStore } from '../stores/appStore'
import { useNativeSubagentViewStore } from '../stores/nativeSubagentViewStore'
import { nativeSubagentLabel } from './sideCard/lineageLogic'
import { SubagentAvatar, useThreadProviderId } from './SubagentAvatar'
import { subagentBadgeTone, subagentIconId } from './subagentStatus'
import './nativeSubagentPage.css'

type ToolPart = { type: string; toolCallId?: string; state?: string; [key: string]: unknown }

/**
 * The saved messages of one native subagent: the call that started it and every call made under it (at any depth),
 * in transcript order. Calls name their parent (`activity.parentId`), so the subagent's own are those whose chain of
 * parents reaches it.
 */
export function nativeSubagentMessages(messages: readonly ChatMessage[], rootId: string): ChatMessage[] {
  const parentOf = new Map<string, string | undefined>()
  for (const message of messages) if (message.activity) parentOf.set(message.id, message.activity.parentId)
  const under = (id: string): boolean => {
    let current = parentOf.get(id)
    for (let depth = 0; current && depth < 32; depth += 1) {
      if (current === rootId) return true
      current = parentOf.get(current)
    }
    return false
  }
  return messages.filter((message) => message.id === rootId || (!message.hidden && under(message.id)))
}

/** The calls a native subagent made, as the chat's tool parts, in order: the parts nested under its root (`<root>:<call>`). */
export function nativeSubagentCalls(uiMessages: readonly UIMessage[], rootId: string): ToolPart[] {
  const root = uiMessages.find((message) => message.id === rootId)
  return ((root?.parts ?? []) as unknown as ToolPart[]).filter(
    (part) => typeof part.toolCallId === 'string' && part.toolCallId.startsWith(`${rootId}:`) && part.type !== 'tool-TaskOutput'
  )
}

/** The task the agent gave its subagent, when the runtime reported it. */
function assignedTask(root: ChatMessage | undefined): string | null {
  const activity = root?.activity
  const prompt = activity?.kind === 'subagent' ? activity.prompt?.trim() : undefined
  return prompt || null
}

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

const NO_MESSAGES: ChatMessage[] = []

interface NativeSubagentPageViewProps {
  card: SubagentCardModel | undefined
  task: string | null
  calls: readonly ToolPart[]
  chatStatus?: string
  inheritedProvider?: string | null
  now: number
  onBack: () => void
}

/**
 * A native subagent on its own page: who it is and how it is doing, the task it was given, the calls it makes as
 * they stream in, and its report once it ends. It has no thread to write to, so where the composer was a pill says
 * only its agent directs it.
 */
export function NativeSubagentPageView({ card, task, calls, chatStatus, inheritedProvider, now, onBack }: NativeSubagentPageViewProps) {
  const backRef = useRef<HTMLButtonElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const title = card ? cardTitle(card) : 'Subagent'
  const running = card ? isCardRunning(card) : true
  const label = card ? nativeSubagentLabel(card.native) : null
  const status = card ? cardStatusLabel(card) : 'Starting'
  const tone = card ? subagentBadgeTone(card) : 'running'
  const elapsed = card ? cardElapsedLabel(card, now) : null
  const report = card?.error ?? card?.native?.result ?? null

  useEffect(() => { backRef.current?.focus() }, [])
  // New calls keep the page at its end while the person reads there; scrolled up, it stays put.
  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (scroller && pinned.current) scroller.scrollTop = scroller.scrollHeight
  }, [calls.length, report])

  return (
    <section
      className="native-subagent-page"
      aria-label={`${title}, native subagent`}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault()
          onBack()
        }
      }}
    >
      <header className="native-subagent-header">
        <button ref={backRef} type="button" className="native-subagent-back" aria-label="Back to chat" title="Back to chat" onClick={onBack}>
          <ArrowLeft size={16} aria-hidden="true" />
        </button>
        <SubagentAvatar providerId={subagentIconId(card?.provider, inheritedProvider)} tone={tone} size={15} chip />
        <div className="native-subagent-heading">
          <h2 className="native-subagent-title">{title}</h2>
          <span className="native-subagent-meta">
            <span className="native-subagent-status" data-tone={tone}>{running ? `${status}…` : status}</span>
            {label && <><span aria-hidden="true"> · </span>{label}</>}
          </span>
        </div>
        {elapsed && <span className="native-subagent-elapsed">{elapsed}</span>}
      </header>

      <div
        ref={scrollRef}
        className="native-subagent-scroll"
        onScroll={(event) => {
          const el = event.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
        }}
      >
        <div className="native-subagent-column">
          {task && (
            <section className="native-subagent-section">
              <h3 className="native-subagent-label">Task</h3>
              <p className="native-subagent-task">{task}</p>
            </section>
          )}
          <section className="native-subagent-section" aria-live="polite">
            <h3 className="native-subagent-label">Activity{calls.length ? <span className="native-subagent-count">{calls.length}</span> : null}</h3>
            {calls.length ? (
              <div className="native-subagent-calls">
                {calls.map((part, index) => {
                  const meta = toolRegistry[part.type]
                  if (!meta) return null
                  const { isPending, isError } = getToolStatus(part, chatStatus)
                  return (
                    <GenericTool
                      key={part.toolCallId ?? index}
                      icon={meta.icon}
                      title={meta.title(part)}
                      subtitle={meta.subtitle?.(part)}
                      isPending={isPending}
                      isError={isError}
                    />
                  )
                })}
              </div>
            ) : (
              <p className="native-subagent-empty">{running ? 'No calls yet' : 'It made no calls'}</p>
            )}
          </section>
          {report?.trim() && (
            <section className="native-subagent-section">
              <h3 className="native-subagent-label">{card?.error ? 'Error' : 'Report'}</h3>
              <div className="native-subagent-report" data-tone={card?.error ? 'failed' : undefined}>
                <Markdown content={report.trim()} />
              </div>
            </section>
          )}
        </div>
      </div>

      <div className="native-subagent-pill" role="note">
        <Lock size={13} aria-hidden="true" />
        <span>Native subagent · only its agent can direct it</span>
      </div>
    </section>
  )
}

/**
 * The open native subagent's page over its thread's chat, drawn from the loaded transcript; it streams as the
 * transcript does. Closes when another thread is opened, or when the subagent is no longer in the transcript.
 */
export function NativeSubagentPage({ threadId }: { threadId: string | null }) {
  const view = useNativeSubagentViewStore((state) => state.open)
  const close = useNativeSubagentViewStore((state) => state.close)
  const shown = view && view.threadId === threadId ? view : null
  const messages = useAppStore((s) => (shown && s.activeThreadId === shown.threadId ? s.messages : NO_MESSAGES))
  const turnState = useAppStore((s) => (shown ? s.turnStates[shown.threadId] : undefined))
  const cards = useNativeSubagents(shown?.threadId)
  const inheritedProvider = useThreadProviderId(shown?.threadId)
  const rootId = shown?.toolCallId ?? ''
  const own = useMemo(() => (rootId ? nativeSubagentMessages(messages, rootId) : NO_MESSAGES), [messages, rootId])
  const calls = useMemo(() => (own.length ? nativeSubagentCalls(mousseToUIMessages(own), rootId) : []), [own, rootId])
  const card = cards.find((entry) => entry.toolCallId === rootId)
  const root = own.find((message) => message.id === rootId)
  const now = useNow(Boolean(card && isCardRunning(card)))
  const gone = Boolean(shown) && messages.length > 0 && !root

  useEffect(() => {
    if (view && (view.threadId !== threadId || gone)) close()
  }, [view, threadId, gone, close])

  if (!shown || gone) return null
  return (
    <NativeSubagentPageView
      card={card}
      task={assignedTask(root)}
      calls={calls}
      chatStatus={chatStatusFromTurn(turnState)}
      inheritedProvider={inheritedProvider}
      now={now}
      onBack={close}
    />
  )
}
