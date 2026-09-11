import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { launchManagedChrome } from '../../../browser-worker/cdp/launch'
import type { ManagedBrowserExecutableProbe } from '../../../shared/browser/install'

export const probeManagedBrowserExecutable: ManagedBrowserExecutableProbe = async (executablePath, signal) => {
  if (signal?.aborted) throw new DOMException('Browser executable probe was cancelled.', 'AbortError')
  const userDataDir = await mkdtemp(join(tmpdir(), 'mousse-browser-probe-'))
  let launched: Awaited<ReturnType<typeof launchManagedChrome>> | undefined
  try {
    launched = await launchManagedChrome({ executablePath, userDataDir })
    if (signal?.aborted) throw new DOMException('Browser executable probe was cancelled.', 'AbortError')
    const version = await launched.cdp.send<{ product?: string; revision?: string }>('Browser.getVersion', {}, { timeoutMs: 10_000 })
    return { version: version.product ?? version.revision ?? '' }
  } finally {
    await launched?.stop().catch(() => undefined)
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
  }
}
