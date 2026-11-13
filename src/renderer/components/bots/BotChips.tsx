import { AlertTriangle, Brain, Clock, FileText, Globe, Pencil, Search, Shield, Sparkles, UserCircle } from '../../lib/icons'
import type { BotChip, BotChipIcon } from '../../../shared/bots/personal/chat'
import { selectThread } from '../../lib/threadActions'
import { useAppStore } from '../../stores/appStore'

/** Shows a thread the bot started, messaged or stopped, with its project's threads in the sidebar. */
function openThread(threadId: string): void {
  useAppStore.getState().setThreadsSidebarView('projects')
  void selectThread(threadId).catch(() => undefined)
}

const CHIP_ICONS: Record<BotChipIcon, typeof Search> = {
  search: Search,
  web: Globe,
  read: FileText,
  edit: Pencil,
  schedule: Clock,
  memory: Brain,
  ask: Shield,
  think: Sparkles,
  name: UserCircle,
  warning: AlertTriangle
}

/**
 * One activity chip (C3): an icon, a few words and the highlighted part. A live chip's icon spins. A chip of a thread the
 * bot started, messaged or stopped reads "started thread · <title>" and offers Open, which shows that thread; its tooltip
 * is the first line of what the bot sent there.
 */
export function BotChipView({ chip }: { chip: BotChip }) {
  const Icon = CHIP_ICONS[chip.icon] ?? Sparkles
  const thread = chip.thread
  const tip = chip.said ? `Sent: ${chip.said}` : chip.title
  return <span className={`bot-chip${chip.live ? ' is-live' : ''}`} {...(tip ? { title: tip } : {})}>
    <Icon size={13} aria-hidden />{chip.text}{chip.highlight && <>{thread ? ' · ' : ' '}<b>{chip.highlight}</b></>}
    {thread && <button type="button" className="bot-chip-open" title="Open this thread" onClick={() => openThread(thread)}>Open</button>}
  </span>
}

/** The chip row under a bot's message. Never a tool log: only what Mousse wrote as chips. */
export function BotChips({ chips }: { chips: readonly BotChip[] }) {
  if (!chips.length) return null
  return <div className="bot-chips">{chips.map((chip, index) => <BotChipView key={`${index}:${chip.icon}:${chip.text}`} chip={chip} />)}</div>
}
