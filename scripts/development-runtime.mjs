import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'

const comparable = (path) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)

/**
 * Whether development opts into the shared global home. MOUSSE_DEV_USE_GLOBAL=1|0 wins;
 * otherwise the checkout's ignored `.mousse-dev/dev.json` `{ "useGlobalHome": true }` decides.
 */
export function developmentUsesGlobalHome(root, env = process.env) {
  const flag = env.MOUSSE_DEV_USE_GLOBAL?.trim().toLowerCase()
  if (flag) {
    if (['1', 'true', 'yes'].includes(flag)) return true
    if (['0', 'false', 'no'].includes(flag)) return false
    throw new Error('MOUSSE_DEV_USE_GLOBAL must be 1 or 0')
  }
  const settingsPath = join(root, '.mousse-dev', 'dev.json')
  if (!existsSync(settingsPath)) return false
  try {
    return JSON.parse(readFileSync(settingsPath, 'utf-8'))?.useGlobalHome === true
  } catch (error) {
    throw new Error(`${settingsPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Pure, explicit process bootstrap. Runtime services must still receive injected paths. */
export function developmentRuntime(root, env = process.env) {
  const canonicalRoot = realpathSync(root)
  const digest = createHash('sha256').update(process.platform === 'win32' ? canonicalRoot.toLowerCase() : canonicalRoot).digest()
  const globalHome = resolve(homedir(), '.mousse')
  const rendererPort = env.MOUSSE_RENDERER_PORT ? Number(env.MOUSSE_RENDERER_PORT) : 5100 + digest.readUInt16BE(0) % 900
  if (!Number.isInteger(rendererPort) || rendererPort < 1024 || rendererPort > 65535) {
    throw new Error('MOUSSE_RENDERER_PORT must be an integer between 1024 and 65535')
  }
  if (developmentUsesGlobalHome(canonicalRoot, env)) {
    if (env.MOUSSE_HOME && comparable(env.MOUSSE_HOME) !== comparable(globalHome)) {
      throw new Error('MOUSSE_DEV_USE_GLOBAL conflicts with MOUSSE_HOME; unset one of them')
    }
    // Unset roots let Electron and MMS pick the installed app's own vault, browser and artifact
    // locations, so chats and sign-ins match stable and nightly.
    return {
      homeDir: globalHome,
      sharedGlobalHome: true,
      rendererPort,
      electronUserData: env.MOUSSE_ELECTRON_USER_DATA ? resolve(env.MOUSSE_ELECTRON_USER_DATA) : null,
      browserRoot: env.MOUSSE_BROWSER_ROOT ? resolve(env.MOUSSE_BROWSER_ROOT) : null,
      artifactRoot: env.MOUSSE_ARTIFACT_ROOT ? resolve(env.MOUSSE_ARTIFACT_ROOT) : null
    }
  }
  const homeDir = resolve(env.MOUSSE_HOME || join(canonicalRoot, '.mousse-dev', 'runtime'))
  if (comparable(homeDir) === comparable(globalHome)) {
    throw new Error('Development cannot share the global Mousse home unless MOUSSE_DEV_USE_GLOBAL=1; use npm start or choose an isolated MOUSSE_HOME')
  }
  return {
    homeDir,
    sharedGlobalHome: false,
    rendererPort,
    electronUserData: resolve(env.MOUSSE_ELECTRON_USER_DATA || join(homeDir, 'electron-user-data')),
    browserRoot: resolve(env.MOUSSE_BROWSER_ROOT || join(homeDir, 'browser')),
    artifactRoot: resolve(env.MOUSSE_ARTIFACT_ROOT || join(homeDir, 'artifacts'))
  }
}

/** Environment for development children; unset roots are removed so the app defaults apply. */
export function developmentEnv(runtime, env = process.env) {
  const childEnv = { ...env, MOUSSE_HOME: runtime.homeDir }
  const roots = {
    MOUSSE_ELECTRON_USER_DATA: runtime.electronUserData,
    MOUSSE_BROWSER_ROOT: runtime.browserRoot,
    MOUSSE_ARTIFACT_ROOT: runtime.artifactRoot
  }
  for (const [key, value] of Object.entries(roots)) {
    if (value) childEnv[key] = value
    else delete childEnv[key]
  }
  delete childEnv.MOUSSE_CLI
  delete childEnv.ELECTRON_RUN_AS_NODE
  return childEnv
}

/** Both development entry points run the daemon with Electron safeStorage. */
export function developmentDaemonInvocation(root, env = process.env) {
  const runtime = developmentRuntime(root, env)
  return {
    argsPrefix: [resolve(root, 'out/cli/index.js')],
    env: developmentEnv(runtime, env),
    runtime
  }
}
