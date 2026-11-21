import type { BranchNamingSettings } from '../../shared/settings'
import { buildTitlePrompt, normalizeTitle, titleSystemPrompt, type TitleContext } from '../../shared/threadTitleText'
import { branchNamingRules } from '../workspace/branchNaming'

/**
 * A new thread is named once, when its first message is sent: one request to the title model gives both the thread's
 * title and its worktree branch's name, instead of one request for each. Every thread's request asks for both, whether
 * it has a worktree or not, so the request is the same for all of them and a Claude Code process started ahead can
 * answer any of them (`ClaudeSubscriptionProviderService.oneShot`); the branch line costs a few words.
 */

/** The request: the title rules (with the person's own title prompt), the branch rules of the naming setting, and the answer's two lines. */
export function threadNamingRequest(context: TitleContext, titlePrompt: string | undefined, branches: BranchNamingSettings): { system: string; prompt: string } {
  const title = titleSystemPrompt(titlePrompt).split('\n').filter((line) => line !== 'Reply with the title only.')
  const system = [
    ...title,
    '',
    "The thread's work also gets a Git branch. Rules for the branch name:",
    ...branchNamingRules(branches).map((rule) => `- ${rule}`),
    '',
    'Reply with exactly two lines and nothing else:',
    'Title: <the title>',
    'Branch: <the branch name>'
  ].join('\n')
  return { system, prompt: buildTitlePrompt(context, true) }
}

export interface ThreadNaming {
  /** The sidebar title (`normalizeTitle`), or null when the answer names nothing. */
  title: string | null
  /** The branch line as the model wrote it, for `branchNameFromModel`; absent when the answer has none. */
  branch?: string
}

/**
 * The answer's title and branch lines. A line labelled `Branch:` is the branch; the title is the line labelled `Title:`,
 * or else the first other line, so an answer that gives only a title still names the thread.
 */
export function parseThreadNaming(text: string): ThreadNaming {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/[*_`]/g, '').trim()).filter(Boolean)
  const branch = lines.find((line) => /^branch(?: name)?\s*:/i.test(line))
  const title = lines.find((line) => /^title\s*:/i.test(line)) ?? lines.find((line) => line !== branch)
  return { title: title ? normalizeTitle(title) : null, ...(branch ? { branch } : {}) }
}
