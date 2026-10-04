import { devNull } from 'node:os'

// Git for Windows recognizes /dev/null, including as an empty hooks/config path.
// Node's Windows device path (\\.\nul) is rejected by Git's path handling.
export const GIT_NULL_DEVICE = process.platform === 'win32' ? '/dev/null' : devNull
