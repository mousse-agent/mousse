import { isIP } from 'node:net'
import { isPackagedRuntime } from '../../shared/diagnostics/memory'
/** Explicit isolated-trial seam; the packaged Electron runtime ignores it even if the variable is set. */
export function secretFetchTestAddress(hostname: string, env: NodeJS.ProcessEnv = process.env, packaged = isPackagedRuntime()): {address: string; family: number} | undefined {
  if (packaged || !env.MOUSSE_TEST_SECRET_FETCH_RESOLVE) return
  const [host, address, extra] = env.MOUSSE_TEST_SECRET_FETCH_RESOLVE.split('=')
  if (extra || host !== hostname || !address || !isIP(address)) return
  return {address, family:isIP(address)}
}
