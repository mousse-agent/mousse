import { Bot } from '../lib/icons'
import { useAppStore } from '../stores/appStore'
import { useBotsStore } from '../stores/botsStore'
import { useChatsStore } from '../stores/chatsStore'
import '../styles/computers.css'
import { HIDDEN_BOT_NAME } from '../../shared/bots/personal/deviceAccess'

/**
 * Top of a thread one of the owner's bots started ("use your threads"): one short line, "Started by <bot>", whose name
 * opens the bot's chat. A bot that was deleted keeps its name there, marked "(deleted)", with nothing to open.
 */
export function ThreadStartedByBarView({ name, onOpenBot, deleted = false }: { name: string; onOpenBot?: () => void; deleted?: boolean }) {
  return (
    <div className="thread-computer-bar thread-started-by" role="note">
      <Bot size={12} strokeWidth={2} aria-hidden="true" />
      <span className="thread-computer-bar-text">
        Started by {onOpenBot ? <button type="button" className="thread-started-by-name" title={`Open ${name}'s chat`} onClick={onOpenBot}>{name}</button> : name}{deleted ? ' (deleted)' : ''}
      </span>
    </div>
  )
}

/**
 * Shown above the selected thread when one of the owner's bots started it: the thread names its launcher
 * (`Thread.createdByThreadId`, the bot's chat thread) and keeps the bot's name from then (`Thread.startedByBot`). A thread
 * of another computer whose bot this device may not reach comes without the bot's name or id, and says "Started by a bot".
 */
export function ThreadStartedByBar() {
  const thread = useAppStore((state) => state.threads.find((entry) => entry.id === state.activeThreadId))
  const launcher = thread?.createdByThreadId
  const started = thread?.startedByBot
  const loaded = useBotsStore((state) => state.loaded)
  const bot = useBotsStore((state) => state.bots.find((entry) => (launcher !== undefined && entry.homeThreadId === launcher) || (started !== undefined && entry.id === started.botId)))
  // A thread of another computer whose bot this device does not reach names no bot (`botId` empty): "Started by a bot".
  if (started && !started.botId) return <ThreadStartedByBarView name={started.name || HIDDEN_BOT_NAME} />
  if (bot) return <ThreadStartedByBarView name={bot.name} onOpenBot={() => void useChatsStore.getState().openBot(bot.id)} />
  if (!started) return null
  // A bot of another computer is not in this one's list, and is not deleted for it.
  if (thread?.node) return <ThreadStartedByBarView name={started.name} />
  // The bot is gone (or its list is not loaded yet): its name as it was, marked deleted once the list says so.
  return <ThreadStartedByBarView name={started.name} deleted={loaded} />
}
