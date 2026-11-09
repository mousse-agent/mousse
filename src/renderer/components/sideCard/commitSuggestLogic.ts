/** The daemon's code when no title model is chosen: nothing can write a message until one is. */
export const SUGGEST_NO_MODEL_CODE = 'git_suggest_no_model'

export const SUGGEST_NO_MODEL_TITLE = 'Choose a title model in Settings to suggest messages'

export interface SuggestButtonInput {
  /** Files the commit would take. */
  fileCount: number
  /** A suggestion is being written. */
  suggesting: boolean
  /** A commit (or amend) is running. */
  committing: boolean
  /** Why another Git action blocks this one; null when none does. */
  blockedReason: string | null
  /** The daemon said no title model is chosen. */
  noModel: boolean
}

export interface SuggestButtonState {
  label: string
  disabled: boolean
  title: string
}

/** The Suggest button beside the commit message: what it says, whether it can be pressed, and why not. */
export function suggestButtonState(input: SuggestButtonInput): SuggestButtonState {
  const label = input.suggesting ? 'Suggesting…' : 'Suggest'
  if (input.noModel) return { label, disabled: true, title: SUGGEST_NO_MODEL_TITLE }
  if (input.blockedReason) return { label, disabled: true, title: input.blockedReason }
  if (input.committing) return { label, disabled: true, title: 'A commit is running' }
  if (input.fileCount === 0) return { label, disabled: true, title: 'No changes to describe' }
  if (input.suggesting) return { label, disabled: true, title: 'Writing a message from the changes' }
  return { label, disabled: false, title: 'Write a message from the changes this commit takes' }
}
