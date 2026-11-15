import { modelChoiceOf, reasoningChange } from '../../shared/modelChoice'
import { upgradeSelection } from '../../shared/modelSelection'
import type { ChatMessage, NativeLlmContext } from '../../shared/types'

type Selection = NonNullable<ChatMessage['modelSelection']>

/** The selection the last visible message of a person was admitted with: its model and the reasoning level chosen for it. */
export function admittedSelection(messages: readonly ChatMessage[]): Selection | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (!message.hidden && message.role === 'user' && message.modelSelection) return message.modelSelection
  }
  return undefined
}

/** Find the last admitted selection; native assistant identity supports older threads. */
export function previousTurnModel(messages: ChatMessage[], context: NativeLlmContext): Selection | undefined {
  const admitted = admittedSelection(messages)
  if (admitted) return admitted
  for (const message of [...context.messages].reverse()) {
    if (message.role === 'assistant' && message.model !== 'legacy-text-only') return { provider: message.provider, model: message.model }
  }
  return undefined
}

/** A switch of provider or model; a change of reasoning level alone is none. */
export function contextHandoff(previous: Selection | undefined, next: Selection): ChatMessage['contextHandoff'] {
  if (!previous) return undefined
  const from = upgradeSelection({ ...previous })
  const to = upgradeSelection({ ...next })
  return from.provider !== to.provider || from.model !== to.model ? { from, to } : undefined
}

/**
 * The transcript marker a turn gets when it runs differently from the turn before it: on another provider or model,
 * at another reasoning level, or both, in one marker. `levelOf` gives the level a selection runs at (the chosen one,
 * else the model's default, so choosing the default by name is no change); without it only the model is compared,
 * as for an older thread whose previous model is known from its replies alone. A changed level is written into both
 * sides, so the marker names it.
 */
export function turnMarker(
  previous: Selection | undefined,
  next: Selection,
  levelOf?: (selection: Selection) => string | undefined
): ChatMessage['contextHandoff'] {
  if (!previous) return undefined
  const from = upgradeSelection({ ...previous })
  const to = upgradeSelection({ ...next })
  const switched = from.provider !== to.provider || from.model !== to.model
  const levels = levelOf ? { from: levelOf(from), to: levelOf(to) } : undefined
  if (!levels || levels.from === levels.to) return switched ? { from, to } : undefined
  const at = ({ effort: _effort, ...selection }: Selection, level: string | undefined): Selection => ({ ...selection, ...(level ? { effort: level } : {}) })
  return { from: at(from, levels.from), to: at(to, levels.to) }
}

/** A marker in plain words, for readers that show a message's text: "Reasoning: Medium → High", "Claude Opus 5.5 → GPT-6.1". */
export function turnMarkerText(marker: NonNullable<ChatMessage['contextHandoff']>): string {
  const reasoning = reasoningChange(marker.from, marker.to)
  return reasoning ? `Reasoning: ${reasoning.from} → ${reasoning.to}` : `${modelChoiceOf(marker.from).name} → ${modelChoiceOf(marker.to).name}`
}

/** A prompt that is a slash command (`/review src`): agents parse it at the start of the prompt, so nothing goes before it. */
const SLASH_COMMAND = /^\/[A-Za-z][\w:-]*(\s|$)/

const isCommand = (message: ChatMessage): boolean => SLASH_COMMAND.test(message.content.trim())

/** A visible message a person sent that started a turn, with the model that turn ran. */
const turnStart = (message: ChatMessage): Selection | undefined =>
  message.role === 'user' && !message.hidden && !message.steered ? message.modelSelection : undefined

/** A reply a model wrote, as the transcript shows it (not a tool row, a thought or a marker). */
const isReply = (message: ChatMessage): boolean =>
  message.role === 'assistant' && !message.hidden && (!message.kind || message.kind === 'message') && message.content.trim() !== ''

const modelKey = (selection: Selection): string => {
  const { provider, model } = upgradeSelection({ ...selection })
  return `${provider}\u0000${model}`
}

/**
 * What the agent is told on the first turn a different model runs in a thread: which model it is now, and which
 * models wrote the earlier replies, so it does not take another model's answers for its own. Only facts, no advice.
 *
 * `index` is the turn's own message in `messages`. The note is due when that message's model (provider or model id;
 * a reasoning level alone is no change) differs from the model of the turn before it, the same rule as the
 * transcript's model-change marker. Both models are stored on the messages, so the note is given once per change,
 * also across a restart, and a run of the same message started again carries it again. Replies are attributed to
 * the model of the turn they belong to. A slash command gets no note (nothing may go before it): the next message
 * still compares with the turn before the command. Undefined when no note is due or no earlier reply exists.
 */
export function modelChangeNote(
  messages: readonly ChatMessage[],
  index: number,
  providerName: (provider: string) => string
): string | undefined {
  const own = messages[index]
  const current = own ? turnStart(own) : undefined
  if (!own || !current || isCommand(own)) return undefined
  let previous: Selection | undefined
  let writer: Selection | undefined
  const writers = new Map<string, Selection>()
  let latest: Selection | undefined
  for (const message of messages.slice(0, index)) {
    const started = turnStart(message)
    if (started) {
      writer = started
      if (!isCommand(message)) previous = started
    } else if (writer && isReply(message)) {
      if (!writers.has(modelKey(writer))) writers.set(modelKey(writer), writer)
      latest = writer
    }
  }
  if (!contextHandoff(previous, current) || !latest) return undefined
  const all = [current, ...writers.values()]
  const providers = new Set(all.map((selection) => upgradeSelection({ ...selection }).provider))
  const named = (selection: Selection): string => {
    const name = modelChoiceOf(selection).name
    return providers.size > 1 ? `${name} (${providerName(upgradeSelection({ ...selection }).provider)})` : name
  }
  const listed = [...writers.values()].map(named)
  const list = listed.length > 1 ? `${listed.slice(0, -1).join(', ')} and ${listed.at(-1)}` : listed[0]
  const last = listed.length > 1 ? ` The latest one was written by ${named(latest)}.` : ''
  return `[Mousse] Model change: you are now ${named(current)}. The earlier assistant replies in this thread were written by ${list}.${last}`
}
