import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { certifiedInstallDir, certifiedMetadataPath, resolveCertifiedBrowser } from '../../../../src/browser-worker/binary/resolver'
import { REPO_ROOT } from './pin'

export const SIBLING_CORE_BROWSER_ROOT = resolve(REPO_ROOT, '..', 'core', '.mousse-dev', 'browser-binaries')
export const WORKTREE_CORE_BROWSER_ROOT = resolve(REPO_ROOT, '..', 'mousse-platform-worktrees', 'core', '.mousse-dev', 'browser-binaries')
export const LOCAL_BROWSER_ROOT = join(REPO_ROOT, '.mousse-dev', 'browser-binaries')
export const CERTIFIED_BROWSER_ROOT_ENV = 'MOUSSE_CERTIFIED_BROWSER_ROOT'

export type ChromeSource =
  | {
    ok: true
    browserRoot: string
    source: string
    version: string
    sha256: string
    executablePath: string
  }
  | { ok: false; message: string }

function sourceCandidates(): Array<{ root: string; label: string }> {
  const configured = process.env[CERTIFIED_BROWSER_ROOT_ENV]?.trim()
  const candidates = [
    ...(configured ? [{ root: resolve(configured), label: 'environment-read-only' }] : []),
    { root: LOCAL_BROWSER_ROOT, label: 'repository-local-read-only' },
    { root: SIBLING_CORE_BROWSER_ROOT, label: 'sibling-core-read-only' },
    { root: WORKTREE_CORE_BROWSER_ROOT, label: 'worktree-core-read-only' }
  ]
  const seen = new Set<string>()
  return candidates.filter(({ root }) => {
    const key = resolve(root).toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function resolveSourceRoot(): ChromeSource {
  const candidates = sourceCandidates()
  for (const candidate of candidates) {
    if (!existsSync(candidate.root)) continue
    const resolved = resolveCertifiedBrowser(candidate.root)
    if (resolved.status === 'ready' && resolved.executablePath && resolved.metadata) {
      return {
        ok: true,
        browserRoot: candidate.root,
        source: candidate.label,
        version: resolved.metadata.version,
        sha256: resolved.metadata.sha256,
        executablePath: resolved.executablePath
      }
    }
  }
  return {
    ok: false,
    message: `Certified Chrome is unavailable. Checked ${candidates.map(({ root }) => root).join(', ')}. Set ${CERTIFIED_BROWSER_ROOT_ENV} to a reviewed browser-binaries root. Q03 does not download browsers.`
  }
}

function copyCertifiedTree(source: string, target: string): void {
  const stat = lstatSync(source)
  if (stat.isSymbolicLink()) throw new Error(`Certified browser contains an unexpected symlink: ${source}`)
  if (stat.isDirectory()) {
    mkdirSync(target, { recursive: true })
    for (const entry of readdirSync(source)) copyCertifiedTree(join(source, entry), join(target, entry))
    return
  }
  mkdirSync(dirname(target), { recursive: true })
  try {
    linkSync(source, target)
  } catch {
    copyFileSync(source, target)
  }
}

export function inspectChromeSource(): ChromeSource {
  return resolveSourceRoot()
}

export async function isolateCertifiedBrowser(source = inspectChromeSource()): Promise<{
  source: ChromeSource
  profileRoot: string
  browserRoot: string
  artifactRoot: string
  stageRoot: string
  home: string
}> {
  if (!source.ok) throw new Error(source.message)
  const home = await mkdtemp(join(tmpdir(), 'mousse-browser-eval-'))
  const profileRoot = join(home, 'profiles')
  const browserRoot = join(home, 'browser-root')
  const artifactRoot = join(profileRoot, 'browser', 'worker-artifacts')
  const stageRoot = join(home, 'stage')
  mkdirSync(profileRoot, { recursive: true })
  mkdirSync(artifactRoot, { recursive: true })
  mkdirSync(stageRoot, { recursive: true })
  copyCertifiedTree(realpathSync.native(certifiedInstallDir(source.browserRoot)), certifiedInstallDir(browserRoot))
  writeFileSync(certifiedMetadataPath(browserRoot), readFileSync(certifiedMetadataPath(source.browserRoot)))
  const resolved = resolveCertifiedBrowser(browserRoot)
  if (resolved.status !== 'ready') throw new Error(`Isolated certified browser did not resolve: ${resolved.message}`)
  return { source, profileRoot, browserRoot, artifactRoot, stageRoot, home }
}

export function assertNotCoreCache(path: string): void {
  const candidate = resolve(path)
  for (const source of sourceCandidates()) {
    if (!existsSync(source.root)) continue
    const readOnlyRoot = realpathSync.native(source.root)
    if (candidate === readOnlyRoot || candidate.startsWith(readOnlyRoot + '\\') || candidate.startsWith(readOnlyRoot + '/')) {
      throw new Error(`Evaluation must not write into the read-only Chrome cache: ${readOnlyRoot}`)
    }
  }
}
