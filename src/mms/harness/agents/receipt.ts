import { createHash } from 'node:crypto'
import { createReadStream, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import type { RegistryChecksum } from '../../../shared/harness/types'

/**
 * What Mousse installed for one agent version, written beside the files (`<root>/receipt.json`)
 * when the install is published and never rewritten. Every launch checks the files against it, so
 * a changed file stops the agent from running instead of running unnoticed.
 */
export interface AgentReceipt {
  agentId: string
  version: string
  /** Registry platform key (`windows-x86_64`), or `node` for npm packages. */
  platform: string
  distribution: 'binary' | 'npx'
  /** The download (binary) or the package (`name@version`, npx). */
  artifactUrl: string
  /** Where the download came from after redirects (npx: the package tarball). */
  finalUrl?: string
  /** The digest the registry published, with its algorithm. */
  expected?: { algorithm: 'sha256' | 'sha512'; digest: string }
  /** SHA-256 of the downloaded archive. */
  archiveSha256?: string
  /** Every file under `dist/`, `/`-separated, with its SHA-256 (`link:<target>` for npm's symlinks). */
  files: Record<string, string>
  /** Total size of `files`. */
  bytes: number
  /** How the agent starts: `cmd` is relative to `dist/`; `runner: 'node'` runs it with Node from PATH. */
  launch: { cmd: string; args: string[]; env: Record<string, string>; runner?: 'node' }
  checksum: RegistryChecksum
  /** When the user accepted a download without a registry checksum. */
  consentedAt?: string
  installedAt: string
}

export const RECEIPT_FILE = 'receipt.json'
export const DIST_DIR = 'dist'

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/** A file's digest (SHA-256 unless asked otherwise, hex unless asked otherwise), streamed. */
export function hashFile(path: string, signal?: AbortSignal, algorithm: 'sha256' | 'sha512' = 'sha256', encoding: 'hex' | 'base64' = 'hex'): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm)
    const stream = createReadStream(path)
    const abort = () => stream.destroy(signal?.reason instanceof Error ? signal.reason : new Error('cancelled'))
    signal?.addEventListener('abort', abort, { once: true })
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', (error) => {
      signal?.removeEventListener('abort', abort)
      reject(error)
    })
    stream.once('end', () => {
      signal?.removeEventListener('abort', abort)
      resolve(hash.digest(encoding))
    })
  })
}

interface TreeEntry {
  rel: string
  path: string
  link?: string
  /** Why a link cannot be part of an install: it points outside it, or nowhere. */
  escapes?: 'outside' | 'dangling'
  size: number
}

/**
 * Every file and link under `root`, sorted; folders are walked, never recorded, and links are
 * never followed. A link (a symlink, or a Windows junction) counts only when it resolves inside
 * `root`: whatever it points at is then a file or folder of the tree itself, hashed on its own.
 */
function walk(root: string): TreeEntry[] {
  const realRoot = realpathSync(root)
  const entries: TreeEntry[] = []
  const visit = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      const rel = prefix ? `${prefix}/${name}` : name
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) {
        let escapes: TreeEntry['escapes']
        try {
          const target = realpathSync(path)
          const inside = relative(realRoot, target)
          if (!inside || inside.startsWith('..') || isAbsolute(inside)) escapes = 'outside'
        } catch {
          escapes = 'dangling'
        }
        entries.push({ rel, path, link: readlinkSync(path), size: 0, ...(escapes ? { escapes } : {}) })
      } else if (stat.isDirectory()) visit(path, rel)
      else if (stat.isFile()) entries.push({ rel, path, size: stat.size })
      else entries.push({ rel, path, link: '\0special', size: 0 })
    }
  }
  visit(root, '')
  return entries
}

function escapeText(entry: TreeEntry): string {
  return entry.escapes === 'dangling' ? `${entry.rel} links to nothing` : `${entry.rel} links outside the install`
}

/** Digests of every file under `root` (`link:<target>` for symlinks), and their total size. */
export async function hashTree(root: string, signal?: AbortSignal): Promise<{ files: Record<string, string>; bytes: number }> {
  const files: Record<string, string> = {}
  let bytes = 0
  for (const entry of walk(root)) {
    signal?.throwIfAborted()
    if (entry.link !== undefined) {
      if (entry.link === '\0special') throw new Error(`${entry.rel} is not a regular file.`)
      if (entry.escapes) throw new Error(`${escapeText(entry)}, so Mousse cannot check what it runs.`)
      // An absolute link (a Windows junction) would point into the staging folder once published.
      if (isAbsolute(entry.link)) throw new Error(`${entry.rel} is an absolute link, which Mousse does not install.`)
      files[entry.rel] = `link:${entry.link}`
      continue
    }
    files[entry.rel] = await hashFile(entry.path, signal)
    bytes += entry.size
  }
  return { files, bytes }
}

/** Why the files under `root` no longer match the receipt, or undefined when they all do. */
export async function changedFile(root: string, receipt: Pick<AgentReceipt, 'files'>, signal?: AbortSignal): Promise<string | undefined> {
  let entries: TreeEntry[]
  try {
    entries = walk(root)
  } catch {
    return 'the install folder is missing'
  }
  const expected = new Map(Object.entries(receipt.files))
  for (const entry of entries) {
    signal?.throwIfAborted()
    const digest = expected.get(entry.rel)
    if (digest === undefined) return `${entry.rel} was added`
    expected.delete(entry.rel)
    if (entry.link !== undefined) {
      if (entry.escapes) return escapeText(entry)
      if (digest !== `link:${entry.link}`) return `${entry.rel} changed`
      continue
    }
    if (digest.startsWith('link:')) return `${entry.rel} changed`
    try {
      if ((await hashFile(entry.path, signal)) !== digest) return `${entry.rel} changed`
    } catch {
      signal?.throwIfAborted()
      return `${entry.rel} cannot be read`
    }
  }
  const missing = expected.keys().next()
  return missing.done ? undefined : `${missing.value} is missing`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** The receipt at `path` and the SHA-256 of its bytes, or undefined when it is missing or malformed. */
export function readReceipt(path: string): { receipt: AgentReceipt; hash: string } | undefined {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  try {
    const value: unknown = JSON.parse(text)
    if (!isRecord(value) || typeof value.agentId !== 'string' || typeof value.version !== 'string' || !isRecord(value.files) || !isRecord(value.launch)) return undefined
    const launch = value.launch
    if (typeof launch.cmd !== 'string' || !Array.isArray(launch.args) || !isRecord(launch.env)) return undefined
    if (Object.values(value.files).some((digest) => typeof digest !== 'string')) return undefined
    return { receipt: value as unknown as AgentReceipt, hash: sha256Hex(text) }
  } catch {
    return undefined
  }
}
