import { execFile } from 'node:child_process'
import { NetError } from '../../../shared/net'

/** No shell, prompting, incoming hooks or process-global Git directory overrides. */
export function git(
  cwd: string,
  args: string[],
  signal?: AbortSignal,
  maximumBytes = 2 * 1024 * 1024
): Promise<string> {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_LFS_SKIP_SMUDGE: '1'
  })
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'protocol.ext.allow=never',
        '-c',
        'protocol.file.allow=always',
        ...args
      ],
      { cwd, env, encoding: 'utf8', maxBuffer: maximumBytes, timeout: 60_000, signal },
      (error, stdout) => {
        if (error)
          reject(
            new NetError(signal?.aborted ? 'cancelled' : 'bad_request', undefined, { cause: error })
          )
        else resolve(stdout.trim())
      }
    )
  })
}
