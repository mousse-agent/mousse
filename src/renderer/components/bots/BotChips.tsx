import { AlertTriangle, Brain, Clock, FileText, Globe, Pencil, Search, Shield, Sparkles, UserCircle } from '../../lib/icons'
import type { BotChip, BotChipIcon } from '../../../shared/bots/personal/chat'

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

/** One activity chip (C3): an icon, a few words and the highlighted part. A live chip's icon spins. */
export function BotChipView({ chip }: { chip: BotChip }) {
  const Icon = CHIP_ICONS[chip.icon] ?? Sparkles
  return <span className={`bot-chip${chip.live ? ' is-live' : ''}`}>
    <Icon size={13} aria-hidden />{chip.text}{chip.highlight && <> <b>{chip.highlight}</b></>}
  </span>
}

/** The chip row under a bot's message. Never a tool log: only what Mousse wrote as chips. */
export function BotChips({ chips }: { chips: readonly BotChip[] }) {
  if (!chips.length) return null
  return <div className="bot-chips">{chips.map((chip, index) => <BotChipView key={`${index}:${chip.icon}:${chip.text}`} chip={chip} />)}</div>
}
