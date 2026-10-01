import { ensureWindowsBrowserSandboxAccess } from '../../shared/browser/windowsSandboxPermissions.mjs'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { spawn } from 'node:child_process'
import {
  CERTIFIED_CHROME_CHANNEL,
  CERTIFIED_CHROME_DOWNLOAD_ROOT,
  CERTIFIED_CHROME_REVISION,
  CERTIFIED_CHROME_VERSION,
  CHROME_FOR_TESTING_LAST_KNOWN_GOOD,
  chromeExecutableRelPath,
  chromeForTestingPlatform
} from './platform'
import { certifiedInstallDir, certifiedMetadataPath } from './resolver'
import type { CertifiedBrowserMetadata, ChromeDownloadDescriptor } from './types'

function zipName(platform: ReturnType<typeof chromeForTestingPlatform>): string {
  switch (platform) {
    case 'win64': return 'chrome-win64.zip'
    case 'win32': return 'chrome-win32.zip'
    case 'linux64': return 'chrome-linux64.zip'
    case 'linux-arm64': return 'chrome-linux-arm64.zip'
    case 'mac-x64': return 'chrome-mac-x64.zip'
    case 'mac-arm64': return 'chrome-mac-arm64.zip'
  }
}

export function pinnedChromeDownload(): ChromeDownloadDescriptor {
  const platform = chromeForTestingPlatform()
  return {
    channel: CERTIFIED_CHROME_CHANNEL,
    version: CERTIFIED_CHROME_VERSION,
    revision: CERTIFIED_CHROME_REVISION,
    platform,
    url: `${CERTIFIED_CHROME_DOWNLOAD_ROOT}/${CERTIFIED_CHROME_VERSION}/${platform}/${zipName(platform)}`
  }
}

export async function lookupLastKnownGood(): Promise<ChromeDownloadDescriptor> {
  const platform = chromeForTestingPlatform()
  const response = await fetch(CHROME_FOR_TESTING_LAST_KNOWN_GOOD)
  if (!response.ok) throw new Error(`Chrome for Testing catalog HTTP ${response.status}`)
  const body = await response.json() as {
    channels?: Record<string, { version?: string; revision?: string; downloads?: { chrome?: Array<{ platform: string; url: string }> } }>
  }
  const stable = body.channels?.Stable
  const asset = stable?.downloads?.chrome?.find((entry) => entry.platform === platform)
  if (!stable?.version || !asset?.url) throw new Error(`Chrome for Testing Stable ${platform} is not listed in the catalog`)
  return { channel: 'Stable', version: stable.version, revision: String(stable.revision ?? ''), platform, url: asset.url }
}

async function downloadFile(url: string, destination: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`Chrome download HTTP ${response.status} from ${url}`)
  mkdirSync(dirname(destination), { recursive: true })
  const hash = createHash('sha256')
  const file = createWriteStream(destination)
  const nodeReadable = Readable.fromWeb(response.body as never)
  nodeReadable.on('data', (chunk: Buffer) => hash.update(chunk))
  await pipeline(nodeReadable, file)
  return hash.digest('hex')
}

function extractZip(zipPath: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true })
  // Linux commonly ships GNU tar, which cannot read Chrome's ZIP archives.
  const command = process.platform === 'linux' ? 'unzip' : process.platform === 'win32' ? 'tar.exe' : 'tar'
  const args = process.platform === 'linux' ? ['-q', zipPath, '-d', destDir] : ['-xf', zipPath, '-C', destDir]
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Chrome ZIP extraction (${command}) exited ${code}`))
    })
  })
}

export async function installCertifiedChrome(browserRoot: string, options: { allowCatalogFallback?: boolean } = {}): Promise<CertifiedBrowserMetadata> {
  const installDir = certifiedInstallDir(browserRoot)
  mkdirSync(installDir, { recursive: true })
  let descriptor = pinnedChromeDownload()
  const staging = join(browserRoot, 'binaries', 'staging')
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  const zipPath = join(staging, zipName(descriptor.platform))
  let sha256: string
  try {
    sha256 = await downloadFile(descriptor.url, zipPath)
  } catch (error) {
    if (!options.allowCatalogFallback) throw error
    descriptor = await lookupLastKnownGood()
    sha256 = await downloadFile(descriptor.url, zipPath)
  }
  const unpackDir = join(staging, 'unpack')
  mkdirSync(unpackDir, { recursive: true })
  await extractZip(zipPath, unpackDir)
  const executable = chromeExecutableRelPath(descriptor.platform)
  if (!existsSync(join(unpackDir, executable))) {
    throw new Error(`Extracted Chrome archive is missing ${executable}`)
  }
  ensureWindowsBrowserSandboxAccess(browserRoot, dirname(join(unpackDir, executable)))
  rmSync(installDir, { recursive: true, force: true })
  mkdirSync(dirname(installDir), { recursive: true })
  const { renameSync } = await import('node:fs')
  renameSync(unpackDir, installDir)
  const metadata: CertifiedBrowserMetadata = {
    source: 'chrome-for-testing',
    channel: descriptor.channel,
    version: descriptor.version,
    revision: descriptor.revision,
    platform: descriptor.platform,
    url: descriptor.url,
    sha256,
    executable,
    certifiedAt: new Date().toISOString()
  }
  writeFileSync(certifiedMetadataPath(browserRoot), JSON.stringify(metadata, null, 2))
  const receipt = join(browserRoot, 'binaries', `SHA256-${descriptor.version}-${descriptor.platform}.txt`)
  writeFileSync(receipt, `${sha256}  ${descriptor.url}\n`)
  rmSync(staging, { recursive: true, force: true })
  return metadata
}

export function writeProbeIntoMetadata(browserRoot: string, probe: CertifiedBrowserMetadata['probe']): CertifiedBrowserMetadata {
  const path = certifiedMetadataPath(browserRoot)
  const metadata = JSON.parse(readFileSync(path, 'utf-8')) as CertifiedBrowserMetadata
  metadata.probe = probe
  writeFileSync(path, JSON.stringify(metadata, null, 2))
  return metadata
}
