const BASE_KEYS = ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'] as const
// Windows requires LOCALAPPDATA when creating Chromium's AppContainer network
// process. Omitting it fails CreateProcess with ERROR_ENVVAR_NOT_FOUND (203)
// and Chromium may silently restart the network service without its sandbox.
const WINDOWS_KEYS = ['LOCALAPPDATA'] as const
// Preserve the explicitly configured Linux setuid sandbox helper. Do not inherit
// unrelated home/desktop settings, provider credentials, or Node/loader flags.
const LINUX_KEYS = ['CHROME_DEVEL_SANDBOX'] as const
const TEST_KEYS = [
  'MOUSSE_BROWSER_TEST_DELAY_RESPONSE_MS',
  'MOUSSE_BROWSER_TEST_DELAY_OOPIF_ENABLE_MS',
  'MOUSSE_BROWSER_TEST_DELAY_TAB_ENABLE_MS'
] as const

export function browserWorkerEnvironment(source: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of [...BASE_KEYS, ...(platform === 'win32' ? WINDOWS_KEYS : []), ...(platform === 'linux' ? LINUX_KEYS : []), ...TEST_KEYS]) {
    if (source[key] !== undefined) env[key] = source[key]
  }
  return { ...env, ELECTRON_RUN_AS_NODE: '1', MOUSSE_BROWSER_WORKER: '1' }
}
