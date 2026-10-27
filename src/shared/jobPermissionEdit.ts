/**
 * Edits that change what a scheduled job does when it runs. Changing the name, the schedule, the repeat or pausing
 * does not. The daemon bounds these by the editor's own permission mode; the Scheduled page uses the same list to
 * tell the person what saving will do.
 */
export const EXECUTABLE_JOB_FIELDS = ['prompt', 'selection', 'mode', 'workspace', 'threadId', 'projectId', 'createThread', 'permissionMode'] as const

/** True when the patch changes something a run does. */
export function isExecutableJobEdit(patch: object): boolean {
  return EXECUTABLE_JOB_FIELDS.some((key) => (patch as Record<string, unknown>)[key] !== undefined)
}

/** A prompt that starts with `/` runs a workflow, which does not run under a permission mode. */
export function isWorkflowPrompt(prompt: string | undefined): boolean {
  return typeof prompt === 'string' && prompt.trim().startsWith('/')
}
