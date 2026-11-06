/**
 * What an agent or workflow editor says about its draft: whether the edits on screen are saved,
 * and whether the saved draft is what was last published. Shared by both editors so they use the
 * same four words.
 */
export type DefinitionSaveState = 'unsaved' | 'draft' | 'unpublished' | 'published'

export const SAVE_STATE_LABELS: Record<DefinitionSaveState, string> = {
  unsaved: 'Unsaved edits',
  draft: 'Draft saved',
  unpublished: 'Unpublished changes',
  published: 'Published'
}

/**
 * `matchesPublished` is null when the definition was never published, otherwise whether the saved
 * draft is the published revision. Unsaved edits win over both.
 */
export function definitionSaveState(input: { dirty: boolean; matchesPublished: boolean | null }): DefinitionSaveState {
  if (input.dirty) return 'unsaved'
  if (input.matchesPublished === null) return 'draft'
  return input.matchesPublished ? 'published' : 'unpublished'
}

/**
 * Why Publish is disabled, in one short line for its tooltip and description. Null when it can
 * publish, or while a save or publish is in progress (the button already says so).
 */
export function publishBlockReason(input: {
  state: DefinitionSaveState
  busy?: boolean
  readOnly?: boolean
  invalidSource?: boolean
  blocking: readonly { message: string }[]
  /** The check of where the saved draft runs has not answered yet. */
  checking?: boolean
}): string | null {
  if (input.busy) return null
  if (input.readOnly) return 'Open the draft to publish.'
  if (input.invalidSource) return 'Fix the source to publish.'
  if (input.state === 'unsaved') return 'Save the draft to publish it.'
  if (input.blocking.length > 0) return input.blocking[0].message
  if (input.checking) return 'Checking where it runs…'
  return null
}

/** "Fix 1 issue to publish" / "Fix 3 issues to publish". */
export function fixIssuesLabel(count: number): string {
  return `Fix ${count} ${count === 1 ? 'issue' : 'issues'} to publish`
}
