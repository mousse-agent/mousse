/**
 * What an agent or workflow editor says about its draft. Edits save themselves (autosave), so there are two words:
 * Live when the saved draft is what was published, and Changes not live otherwise (never published, an edit not yet
 * published, or one still saving). A save that fails is an error with Retry, not a state. Shared by both editors.
 */
export type DefinitionSaveState = 'live' | 'changes'

export const SAVE_STATE_LABELS: Record<DefinitionSaveState, string> = {
  live: 'Live',
  changes: 'Changes not live'
}

/** How long an edit waits before it saves, so typing saves once. */
export const AUTOSAVE_DELAY_MS = 800

/**
 * `matchesPublished` is null when the definition was never published, otherwise whether the saved draft is the
 * published revision. An edit not saved yet is not live either.
 */
export function definitionSaveState(input: { dirty: boolean; matchesPublished: boolean | null }): DefinitionSaveState {
  return !input.dirty && input.matchesPublished === true ? 'live' : 'changes'
}

/**
 * Why Publish is disabled, in one short line for its tooltip and description. Null when it can publish, or while a
 * save or publish is in progress (the button already says so).
 */
export function publishBlockReason(input: {
  busy?: boolean
  /** An edit is waiting to save. */
  dirty?: boolean
  /** The last save failed: Retry first. */
  saveFailed?: boolean
  readOnly?: boolean
  invalidSource?: boolean
  blocking: readonly { message: string }[]
  /** The check of where the saved draft runs has not answered yet. */
  checking?: boolean
}): string | null {
  if (input.busy) return null
  if (input.readOnly) return 'Open the draft to publish.'
  if (input.invalidSource) return 'Fix the source to publish.'
  if (input.saveFailed) return 'Your edits did not save. Retry first.'
  if (input.dirty) return 'Saving your edits…'
  if (input.blocking.length > 0) return input.blocking[0].message
  if (input.checking) return 'Checking where it runs…'
  return null
}

/** "Fix 1 issue to publish" / "Fix 3 issues to publish". */
export function fixIssuesLabel(count: number): string {
  return `Fix ${count} ${count === 1 ? 'issue' : 'issues'} to publish`
}

/** "Used by 3 automations · they get this on their next run". */
export function publishImpactLine(count: number): string {
  return `Used by ${count} ${count === 1 ? 'automation' : 'automations'} · ${count === 1 ? 'it gets' : 'they get'} this on ${count === 1 ? 'its' : 'their'} next run`
}
