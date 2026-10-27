import type { HarnessDriverKind } from './types'
import type { InstanceSnapshot } from './status'

/**
 * Model APIs that now run as an agent (agent CLIs plan §5): a connected `pi:<provider>` entry offers
 * "Move…" to the agent kind named here. The table is data: each agent PR adds its own row
 * (`cursor: 'cursor'`, `xai: 'grok'`) with its copy, and nothing else branches on it.
 */
export const FOLDED_INTO_AGENT: Readonly<Record<string, HarnessDriverKind>> = Object.freeze({
  // Claude runs through Claude Code only: an Anthropic API key moves to Claude Code on that key.
  anthropic: 'claude',
  cursor: 'cursor',
  xai: 'grok',
  'openai-codex': 'codex'
})

/** The agent a model API's provider id moves to, when it has one. */
export function foldedInto(providerId: string | undefined): HarnessDriverKind | undefined {
  return providerId && Object.prototype.hasOwnProperty.call(FOLDED_INTO_AGENT, providerId) ? FOLDED_INTO_AGENT[providerId] : undefined
}

/**
 * A moving entry whose old route is going away: its snapshot says `nextStep: move`, and the card and
 * every thread on it keep a Move banner until it moved. Only these entries need the new route signed
 * in before the move happens and drop their old sign-in with it.
 */
export interface MovePrompt {
  title: string
  detail: string
}

const MOVE_PROMPTS: Readonly<Record<string, MovePrompt>> = Object.freeze({
  'openai-codex': {
    title: 'Move to ChatGPT subscription',
    detail: 'This connection uses an older sign-in that a coming Mousse update turns off. Your chats stay.'
  }
})

/** The prompt a model API's provider id carries until it moved; undefined for a move that is only on offer. */
export function movePromptOf(providerId: string | undefined): MovePrompt | undefined {
  return providerId && Object.prototype.hasOwnProperty.call(MOVE_PROMPTS, providerId) ? MOVE_PROMPTS[providerId] : undefined
}

/**
 * The kind of agent entry a model API moves to, when not every entry of the agent may take it. A
 * move goes only to an entry whose config has `loginMethod`, and creates one with this slug, name
 * and config when there is none (PR 2 §6: `pi:anthropic` → `claude:api`, Claude Code on an API key
 * in a home of its own, never the user's own Claude Code). `copyKey` is the dialog's starting choice.
 */
export interface FoldedTarget {
  slug: string
  displayName: string
  loginMethod: string
  copyKey: boolean
}

export const FOLDED_TARGETS: Readonly<Record<string, FoldedTarget>> = Object.freeze({
  anthropic: Object.freeze({ slug: 'api', displayName: 'Claude Code (API key)', loginMethod: 'api_key', copyKey: true })
})

/** The kind of entry a model API's provider id moves to, when it is narrower than the agent. */
export function foldedTarget(providerId: string | undefined): FoldedTarget | undefined {
  return providerId && Object.prototype.hasOwnProperty.call(FOLDED_TARGETS, providerId) ? FOLDED_TARGETS[providerId] : undefined
}

/** Whether an entry of the agent, with its stored config, may take a move of `providerId`. */
export function acceptsMove(providerId: string | undefined, config: { loginMethod?: unknown } | undefined): boolean {
  const target = foldedTarget(providerId)
  return !target || config?.loginMethod === target.loginMethod
}

/** What a move changed, for the dialog to list. */
export interface MoveResult {
  from: string
  to: string
  /** Defaults that named the old entry and now name the new one ("Default model", "Project Foo"). */
  rewritten: string[]
  /**
   * What became of the old entry's sign-in (an entry whose old route is going away): `removed`;
   * `kept_shared` because another profile of the device still uses it; `remains` because it could
   * not be deleted (the move stands, and the stale credential is not used).
   */
  oldSignIn?: 'removed' | 'kept_shared' | 'remains'
}

/** The persistent Move banner of an entry (its card, and every thread whose selection it is). */
export interface MoveBanner {
  instanceId: string
  title: string
  detail: string
  label: string
}

/** Whether a snapshot carries the Move prompt: generic, it reads only the snapshot's `nextStep`. */
export function moveBannerOf(snapshot: Pick<InstanceSnapshot, 'instanceId' | 'nextStep' | 'config'> | undefined): MoveBanner | null {
  const step = snapshot?.nextStep
  if (!snapshot || step?.action !== 'move' || snapshot.config?.movedTo) return null
  return { instanceId: snapshot.instanceId, title: step.title ?? step.label, detail: step.detail ?? '', label: step.label }
}

/** The banner at the top of a thread whose selection is `instanceId`, from the instance snapshots. */
export function threadMoveBanner(instanceId: string | undefined, snapshots: readonly InstanceSnapshot[] | undefined): MoveBanner | null {
  return instanceId ? moveBannerOf(snapshots?.find((snapshot) => snapshot.instanceId === instanceId)) : null
}
