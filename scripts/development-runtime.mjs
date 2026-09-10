import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { realpathSync } from 'node:fs'

/** Pure, explicit process bootstrap. Runtime services must still receive injected paths. */
export function developmentRuntime(root, env = process.env) {
  const canonicalRoot = realpathSync(root)
  const digest = createHash('sha256').update(process.platform === 'win32' ? canonicalRoot.toLowerCase() : canonicalRoot).digest()
  const homeDir = resolve(env.MOUSSE_HOME || join(canonicalRoot, '.mousse-dev', 'runtime'))
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
