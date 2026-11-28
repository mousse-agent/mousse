import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { UIMessage } from 'ai'
import type { BotChatMessage } from '../../../shared/bots/personal/chat'
import { shownApplets } from '../../../shared/bots/personal/remoteApplets'
import type { FindTurn } from '../../chat/components/agent-elements/find/find-index'
import type { RevealNavigation } from '../../chat/components/agent-elements/find/reveal'
import { useThreadFind, type ThreadFind } from '../../chat/components/agent-elements/find/use-thread-find'
import { actionStatus, actionTitle } from './BotActionCard'
import { botGroupTime } from './messageGroups'
import { useBotsStore } from '../../stores/botsStore'
import type { BotChatRow } from './botChatShape'

/** The field's name in a bot's chat. */
export const BOT_FIND_LABEL = 'Find in chat'
/** Frames a match's message may take to be drawn after it was loaded or scrolled to. */
const ROW_WAIT_FRAMES = 30
/** Space kept above a message the find bar scrolls to. */
const ROW_MARGIN = 16

/**
 * The words a message shows in its bubble, which find reads. A question's answers and a reply's cards are drawn under
 * its words, which then stop where their plain copy starts (as BotChatView draws them).
 */
export function botFindText(message: BotChatMessage): string {
  // Only the always-visible title and status are indexed; arguments and the replaced fallback never count.
  const action = message.action
  if (action) return [actionTitle(action), actionStatus(action)].filter(Boolean).join('\n\n')
  if (message.actionSentAt) return `Sent · ${botGroupTime(message.actionSentAt)}`
  if (message.plainFrom !== undefined && (message.question || message.cards?.length || shownApplets(message.applets))) return message.text.slice(0, message.plainFrom).trimEnd()
  return message.text
}

const asFind = new WeakMap<BotChatMessage, UIMessage>()

/** A message as the find index reads one: its words as Markdown, which both sides' bubbles draw. */
function findMessageOf(message: BotChatMessage): UIMessage {
  let found = asFind.get(message)
  if (!found) {
    // Escaped plain text prevents argument-like Markdown in a title from changing the search index.
    const escape = (text: string) => text.replace(/[!-/:-@[-`{-~]/g, '\\$&')
    found = { id: message.id, role: 'assistant', parts: message.action
      ? [actionTitle(message.action), actionStatus(message.action)].map((text) => ({ type: 'text' as const, text: escape(text) }))
      : [{ type: 'text', text: botFindText(message) }] }
    asFind.set(message, found)
  }
  return found
}

/** The chat's messages as find's rows: one per message, keyed by its id (the `data-turn-key` of its article). */
export function botFindTurns(rows: readonly BotChatRow[]): FindTurn[] {
  return rows.flatMap((row) => (row.kind === 'message' ? [{ key: row.message.id, assistantMsgs: [findMessageOf(row.message)] }] : []))
}

/**
 * Loads the chat's older pages, one after another, until the whole history is held or `stopped` says to end. A page
 * that brings nothing older (it failed, or the profile changed) ends it too.
 */
export async function loadWholeChat(botId: string, stopped: () => boolean): Promise<void> {
  const store = useBotsStore.getState
  for (;;) {
    const before = store().chats[botId]
    if (stopped() || !before?.hasMore || !before.messages.length) return
    await store().loadOlder(botId)
    const after = store().chats[botId]
    if (!after?.messages.length || after.messages[0]!.seq >= before.messages[0]!.seq) return
  }
}

const nextFrame = () => new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()) })

interface Options {
  botId: string
  /** The rows the transcript draws, sent and on their way. */
  rows: readonly BotChatRow[]
  /** The transcript: it scrolls, and its children are the rows (each message's article carries `data-turn-key`). */
  transcript: RefObject<HTMLDivElement | null>
  /** Older history exists that is not loaded yet. */
  hasMore: boolean
  /** A match is about to be shown: the chat stops following its end. */
  onNavigate(): void
  /** The landing that `onNavigate` began is over (shown, replaced by none, or cancelled). */
  onLanded?(): void
  /**
   * Brings a message's row into the transcript and near its top; resolves false when it can't. By default a message
   * not loaded yet is loaded first, then its drawn row is scrolled to. A transcript that draws only some of its rows
   * passes its own.
   */
  scrollToMessage?(id: string, navigation: RevealNavigation): Promise<boolean>
}

/**
 * Find in a bot's chat: the thread's find bar, index and highlights over the chat's messages. While the bar is open
 * the chat's older history is loaded too, so every message is searched, and a match in a message that is not drawn is
 * scrolled to through `scrollToMessage`. Ctrl/Cmd+F opens it while the chat shows (the focused transcript wins).
 */
export function useBotChatFind({ botId, rows, transcript, hasMore, onNavigate, onLanded, scrollToMessage }: Options): ThreadFind {
  const turns = useMemo(() => botFindTurns(rows), [rows])
  const [loadingHistory, setLoadingHistory] = useState(false)
  const navigation = useRef(0)
  const latest = useRef({ botId, onNavigate, onLanded, scrollToMessage })
  latest.current = { botId, onNavigate, onLanded, scrollToMessage }

  const virtualization = useMemo(() => {
    const begin = (): RevealNavigation & { token: number } => {
      const token = ++navigation.current
      // Only the newest landing's end counts: one replaced by the next match is not over.
      return { token, isCurrent: () => navigation.current === token, end: () => { if (navigation.current === token) latest.current.onLanded?.() } }
    }
    return {
      beginNavigation: begin,
      cancelNavigation: () => {
        navigation.current += 1
        latest.current.onLanded?.()
      },
      scrollToKey: (id: string, _target: unknown, handle?: RevealNavigation) => {
        const token = handle ?? begin()
        const own = latest.current.scrollToMessage
        return own ? own(id, token) : showRow(transcript, latest.current.botId, id, token)
      }
    }
  }, [transcript])

  const find = useThreadFind({
    enabled: typeof window !== 'undefined',
    turns,
    isStreaming: false,
    containerRef: transcript,
    rowsRef: transcript,
    virtualization,
    onNavigate: () => latest.current.onNavigate(),
    onProgrammaticScroll: () => undefined,
    pending: loadingHistory && hasMore,
    label: BOT_FIND_LABEL
  })

  // While the bar is open, the rest of the chat's history comes in, page by page.
  useEffect(() => {
    if (!find.open || !hasMore) return
    let stopped = false
    setLoadingHistory(true)
    void loadWholeChat(botId, () => stopped).finally(() => { if (!stopped) setLoadingHistory(false) })
    return () => {
      stopped = true
      setLoadingHistory(false)
    }
  }, [find.open, hasMore, botId])

  return find
}

/** The default `scrollToMessage`: loads the message when it is older than what is held, then scrolls to its row. */
async function showRow(transcript: RefObject<HTMLDivElement | null>, botId: string, id: string, navigation: RevealNavigation): Promise<boolean> {
  const row = () => transcript.current?.querySelector<HTMLElement>(`:scope > [data-turn-key="${CSS.escape(id)}"]`) ?? null
  if (!row() && !(await useBotsStore.getState().findMessage(botId, id))) return false
  for (let frame = 0; !row(); frame += 1) {
    if (!navigation.isCurrent() || frame >= ROW_WAIT_FRAMES) return false
    await nextFrame()
  }
  const container = transcript.current
  const element = row()
  if (!container || !element || !navigation.isCurrent()) return false
  container.scrollTop += element.getBoundingClientRect().top - container.getBoundingClientRect().top - ROW_MARGIN
  return true
}
