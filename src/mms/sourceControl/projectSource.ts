import { execRunner, type ExecutableRunner } from '../git/ghRunner'

/** Where a project of this computer came from: its GitHub repository (`owner/name`) and the branch it is on. */
export interface ProjectSource {
  repository?: string
  branch?: string
}

const SEGMENT = '[A-Za-z0-9][A-Za-z0-9_.-]{0,99}'
const GITHUB_REMOTE = new RegExp(`^(?:https?://(?:[^@/]+@)?(?:www\\.)?github\\.com/|ssh://git@github\\.com/|git@github\\.com:)(${SEGMENT})/(${SEGMENT})/?$`, 'i')

/** `owner/name` of a GitHub remote URL (https, ssh or scp form), or undefined for another host. */
export function githubRemote(url: string): string | undefined {
  const match = GITHUB_REMOTE.exec(url.trim())
  if (!match) return undefined
  return `${match[1]}/${match[2]!.replace(/\.git$/i, '')}`
}

/**
 * The GitHub repository and branch of a project folder, so another computer can clone the same one: `origin` when it is
 * on GitHub, else `upstream`, else the first remote that is. The branch is left out when the checkout is detached. A
 * folder without Git, or without a GitHub remote, answers what it has.
 */
export async function projectSource(path: string, run: ExecutableRunner = execRunner): Promise<ProjectSource> {
  const [remotes, head] = await Promise.all([
    run('git', ['remote', '-v'], { cwd: path }).then((result) => result.stdout, () => ''),
    run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: path }).then((result) => result.stdout.trim(), () => '')
  ])
  const byName = new Map<string, string>()
  for (const line of remotes.split(/\r?\n/)) {
    const [name, url] = line.split(/\s+/)
    if (!name || !url || byName.has(name)) continue
    const repository = githubRemote(url)
    if (repository) byName.set(name, repository)
  }
  const repository = byName.get('origin') ?? byName.get('upstream') ?? byName.values().next().value
  const branch = head && head !== 'HEAD' ? head : undefined
  return { ...(repository ? { repository } : {}), ...(branch ? { branch } : {}) }
}
