import { execFile } from 'node:child_process'
import { devNull } from 'node:os'
import { NetError } from '../../../shared/net'

const remoteConfiguration = new Set(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM'])

function environment(trustRemoteConfiguration: boolean): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (!key.startsWith('GIT_')) continue
    // Retain the owner's config locations and transport settings, never repository/object/index overrides.
    const transport = /^GIT_(SSH|SSL|HTTP)(_|$)/.test(key) || key === 'GIT_PROXY_COMMAND'
    if (!trustRemoteConfiguration || (!remoteConfiguration.has(key) && !transport)) delete env[key]
  }
  if (!trustRemoteConfiguration) {
    env.GIT_CONFIG_NOSYSTEM = '1'
    env.GIT_CONFIG_GLOBAL = devNull
  }
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: devNull,
    SSH_ASKPASS: devNull,
    SSH_ASKPASS_REQUIRE: 'never',
    GCM_INTERACTIVE: 'never',
    GIT_LFS_SKIP_SMUDGE: '1'
  })
  return env
}

function runGit(
  cwd: string,
  args: string[],
  trustRemoteConfiguration: boolean,
  signal?: AbortSignal,
  maximumBytes = 2 * 1024 * 1024
): Promise<string> {
  const safety = [
    '-c', `core.hooksPath=${devNull}`,
    '-c', 'core.fsmonitor=false',
    '-c', 'protocol.ext.allow=never',
    '-c', 'protocol.file.allow=always',
    '-c', 'credential.interactive=false'
  ]
  return new Promise((resolve, reject) => {
    execFile('git', [...safety, ...args], {
      cwd,
      env: environment(trustRemoteConfiguration),
      encoding: 'utf8',
      maxBuffer: maximumBytes,
      timeout: 60_000,
      signal
    }, (error, stdout) => {
      if (error) reject(new NetError(signal?.aborted ? 'cancelled' : 'bad_request', undefined, { cause: error }))
      else resolve(stdout.trim())
    })
  })
}

/** Isolated Git for incoming bundles, quarantine and local content operations. */
export function git(cwd: string, args: string[], signal?: AbortSignal, maximumBytes?: number): Promise<string> {
  return runGit(cwd, args, false, signal, maximumBytes)
}

/** Fetch/push only against the locally bound owner's remote; trusts their credentials and transport configuration. */
export function remoteGit(cwd: string, args: string[], signal?: AbortSignal, maximumBytes?: number): Promise<string> {
  return runGit(cwd, args, true, signal, maximumBytes)
}
