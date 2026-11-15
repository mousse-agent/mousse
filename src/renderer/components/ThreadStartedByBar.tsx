import { useState } from 'react'
import { Bot } from '../lib/icons'
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
 * Shown above the selected thread when one of the owner's bots started it: the thread names its launcher
 * (`Thread.createdByThreadId`, the bot's chat thread) and keeps the bot's name from then (`Thread.startedByBot`). A thread
 * of another computer whose bot this device may not reach comes without the bot's name or id, and says "Started by a bot".
 * A hidden thread of this computer (`Thread.hidden`) offers Show in sidebar, also once its bot is deleted.
 */
export function ThreadStartedByBar() {
  const thread = useAppStore((state) => state.threads.find((entry) => entry.id === state.activeThreadId))
  const launcher = thread?.createdByThreadId
  const started = thread?.startedByBot
  const loaded = useBotsStore((state) => state.loaded)
  const bot = useBotsStore((state) => state.bots.find((entry) => (launcher !== undefined && entry.homeThreadId === launcher) || (started !== undefined && entry.id === started.botId)))
  // Showing a hidden thread is asked of the computer that runs it (`threads.setHidden` is not routed).
  const threadId = thread?.id
  const onShow = threadId && thread.hidden && !thread.node ? () => setThreadHidden(threadId, false) : undefined
  // A thread of another computer whose bot this device does not reach names no bot (`botId` empty): "Started by a bot".
  if (started && !started.botId) return <ThreadStartedByBarView name={started.name || HIDDEN_BOT_NAME} />
  if (bot) return <ThreadStartedByBarView name={bot.name} onOpenBot={() => void useChatsStore.getState().openBot(bot.id)} onShow={onShow} />
  if (!started) return null
  // A bot of another computer is not in this one's list, and is not deleted for it.
  if (thread?.node) return <ThreadStartedByBarView name={started.name} />
  // The bot is gone (or its list is not loaded yet): its name as it was, marked deleted once the list says so.
  return <ThreadStartedByBarView name={started.name} deleted={loaded} onShow={onShow} />
}
