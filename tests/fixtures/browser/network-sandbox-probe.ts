import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ManagedSession } from '../../../src/browser-worker/session/Session'
import type { CdpTransport } from '../../../src/browser-worker/cdp/transport'
import { resolveCertifiedBrowser } from '../../../src/browser-worker/binary/resolver'

const browserRoot = process.argv[2]
const artifacts = process.argv[3]
const binary = resolveCertifiedBrowser(browserRoot)
if (binary.status !== 'ready' || !binary.executablePath || !binary.metadata) throw new Error('Managed Chrome unavailable')
const profileId = `profile_network_probe_${randomUUID()}`
const workspaceId = 'sandbox_probe'
const profileRoot = join(browserRoot, 'user-data', profileId)
const userData = join(profileRoot, 'workspaces', workspaceId)
const site = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><title>Sandbox probe</title>ready') })
await new Promise<void>(done => site.listen(0, '127.0.0.1', done))
const session = new ManagedSession({ profileId, browserRoot, artifactRoot: artifacts, executablePath: binary.executablePath, browserVersion: binary.metadata.version }, { persistent: true, workspaceId })
let result: unknown
let failure: unknown
try {
  await session.start(`http://127.0.0.1:${(site.address() as { port: number }).port}/`)
  const cdp = (session as unknown as { chrome: { cdp: CdpTransport } }).chrome.cdp
  result = await cdp.send('Browser.getHistograms', { query: 'Chrome.SystemNetworkContextManager.NetworkSandbox', delta: false })
} catch (error) {
  failure = error
} finally {
  try { await session.close() } finally {
    site.closeAllConnections()
    await new Promise<void>(done => site.close(() => done()))
  }
}
try {
  if (failure) throw failure
  const state = JSON.parse(readFileSync(join(userData, 'Local State'), 'utf8'))
  process.stdout.write(JSON.stringify({ result, failedLaunchMajorVersion: state.net?.network_service_failed_launch_major_version ?? 0 }))
} finally {
  // Only after successful process cleanup; never remove shared binary files.
  rmSync(profileRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
