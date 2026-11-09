import { useId, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { Shuffle } from 'lucide-react'
import {
  BOT_ACCESSORIES,
  BOT_ACCESSORY_LABELS,
  BOT_COLOUR_HEX,
  BOT_COLOURS,
  BOT_EYES,
  BOT_EYES_LABELS,
  BOT_KIND_LABELS,
  BOT_KINDS,
  botEyesOf,
  botKindOf,
  normalizeBotLook,
  withKindAndEyes,
  type BotLook,
  type KnownBotLook
} from '../../../../shared/bots/personal/look'
import { BotFace } from './BotFace'
import './face.css'

/**
 * Picks a bot's look (bot-ui §4.2): a large live preview with Shuffle under it, the character
 * (mouse or Mousse), the eight colours, the eight eye shapes and the 12 accessories, each shown on
 * the chosen character in the chosen colour. Unknown stored values show, and are picked, as the
 * default.
 */
export interface BotLookPickerProps {
  look: BotLook
  onChange(look: KnownBotLook): void
  /** The owner's other bots' looks; Shuffle prefers looks none of them wear. */
  existingLooks?: readonly BotLook[]
  className?: string
}

const PREVIEW_SIZE = 112
const THUMB_SIZE = 40

export const BOT_COLOUR_LABELS: Record<(typeof BOT_COLOURS)[number], string> = {
  coral: 'Coral',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
  teal: 'Teal',
  blue: 'Blue',
  purple: 'Purple',
  pink: 'Pink'
}

/**
 * A random colour and accessory other than `current`'s, among the looks `existing` doesn't wear
 * while any is free. The character and eyes stay as picked.
 */
export function shuffleLook(current: BotLook, existing: readonly BotLook[] = [], random: () => number = Math.random): KnownBotLook {
  const now = normalizeBotLook(current)
  const worn = new Set(existing.map((look) => normalizeBotLook(look)).map((look) => `${look.colour}/${look.accessory}`))
  const all = BOT_COLOURS.flatMap((colour) => BOT_ACCESSORIES.map((accessory) => ({ colour, accessory })))
  const others = all.filter((look) => look.colour !== now.colour || look.accessory !== now.accessory)
  const free = others.filter((look) => !worn.has(`${look.colour}/${look.accessory}`))
  const pool = free.length > 0 ? free : others
  const pick = pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))]!
  return withKindAndEyes(pick, botKindOf(now), botEyesOf(now))
}

/** The look in words, for the preview's accessible name: "Purple Mousse with heart eyes and glasses". */
export function lookLabel(look: KnownBotLook): string {
  const kind = botKindOf(look)
  const eyes = botEyesOf(look)
  const extras = [
    ...(eyes !== 'pill' ? [`${BOT_EYES_LABELS[eyes].toLowerCase()} eyes`] : []),
    ...(look.accessory !== 'none' ? [BOT_ACCESSORY_LABELS[look.accessory].toLowerCase()] : [])
  ]
  const noun = kind === 'mousse' ? BOT_KIND_LABELS.mousse : BOT_KIND_LABELS.mouse.toLowerCase()
  return `${BOT_COLOUR_LABELS[look.colour]} ${noun}${extras.length > 0 ? ` with ${extras.join(' and ')}` : ''}`
}

export function BotLookPicker({ look, onChange, existingLooks = [], className }: BotLookPickerProps) {
  const current = normalizeBotLook(look)
  const id = useId()
  const kind = botKindOf(current)
  const eyes = botEyesOf(current)
  const previewLabel = lookLabel(current)
  return (
    <div className={`bot-look-picker${className ? ` ${className}` : ''}`}>
      <div className="bot-look-picker__preview">
        <BotFace look={current} state="idle" size={PREVIEW_SIZE} view="full" label={previewLabel} />
        <button type="button" className="btn btn-ghost btn-sm bot-look-picker__shuffle" onClick={() => onChange(shuffleLook(current, existingLooks))}>
          <Shuffle size={14} aria-hidden />
          Shuffle
        </button>
      </div>
      <div className="bot-look-picker__options">
        <div className="bot-look-picker__label" id={`${id}-kind`}>Character</div>
        <RadioRow
          className="bot-look-picker__kinds"
          labelledBy={`${id}-kind`}
          options={BOT_KINDS}
          selected={kind}
          onSelect={(next) => onChange(withKindAndEyes(current, next, eyes))}
          render={(next) => ({
            label: BOT_KIND_LABELS[next],
            className: 'bot-look-picker__accessory',
            content: (
              <>
                <BotFace look={withKindAndEyes(current, next, eyes)} state="idle" size={THUMB_SIZE} view="head" still />
                <span>{BOT_KIND_LABELS[next]}</span>
              </>
            )
          })}
        />
        <div className="bot-look-picker__label" id={`${id}-colour`}>Colour</div>
        <RadioRow
          className="bot-look-picker__colours"
          labelledBy={`${id}-colour`}
          options={BOT_COLOURS}
          selected={current.colour}
          onSelect={(colour) => onChange({ ...current, colour })}
          render={(colour) => ({
            label: BOT_COLOUR_LABELS[colour],
            className: 'bot-look-picker__swatch',
            style: { background: BOT_COLOUR_HEX[colour] },
            content: null
          })}
        />
        <div className="bot-look-picker__label" id={`${id}-eyes`}>Eyes</div>
        <RadioRow
          className="bot-look-picker__eyes"
          labelledBy={`${id}-eyes`}
          options={BOT_EYES}
          selected={eyes}
          onSelect={(next) => onChange(withKindAndEyes(current, kind, next))}
          render={(next) => ({
            label: `${BOT_EYES_LABELS[next]} eyes`,
            className: 'bot-look-picker__accessory',
            content: (
              <>
                <BotFace look={withKindAndEyes(current, kind, next)} state="idle" size={THUMB_SIZE} view="head" still />
                <span>{BOT_EYES_LABELS[next]}</span>
              </>
            )
          })}
        />
        <div className="bot-look-picker__label" id={`${id}-accessory`}>Accessory</div>
        <RadioRow
          className="bot-look-picker__accessories"
          labelledBy={`${id}-accessory`}
          options={BOT_ACCESSORIES}
          selected={current.accessory}
          onSelect={(accessory) => onChange({ ...current, accessory })}
          render={(accessory) => ({
            label: BOT_ACCESSORY_LABELS[accessory],
            className: 'bot-look-picker__accessory',
            content: (
              <>
                <BotFace look={{ ...current, accessory }} state="idle" size={THUMB_SIZE} view="head" still />
                <span>{BOT_ACCESSORY_LABELS[accessory]}</span>
              </>
            )
          })}
        />
      </div>
    </div>
  )
}

interface RadioRowProps<T extends string> {
  className: string
  labelledBy: string
  options: readonly T[]
  selected: T
  onSelect(option: T): void
  render(option: T): { label: string; className: string; style?: CSSProperties; content: ReactNode }
}

/** A radio group of buttons: one tab stop, arrow keys move and pick. */
function RadioRow<T extends string>({ className, labelledBy, options, selected, onSelect, render }: RadioRowProps<T>) {
  const ref = useRef<HTMLDivElement>(null)
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
    if (step === 0) return
    event.preventDefault()
    const next = options[(options.indexOf(selected) + step + options.length) % options.length]!
    onSelect(next)
    ref.current?.querySelector<HTMLButtonElement>(`[data-value="${next}"]`)?.focus()
  }
  return (
    <div ref={ref} className={className} role="radiogroup" aria-labelledby={labelledBy} onKeyDown={onKeyDown}>
      {options.map((option) => {
        const item = render(option)
        const checked = option === selected
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={item.label}
            title={item.label}
            tabIndex={checked ? 0 : -1}
            data-value={option}
            className={item.className}
            style={item.style}
            onClick={() => onSelect(option)}
          >
            {item.content}
          </button>
        )
      })}
    </div>
  )
}
