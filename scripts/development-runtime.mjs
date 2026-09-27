import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'

/** Pure, explicit process bootstrap. Runtime services must still receive injected paths. */
export function developmentRuntime(root, env = process.env) {
  const canonicalRoot = realpathSync(root)
  const digest = createHash('sha256').update(process.platform === 'win32' ? canonicalRoot.toLowerCase() : canonicalRoot).digest()
  const homeDir = resolve(env.MOUSSE_HOME || join(canonicalRoot, '.mousse-dev', 'runtime'))
  const globalHome = resolve(homedir(), '.mousse')
  const comparable = (path) => process.platform === 'win32' ? path.toLowerCase() : path
  if (comparable(homeDir) === comparable(globalHome)) {
    throw new Error('Development cannot share the global Mousse home; use npm start or choose an isolated MOUSSE_HOME')
  }
  const rendererPort = env.MOUSSE_RENDERER_PORT ? Number(env.MOUSSE_RENDERER_PORT) : 5100 + digest.readUInt16BE(0) % 900
  if (!Number.isInteger(rendererPort) || rendererPort < 1024 || rendererPort > 65535) {
    throw new Error('MOUSSE_RENDERER_PORT must be an integer between 1024 and 65535')
  }
  return {
    homeDir,
    rendererPort,
    electronUserData: resolve(env.MOUSSE_ELECTRON_USER_DATA || join(homeDir, 'electron-user-data')),
    browserRoot: resolve(env.MOUSSE_BROWSER_ROOT || join(homeDir, 'browser')),
    artifactRoot: resolve(env.MOUSSE_ARTIFACT_ROOT || join(homeDir, 'artifacts'))
  }
}

/** Both development entry points run the daemon with Electron safeStorage. */
export function developmentDaemonInvocation(root, env = process.env) {
  const runtime = developmentRuntime(root, env)
  const childEnv = {
    ...env,
    MOUSSE_HOME: runtime.homeDir,
    MOUSSE_ELECTRON_USER_DATA: runtime.electronUserData,
    MOUSSE_BROWSER_ROOT: runtime.browserRoot,
    MOUSSE_ARTIFACT_ROOT: runtime.artifactRoot
  }
  delete childEnv.MOUSSE_CLI
  delete childEnv.ELECTRON_RUN_AS_NODE
  return {
    argsPrefix: [resolve(root, 'out/cli/index.js')],
    env: childEnv
  }
}
