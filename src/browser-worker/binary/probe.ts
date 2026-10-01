import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchManagedChrome } from '../cdp/launch'
import { writeProbeIntoMetadata } from './install'
import { resolveCertifiedBrowser } from './resolver'
import type { CertifiedBrowserProbe } from './types'

export async function probeCertifiedChrome(browserRoot: string): Promise<CertifiedBrowserProbe> {
  const resolution = resolveCertifiedBrowser(browserRoot)
  if (resolution.status !== 'ready' || !resolution.executablePath) {
    throw new Error(resolution.message)
  }
  const userDataDir = mkdtempSync(join(tmpdir(), 'mousse-chrome-probe-'))
  const launched = await launchManagedChrome({
    executablePath: resolution.executablePath,
    userDataDir,
    headless: true
  })
  try {
    const version = await launched.cdp.send<{
      protocolVersion?: string
      product?: string
      revision?: string
      userAgent?: string
      jsVersion?: string
    }>('Browser.getVersion')
    const probe: CertifiedBrowserProbe = {
      product: version.product ?? '',
      userAgent: version.userAgent ?? '',
      protocolVersion: version.protocolVersion ?? '',
      jsVersion: version.jsVersion,
      revision: version.revision,
      remoteDebuggingPipe: true,
      headless: true,
      probedAt: new Date().toISOString()
    }
    writeProbeIntoMetadata(browserRoot, probe)
    return probe
  } finally {
    await launched.stop()
    rmSync(userDataDir, { recursive: true, force: true })
  }
}
