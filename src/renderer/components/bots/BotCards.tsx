import type { ReactNode } from 'react'
import { Circle, CircleCheck, CircleDotDashed, CircleMinus } from '../../lib/icons'
import type { BotChatCard } from '../../../shared/bots/personal/chat'
import type { BotChecklistCard, BotChecklistState, BotChatGalleryCard, BotFactsCard, BotProgressCard } from '../../../shared/bots/personal/cards'
import { BotLink, KeyValueRows } from './BotFiles'
import { BotReplyMedia } from './BotReplyMedia'
import type { ReplyImage } from './botReplyImages'

/**
 * The cards on a bot's message (`show_card`, issue #1123), each drawn from the app's own components: the bot sends text
 * and numbers only, never HTML, style or script. Facts look as a reply's list of bold keys does; a gallery shows its
 * pictures as a reply's pictures, with the same preview. An unknown card is left out.
 */

/**
 * A fact's value: its words, with only links, **bold** and `code` drawn, as the bot was told. Anything else stays as
 * written.
 */
export function CardValue({ text }: { text: string }) {
  const parts: ReactNode[] = []
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g
  let at = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > at) parts.push(text.slice(at, index))
    const key = `${index}`
    if (match[1] !== undefined) parts.push(<code key={key} className="an-md-code">{match[1]}</code>)
    else if (match[2] !== undefined) parts.push(<strong key={key}>{match[2]}</strong>)
    else parts.push(<BotLink key={key} href={match[4]}>{match[3]}</BotLink>)
    at = index + match[0].length
  }
  if (at < text.length) parts.push(text.slice(at))
  return <>{parts}</>
}

function FactsCard({ card }: { card: BotFactsCard }) {
  return <KeyValueRows title={card.title} rows={card.rows.map((row, index) => ({ key: index, label: row.label, value: <CardValue text={row.value} /> }))} />
}

const CHECK_ICON: Record<BotChecklistState, typeof Circle> = { done: CircleCheck, doing: CircleDotDashed, todo: Circle, skipped: CircleMinus }
const CHECK_LABEL: Record<BotChecklistState, string> = { done: 'Done', doing: 'In progress', todo: 'To do', skipped: 'Skipped' }

function ChecklistCard({ card }: { card: BotChecklistCard }) {
  return <section className="bot-card bot-checklist" aria-label={card.title ?? 'Checklist'}>
    {card.title && <p className="bot-card-title">{card.title}</p>}
    <ul>
      {card.items.map((item, index) => {
        const Icon = CHECK_ICON[item.state]
        return <li key={index} className={`is-${item.state}`}>
          <Icon size={15} aria-hidden />
          <span><span className="sr-only">{CHECK_LABEL[item.state]}: </span>{item.text}</span>
        </li>
      })}
    </ul>
  </section>
}

function ProgressCard({ card }: { card: BotProgressCard }) {
  const share = card.total > 0 ? Math.min(1, Math.max(0, card.done / card.total)) : 0
  return <section className="bot-card bot-progress" aria-label={card.label}>
    <p className="bot-progress-head"><span className="bot-progress-label">{card.label}</span><span className="bot-progress-count">{card.done} of {card.total}</span></p>
    <div className="bot-progress-track" role="progressbar" aria-label={card.label} aria-valuemin={0} aria-valuemax={card.total} aria-valuenow={card.done}>
      <div className="bot-progress-fill" style={{ width: `${(share * 100).toFixed(1)}%` }} />
    </div>
    {card.note && <p className="bot-progress-note">{card.note}</p>}
  </section>
}

function GalleryCard({ card }: { card: BotChatGalleryCard }) {
  const images: ReplyImage[] = card.files.map((file) => ({ key: file.path, path: file.path, name: file.caption ?? file.name }))
  return <section className="bot-card bot-gallery" aria-label={card.title ?? 'Pictures'}>
    {card.title && <p className="bot-card-title">{card.title}</p>}
    <BotReplyMedia images={images} />
  </section>
}

/** A message's cards, in the order the bot made them. */
export function BotCards({ cards }: { cards: readonly BotChatCard[] }) {
  if (!cards.length) return null
  return <div className="bot-cards">
    {cards.map((card, index) => {
      if (card.type === 'facts') return <FactsCard key={index} card={card} />
      if (card.type === 'checklist') return <ChecklistCard key={index} card={card} />
      if (card.type === 'progress') return <ProgressCard key={index} card={card} />
      if (card.type === 'gallery') return <GalleryCard key={index} card={card} />
      return null
    })}
  </div>
}

/** The paths a message's galleries show, which its own picture strip leaves to them. */
export function galleryPaths(cards: readonly BotChatCard[] | undefined): ReadonlySet<string> {
  return new Set((cards ?? []).flatMap((card) => (card.type === 'gallery' ? card.files.map((file) => file.path) : [])))
}
