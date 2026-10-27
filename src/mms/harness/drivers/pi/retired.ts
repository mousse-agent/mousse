import type { HarnessDriverKind } from '../../../../shared/harness/types'

/**
 * Model APIs a Mousse update retired (PR 4 §11): they ran only on the legacy loop, and the agent
 * named by `moveTo` replaces them. A retired entry keeps its record, its stored sign-in and its
 * chats, but nothing runs on it, nothing refreshes its sign-in, and nothing fetches its models or
 * usage. Its one next step is Move (PR 3's flow), which deletes the old sign-in once moved.
 *
 * The rule is this table: nothing outside the harness names a retired provider.
 */
export interface RetiredPiProvider {
  /** The agent kind the entry moves to (`FOLDED_INTO_AGENT` names the same one). */
  moveTo: HarnessDriverKind
  /** What the Move prompt calls the target. */
  target: string
}

export const PI_RETIRED: Readonly<Record<string, RetiredPiProvider>> = Object.freeze({
  'openai-codex': Object.freeze({ moveTo: 'codex', target: 'ChatGPT subscription' }),
  cursor: Object.freeze({ moveTo: 'cursor', target: 'Cursor' })
})

/** The retirement of a pi-ai provider id, when a Mousse update retired it. */
export function piRetiredOf(providerId: string | undefined): RetiredPiProvider | undefined {
  return providerId && Object.prototype.hasOwnProperty.call(PI_RETIRED, providerId) ? PI_RETIRED[providerId] : undefined
}

/** The Move prompt of a retired entry: its card, every thread on it, and the error of a turn on it. */
export function piRetiredPrompt(retired: RetiredPiProvider): { title: string; detail: string; target: string } {
  return {
    title: 'Retired by this update',
    detail: `Move to ${retired.target} to keep chatting. Your chats stay.`,
    target: retired.target
  }
}
