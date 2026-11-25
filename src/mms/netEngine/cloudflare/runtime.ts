import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, open, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { ensurePrivateDirectory } from '../../data/privateAcl'
import { extractArchive } from '../../harness/agents/archive'

const RELEASE = '2026.11.1'
const RELEASES = 'https://github.com/cloudflare/cloudflared/releases/download'
const MAX_BYTES = 96 * 1024 * 1024
const INSTALL_MS = 120_000
const VERSION_MS = 5_000

const ASSETS = {
  'win32-x64': ['cloudflared-windows-amd64.exe', '341deda3db5ec498a0482254d6c38c0b7cf01a30c37bb5dd95d2216d08955e35'],
  'linux-x64': ['cloudflared-linux-amd64', '97bb3b02d23a5980fc9c15a1a270e692da1923f103f920d5b16d4931d5ab55e7'],
  'linux-arm64': ['cloudflared-linux-arm64', 'b155cec3e48e489cfb8e5c602769fb8c771083018d8881d68b4d18a791567c5a'],
  'darwin-x64': ['cloudflared-darwin-amd64.tgz', '5e0403b188dfee71fbd9b995e7dc9910d61b661c52371935ab6475d41185632f'],
  'darwin-arm64': ['cloudflared-darwin-arm64.tgz', '02fe4bcf08f2c09699cff30658228a739a0c47fb75f3653d1b8772a27ade4462']
} as const

function target(): keyof typeof ASSETS | undefined {
  // Cloudflare's Windows x64 release runs on Windows 11 ARM through emulation.
  const arch = process.platform === 'win32' && process.arch === 'arm64' ? 'x64' : process.arch
  const key = `${process.platform}-${arch}`
  return Object.hasOwn(ASSETS, key) ? (key as keyof typeof ASSETS) : undefined
}

export function cloudflaredEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => {
      const name = key.toUpperCase()
      return !name.startsWith('TUNNEL_') && !['NO_AUTOUPDATE', 'NO_TLS_VERIFY'].includes(name)
    })
  )
}

function binaryVersion(binary: string, signal: AbortSignal): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(binary, ['--version'], {
      signal,
      timeout: VERSION_MS,
      maxBuffer: 16 * 1024,
      windowsHide: true,
      env: cloudflaredEnv()
    }, (error, output) => {
      resolve(error ? undefined : /\bcloudflared version (\d+\.\d+\.\d+)\b/.exec(output)?.[1])
    })
  })
}

async function download(name: string, expected: string, path: string, signal: AbortSignal): Promise<void> {
  const response = await fetch(`${RELEASES}/${RELEASE}/${name}`, { signal })
  if (!response.ok || !response.body) throw new Error('Cloudflare download failed. Try again.')
  const reader = response.body.getReader()
  const digest = createHash('sha256')
  const file = await open(path, 'wx', 0o600)
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > MAX_BYTES) throw new Error('The Cloudflare download is too large.')
      digest.update(value)
      await file.writeFile(value)
    }
    if (digest.digest('hex') !== expected) throw new Error('The Cloudflare download could not be verified.')
  } finally {
    await file.close()
    await reader.cancel().catch(() => undefined)
  }
}

/** An app-managed release changes with Mousse, so every download has an approved digest. */
export async function resolveCloudflared(directory: string, signal: AbortSignal): Promise<string> {
  const platform = target()
  if (!platform) throw new Error('Cloudflare Tunnel is unavailable on this device.')
  const releaseDir = join(directory, `${RELEASE}-${platform}`)
  const executable = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
  const installed = join(releaseDir, executable)
  const exists = (path: string) => stat(path).then((info) => info.isFile(), () => false)

  if (await exists(installed) && (await binaryVersion(installed, signal)) === RELEASE) return installed
  signal.throwIfAborted()

  ensurePrivateDirectory(directory)
  const stage = await mkdtemp(join(directory, 'install-'))
  const unpacked = join(stage, 'unpacked')
  try {
    await mkdir(unpacked)
    const [name, expected] = ASSETS[platform]
    const asset = join(stage, name)
    const installSignal = AbortSignal.any([signal, AbortSignal.timeout(INSTALL_MS)])
    await download(name, expected, asset, installSignal)
    const candidate = join(unpacked, executable)
    if (name.endsWith('.tgz')) {
      await extractArchive(asset, unpacked, {
        format: 'tar.gz',
        signal: installSignal,
        maxEntries: 20,
        maxBytes: MAX_BYTES
      })
    } else {
      await rename(asset, candidate)
    }
    if (process.platform !== 'win32') await chmod(candidate, 0o700)
    if ((await binaryVersion(candidate, installSignal)) !== RELEASE)
      throw new Error('The Cloudflare runtime did not start. Try again.')
    installSignal.throwIfAborted()
    try {
      await mkdir(releaseDir, { recursive: true })
      await rename(candidate, installed)
    } catch (error) {
      // Another profile can finish the same verified install while this one is running.
      if ((await binaryVersion(installed, installSignal)) !== RELEASE) throw error
    }
    return installed
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}
