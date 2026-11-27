import type { BotLane } from '../../../shared/bots/personal/definition'
import type { BotActivationProvenance } from '../store/BotStore'

/**
 * What a bot's turn may do, by what started it (its provenance, `bot_activations.provenance`). One row per kind of start:
 * every rule that reads the start reads this table (`turnRightsOf` in `BotEngine`), so a difference between two kinds of
 * turn is one cell here, with its reason beside it (docs/bots.md, "What each kind of turn may do"; issue #1360).
 *
 * A chat turn is offered the same tools whatever started it, so the start of the runtime's prompt (and its cache, and a
 * resumed conversation) never changes with the turn: a cell that says no is refused at the call (`turnRefusals`). A run's
 * main turn is compiled with only the tools its row allows. Consults and subagents compile their own narrowed tools and
 * never read this table.
 */
export interface BotTurnRights {
  /** The lane a start of this kind belongs to. A row on the other lane reads as `unknown`. */
  lane: BotLane | 'any'
  /**
   * The owner's own words started it: queued before any other chat turn (`nextChat`), resets the chain of a work wait it
   * adds to, may pick a model for work and may let a tool run alone. A tap is the bot's words, so not one.
   */
  ownerWords: boolean
  /** `chat`: may write owner facts, standing notes and Forget, and set a schedule's fixed line (`say`). */
  memoryLane: BotLane
  /** May start, message, steer, stop or archive the owner's threads, and make or change their jobs (`threadsActOf`). */
  threadsAct: boolean
  /** `watch_start`. From a run it is detached: it returns at once, and its end wakes the chat, never the run. */
  watchStart: boolean
  /** `remind`. A run's reminder says its text; it hands out work only where `workStart` holds. */
  remind: boolean
  /** `question_answer`: passes on to work an answer the owner gave in the chat. */
  relayAnswer: boolean
  /** `question_ask` and `question_withdraw`. In a run, a question it waits on parks the run until it is answered. */
  asksOwner: boolean
  /** `work_wait`: the run parks on a time or an event, holding no slot. */
  workWait: boolean
  /** `bot_list` and `bot_send`: messages to the owner's other bots. */
  botSend: boolean
  /** `work_start`: hands a job to work. Only the chat does: work and runs do it themselves, with subagents. */
  workStart: boolean
  /** `subagent_*`: splits the job among subagents. Only a run's main turn: the chat hands long jobs to work instead. */
  subagents: boolean
}

/**
 * A chat turn the owner did not start that may still act: the bot's first message, a wake, a question's default, a
 * thread's notice or message, a held call's result.
 */
const CHAT_ACTING: BotTurnRights = {
  lane: 'chat', ownerWords: false, memoryLane: 'run', threadsAct: true,
  watchStart: true, remind: true, relayAnswer: false, asksOwner: true, workWait: false, botSend: true, workStart: true, subagents: false
}

/**
 * The table. Reasons for each "no":
 * - `memoryLane: 'run'` outside the owner's message or tap: only the owner says what the bot keeps about them.
 * - `relayAnswer` only for the owner's message or tap: an answer passed on to work must be the owner's.
 * - `threadsAct` never for another bot's message or an unknown start: text the owner never saw would steer their
 *   threads. A held call's result acts only as far as the turn that held the call did.
 * - `workWait` only in a run: the chat has one slot (`slotFree`) and nothing may hold it while it waits; it sets a wake.
 * - `workStart` never in a run: work does the job itself, splitting it among subagents; it does not hand it on.
 * - `subagents` never in the chat: it hands long jobs to work.
 * - A run started by hand (`manual`) asks nobody, waits for nothing and messages no bot: nobody asked it to and nobody
 *   waits on its report.
 * - `unknown`, a start no build writes (a newer build's row, or a provenance on the wrong lane): it may only read and
 *   answer, until a build names it here.
 */
export const BOT_TURN_KINDS: Readonly<Record<BotActivationProvenance, BotTurnRights>> = {
  owner_message: { ...CHAT_ACTING, ownerWords: true, memoryLane: 'chat', relayAnswer: true },
  owner_tap: { ...CHAT_ACTING, memoryLane: 'chat', relayAnswer: true },
  first_message: CHAT_ACTING,
  wake: CHAT_ACTING,
  question: CHAT_ACTING,
  job: CHAT_ACTING,
  threadmsg: CHAT_ACTING,
  botmsg: { ...CHAT_ACTING, threadsAct: false },
  // A held call's result: acts as a chat turn the owner did not start, its threads held to the turn that held the call
  // (`threadsActOf` reads the trigger's `threadsReadOnly`) and its device's limit (`ownerTurn`).
  action_result: CHAT_ACTING,
  work: {
    lane: 'run', ownerWords: false, memoryLane: 'run', threadsAct: true,
    watchStart: true, remind: true, relayAnswer: false, asksOwner: true, workWait: true, botSend: true, workStart: false, subagents: true
  },
  schedule: {
    lane: 'run', ownerWords: false, memoryLane: 'run', threadsAct: true,
    watchStart: true, remind: true, relayAnswer: false, asksOwner: true, workWait: true, botSend: true, workStart: false, subagents: true
  },
  manual: {
    lane: 'run', ownerWords: false, memoryLane: 'run', threadsAct: true,
    watchStart: true, remind: true, relayAnswer: false, asksOwner: false, workWait: false, botSend: false, workStart: false, subagents: true
  },
  unknown: {
    lane: 'any', ownerWords: false, memoryLane: 'run', threadsAct: false,
    watchStart: false, remind: false, relayAnswer: false, asksOwner: false, workWait: false, botSend: false, workStart: false, subagents: false
  }
}

/** What a turn on `lane` that `provenance` started may do. A provenance on the other lane is not trusted: `unknown`. */
export function turnRights(lane: BotLane, provenance: BotActivationProvenance): BotTurnRights {
  const rights = BOT_TURN_KINDS[provenance] ?? BOT_TURN_KINDS.unknown
  return rights.lane === 'any' || rights.lane === lane ? rights : BOT_TURN_KINDS.unknown
}

/** A run's provenance from its trigger's kind (`deriveBotProvenance`'s run lane). */
export function runProvenance(kind: string | undefined): BotActivationProvenance {
  return kind === 'work' || kind === 'schedule' || kind === 'manual' ? kind : 'unknown'
}

/** The tools whose cell a chat turn's start decides at the call (`BotAuthority.turnRefusals`), and the cell. */
const TURN_TOOLS: ReadonlyArray<readonly [string, keyof BotTurnRights]> = [
  ['watch_start', 'watchStart'], ['remind', 'remind'], ['question_answer', 'relayAnswer'], ['question_ask', 'asksOwner'], ['question_withdraw', 'asksOwner'],
  ['bot_send', 'botSend'], ['work_start', 'workStart'], ['work_wait', 'workWait'], ['subagent_start', 'subagents']
]

/** What a turn whose start no build names is told. */
export const BOT_TURN_UNKNOWN_TEXT = "Not on this turn: Mousse can't tell what started it, so it only reads and answers. Say what you would do; your owner's next message can ask for it."
/** `question_answer` from a turn the owner did not start. */
export const BOT_RELAY_OWNER_ONLY_TEXT = "Only a chat turn your owner's own message or tapped answer started can pass on their answer."

/**
 * The tools a turn holds that its start may not call, each with what the bot is told (`BotAuthority.turnRefusals`).
 * Only tools in `held`: one the turn is not offered is refused as it is today (not granted, or unavailable).
 */
export function turnRefusals(rights: BotTurnRights, held: ReadonlySet<string>): Map<string, string> {
  const refused = new Map<string, string>()
  for (const [tool, cell] of TURN_TOOLS) {
    if (rights[cell] || !held.has(tool)) continue
    refused.set(tool, tool === 'question_answer' ? BOT_RELAY_OWNER_ONLY_TEXT
      : rights === BOT_TURN_KINDS.unknown ? BOT_TURN_UNKNOWN_TEXT : `Not on this kind of turn: ${tool} is not for it. Say in your reply what you would do.`)
  }
  return refused
}
