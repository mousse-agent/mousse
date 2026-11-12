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

export async function startFixtureSite(): Promise<{ origin: string; close: () => Promise<void>; submitCount: () => number }> {
  let submitRequests = 0
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'POST' && url.pathname === '/submit-once') {
      submitRequests += 1
      res.statusCode = 200
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.end('accepted')
      return
    }
    if (req.method === 'GET' && url.pathname === '/oversize.bin') {
      res.statusCode = 200
      res.setHeader('content-type', 'application/octet-stream')
      res.setHeader('content-disposition', 'attachment; filename="oversize.bin"')
      let remaining = 51
      const chunk = Buffer.alloc(1024 * 1024, 7)
      const write = () => {
        if (res.destroyed) return
        while (remaining > 0) {
          // write(false) still accepts these bytes; it only requests a pause.
          remaining -= 1
          if (!res.write(chunk)) { res.once('drain', write); return }
        }
        res.end()
      }
      write()
      return
    }
    if (req.method === 'GET' && url.pathname === '/aborted.bin') {
      res.statusCode = 200
      res.setHeader('content-type', 'application/octet-stream')
      res.setHeader('content-disposition', 'attachment; filename="aborted.bin"')
      res.write('partial fixture bytes')
      res.destroy()
      return
    }
    if (req.method === 'GET' && url.pathname === '/viewer-slow.html') {
      res.statusCode = 200
      res.setHeader('content-type', 'text/html; charset=utf-8')
      setTimeout(() => res.end('<!doctype html><title>Viewer slow fixture</title><main>slow fixture</main>'), 5_000)
      return
    }
    // A page whose document is ready at once and that never finishes loading: one image is never answered.
    if (req.method === 'GET' && url.pathname === '/never-loads.html') {
      res.statusCode = 200
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end('<!doctype html><title>Never loads</title><main><h1>Ready, still loading</h1><img src="/hang.png" alt=""></main>')
      return
    }
    if (req.method === 'GET' && url.pathname === '/hang.png') {
      res.statusCode = 200
      res.setHeader('content-type', 'image/png')
      res.flushHeaders()
      return
    }
    // A sign-in wall: 401 and a password field.
    if (req.method === 'GET' && url.pathname === '/sign-in.html') {
      res.statusCode = 401
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end('<!doctype html><title>Sign in</title><main><form><label>Email <input name="email"></label><label>Password <input type="password" name="password"></label><button>Sign in</button></form></main>')
      return
    }
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
    close: () => new Promise((resolvePromise, reject) => {
      server.close((error) => (error ? reject(error) : resolvePromise()))
      // The never-answered image would hold the server open.
      server.closeAllConnections()
    }),
    submitCount: () => submitRequests
  }
}

/** What a fixture page reported (`/report?k=…&v=…`): a value its script read, on the site that served it. */
export interface FixtureReport { site: 'parent' | 'child'; key: string; value: string; at: number }
/** A page request's identity headers, as a site sees them. */
export interface FixtureRequest { site: 'parent' | 'child'; path: string; userAgent?: string; secChUa?: string; secChUaPlatform?: string; secChUaMobile?: string }

export async function startCrossOriginFixtureSite(): Promise<{ parentOrigin: string; childOrigin: string; close: () => Promise<void>; frameSubmitCount: () => number; reports: FixtureReport[]; requests: FixtureRequest[] }> {
  let frameSubmitRequests = 0
  const reports: FixtureReport[] = []
  const requests: FixtureRequest[] = []
  let parentOrigin = ''
  /** `/report` records what a page read; a page asked for with `delayMs` is answered that much later. */
  const probe = (site: 'parent' | 'child', req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL, serve: () => void): void => {
    if (url.pathname === '/report') {
      reports.push({ site, key: url.searchParams.get('k') ?? '', value: url.searchParams.get('v') ?? '', at: Date.now() })
      res.setHeader('access-control-allow-origin', '*')
      res.end('')
      return
    }
    if (url.pathname.endsWith('.html')) {
      const header = (name: string) => { const value = req.headers[name]; return Array.isArray(value) ? value.join(', ') : value }
      requests.push({ site, path: url.pathname + url.search, userAgent: header('user-agent'), secChUa: header('sec-ch-ua'), secChUaPlatform: header('sec-ch-ua-platform'), secChUaMobile: header('sec-ch-ua-mobile') })
    }
    const delayMs = Number(url.searchParams.get('delayMs') ?? 0)
    if (delayMs > 0) setTimeout(serve, Math.min(delayMs, 20_000))
    else serve()
  }
  const serveFile = (res: import('node:http').ServerResponse, pathname: string, extraBody?: string) => {
    const relative = pathname.replace(/^\/+/, '')
    const file = join(SITE_DIR, relative)
    if (!file.startsWith(SITE_DIR) || !existsSync(file)) {
      res.statusCode = 404
      res.end('not found')
      return
    }
    res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream')
    if (extraBody === undefined) res.end(readFileSync(file))
    else res.end(extraBody)
  }
  const childServer: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'POST' && url.pathname === '/frame-submit') {
      frameSubmitRequests += 1
      res.statusCode = 200
      res.end('accepted')
      return
    }
    probe('child', req, res, url, () => {
      const pathname = url.pathname === '/' ? '/frame-child.html' : url.pathname
      const page = join(SITE_DIR, pathname.replace(/^\/+/, ''))
      if (pathname.startsWith('/automation-') && pathname.endsWith('.html') && page.startsWith(SITE_DIR) && existsSync(page)) {
        serveFile(res, pathname, readFileSync(page, 'utf8').replaceAll('__CHILD_ORIGIN__', childOrigin).replaceAll('__PARENT_ORIGIN__', parentOrigin))
        return
      }
      serveFile(res, pathname)
    })
  })
  await new Promise<void>((resolvePromise) => childServer.listen(0, resolvePromise))
  const childAddress = childServer.address() as AddressInfo
  const childOrigin = `http://foo.test:${childAddress.port}`
  const parentServer: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    probe('parent', req, res, url, () => {
      const pathname = url.pathname === '/' ? '/form.html' : url.pathname
      const page = join(SITE_DIR, pathname.replace(/^\/+/, ''))
      if (pathname.endsWith('.html') && page.startsWith(SITE_DIR) && existsSync(page)) {
        serveFile(res, pathname, readFileSync(page, 'utf8').replaceAll('__CHILD_ORIGIN__', childOrigin).replaceAll('__PARENT_ORIGIN__', parentOrigin))
        return
      }
      serveFile(res, pathname)
    })
  })
  await new Promise<void>((resolvePromise) => parentServer.listen(0, '127.0.0.1', resolvePromise))
  const parentAddress = parentServer.address() as AddressInfo
  parentOrigin = `http://127.0.0.1:${parentAddress.port}`
  return {
    parentOrigin,
    childOrigin,
    reports,
    requests,
    frameSubmitCount: () => frameSubmitRequests,
    close: async () => {
      await Promise.all([
        new Promise<void>((resolvePromise, reject) => childServer.close((error) => (error ? reject(error) : resolvePromise()))),
        new Promise<void>((resolvePromise, reject) => parentServer.close((error) => (error ? reject(error) : resolvePromise())))
      ])
    }
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

export async function createInProcessBroker(options: { artifacts?: BrowserArtifactPort; policy?: BrowserPolicyPort; chromeExtraArgs?: string[] } = {}) {
  const roots = await createBrokerHome()
  mkdirSync(roots.profileRoot, { recursive: true })
  mkdirSync(roots.artifactRoot, { recursive: true })
  const broker = new BrowserBroker({
    ...roots,
    policy: options.policy ?? createAllowHttpPolicy(),
    ...(options.artifacts ? { artifacts: options.artifacts } : {}),
    ...(options.chromeExtraArgs ? { chromeExtraArgs: options.chromeExtraArgs } : {}),
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
