/**
 * Built-in and alias slugs reserved across app, CLI, and channels.
 * Publication must reject these so workflows cannot shadow built-in commands.
 */
export const RESERVED_WORKFLOW_SLUGS: readonly string[] = [
  'help',
  'start',
  'new',
  'reset',
  'status',
  'usage',
  'threads',
  'thread',
  'model',
  'models',
  'stop',
  'steer',
  'whoami',
  'title',
  'sethome',
  'set-home',
  'agents',
  'tasks',
  'skills',
  'skill',
  'workflow',
  'workflows',
  'exit',
  'quit',
  'q'
]

export function isReservedWorkflowSlug(slug: string): boolean {
  return RESERVED_WORKFLOW_SLUGS.includes(slug.toLowerCase())
}
