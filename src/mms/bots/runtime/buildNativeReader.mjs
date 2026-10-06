import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
/** Build only at package/test time. Restricted reader execution never compiles or spawns. */
export function buildNativeReader({ headers, outfile, compiler = 'c++' }) {
  if (!['darwin', 'linux'].includes(process.platform))
    throw new Error('Native reader platform unsupported')
  const args = [
    '-std=c++17',
    '-O2',
    '-fPIC',
    '-shared',
    '-DNAPI_VERSION=8',
    `-I${resolve(headers)}`,
    fileURLToPath(new URL('./nativeReader.cc', import.meta.url)),
    '-o',
    resolve(outfile)
  ]
  if (process.platform === 'darwin') args.push('-undefined', 'dynamic_lookup')
  execFileSync(compiler, args, { stdio: 'pipe', timeout: 60000 })
  return resolve(outfile)
}
