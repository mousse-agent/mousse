import {
  BOT_DEPTHS,
  BOT_MODEL_SLOT_KEYS,
  BOT_WORK_LEVELS,
  DEPTH_LEVEL,
  LEVEL_DEPTH,
  type BotActivationTrigger,
  type BotDepth,
  type BotLane,
  type BotModelChoice,
  type BotModelOverride,
  type BotModelPick,
  type BotModelSlotKey,
  type BotModelSlots,
  type BotThreadSpec,
  type BotWorkLevel
} from './definition'

/**
 * A bot's models by situation (#673): Talk for the chat, and Light, Medium and Hard work for the run lane. Pure and
 * browser-safe: the daemon resolves a turn's row here, and the Runs on picker reads the same rows.
 *
 * Format 2 keeps `main.model` as it was, so older builds read every bot. It mirrors the Talk row (an older build runs
 * every turn on it), and `main.slots` holds the rows only when `main.model` alone can't say them. A row an older build
 * changed (`main.model` no longer mirrors Talk) makes `main.model` the truth again: Talk and Work both on it, as for a
 * bot made before rows existed.
 */

/** Every row on Automatic: a new bot. */
export const AUTOMATIC_SLOTS: Readonly<BotModelSlots> = Object.freeze({ talk: null, light: null, medium: null, hard: null })

/** The Work rows, Light first. */
export const WORK_SLOT_KEYS: readonly BotWorkLevel[] = BOT_WORK_LEVELS

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

/** What `main.model` says when the rows are `slots`: the Talk row, by name, at the standing depth. */
export function mirrorOf(slots: BotModelSlots, depth: BotDepth): BotModelChoice {
  return slots.talk ? { mode: 'named', model: slots.talk.model, depth } : { mode: 'auto', depth }
}

const sameChoice = (a: BotModelChoice, b: BotModelChoice) => a.mode === b.mode && (a.mode === 'auto' || (b.mode === 'named' && a.model === b.model))

/**
 * A thread's rows, upgraded on read: the written rows while `main.model` still mirrors them; otherwise `main.model` on
 * every row (Automatic, or one model by name, matched across entries as before).
 */
export function slotsOf(spec: Pick<BotThreadSpec, 'model' | 'slots'>): BotModelSlots {
  if (spec.slots && !modelSlotsProblem(spec.slots) && sameChoice(mirrorOf(spec.slots, spec.model.depth), spec.model)) return copySlots(spec.slots)
  return slotsAllOn(spec.model.mode === 'named' ? { model: spec.model.model } : null)
}

/**
 * The thread with `slots` as its rows: `model` mirrors Talk at the same standing depth, and `slots` is left out when
 * `model` alone says the same (every row Automatic, or one model by name and Default on every row).
 */
export function withSlots<T extends Pick<BotThreadSpec, 'model' | 'slots'>>(spec: T, slots: BotModelSlots): T {
  const model = mirrorOf(slots, spec.model.depth)
  const { slots: _old, ...rest } = spec
  const plain = BOT_MODEL_SLOT_KEYS.every((key) => samePick(slots[key], slots.talk)) && (!slots.talk || (!slots.talk.instanceId && !slots.talk.effort))
  return (plain ? { ...rest, model } : { ...rest, model, slots: copySlots(slots) }) as T
}

function copySlots(slots: BotModelSlots): BotModelSlots {
  const copy = (pick: BotModelPick | null): BotModelPick | null => pick ? { ...(pick.instanceId ? { instanceId: pick.instanceId } : {}), model: pick.model, ...(pick.effort ? { effort: pick.effort } : {}) } : null
  return { talk: copy(slots.talk), light: copy(slots.light), medium: copy(slots.medium), hard: copy(slots.hard) }
}

const PICK_KEYS = new Set(['instanceId', 'model', 'effort'])
const shortText = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max

/** Why `value` is not one pick (a row by hand), or undefined. */
export function modelPickProblem(value: unknown): string | undefined {
  const pick = value as Record<string, unknown> | null
  if (!pick || typeof pick !== 'object' || Array.isArray(pick) || Object.keys(pick).some((key) => !PICK_KEYS.has(key))) return 'A model is an entry, a model and a reasoning level.'
  if (!shortText(pick.model, 200)) return 'A model is a name of 1 to 200 characters.'
  if (pick.instanceId !== undefined && !shortText(pick.instanceId, 200)) return 'An entry is an id of 1 to 200 characters.'
  if (pick.effort !== undefined && !shortText(pick.effort, 40)) return 'A reasoning level is a word of 1 to 40 characters.'
  return undefined
}

/** Why `value` is not a bot's rows (Talk, Light, Medium and Hard, each a pick or null for Automatic), or undefined. */
export function modelSlotsProblem(value: unknown): string | undefined {
  const slots = value as Record<string, unknown> | null
  if (!slots || typeof slots !== 'object' || Array.isArray(slots)) return 'The models are Talk, Light, Medium and Hard work.'
  const keys = Object.keys(slots)
  if (keys.length !== BOT_MODEL_SLOT_KEYS.length || keys.some((key) => !(BOT_MODEL_SLOT_KEYS as readonly string[]).includes(key))) return 'The models are Talk, Light, Medium and Hard work.'
  for (const key of BOT_MODEL_SLOT_KEYS) {
    if (slots[key] === null) continue
    const problem = modelPickProblem(slots[key])
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

/** What one turn runs on (#673): its row, the pick on it (null: Automatic), and the depth Automatic resolves at. */
export interface BotTurnModel {
  slot: BotModelSlotKey
  pick: BotModelPick | null
  depth: BotDepth
}

/**
 * The model of an activation's turn. A chat turn takes Talk; a run takes the row of its level: `set_depth now` in that
 * run, else the level its work names (`work_start`), else the bot's standing level (`set_depth always`, medium unless
 * changed). An activation's own pick (`use_model now`, an automation's model by hand) replaces the row. A picked row
 * keeps its model and reasoning level whatever the depth; Default and Automatic follow it.
 */
export function turnModelOf(spec: Pick<BotThreadSpec, 'model' | 'slots'>, activation: { lane: BotLane; trigger: BotActivationTrigger; modelOverride?: BotModelOverride | null }): BotTurnModel {
  const override = activation.modelOverride ?? undefined
  const depth = override && BOT_DEPTHS.includes(override.depth) ? override.depth : startDepthOf(spec, activation)
  const slot: BotModelSlotKey = activation.lane === 'chat' ? 'talk' : DEPTH_LEVEL[depth]
  const own: BotModelPick | null = override?.mode === 'named'
    ? { ...(override.instanceId ? { instanceId: override.instanceId } : {}), model: override.model, ...(override.effort ? { effort: override.effort } : {}) }
    : null
  return { slot, pick: own ?? slotsOf(spec)[slot], depth }
}

/** Why a model picked by hand can't run now: its entry is gone, off, signed out or not ready, it is at its usage limit, or it can't hold the bot. */
export type BotPickReason = 'removed' | 'off' | 'signed_out' | 'not_ready' | 'limited' | 'cant_hold'

/**
 * A pick that could not run, so the turn went on Automatic. The chat says so once per `key` (the pick and the reason)
 * while it lasts. `label` names the model and its entry: the one place a bot's chat names a model.
 */
export interface BotPickMiss {
  key: string
  label: string
  reason: BotPickReason
}

const PICK_REASON_TEXT: Record<BotPickReason, string> = {
  removed: 'it\'s no longer set up',
  off: 'it\'s turned off',
  signed_out: 'it\'s signed out',
  not_ready: 'it isn\'t ready',
  limited: 'it\'s at its usage limit',
  cant_hold: 'it can\'t keep to my permissions'
}

/** The chat's one line for a pick that could not run. */
export function pickMissText(miss: Pick<BotPickMiss, 'label' | 'reason'>): string {
  return `I can't use ${miss.label}: ${PICK_REASON_TEXT[miss.reason] ?? 'it isn\'t available'}, so I'm using Automatic for now.`
}

/** The most picks the bot remembers having said it could not use. */
const MAX_MISSING = 8

/**
 * The picks the chat has said it could not use, after one turn: a pick that ran is forgotten (so a new problem with it
 * is said again), and one that could not run is remembered. Keys are `<entry>|<model>|<reason>`.
 */
export function missingAfter(said: readonly string[] | undefined, pick: BotModelPick | null, missed: Pick<BotPickMiss, 'key'> | undefined): string[] {
  const prefix = pick ? `${pick.instanceId ?? ''}|${pick.model}|` : undefined
  const forget = (key: string) => (prefix !== undefined && key.startsWith(prefix)) || key === missed?.key
  const kept = (said ?? []).filter((key) => typeof key === 'string' && !forget(key))
  return (missed ? [...kept, missed.key] : kept).slice(-MAX_MISSING)
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
