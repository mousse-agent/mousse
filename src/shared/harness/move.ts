import type { HarnessDriverKind } from './types'

/**
 * Model APIs that now run as an agent (agent CLIs plan §5): a connected `pi:<provider>` entry offers
 * "Move…" to the agent kind named here. The table is data: each agent PR adds its own row
 * (`cursor: 'cursor'`, `xai: 'grok'`) with its copy, and nothing else branches on it.
 */
export const FOLDED_INTO_AGENT: Readonly<Record<string, HarnessDriverKind>> = Object.freeze({
  cursor: 'cursor'
})

/** The agent a model API's provider id moves to, when it has one. */
export function foldedInto(providerId: string | undefined): HarnessDriverKind | undefined {
  return providerId && Object.prototype.hasOwnProperty.call(FOLDED_INTO_AGENT, providerId) ? FOLDED_INTO_AGENT[providerId] : undefined
}

/** What a move changed, for the dialog to list. */
export interface MoveResult {
  from: string
  to: string
  /** Defaults that named the old entry and now name the new one ("Default model", "Project Foo"). */
  rewritten: string[]
}
