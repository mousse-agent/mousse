import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { certifiedInstallDir, certifiedMetadataPath, resolveCertifiedBrowser } from '../../../../src/browser-worker/binary/resolver'
import { REPO_ROOT } from './pin'

export const SIBLING_CORE_BROWSER_ROOT = resolve(REPO_ROOT, '..', 'core', '.mousse-dev', 'browser-binaries')
export const LOCAL_BROWSER_ROOT = join(REPO_ROOT, '.mousse-dev', 'browser-binaries')

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

function resolveSourceRoot(): ChromeSource {
  const candidates = [
    { root: SIBLING_CORE_BROWSER_ROOT, label: 'sibling-core-read-only' },
    { root: LOCAL_BROWSER_ROOT, label: 'worktree-local-read-only' }
  ]
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
    message: `Certified Chrome is not available at ${SIBLING_CORE_BROWSER_ROOT} or ${LOCAL_BROWSER_ROOT}. Q03 does not download browsers.`
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
  const artifactRoot = join(home, 'artifacts')
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
  const core = realpathSync.native(SIBLING_CORE_BROWSER_ROOT)
  const candidate = resolve(path)
  if (candidate === core || candidate.startsWith(core + '\\') || candidate.startsWith(core + '/')) {
    throw new Error('Evaluation must not write into the sibling core Chrome cache')
  }
}
