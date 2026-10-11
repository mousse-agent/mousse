import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, chmodSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { open as openZip, type Entry, type ZipFile } from 'yauzl'
import { atomicWriteJsonSync } from '../../data/AtomicFs'

/** Google ACP registry release pinned by the attached implementation report. */
export const ANTIGRAVITY_RELEASE = 'agy_acp_server_1.1.1'
type Release = { url: string; sha256: string; archiveSize: number; agentSize: number; helperSize: number }
const RELEASES: Record<string, Release> = {
  'linux-x64': { url: 'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_1.1.1-linux-x86_64.zip', sha256: '38f62d01b32deb0907b3d39a71ec301fd36369f6ffd1cf262d4af385177f79df', archiveSize: 681969407, agentSize: 1880360328, helperSize: 128966920 },
  'linux-arm64': { url: 'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_1.1.1-linux-arm64.zip', sha256: 'ed69e64b308fcb123ab54bf3277bf9cb0d651064f885ea5aab0ff520c7175398', archiveSize: 656572786, agentSize: 1862073131, helperSize: 122158704 },
  'darwin-arm64': { url: 'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-agy_acp_server_1.1.1-darwin-arm64.zip', sha256: 'fdfa915652cdb7ba8085cc8fffed072cbe009251aa2c951aabdda07a8c28a189', archiveSize: 316014828, agentSize: 802163856, helperSize: 116766704 },
  'win32-x64': { url: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_1.1.1-windows-x86_64.zip', sha256: '47cb50eef14f0a4655d78cfcfda869bcea7aaee5f9787e936bc2935ea612c3b8', archiveSize: 468238392, agentSize: 430801616, helperSize: 130971800 },
  'win32-arm64': { url: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_1.1.1-windows-arm64.zip', sha256: '35f4b1f47ba6a3fea7b0a3e30010df5ea73a64b4f0e7cf991cddc673ddfbcafc', archiveSize: 468521191, agentSize: 435075816, helperSize: 122455704 }
}

const executable = (): string => process.platform === 'win32' ? 'agy_acp_server.exe' : 'agy_acp_server.par'
const helper = (): string => process.platform === 'win32' ? 'localharness_external.exe' : 'localharness_external'
export const releaseDirectory = (installationHome: string): string => join(installationHome, 'providers', 'antigravity', ANTIGRAVITY_RELEASE, `${process.platform}-${process.arch}`)

export function installedAntigravityBinary(installationHome: string): string | undefined {
  const dir = releaseDirectory(installationHome)
  const activePath = join(dirname(dir), 'active.json')
  const manifest = join(dir, 'verified.json')
  const agent = join(dir, executable())
  const harness = join(dir, helper())
  if (!existsSync(activePath) || !existsSync(manifest) || !existsSync(agent) || !existsSync(harness)) return undefined
  try {
    const active = JSON.parse(readFileSync(activePath, 'utf8')) as { version?: string; platform?: string }
    const data = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string; sha256?: string }
    const pin = RELEASES[`${process.platform}-${process.arch}`]
    if (active.version !== ANTIGRAVITY_RELEASE || active.platform !== `${process.platform}-${process.arch}`) return undefined
    if (data.version !== ANTIGRAVITY_RELEASE || data.sha256 !== pin?.sha256) return undefined
    if (statSync(agent).size !== pin.agentSize || statSync(harness).size !== pin.helperSize) return undefined
    return agent
  } catch { return undefined }
}

/** Manual installs must contain Google's matched ACP agent and local harness. */
export function validateManualAntigravityBinary(path: string): string {
  const agent = resolve(path)
  if (!existsSync(agent) || !existsSync(join(dirname(agent), helper())) || !agent.endsWith(executable())) {
    throw new Error(`Select Google's ${executable()} beside ${helper()}.`)
  }
  return agent
}

function zipOpen(path: string): Promise<ZipFile> {
  return new Promise((resolveZip, reject) => openZip(path, { lazyEntries: true, autoClose: false }, (error, zip) => error || !zip ? reject(error ?? new Error('Invalid archive')) : resolveZip(zip)))
}
function entryStream(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolveStream, reject) => zip.openReadStream(entry, (error, stream) => error || !stream ? reject(error ?? new Error('Unreadable archive entry')) : resolveStream(stream)))
}

/** Download only Google's pinned archive and publish a verified immutable release. */
export async function installAntigravity(installationHome: string, signal?: AbortSignal, progress?: (message: string) => void): Promise<string> {
  const pin = RELEASES[`${process.platform}-${process.arch}`]
  if (!pin) throw new Error('This platform is not available in the pinned Antigravity release.')
  const existing = installedAntigravityBinary(installationHome)
  if (existing) return existing
  const dir = releaseDirectory(installationHome)
  const root = dirname(dir)
  mkdirSync(root, { recursive: true })
  const temp = join(root, `.download-${crypto.randomUUID()}`)
  const staged = join(root, `.stage-${crypto.randomUUID()}`)
  mkdirSync(staged)
  try {
    progress?.('Downloading Google Antigravity ACP agent…')
    const response = await fetch(pin.url, { signal, redirect: 'error' })
    if (!response.ok || !response.body) throw new Error(`Google download failed (${response.status})`)
    const writer = createWriteStream(temp, { flags: 'wx' })
    const hash = createHash('sha256')
    let size = 0
    const reader = response.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > pin.archiveSize) throw new Error('Antigravity archive exceeds pinned size')
        hash.update(value)
        if (!writer.write(value)) await new Promise<void>((resolveDrain) => writer.once('drain', resolveDrain))
      }
    } finally { writer.end() }
    await new Promise<void>((resolveEnd, reject) => { writer.once('finish', resolveEnd); writer.once('error', reject) })
    if (size !== pin.archiveSize || hash.digest('hex') !== pin.sha256) throw new Error('Antigravity archive failed pinned size/SHA-256 verification')
    progress?.('Verifying agent and local harness…')
    const zip = await zipOpen(temp)
    try {
      const expected = new Map([[executable(), pin.agentSize], [helper(), pin.helperSize]])
      await new Promise<void>((resolveEntries, reject) => {
        zip.on('entry', (entry: Entry) => {
          const base = entry.fileName.split('/').at(-1) ?? ''
          const expectedSize = expected.get(base)
          if (expectedSize === undefined) { zip.readEntry(); return }
          if (entry.uncompressedSize !== expectedSize) { reject(new Error(`Invalid ${base} in Google archive`)); return }
          expected.delete(base)
          void (async () => {
            const source = await entryStream(zip, entry)
            const target = join(staged, base)
            await pipeline(source, createWriteStream(target, { flags: 'wx' }))
            if (statSync(target).size !== expectedSize) throw new Error(`Invalid extracted ${base} size`)
            if (process.platform !== 'win32') chmodSync(target, 0o755)
            zip.readEntry()
          })().catch(reject)
        })
        zip.once('end', () => expected.size ? reject(new Error('Google archive is missing the ACP agent or helper')) : resolveEntries())
        zip.once('error', reject)
        zip.readEntry()
      })
    } finally { zip.close() }
    atomicWriteJsonSync(join(staged, 'verified.json'), { version: ANTIGRAVITY_RELEASE, sha256: pin.sha256 })
    if (!existsSync(dir)) renameSync(staged, dir)
    atomicWriteJsonSync(join(root, 'active.json'), { version: ANTIGRAVITY_RELEASE, platform: `${process.platform}-${process.arch}` })
    return installedAntigravityBinary(installationHome) ?? (() => { throw new Error('Installed Antigravity release could not be verified') })()
  } finally {
    rmSync(temp, { force: true })
    rmSync(staged, { recursive: true, force: true })
  }
}
