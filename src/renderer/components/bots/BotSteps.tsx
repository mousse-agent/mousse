import type { BotChip } from '../../../shared/bots/personal/chat'
import { selectThread } from '../../lib/threadActions'
import { useAppStore } from '../../stores/appStore'
import { stepText } from './botChatShape'

/** Shows a thread the bot started, messaged or stopped, with its project's threads in the sidebar. */
export function openThread(threadId: string): void {
  useAppStore.getState().setThreadsSidebarView('projects')
  void selectThread(threadId).catch(() => undefined)
}

/**
 * What a reply's work did, opened from its "Worked for" line: one plain line per step, never a tool log. A thread the
 * bot started, messaged or stopped offers Open; its hover is the first line of what the bot sent there. Work on a
 * model of its own names it on hover.
 */
export function BotSteps({ chips }: { chips: readonly BotChip[] }) {
  if (!chips.length) return null
  return <ul className="bot-steps">
    {chips.map((chip, index) => {
      const tip = chip.said ? `Sent: ${chip.said}` : chip.title
      return <li key={`${index}:${chip.icon}:${chip.text}`} {...(tip ? { title: tip } : {})}>
        <span>{stepText(chip)}</span>
        {chip.thread && <button type="button" className="bot-step-open" title="Open this thread" onClick={() => openThread(chip.thread!)}>Open</button>}
      </li>
    })}
  </ul>
}
