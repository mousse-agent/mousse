import { devNull } from 'node:os'

// Git for Windows recognizes /dev/null, including as an empty hooks/config path.
// Node's Windows device path (\\.\nul) is rejected by Git's path handling.
export const GIT_NULL_DEVICE = process.platform === 'win32' ? '/dev/null' : devNull

/**
 * A `core.hooksPath` that holds no hooks. On Windows `/dev/null` is understood by Git but not by Git
 * LFS, which then creates a `dev/null` hooks folder inside the repository; `//./NUL` is a device path
 * to both, so nothing can be created there.
 */
export const NO_HOOKS_PATH = process.platform === 'win32' ? '//./NUL' : devNull
