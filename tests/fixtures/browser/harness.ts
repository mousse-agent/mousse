import { createServer, type AddressInfo, type Server } from 'node:http'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { BrowserBroker } from '../../../src/mms/browser/BrowserBroker'
import { createAllowHttpPolicy } from '../../../src/mms/browser/defaultPorts'
import type { BrowserArtifactPort, BrowserPolicyPort } from '../../../src/mms/browser/ports'
import { installCertifiedChrome } from '../../../src/browser-worker/binary/install'
import { resolveCertifiedBrowser } from '../../../src/browser-worker/binary/resolver'
import type { BrowserWorkerRequest } from '../../../src/shared/browser/types'

const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
export const MANAGED_BROWSER_ROOT = join(repoRoot, '.mousse-dev', 'browser-binaries')
const SITE_DIR = join(repoRoot, 'tests', 'fixtures', 'browser', 'site')

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
}

export async function startFixtureSite(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const relative = url.pathname === '/' ? '/form.html' : url.pathname
    const file = join(SITE_DIR, relative.replace(/^\/+/, ''))
    if (!file.startsWith(SITE_DIR) || !existsSync(file)) {
      res.statusCode = 404
      res.end('not found')
      return
    }
    res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream')
    res.end(readFileSync(file))
  })
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const address = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolvePromise, reject) => server.close((error) => (error ? reject(error) : resolvePromise())))
  }
}

export async function ensureManagedChrome(): Promise<{ ok: true; version: string } | { ok: false; message: string }> {
  mkdirSync(MANAGED_BROWSER_ROOT, { recursive: true })
  let resolution = resolveCertifiedBrowser(MANAGED_BROWSER_ROOT)
  if (resolution.status !== 'ready') {
    try {
      await installCertifiedChrome(MANAGED_BROWSER_ROOT, { allowCatalogFallback: true })
      resolution = resolveCertifiedBrowser(MANAGED_BROWSER_ROOT)
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }
  if (resolution.status !== 'ready' || !resolution.executablePath) return { ok: false, message: resolution.message }
  return { ok: true, version: resolution.metadata?.version ?? '' }
}

export async function createBrokerHome(): Promise<{ profileRoot: string; browserRoot: string; artifactRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), 'mousse-browser-test-'))
  return {
    profileRoot: join(root, 'profiles'),
    browserRoot: MANAGED_BROWSER_ROOT,
    artifactRoot: join(root, 'artifacts')
  }
}

export async function createInProcessBroker(options: { artifacts?: BrowserArtifactPort; policy?: BrowserPolicyPort } = {}) {
  const roots = await createBrokerHome()
  mkdirSync(roots.profileRoot, { recursive: true })
  mkdirSync(roots.artifactRoot, { recursive: true })
  const broker = new BrowserBroker({
    ...roots,
    policy: options.policy ?? createAllowHttpPolicy(),
    ...(options.artifacts ? { artifacts: options.artifacts } : {}),
    transport: 'in-process'
  })
  const capabilities = await broker.start()
  return { broker, roots, capabilities }
}

let requestSeq = 0
export function workerRequest(profileId: string, method: BrowserWorkerRequest['method'], params: Record<string, unknown>): BrowserWorkerRequest {
  requestSeq += 1
  return { version: 1, id: `req_${requestSeq}`, profileId, method, params }
}
