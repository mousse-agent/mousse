import { createServer, type AddressInfo, type Server } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { REPO_ROOT } from './pin'

const SHARED_SITE = join(REPO_ROOT, 'tests', 'fixtures', 'browser', 'site')
const EVAL_SITE = join(REPO_ROOT, 'tests', 'fixtures', 'browser', 'evaluation', 'site')

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
}

export interface EvaluationSite {
  origin: string
  parentOrigin: string
  childOrigin: string
  close: () => Promise<void>
  submitCount: (path?: string) => number
  frameSubmitCount: () => number
  counterSnapshot: () => EvaluationSiteCounterSnapshot
  submitDelta: (snapshot: EvaluationSiteCounterSnapshot, path?: string) => number
  frameSubmitDelta: (snapshot: EvaluationSiteCounterSnapshot) => number
}

export interface EvaluationSiteCounterSnapshot {
  submits: ReadonlyMap<string, number>
  frameSubmitRequests: number
}

function serveFile(res: import('node:http').ServerResponse, roots: string[], pathname: string, rewrite?: (body: string) => string): boolean {
  const relative = pathname === '/' ? 'form.html' : pathname.replace(/^\/+/, '')
  for (const root of roots) {
    const file = join(root, relative)
    if (!file.startsWith(root) || !existsSync(file)) continue
    res.statusCode = 200
    res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream')
    const raw = readFileSync(file)
    if (rewrite && extname(file) === '.html') res.end(rewrite(raw.toString('utf8')))
    else res.end(raw)
    return true
  }
  return false
}

export async function startEvaluationSite(): Promise<EvaluationSite> {
  const counts = new Map<string, number>()
  let frameSubmitRequests = 0
  const bump = (path: string) => counts.set(path, (counts.get(path) ?? 0) + 1)

  const childServer: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'POST' && url.pathname === '/frame-submit') {
      frameSubmitRequests += 1
      res.statusCode = 200
      res.end('accepted')
      return
    }
    if (!serveFile(res, [SHARED_SITE, EVAL_SITE], url.pathname === '/' ? '/frame-child.html' : url.pathname)) {
      res.statusCode = 404
      res.end('not found')
    }
  })
  await new Promise<void>((resolve) => childServer.listen(0, '127.0.0.1', resolve))
  const childOrigin = `http://foo.test:${(childServer.address() as AddressInfo).port}`

  const parentServer: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'POST') {
      bump(url.pathname)
      res.statusCode = 200
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.end('accepted')
      return
    }
    const rewrite = url.pathname === '/frame-parent.html'
      ? (body: string) => body.replaceAll('__CHILD_ORIGIN__', childOrigin)
      : undefined
    if (!serveFile(res, [SHARED_SITE, EVAL_SITE], url.pathname, rewrite)) {
      res.statusCode = 404
      res.end('not found')
    }
  })
  await new Promise<void>((resolve) => parentServer.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(parentServer.address() as AddressInfo).port}`

  return {
    origin,
    parentOrigin: origin,
    childOrigin,
    submitCount: (path = '/submit-once') => counts.get(path) ?? 0,
    frameSubmitCount: () => frameSubmitRequests,
    counterSnapshot: () => ({ submits: new Map(counts), frameSubmitRequests }),
    submitDelta: (snapshot, path = '/submit-once') => Math.max(0, (counts.get(path) ?? 0) - (snapshot.submits.get(path) ?? 0)),
    frameSubmitDelta: (snapshot) => Math.max(0, frameSubmitRequests - snapshot.frameSubmitRequests),
    close: async () => {
      await Promise.all([
        new Promise<void>((resolve, reject) => childServer.close((error) => (error ? reject(error) : resolve()))),
        new Promise<void>((resolve, reject) => parentServer.close((error) => (error ? reject(error) : resolve())))
      ])
    }
  }
}
