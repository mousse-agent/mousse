/**
 * A bot's look (Bot Phase 1 §5.1.1, bot-ui §4.3): a clay mouse, or a Mousse (the app logo as a
 * character), in one of 8 colours wearing one of 12 accessories, with one of 8 eye shapes. Browser-safe. The accessory order matches `ACCS` in the face shader reference
 * (`docs/plans/mockups/bot-ui/source/mice3d/mice.html`), so an accessory's index is the shader's `uAcc`.
 */

export const BOT_COLOURS = ['coral', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'] as const
export const BOT_ACCESSORIES = ['none', 'headphones', 'glasses', 'beret', 'goggles', 'beanie', 'cap', 'crown', 'bow_tie', 'scarf', 'chef_hat', 'hood'] as const
/** The character: the clay mouse, or the Mousse logo (mousse in a goblet, its top tapering into a curled whip). */
export const BOT_KINDS = ['mouse', 'mousse'] as const
/** Eye shapes, in the face shader's `uK.y` order. `pill` is the original eye. */
export const BOT_EYES = ['pill', 'round', 'dot', 'tall', 'square', 'heart', 'star', 'code'] as const
export type BotColour = (typeof BOT_COLOURS)[number]
export type BotAccessory = (typeof BOT_ACCESSORIES)[number]
export type BotKind = (typeof BOT_KINDS)[number]
export type BotEyes = (typeof BOT_EYES)[number]
/** Eye colours. A look without one shows the colour that stands out on its body (`defaultEyeColour`). */
export const BOT_EYE_COLOURS = ['black', 'white'] as const
export type BotEyeColour = (typeof BOT_EYE_COLOURS)[number]

/** Stored as plain strings so later builds can add looks; unknown values read as the default. */
export interface BotLook {
  colour: string
  accessory: string
  /** Missing means the mouse, so looks from before kinds existed read unchanged. */
  kind?: string
  /** Missing means the pill eyes. */
  eyes?: string
  /** Missing means the default for the character and colour. */
  eyeColour?: string
}

/** A look whose values this build knows. */
export interface KnownBotLook {
  colour: BotColour
  accessory: BotAccessory
  /** Present only when not the mouse. */
  kind?: BotKind
  /** Present only when not the pill eyes. */
  eyes?: BotEyes
  /** Present only when picked. */
  eyeColour?: BotEyeColour
}

export const DEFAULT_BOT_LOOK: KnownBotLook = { colour: 'coral', accessory: 'none' }

/** Body colours, as the shader draws them: bold, saturated colours that stay bright on a true-dark page. */
export const BOT_COLOUR_HEX: Record<BotColour, string> = {
  coral: '#ff5245',
  orange: '#ff7414',
  yellow: '#ffc414',
  green: '#22d36f',
  teal: '#00b8a3',
  blue: '#2b74ff',
  purple: '#9150ff',
  pink: '#ff3d9e'
}

/** Each accessory's own colour (none has none). */
export const BOT_ACCESSORY_HEX: Record<BotAccessory, string | null> = {
  none: null,
  headphones: '#232327',
  glasses: '#1c1c1f',
  beret: '#232326',
  goggles: '#7a4a2e',
  beanie: '#8e8a86',
  cap: '#2b3f6e',
  crown: '#e8b931',
  bow_tie: '#1e1e22',
  scarf: '#b8323f',
  chef_hat: '#f3f1ec',
  hood: '#8f939c'
}

export const BOT_KIND_LABELS: Record<BotKind, string> = { mouse: 'Mouse', mousse: 'Mousse' }

/** Eye shapes in plain words, for the picker and labels. */
export const BOT_EYES_LABELS: Record<BotEyes, string> = {
  pill: 'Pill',
  round: 'Round',
  dot: 'Dot',
  tall: 'Tall',
  square: 'Square',
  heart: 'Heart',
  star: 'Star',
  code: 'Code'
}

export const BOT_EYE_COLOUR_LABELS: Record<BotEyeColour, string> = { black: 'Black', white: 'White' }

/** Accessory names in plain words, for the picker and labels. */
export const BOT_ACCESSORY_LABELS: Record<BotAccessory, string> = {
  none: 'None',
  headphones: 'Headphones',
  glasses: 'Glasses',
  beret: 'Beret',
  goggles: 'Goggles',
  beanie: 'Beanie',
  cap: 'Cap',
  crown: 'Crown',
  bow_tie: 'Bow tie',
  scarf: 'Scarf',
  chef_hat: 'Chef hat',
  hood: 'Hood'
}

const isColour = (value: unknown): value is BotColour => (BOT_COLOURS as readonly unknown[]).includes(value)
const isAccessory = (value: unknown): value is BotAccessory => (BOT_ACCESSORIES as readonly unknown[]).includes(value)
const isKind = (value: unknown): value is BotKind => (BOT_KINDS as readonly unknown[]).includes(value)
const isEyes = (value: unknown): value is BotEyes => (BOT_EYES as readonly unknown[]).includes(value)
const isEyeColour = (value: unknown): value is BotEyeColour => (BOT_EYE_COLOURS as readonly unknown[]).includes(value)

/**
 * The look this build draws: each unknown or missing value becomes the default (coral, none, the
 * mouse, pill eyes). `kind` and `eyes` are kept only when they differ from the default.
 */
export function normalizeBotLook(look: Partial<BotLook> | null | undefined): KnownBotLook {
  const known: KnownBotLook = {
    colour: isColour(look?.colour) ? look.colour : DEFAULT_BOT_LOOK.colour,
    accessory: isAccessory(look?.accessory) ? look.accessory : DEFAULT_BOT_LOOK.accessory
  }
  if (isKind(look?.kind) && look.kind !== 'mouse') known.kind = look.kind
  if (isEyes(look?.eyes) && look.eyes !== 'pill') known.eyes = look.eyes
  if (isEyeColour(look?.eyeColour)) known.eyeColour = look.eyeColour
  return known
}

/** The look's character; looks without one are mice. */
export const botKindOf = (look: Pick<KnownBotLook, 'kind'>): BotKind => look.kind ?? 'mouse'
/** The look's eye shape; looks without one have pill eyes. */
export const botEyesOf = (look: Pick<KnownBotLook, 'eyes'>): BotEyes => look.eyes ?? 'pill'

/**
 * Whether white eyes stand out better than black on a body of `hex`: the Mousse's colour at eye height is about
 * 0.89 of it, and white wins when that colour's relative luminance is under 0.3.
 */
export function whiteEyesSuit(hex: string): boolean {
  const lin = [1, 3, 5].map((i) => {
    const c = (parseInt(hex.slice(i, i + 2), 16) / 255) * 0.89
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]! < 0.3
}

/** The eye colour a look shows when none is picked: the mouse's are black; the Mousse's stand out on its colour. */
export function defaultEyeColour(look: Pick<KnownBotLook, 'colour' | 'kind'>): BotEyeColour {
  return botKindOf(look) === 'mousse' && whiteEyesSuit(BOT_COLOUR_HEX[look.colour]) ? 'white' : 'black'
}

/** The look's eye colour: the picked one, or the default. */
export const botEyeColourOf = (look: Pick<KnownBotLook, 'colour' | 'kind' | 'eyeColour'>): BotEyeColour => look.eyeColour ?? defaultEyeColour(look)

/**
 * A look in a few plain words, as the bot says it of itself: "a blue mouse with headphones and black round eyes". A
 * Mousse is the app logo as a character, so it is named so.
 */
export function botLookWords(look: KnownBotLook): string {
  const kind = botKindOf(look) === 'mousse' ? 'Mousse (the app logo as a character: mousse in a goblet)' : 'mouse'
  const accessory = look.accessory === 'none' ? '' : ` with ${look.accessory === 'glasses' || look.accessory === 'goggles' || look.accessory === 'headphones' ? '' : 'a '}${BOT_ACCESSORY_LABELS[look.accessory].toLowerCase()}`
  const eyes = `${botEyeColourOf(look)} ${BOT_EYES_LABELS[botEyesOf(look)].toLowerCase()} eyes`
  return `${/^[aeiou]/.test(look.colour) ? 'an' : 'a'} ${look.colour} ${kind}${accessory} ${accessory ? 'and' : 'with'} ${eyes}`
}

/** Only the fields a look stores (colour, accessory, and kind, eyes and eye colour when given). */
export function lookFields(look: BotLook): BotLook {
  return {
    colour: look.colour,
    accessory: look.accessory,
    ...(look.kind !== undefined ? { kind: look.kind } : {}),
    ...(look.eyes !== undefined ? { eyes: look.eyes } : {}),
    ...(look.eyeColour !== undefined ? { eyeColour: look.eyeColour } : {})
  }
}

/** `look` with `kind` and `eyes` set, dropping either when it is the default. */
export function withKindAndEyes(look: KnownBotLook, kind: BotKind, eyes: BotEyes): KnownBotLook {
  const { kind: _kind, eyes: _eyes, ...rest } = look
  return { ...rest, ...(kind !== 'mouse' ? { kind } : {}), ...(eyes !== 'pill' ? { eyes } : {}) }
}

/** The values of `options` with the fewest `count`s; ties are broken by `random`. */
function leastUsed<T>(options: readonly T[], count: (option: T) => number, random: () => number): T {
  let fewest = Infinity
  let tied: T[] = []
  for (const option of options) {
    const n = count(option)
    if (n < fewest) {
      fewest = n
      tied = [option]
    } else if (n === fewest) tied.push(option)
  }
  return tied[Math.min(tied.length - 1, Math.max(0, Math.floor(random() * tied.length)))]!
}

/**
 * A look for a new bot that the owner's other bots don't wear yet: the least-used accessory among
 * `existing`, then the colour least used with that accessory (so no two bots match while any of the
 * 96 looks is free), then the least-used colour overall. Ties are broken by `random`.
 */
export function pickDistinctLook(existing: readonly BotLook[], random: () => number = Math.random): KnownBotLook {
  const looks = existing.map(normalizeBotLook)
  const accessory = leastUsed(BOT_ACCESSORIES, (option) => looks.filter((look) => look.accessory === option).length, random)
  const same = looks.filter((look) => look.accessory === accessory)
  const colour = leastUsed(
    BOT_COLOURS,
    // Exact matches weigh more than any overall count can: an unused look always wins.
    (option) => same.filter((look) => look.colour === option).length * (looks.length + 1) + looks.filter((look) => look.colour === option).length,
    random
  )
  return { colour, accessory }
}
