import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { unzipSync } from 'fflate'

export interface SafeExtractLimits {
  maxEntries: number
  maxExtractedBytes: number
}

export async function extractChromeZip(
  archive: Uint8Array,
  destination: string,
  limits: SafeExtractLimits
): Promise<{ entries: number; extractedBytes: number }> {
  const files = unzipSync(archive)
  const destinationRoot = resolve(destination)
  const names = Object.keys(files)
  if (names.length > limits.maxEntries) throw new Error(`Archive contains too many entries (${names.length}).`)
  let extractedBytes = 0
  for (const rawName of names) {
    const name = rawName.replaceAll('\\', '/')
    if (!name || name.includes('\u0000') || isAbsolute(name) || name.split('/').includes('..')) {
      throw new Error(`Archive entry escapes extraction root: ${rawName}`)
    }
    const target = resolve(destinationRoot, name)
    const rel = relative(destinationRoot, target)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Archive entry escapes extraction root: ${rawName}`)
    }
    const bytes = files[rawName]
    if (name.endsWith('/')) {
      await mkdir(target, { recursive: true })
      continue
    }
    extractedBytes += bytes.byteLength
    if (extractedBytes > limits.maxExtractedBytes) throw new Error('Archive extracted size exceeds the configured limit.')
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, bytes, { flag: 'wx' })
    if (process.platform !== 'win32') await chmod(target, 0o755).catch(() => undefined)
  }
  return { entries: names.length, extractedBytes }
}
