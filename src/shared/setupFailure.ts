/**
 * What a person reads when a thread's worktree could not be set up (`Thread.setupFailure`): one plain line for the chat
 * and the sidebar row, and what Git or the system said, for the tooltip.
 */

const DETAIL_MAX = 600

/** The lines of Git's or the system's message that say what went wrong, without Mousse's own command prefix. */
export function setupFailureDetail(message: string): string {
  const lines = message.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  // Git's own words (`fatal: …`, `error: …`) say it best; otherwise the message as it is.
  const said = lines.filter((line) => /^(fatal|error):/i.test(line))
  const detail = (said.length ? said : lines).join('\n')
  return detail.length > DETAIL_MAX ? `${detail.slice(0, DETAIL_MAX - 1)}…` : detail
}

/** One plain line saying why the worktree could not be set up. */
export function setupFailureReason(message: string): string {
  if (/filename too long|file ?name too long|path too long|too big|ENAMETOOLONG|name too long/i.test(message))
    return "Couldn't create the worktree: Git says the folder path is too long."
  if (/ENOSPC|no space left/i.test(message)) return "Couldn't create the worktree: the disk is full."
  if (/EACCES|EPERM|permission denied|access is denied/i.test(message)) return "Couldn't create the worktree: Mousse isn't allowed to write its folder."
  if (/not a git repository/i.test(message)) return "Couldn't create the worktree: the project's Git repository wasn't found."
  // A branch named like the thread's prefix (`mousse`) blocks every `mousse/…` branch.
  const blocking = /cannot lock ref '[^']+': '(?:refs\/heads\/)?([^']+)' exists/i.exec(message)
  if (blocking) return `Couldn't create this thread's branch: the branch "${blocking[1]}" is in the way.`
  if (/already exists/i.test(message)) return "Couldn't create the worktree: its folder or branch already exists."
  if (/invalid reference|not a valid object name|unknown revision/i.test(message)) return "Couldn't create the worktree: the commit it starts from wasn't found."
  return "Couldn't set up this thread's worktree."
}
