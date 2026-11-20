import { registerBranchNamer } from '../../src/mms/workspace/branchNaming'

/**
 * A title model for branch names that answers with the task it was given, as a slug: "Look at the worker path" names
 * `look-at-the-worker-path`. A branch named this way shows exactly which words Mousse asked about, so a test can tell
 * the task from any label or guidance around it. Returns the undo.
 */
export function echoBranchNamer(profileHome: string, prefix = 'mousse'): () => void {
  return registerBranchNamer(profileHome, {
    settings: () => ({ mode: 'static', prefix, instructions: '' }),
    ask: async ({ prompt }) => prompt.replace(/^The task:\n/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  })
}
