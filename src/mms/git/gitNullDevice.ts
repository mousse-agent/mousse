import { devNull } from 'node:os'
import { join } from 'node:path'

// Git for Windows recognizes /dev/null, including as an empty hooks/config path.
// Node's Windows device path (\\.\nul) is rejected by Git's path handling.
export const GIT_NULL_DEVICE = process.platform === 'win32' ? '/dev/null' : devNull

/**
 * A `core.hooksPath` that holds no hooks and that nothing can create. On Windows, Git understands
 * `/dev/null` but Git LFS does not (it creates a `dev/null` hooks folder inside the repository), and
 * the device path `//./NUL` makes `git worktree` slow enough to hold files open. A folder inside the
 * running program's own executable file cannot exist for either of them.
 */
export const NO_HOOKS_PATH = process.platform === 'win32' ? join(process.execPath, 'no-hooks').replace(/\\/g, '/') : devNull
