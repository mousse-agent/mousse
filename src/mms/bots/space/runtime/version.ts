import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { NetError } from '../../../../shared/net'
/** The pinned pi-ai version Space bots qualify against, apart from the provider guard so packaging probes load no provider code. */
export function nativeSdkVersion(): string {
  const path = fileURLToPath(import.meta.resolve('@earendil-works/pi-ai')),
    data = JSON.parse(readFileSync(join(dirname(path), '../package.json'), 'utf8'))
  if (data.name !== '@earendil-works/pi-ai' || typeof data.version !== 'string')
    throw new NetError('profile_unsupported')
  return data.version
}
