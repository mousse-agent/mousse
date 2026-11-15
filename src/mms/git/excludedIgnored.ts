const IGNORED_PATHS_HEADER = 'The following paths are ignored by one of your .gitignore files:'

/**
 * Whether a failed `git add` only reported ignored paths that the command itself excluded. Git counts a path an
 * `:(exclude)` pathspec names (`.mousse`, or a file a snapshot leaves out) as an ignored path the person asked for when
 * the project's `.gitignore` lists it too, and exits with 1; it has added everything else by then. `excluded` are the
 * excluded paths; Git may name one of them, or the ignored folder that holds one.
 */
export function onlyExcludedIgnored(stderr: string, excluded: string[]): boolean {
  // Warnings (an unreadable folder Git skipped) and hints may come with it; any other line is a real failure.
  const lines = stderr.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith('hint:') && !line.startsWith('warning:'))
  if (lines[0] !== IGNORED_PATHS_HEADER || lines.length < 2) return false
  const own = (path: string) => excluded.some((exclusion) => exclusion === path || exclusion.startsWith(`${path}/`) || path.startsWith(`${exclusion}/`))
  return lines.slice(1).every(own)
}
