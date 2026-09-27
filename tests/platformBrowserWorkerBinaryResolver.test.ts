import { dirname, join } from 'node:path'
import {
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  renameSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserBroker } from '../src/mms/browser/BrowserBroker'
import { createAllowHttpPolicy } from '../src/mms/browser/defaultPorts'
import {
  certifiedInstallDir,
  readCertifiedMetadata,
  resolveCertifiedBrowser
} from '../src/browser-worker/binary/resolver'
import { chromeExecutableRelPath, chromeForTestingPlatform } from '../src/browser-worker/binary/platform'
import { MANAGED_BROWSER_ROOT, startFixtureSite, workerRequest } from './fixtures/browser/harness'
import {
  makeManagedBrowserTempRoot,
  removeOwnedTempRoot
} from './fixtures/agent-platform/managed-browser-drain/ownedTemp'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) removeOwnedTempRoot(root)
})

function copyAsHardlinks(source: string, target: string): void {
  const stat = lstatSync(source)
  if (stat.isSymbolicLink()) throw new Error(`Fixture Chrome contains a symlink: ${source}`)
  if (stat.isDirectory()) {
    mkdirSync(target, { recursive: true })
    for (const entry of readdirSync(source)) copyAsHardlinks(join(source, entry), join(target, entry))
    return
  }
  mkdirSync(dirname(target), { recursive: true })
  if (process.platform === 'win32') {
    copyFileSync(source, target)
    return
  }
  try {
    linkSync(source, target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    copyFileSync(source, target)
  }
}

function materializeActiveInstallerLayout(browserRoot: string): { version: string; executablePath: string } {
  const legacy = readCertifiedMetadata(MANAGED_BROWSER_ROOT)
  if (!legacy) throw new Error('Local certified Chrome fixture metadata is unavailable')
  const platform = chromeForTestingPlatform()
  const versionRoot = join(browserRoot, 'versions', `${platform}-${legacy.version}`)
  copyAsHardlinks(certifiedInstallDir(MANAGED_BROWSER_ROOT), versionRoot)
  const executableRelativePath = chromeExecutableRelPath(platform)
  const metadata = {
    source: 'injected-fixture',
    channel: legacy.channel,
    version: legacy.version,
    revision: legacy.revision,
    platform,
    url: legacy.url,
    sha256: legacy.sha256,
    hashVerified: false,
    executableRelativePath,
    installedAt: '2026-09-11T00:00:00.000Z',
    archiveBytes: 1,
    extractedBytes: 1
  }
  writeFileSync(join(versionRoot, 'mousse-browser.json'), JSON.stringify(metadata))
  mkdirSync(browserRoot, { recursive: true })
  writeFileSync(join(browserRoot, 'active.json'), JSON.stringify({
    version: legacy.version,
    platform,
    activatedAt: '2026-09-11T00:00:00.000Z'
  }))
  return { version: legacy.version, executablePath: join(versionRoot, executableRelativePath) }
}

describe('browser worker installed-binary resolver', () => {
  it('resolves the active installer layout and rejects inconsistent or oversized metadata', () => {
    const root = makeManagedBrowserTempRoot()
    roots.push(root)
    const browserRoot = join(root, 'browser')
    const installed = materializeActiveInstallerLayout(browserRoot)
    expect(resolveCertifiedBrowser(browserRoot)).toMatchObject({
      status: 'ready', executablePath: installed.executablePath,
      metadata: { version: installed.version, platform: chromeForTestingPlatform() }
    })

    const versionRoot = join(browserRoot, 'versions', `${chromeForTestingPlatform()}-${installed.version}`)
    const linkedTarget = join(browserRoot, 'linked-version-target')
    renameSync(versionRoot, linkedTarget)
    try {
      symlinkSync(linkedTarget, versionRoot, process.platform === 'win32' ? 'junction' : 'dir')
      expect(resolveCertifiedBrowser(browserRoot)).toMatchObject({ status: 'setup_required' })
      expect(resolveCertifiedBrowser(browserRoot).message).toMatch(/leaves its owned root/i)
    } finally {
      if (existsSync(versionRoot)) unlinkSync(versionRoot)
      renameSync(linkedTarget, versionRoot)
    }

    const metadataPath = join(versionRoot, 'mousse-browser.json')
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as Record<string, unknown>
    writeFileSync(metadataPath, JSON.stringify({ ...metadata, executableRelativePath: '../outside/chrome' }))
    expect(resolveCertifiedBrowser(browserRoot)).toMatchObject({ status: 'setup_required' })
    expect(resolveCertifiedBrowser(browserRoot).message).toMatch(/does not match/i)

    writeFileSync(join(browserRoot, 'active.json'), JSON.stringify({ padding: 'x'.repeat(70_000) }))
    const oversized = resolveCertifiedBrowser(browserRoot)
    expect(oversized.status).toBe('setup_required')
    expect(oversized.message).toMatch(/bounded regular file/i)
  })
})

const localChrome = existsSync(join(MANAGED_BROWSER_ROOT, 'binaries'))
  ? resolveCertifiedBrowser(MANAGED_BROWSER_ROOT)
  : { status: 'setup_required' as const, message: 'Local Chrome fixture is absent' }

describe.skipIf(localChrome.status !== 'ready')('browser worker active installer integration', () => {
  it('opens and closes a real worker session from the installer version layout', async () => {
    const root = makeManagedBrowserTempRoot()
    roots.push(root)
    const browserRoot = join(root, 'browser')
    const installed = materializeActiveInstallerLayout(browserRoot)
    const site = await startFixtureSite()
    const broker = new BrowserBroker({
      profileRoot: join(root, 'profiles'),
      browserRoot,
      artifactRoot: join(root, 'artifacts'),
      policy: createAllowHttpPolicy(),
      transport: 'in-process'
    })
    try {
      const capabilities = await broker.start()
      expect(capabilities).toMatchObject({ ready: true, setupRequired: false, version: installed.version })
      const opened = await broker.call(workerRequest('profile_installed', 'session.open', { url: `${site.origin}/form.html` }))
      expect(opened.ok).toBe(true)
      const sessionId = (opened.result as { session: { id: string } }).session.id
      await expect(broker.call(workerRequest('profile_installed', 'session.close', { sessionId })))
        .resolves.toMatchObject({ ok: true })
    } finally {
      await broker.close()
      await site.close()
    }
  }, 120_000)
})
