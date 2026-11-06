import { RefreshCw } from '../../../lib/icons'
import { BOT_ACCESSORIES, BOT_ACCESSORY_LABELS, BOT_COLOURS, BOT_COLOUR_HEX, normalizeBotLook, type BotLook } from '../../../../shared/bots/personal/look'
import { BotFace } from './BotFace'

/**
 * Picks a bot's look (bot-ui §4.2): a large preview with Shuffle, the eight colours and the 12
 * accessories, each shown on the mouse. Unknown stored values show as the default.
 * TODO(WP5): this is WP4's stand-in on the still face; WP5's picker replaces it with the same props.
 */
export interface BotLookPickerProps {
  look: BotLook
  onChange(look: BotLook): void
  /** The owner's other bots' looks; Shuffle avoids them while any look is free. */
  existingLooks?: readonly BotLook[]
}

const title = (word: string) => word.charAt(0).toUpperCase() + word.slice(1)

export function BotLookPicker({ look, onChange, existingLooks = [] }: BotLookPickerProps) {
  const known = normalizeBotLook(look)
  const shuffle = () => {
    const taken = new Set(existingLooks.map((entry) => { const k = normalizeBotLook(entry); return `${k.colour}/${k.accessory}` }))
    const all = BOT_COLOURS.flatMap((colour) => BOT_ACCESSORIES.map((accessory) => ({ colour, accessory })))
    const others = all.filter((entry) => entry.colour !== known.colour || entry.accessory !== known.accessory)
    const free = others.filter((entry) => !taken.has(`${entry.colour}/${entry.accessory}`))
    const pool = free.length ? free : others
    onChange(pool[Math.floor(Math.random() * pool.length)]!)
  }
  return <div className="bot-new-face">
    <div className="bot-new-preview">
      <BotFace look={known} state="idle" size={104} view="full" label="Preview" />
      <button type="button" className="bot-shuffle" onClick={shuffle}><RefreshCw size={13} aria-hidden="true" />Shuffle</button>
    </div>
    <div>
      <span className="bot-new-label" id="bot-look-colour">Colour</span>
      <div className="bot-tones" role="radiogroup" aria-labelledby="bot-look-colour">
        {BOT_COLOURS.map((colour) => <button key={colour} type="button" role="radio" aria-checked={colour === known.colour} aria-label={title(colour)} title={title(colour)}
          className={`bot-tone${colour === known.colour ? ' is-picked' : ''}`} style={{ background: BOT_COLOUR_HEX[colour] }} onClick={() => onChange({ ...known, colour })} />)}
      </div>
      <span className="bot-new-label bot-new-label-gap" id="bot-look-accessory">Accessory</span>
      <div className="bot-shape-grid" role="radiogroup" aria-labelledby="bot-look-accessory">
        {BOT_ACCESSORIES.map((accessory) => <button key={accessory} type="button" role="radio" aria-checked={accessory === known.accessory} aria-label={BOT_ACCESSORY_LABELS[accessory]} title={BOT_ACCESSORY_LABELS[accessory]}
          className={accessory === known.accessory ? 'is-picked' : ''} onClick={() => onChange({ ...known, accessory })}>
          <BotFace look={{ colour: known.colour, accessory }} state="idle" size={40} view="head" still />
        </button>)}
      </div>
    </div>
  </div>
}
