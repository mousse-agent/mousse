import { useId, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { Shuffle } from 'lucide-react'
import {
  BOT_ACCESSORIES,
  BOT_ACCESSORY_LABELS,
  BOT_COLOUR_HEX,
  BOT_COLOURS,
  normalizeBotLook,
  type BotLook,
  type KnownBotLook
} from '../../../../shared/bots/personal/look'
import { BotFace } from './BotFace'
import './face.css'

/**
 * Picks a bot's look (bot-ui §4.2): a large live preview with Shuffle under it, the eight colours
 * and the 12 accessories, each shown on the mouse in the chosen colour. Unknown stored values
 * show, and are picked, as the default.
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

/** A random look other than `current`, among the looks `existing` doesn't wear while any is free. */
export function shuffleLook(current: BotLook, existing: readonly BotLook[] = [], random: () => number = Math.random): KnownBotLook {
  const now = normalizeBotLook(current)
  const worn = new Set(existing.map((look) => normalizeBotLook(look)).map((look) => `${look.colour}/${look.accessory}`))
  const all = BOT_COLOURS.flatMap((colour) => BOT_ACCESSORIES.map((accessory) => ({ colour, accessory })))
  const others = all.filter((look) => look.colour !== now.colour || look.accessory !== now.accessory)
  const free = others.filter((look) => !worn.has(`${look.colour}/${look.accessory}`))
  const pool = free.length > 0 ? free : others
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))]!
}

export function BotLookPicker({ look, onChange, existingLooks = [], className }: BotLookPickerProps) {
  const current = normalizeBotLook(look)
  const id = useId()
  const colourName = BOT_COLOUR_LABELS[current.colour]
  const accessoryName = BOT_ACCESSORY_LABELS[current.accessory]
  const previewLabel = current.accessory === 'none' ? `${colourName} mouse` : `${colourName} mouse with ${accessoryName.toLowerCase()}`
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
                <BotFace look={{ colour: current.colour, accessory }} state="idle" size={THUMB_SIZE} view="head" still />
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
