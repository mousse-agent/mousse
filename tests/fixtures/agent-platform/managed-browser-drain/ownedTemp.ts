import { execFileSync } from 'node:child_process'
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserBroker } from '../../../../src/mms/browser/BrowserBroker'
import { createAllowHttpPolicy } from '../../../../src/mms/browser/defaultPorts'
import { certifiedInstallDir, certifiedMetadataPath, resolveCertifiedBrowser } from '../../../../src/browser-worker/binary/resolver'
import { MANAGED_BROWSER_ROOT } from '../../browser/harness'

const fixtureDir = dirname(fileURLToPath(import.meta.url))
const REMOVE_SCRIPT = join(fixtureDir, 'remove-owned-temp.ps1')

function assertAbsoluteUnderTemp(root: string, tmp: string): string {
  if (!isAbsolute(root) || !isAbsolute(tmp)) {
    throw new Error(`owned temp paths must be absolute: root=${root} tmp=${tmp}`)
  }
  const resolvedRoot = resolve(root)
  const resolvedTmp = resolve(tmp)
  const rel = relative(resolvedTmp, resolvedRoot)
  if (rel === '') throw new Error('owned temp root must be a unique subdirectory of temp')
  if (isAbsolute(rel) || rel.split(/[/\\]/).includes('..')) {
    throw new Error(`owned temp root escapes temp: root=${resolvedRoot} tmp=${resolvedTmp}`)
  }
  return resolvedRoot
}

export function makeManagedBrowserTempRoot(): string {
  const tmp = realpathSync.native(tmpdir())
  const root = mkdtempSync(join(tmp, 'mousse-managed-browser-drain-'))
  return assertAbsoluteUnderTemp(root, tmp)
}

export function removeOwnedTempRoot(root: string): void {
  const tmp = realpathSync.native(tmpdir())
  const resolved = assertAbsoluteUnderTemp(resolve(root), tmp)
  if (process.platform === 'win32') {
    try {
      execFileSync(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', REMOVE_SCRIPT, resolved, tmp],
        { timeout: 30_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      )
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (!existsSync(resolved)) return
      throw new Error(`PowerShell owned-temp cleanup failed for ${resolved}: ${detail}`)
    }
    if (!existsSync(resolved)) return
  }
  rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

export function hardlinkCertifiedChrome(browserRoot: string): void {
  const sourceRoot = realpathSync.native(certifiedInstallDir(MANAGED_BROWSER_ROOT))
  const targetRoot = certifiedInstallDir(browserRoot)
  const copyImmutable = (source: string, target: string): void => {
    const stat = lstatSync(source)
    if (stat.isSymbolicLink()) throw new Error(`Certified browser contains an unexpected symlink: ${source}`)
    if (stat.isDirectory()) {
      mkdirSync(target, { recursive: true })
      for (const entry of readdirSync(source)) copyImmutable(join(source, entry), join(target, entry))
      return
    }
    mkdirSync(dirname(target), { recursive: true })
    linkSync(source, target)
  }
  copyImmutable(sourceRoot, targetRoot)
  mkdirSync(targetRoot, { recursive: true })
  writeFileSync(certifiedMetadataPath(browserRoot), readFileSync(certifiedMetadataPath(MANAGED_BROWSER_ROOT)))
  const resolved = resolveCertifiedBrowser(browserRoot)
  if (resolved.status !== 'ready') throw new Error(`Isolated certified browser did not resolve: ${resolved.message}`)
}

export function createDrainBroker(root: string, options: { transport?: 'in-process' | 'child-process'; workerModulePath?: string } = {}): {
  broker: BrowserBroker
  profileRoot: string
  browserRoot: string
  artifactRoot: string
} {
  const profileRoot = join(root, 'profiles')
  const browserRoot = join(root, 'browser-root')
  const artifactRoot = join(root, 'artifacts')
  mkdirSync(profileRoot, { recursive: true })
  mkdirSync(artifactRoot, { recursive: true })
  hardlinkCertifiedChrome(browserRoot)
  const broker = new BrowserBroker({
    profileRoot,
    browserRoot,
    artifactRoot,
    policy: createAllowHttpPolicy(),
    transport: options.transport ?? 'in-process',
    ...(options.workerModulePath ? { workerModulePath: options.workerModulePath } : {})
  })
  return { broker, profileRoot, browserRoot, artifactRoot }
}

export function processRecordPathFor(browserRoot: string, profileId: string, kind: { ephemeralId: string } | { workspaceId: string }): string {
  const userData = 'ephemeralId' in kind
    ? join(browserRoot, 'user-data', profileId, 'ephemeral', kind.ephemeralId)
    : join(browserRoot, 'user-data', profileId, 'workspaces', kind.workspaceId)
  return join(userData, 'mousse-owned-process.json')
}

export function readOwnedChromeRecord(path: string): { pid: number; descendants?: Array<{ pid: number }> } {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown; descendants?: Array<{ pid?: unknown }> }
  if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
    throw new Error(`invalid owned chrome pid in ${path}`)
  }
  if (parsed.pid === process.pid) throw new Error(`owned chrome pid reused the test runner pid`)
  return {
    pid: parsed.pid,
    descendants: Array.isArray(parsed.descendants)
      ? parsed.descendants.filter((item): item is { pid: number } => typeof item.pid === 'number')
      : []
  }
}
