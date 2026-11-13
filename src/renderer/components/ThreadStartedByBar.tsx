import { Bot } from '../lib/icons'
import { useAppStore } from '../stores/appStore'
import { useBotsStore } from '../stores/botsStore'
import { useChatsStore } from '../stores/chatsStore'
import '../styles/computers.css'

/**
 * Top of a thread one of the owner's bots started ("use your threads"): one short line, "Started by <bot>", whose name
 * opens the bot's chat. The thread names its launcher (`Thread.createdByThreadId`), which for a bot is its chat thread.
 */
export function ThreadStartedByBarView({ name, onOpenBot }: { name: string; onOpenBot?: () => void }) {
  return (
    <div className="thread-computer-bar thread-started-by" role="note">
      <Bot size={12} strokeWidth={2} aria-hidden="true" />
      <span className="thread-computer-bar-text">
        Started by {onOpenBot ? <button type="button" className="thread-started-by-name" title={`Open ${name}'s chat`} onClick={onOpenBot}>{name}</button> : name}
      </span>
    </div>
  )
}

/** Shown above the selected thread when one of the owner's bots started it. */
export function ThreadStartedByBar() {
  const launcher = useAppStore((state) => state.threads.find((entry) => entry.id === state.activeThreadId)?.createdByThreadId)
  const bot = useBotsStore((state) => (launcher ? state.bots.find((entry) => entry.homeThreadId === launcher) : undefined))
  if (!launcher || !bot) return null
  return <ThreadStartedByBarView name={bot.name} onOpenBot={() => void useChatsStore.getState().openBot(bot.id)} />
}
