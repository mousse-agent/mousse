import {
  BOT_DEPTHS,
  BOT_MODEL_SLOT_KEYS,
  BOT_WORK_LEVELS,
  DEPTH_LEVEL,
  LEVEL_DEPTH,
  MAX_BOT_MODEL_CHARS,
  type BotActivationTrigger,
  type BotDepth,
  type BotLane,
  type BotModelChoice,
  type BotModelOverride,
  type BotModelPick,
  type BotModelSlotKey,
  type BotModelSlots,
  type BotPickCredential,
  type BotThreadSpec,
  type BotWorkLevel
} from './definition'

/**
 * A bot's models by situation (#673): Talk for the chat, and Light, Medium and Hard work for the run lane, each a model
 * the owner picked on one provider entry. Pure and browser-safe: the daemon resolves a turn's row here, and Runs on
 * reads the same rows.
 *
 * Format 2 keeps `main.model` as it was, so older builds read every bot. While a row holds a pick, `main.model` is a
 * mirror older builds run every turn on, and `main.slots` holds the rows. Once an older build rewrites `main.model`, the
 * rows are stale and dropped: `main.model` is the truth again, as for a bot made before rows existed.
 */

/** Every row "Mousse chooses": a bot from before picks. */
export const UNPICKED_SLOTS: Readonly<BotModelSlots> = Object.freeze({ talk: null, light: null, medium: null, hard: null })

/** The Work rows, Light first. */
export const WORK_SLOT_KEYS: readonly BotWorkLevel[] = BOT_WORK_LEVELS

/** A row the owner picked on an entry, as opposed to "Mousse chooses" (null) or a model by name from an older bot. */
export function isPinned(pick: BotModelPick | null | undefined): pick is BotModelPick & { instanceId: string } {
  return Boolean(pick?.instanceId)
}

/** Every row picked on an entry: a picked bot, which never goes back to Mousse choosing. */
export function allPinned(slots: BotModelSlots): boolean {
  return BOT_MODEL_SLOT_KEYS.every((key) => isPinned(slots[key]))
}

/** The same choice: entry, model and reasoning level (what the sign-in was is the daemon's to check). */
export function samePick(a: BotModelPick | null | undefined, b: BotModelPick | null | undefined): boolean {
  if (!a || !b) return !a && !b
  return a.model === b.model && (a.instanceId ?? '') === (b.instanceId ?? '') && (a.effort ?? '') === (b.effort ?? '')
}

/** One pick on every row: the simple view with Talk and Work on the same model. */
export function slotsAllOn(pick: BotModelPick | null): BotModelSlots {
  return { talk: pick, light: pick, medium: pick, hard: pick }
}

/** Whether the Work rows differ, which shows the picker's Advanced view: Light or Hard is not Medium. */
export function workRowsDiffer(slots: BotModelSlots): boolean {
  return !samePick(slots.light, slots.medium) || !samePick(slots.hard, slots.medium)
}

/**
 * The mark on the mirror `withSlots` writes: a space after the model's name. Older builds trim a name before they match
 * it, so they run the mirror as that model, and trim every name they write, so they never write the mark. A mirror
 * without it was written by an older build: the rows beside it are stale, even when that build later wrote the same
 * model again.
 */
const MIRROR_MARK = ' '

/**
 * What `main.model` says when the rows are `slots`, at the standing depth: with a pick on an entry, its model by name
 * and marked (Talk's, else Medium work's, else the first); without one, the Talk row as an older build wrote it.
 */
export function mirrorOf(slots: BotModelSlots, depth: BotDepth): BotModelChoice {
  const pinned = (['talk', 'medium', 'light', 'hard'] as const).map((key) => slots[key]).find(isPinned)
  if (pinned) return { mode: 'named', model: `${pinned.model.trim().slice(0, MAX_BOT_MODEL_CHARS - MIRROR_MARK.length)}${MIRROR_MARK}`, depth }
  return slots.talk ? { mode: 'named', model: slots.talk.model, depth } : { mode: 'auto', depth }
}

const sameChoice = (a: BotModelChoice, b: BotModelChoice) => a.mode === b.mode && (a.mode === 'auto' || (b.mode === 'named' && a.model === b.model))

/** `spec.slots` as rows when every known row is there and readable, and `main.model` is still their mirror. */
function liveSlots(spec: Pick<BotThreadSpec, 'model' | 'slots'>): BotModelSlots | undefined {
  const rows = readSlots(spec.slots)
  return rows && sameChoice(mirrorOf(rows, spec.model.depth), spec.model) ? rows : undefined
}

/**
 * A thread's rows, upgraded on read: the written rows while `main.model` is still their mirror; otherwise `main.model`
 * on every row (Mousse choosing, or one model by name, matched across entries as before).
 */
export function slotsOf(spec: Pick<BotThreadSpec, 'model' | 'slots'>): BotModelSlots {
  return liveSlots(spec) ?? slotsAllOn(spec.model.mode === 'named' ? { model: spec.model.model.trim() } : null)
}

/**
 * The thread with `slots` as its rows: `model` mirrors them at the same standing depth, and `slots` is left out when
 * `model` alone says the same (every row Mousse choosing, or one model by name). Rows a later build added are kept.
 */
export function withSlots<T extends Pick<BotThreadSpec, 'model' | 'slots'>>(spec: T, slots: BotModelSlots): T {
  const model = mirrorOf(slots, spec.model.depth)
  const { slots: old, ...rest } = spec
  const pinned = BOT_MODEL_SLOT_KEYS.some((key) => isPinned(slots[key]))
  const plain = !pinned && BOT_MODEL_SLOT_KEYS.every((key) => samePick(slots[key], slots.talk)) && !slots.talk?.effort
  if (plain) return { ...rest, model } as T
  const later = liveSlots(spec) ? Object.fromEntries(Object.entries(old as object).filter(([key]) => !(BOT_MODEL_SLOT_KEYS as readonly string[]).includes(key))) : {}
  return { ...rest, model, slots: { ...later, ...copySlots(slots) } } as T
}

/** A pick with only the fields this build knows. */
export function copyPick(pick: BotModelPick): BotModelPick {
  return {
    ...(pick.instanceId ? { instanceId: pick.instanceId } : {}),
    model: pick.model,
    ...(pick.effort ? { effort: pick.effort } : {}),
    ...(pick.credential ? { credential: pick.credential } : {}),
    ...(pick.account ? { account: pick.account } : {})
  }
}

/** A pick as a client sees it: entry, model and reasoning level, without what the daemon remembers of the sign-in. */
export function shownPick(pick: BotModelPick | null): BotModelPick | null {
  return pick ? { ...(pick.instanceId ? { instanceId: pick.instanceId } : {}), model: pick.model, ...(pick.effort ? { effort: pick.effort } : {}) } : null
}

function copySlots(slots: BotModelSlots): BotModelSlots {
  const copy = (pick: BotModelPick | null) => (pick ? copyPick(pick) : null)
  return { talk: copy(slots.talk), light: copy(slots.light), medium: copy(slots.medium), hard: copy(slots.hard) }
}

const CLIENT_PICK_KEYS = new Set(['instanceId', 'model', 'effort'])
const CREDENTIALS: readonly BotPickCredential[] = ['subscription', 'api_key', 'ambient']
const shortText = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max

/**
 * Why `value` is not one pick, or undefined. `client`: a pick a method takes, which is always on an entry and carries
 * only the entry, the model and a reasoning level. Otherwise a stored one: fields a later build added are ignored.
 */
export function modelPickProblem(value: unknown, options: { client?: boolean } = {}): string | undefined {
  const pick = value as Record<string, unknown> | null
  if (!pick || typeof pick !== 'object' || Array.isArray(pick)) return 'A model is an entry, a model and a reasoning level.'
  if (options.client && Object.keys(pick).some((key) => !CLIENT_PICK_KEYS.has(key))) return 'A model is an entry, a model and a reasoning level.'
  if (!shortText(pick.model, MAX_BOT_MODEL_CHARS)) return `A model is a name of 1 to ${MAX_BOT_MODEL_CHARS} characters.`
  if (options.client && pick.instanceId === undefined) return 'Pick a model on one of your provider entries.'
  if (pick.instanceId !== undefined && !shortText(pick.instanceId, 200)) return 'An entry is an id of 1 to 200 characters.'
  if (pick.effort !== undefined && !shortText(pick.effort, 40)) return 'A reasoning level is a word of 1 to 40 characters.'
  if (pick.credential !== undefined && !CREDENTIALS.includes(pick.credential as BotPickCredential)) return 'A model\'s sign-in is unreadable.'
  if (pick.account !== undefined && !shortText(pick.account, 128)) return 'A model\'s account is unreadable.'
  return undefined
}

/**
 * Why a definition's rows are unreadable, or undefined. A row this build does not know is ignored, so a later build can
 * add one; a known row must be null or a pick. A known row that is missing makes the rows unreadable to `slotsOf`
 * (`main.model` is read instead) but is not refused.
 */
export function modelSlotsProblem(value: unknown): string | undefined {
  const slots = value as Record<string, unknown> | null
  if (!slots || typeof slots !== 'object' || Array.isArray(slots)) return 'The models are Talk, Light, Medium and Hard work.'
  for (const key of BOT_MODEL_SLOT_KEYS) {
    if (slots[key] === undefined || slots[key] === null) continue
    const problem = modelPickProblem(slots[key])
    if (problem) return problem
  }
  return undefined
}

/** The known rows of `value`, when each of them is there and readable. */
function readSlots(value: unknown): BotModelSlots | undefined {
  if (value === undefined || modelSlotsProblem(value)) return undefined
  const slots = value as Record<string, BotModelPick | null | undefined>
  if (BOT_MODEL_SLOT_KEYS.some((key) => slots[key] === undefined)) return undefined
  return copySlots(slots as unknown as BotModelSlots)
}

/**
 * Why `value` is not rows a method may set, or undefined: some of Talk, Light, Medium and Hard work (all four with
 * `all`), each a pick on an entry. A row is never set back to Mousse choosing.
 */
export function modelRowsProblem(value: unknown, options: { all?: boolean } = {}): string | undefined {
  const rows = value as Record<string, unknown> | null
  if (!rows || typeof rows !== 'object' || Array.isArray(rows)) return 'The models are Talk, Light, Medium and Hard work.'
  const keys = Object.keys(rows)
  if (!keys.length || keys.some((key) => !(BOT_MODEL_SLOT_KEYS as readonly string[]).includes(key))) return 'The models are Talk, Light, Medium and Hard work.'
  if (options.all && BOT_MODEL_SLOT_KEYS.some((key) => rows[key] === undefined)) return 'Pick a model for Talk and for Work.'
  for (const key of keys) {
    if (rows[key] === null) return 'Pick a model for each row.'
    const problem = modelPickProblem(rows[key], { client: true })
    if (problem) return problem
  }
  return undefined
}

/** A work level from a tool's or a method's word; undefined when it is none. */
export function workLevelOf(value: unknown): BotWorkLevel | undefined {
  return typeof value === 'string' && (BOT_WORK_LEVELS as readonly string[]).includes(value) ? value as BotWorkLevel : undefined
}

/** The level an activation's run starts at: the one its work names, else the bot's standing level. */
export function startDepthOf(spec: Pick<BotThreadSpec, 'model'>, activation: { lane: BotLane; trigger: BotActivationTrigger }): BotDepth {
  const level = activation.lane === 'run' && activation.trigger.kind === 'work' ? workLevelOf(activation.trigger.level) : undefined
  return level ? LEVEL_DEPTH[level] : spec.model.depth
}

/** What one turn runs on (#673): its row, the pick on it (null: Mousse chooses), and the depth that picks the row. */
export interface BotTurnModel {
  slot: BotModelSlotKey
  pick: BotModelPick | null
  depth: BotDepth
}

/**
 * The model of an activation's turn. A chat turn takes Talk; a run takes the row of its level: `set_depth now` in that
 * run, else the level its work names (`work_start`), else the bot's standing level (`set_depth always`, medium unless
 * changed). An activation's own pick (`use_model now`, an automation's model by hand) replaces the row. A pick keeps its
 * model and reasoning level whatever the depth; only a row on which Mousse chooses follows it.
 */
export function turnModelOf(spec: Pick<BotThreadSpec, 'model' | 'slots'>, activation: { lane: BotLane; trigger: BotActivationTrigger; modelOverride?: BotModelOverride | null }): BotTurnModel {
  const override = activation.modelOverride ?? undefined
  const depth = override && BOT_DEPTHS.includes(override.depth) ? override.depth : startDepthOf(spec, activation)
  const slot: BotModelSlotKey = activation.lane === 'chat' ? 'talk' : DEPTH_LEVEL[depth]
  const own: BotModelPick | null = override?.mode === 'named'
    ? copyPick({ model: override.model, ...(override.instanceId ? { instanceId: override.instanceId } : {}), ...(override.effort ? { effort: override.effort } : {}), ...(override.credential ? { credential: override.credential } : {}), ...(override.account ? { account: override.account } : {}) })
    : null
  return { slot, pick: own ?? slotsOf(spec)[slot], depth }
}

/**
 * Why a pick can't run now: its entry is gone, off, signed out or not ready, the entry no longer offers the model, it
 * can't hold the bot, or the entry now signs in another way or to another account than when it was picked. A pick at
 * its usage limit is not one of these: it waits for the reset.
 */
export type BotPickReason = 'removed' | 'off' | 'signed_out' | 'not_ready' | 'model_gone' | 'cant_hold' | 'sign_in_changed' | 'account_changed'

/** A pick that can't run, named for the owner ("Opus 5.5 on Claude Code"). Shown to the owner only, never to the bot. */
export interface BotPickMiss {
  label: string
  reason: BotPickReason
}

const PICK_REASON_TEXT: Record<BotPickReason, string> = {
  removed: 'it\'s no longer set up',
  off: 'it\'s turned off',
  signed_out: 'it\'s signed out',
  not_ready: 'it isn\'t ready',
  model_gone: 'it no longer offers that model',
  cant_hold: 'it can\'t keep to my permissions',
  sign_in_changed: 'it signs in another way now',
  account_changed: 'it\'s signed in to another account now'
}

/** The chat's one line for a pick that can't run; its action is Pick a model. */
export function pickProblemText(miss: BotPickMiss): string {
  return `I can't use ${miss.label}: ${PICK_REASON_TEXT[miss.reason] ?? 'it isn\'t available'}.`
}

/**
 * Characters that never belong in a one-line label: C0 and C1 controls, zero-width and direction marks, line and
 * paragraph separators, direction embeddings and isolates, and the byte-order mark (by code point).
 */
function hiddenChar(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || (code >= 0x200b && code <= 0x200f) || (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) || code === 0xfeff
}

/**
 * Text from elsewhere (an entry's name, a custom endpoint's model name) as one plain line: no control or direction
 * characters, spaces collapsed, cut to `max`.
 */
export function plainLabel(text: string, max = 48): string {
  const line = [...text].map((char) => (hiddenChar(char.codePointAt(0) ?? 0) ? ' ' : char)).join('').replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

/** Which rows `use_model` with `always` sets: Talk, the three Work rows, or all of them. */
export type BotModelRows = 'talk' | 'work' | 'all'

/** `slots` with `pick` on `rows`. */
export function slotsWith(slots: BotModelSlots, rows: BotModelRows, pick: BotModelPick | null): BotModelSlots {
  return {
    talk: rows === 'work' ? slots.talk : pick,
    light: rows === 'talk' ? slots.light : pick,
    medium: rows === 'talk' ? slots.medium : pick,
    hard: rows === 'talk' ? slots.hard : pick
  }
}

/** Lower-case words and numbers: "Opus 5.5" and "opus-5-5" are both opus, 5, 5. */
function wordsOf(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

/**
 * Whether the owner's own words name a model: one of `names` (the words `use_model` was given, the model's own name, its
 * short name, its id) appears in `owner` as whole words in a row, ignoring case and punctuation.
 */
export function ownerNamesModel(owner: string, names: readonly string[]): boolean {
  const said = wordsOf(owner)
  return names.some((name) => {
    const wanted = wordsOf(name)
    if (!wanted.length || wanted.length > said.length) return false
    for (let start = 0; start + wanted.length <= said.length; start += 1)
      if (wanted.every((word, index) => said[start + index] === word)) return true
    return false
  })
}
