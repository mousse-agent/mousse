import { useEffect, useState } from 'react'
import { Bot, Sparkles } from '../lib/icons'
import { openThread } from '../lib/openThread'
import { useComputer } from '../lib/computers'
import { showBotThreadInSidebar, useShownBotThread } from '../lib/botThread'
import { setThreadHidden } from '../lib/threadActions'
import { useAppStore } from '../stores/appStore'
import { useBotsStore } from '../stores/botsStore'
import { useChatsStore } from '../stores/chatsStore'
import '../styles/computers.css'
import { HIDDEN_BOT_NAME } from '../../shared/bots/personal/deviceAccess'

/**
 * Top of a thread one of the owner's bots started ("use your threads"): one short line, "Started by <bot>", whose name
 * opens the bot's chat. A bot that was deleted keeps its name there, marked "(deleted)", with nothing to open. A thread the
 * bot keeps out of the sidebar adds "Hidden" and Show in sidebar (`onShow`).
 */
export function ThreadStartedByBarView({ name, onOpenBot, deleted = false, onShow }: { name: string; onOpenBot?: () => void; deleted?: boolean; onShow?: () => Promise<unknown> }) {
  const [showing, setShowing] = useState(false)
  return (
    <div className="thread-computer-bar thread-started-by" role="note">
      <Bot size={12} strokeWidth={2} aria-hidden="true" />
      <span className="thread-computer-bar-text">
        Started by {onOpenBot ? <button type="button" className="thread-started-by-name" title={`Open ${name}'s chat`} onClick={onOpenBot}>{name}</button> : name}{deleted ? ' (deleted)' : ''}
        {onShow && <> · <span title={deleted ? 'Not in your sidebar' : `Not in your sidebar. ${name}'s chat lists it.`}>Hidden</span></>}
      </span>
      {onShow && <button type="button" className="thread-started-by-name thread-started-by-show" disabled={showing}
        onClick={() => { setShowing(true); void onShow().finally(() => setShowing(false)) }}>Show in sidebar</button>}
    </div>
  )
}

/**
 * Top of a bot's thread opened in the bot's chat pane, whose header already names the bot: only Show in sidebar, for a
 * thread the bot keeps out of the sidebar. It lists the thread again and takes the sidebar back to the thread list.
 */
export function BotThreadShowBarView({ onShow }: { onShow: () => Promise<unknown> }) {
  const [showing, setShowing] = useState(false)
  return (
    <div className="thread-computer-bar thread-started-by" role="note">
      <button type="button" className="thread-started-by-name thread-started-by-show" disabled={showing}
        title="Not in your sidebar. Show it there."
        onClick={() => { setShowing(true); void onShow().finally(() => setShowing(false)) }}>Show in sidebar</button>
    </div>
  )
}

/**
 * Top of a thread an agent in another thread started (`thread_create`): "Started by an agent in «title»", whose title
 * opens that thread. A launcher this window no longer lists (deleted) is named as gone, with nothing to open. An agent
 * on another computer is named with it ("on <computer>"), with nothing to open here. A thread the agent keeps out of the
 * sidebar adds "Hidden" and Show in sidebar (`onShow`).
 */
export function ThreadStartedByAgentBarView({ title, onOpen, computer, onShow }: { title?: string; onOpen?: () => void; computer?: string; onShow?: () => Promise<unknown> }) {
  const [showing, setShowing] = useState(false)
  return (
    <div className="thread-computer-bar thread-started-by" role="note">
      <Sparkles size={12} strokeWidth={2} aria-hidden="true" />
      <span className="thread-computer-bar-text">
        {title === undefined
          ? 'Started by an agent in a thread that is no longer here'
          : <>Started by an agent in «{onOpen ? <button type="button" className="thread-started-by-name" aria-label={`Open ${title}, the thread that started this one`} title={`Open ${title}`} onClick={onOpen}>{title}</button> : title}»{computer ? ` on ${computer}` : ''}</>}
        {onShow && <> · <span title={computer ? 'Not in your sidebar' : 'Not in your sidebar. The side panel of the thread that started it lists it.'}>Hidden</span></>}
      </span>
      {onShow && <button type="button" className="thread-started-by-name thread-started-by-show" disabled={showing}
        onClick={() => { setShowing(true); void onShow().finally(() => setShowing(false)) }}>Show in sidebar</button>}
    </div>
  )
}

/**
 * Shown above the selected thread when an agent in another thread started it (the thread names it in
 * `Thread.createdByThreadId`), or when one of the owner's bots started it: the thread names its launcher
 * (`Thread.createdByThreadId`, the bot's chat thread) and keeps the bot's name from then (`Thread.startedByBot`). A thread
 * of another computer whose bot this device may not reach comes without the bot's name or id, and says "Started by a bot".
 * A thread an agent on another computer started names that agent's thread and computer (`Thread.startedFrom.agent`). A
 * hidden thread of this computer (`Thread.hidden`) offers Show in sidebar, also once its bot is deleted. In a bot's chat
 * pane (lib/botThread.ts) only Show in sidebar shows.
 */
export function ThreadStartedByBar() {
  const thread = useAppStore((state) => state.threads.find((entry) => entry.id === state.activeThreadId))
  const launcher = thread?.createdByThreadId
  const started = thread?.startedByBot
  const loaded = useBotsStore((state) => state.loaded)
  // A bot's chat thread is not listed, so a launcher that is listed is a thread like any other.
  const launcherTitle = useAppStore((state) => (launcher === undefined ? undefined : state.threads.find((entry) => entry.id === launcher)?.name))
  const bot = useBotsStore((state) => state.bots.find((entry) => (launcher !== undefined && entry.homeThreadId === launcher) || (started !== undefined && entry.id === started.botId)))
  // A launcher that is not listed may be a bot's chat thread: the bots are read (once) to tell it from a deleted thread.
  const unlisted = launcher !== undefined && launcherTitle === undefined && !started
  useEffect(() => {
    if (unlisted && !useBotsStore.getState().loaded) void useBotsStore.getState().refresh()
  }, [unlisted])
  // The computer an agent that started this thread runs on, when it is another one.
  const launcherComputer = useComputer(thread?.node ? undefined : thread?.startedFrom?.agent ? thread.startedFrom.node : undefined)
  // Showing a hidden thread is asked of the computer that runs it (`threads.setHidden` is not routed).
  const threadId = thread?.id
  const onShow = threadId && thread.hidden && !thread.node ? () => setThreadHidden(threadId, false) : undefined
  // In the bot's chat pane the header names the bot: no "Started by", only Show in sidebar for a hidden thread.
  const inBotPane = useShownBotThread()?.threadId === threadId && threadId !== undefined
  if (inBotPane) return onShow ? <BotThreadShowBarView onShow={() => onShow().then((shown) => { if (shown) showBotThreadInSidebar(threadId) })} /> : null
  // A thread of another computer whose bot this device does not reach names no bot (`botId` empty): "Started by a bot".
  if (started && !started.botId) return <ThreadStartedByBarView name={started.name || HIDDEN_BOT_NAME} />
  if (bot) return <ThreadStartedByBarView name={bot.name} onOpenBot={() => void useChatsStore.getState().openBot(bot.id)} onShow={onShow} />
  if (!started) {
    // An agent on another computer started this thread of this computer (`startedFrom.agent`): its thread is there.
    if (launcher === undefined && thread?.startedFrom?.agent && !thread.node)
      return <ThreadStartedByAgentBarView title={thread.startedFrom.agent.title.trim() || 'Untitled thread'} computer={launcherComputer?.name ?? 'another computer'} onShow={onShow} />
    if (launcher === undefined) return null
    if (launcherTitle !== undefined) return <ThreadStartedByAgentBarView title={launcherTitle.trim() || 'Untitled thread'} onOpen={() => void openThread(launcher)} onShow={onShow} />
    // Not listed: deleted, or a bot's chat thread whose bot is not read yet (or was deleted).
    return loaded ? <ThreadStartedByAgentBarView onShow={onShow} /> : null
  }
  // A bot of another computer is not in this one's list, and is not deleted for it.
  if (thread?.node) return <ThreadStartedByBarView name={started.name} />
  // The bot is gone (or its list is not loaded yet): its name as it was, marked deleted once the list says so.
  return <ThreadStartedByBarView name={started.name} deleted={loaded} onShow={onShow} />
}
