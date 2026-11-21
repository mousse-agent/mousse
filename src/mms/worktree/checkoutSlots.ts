import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { sqliteFilePath } from '../data/sqliteFilePath'
import { untilAborted } from '../git/gitPolicy'
import { volumeKey } from '../files/folderAccess'
import { runInCheckoutSlot } from './checkoutSlotProcess'

export const CHECKOUTS_PER_DISK_DEFAULT = 1
const run = promisify(execFile)

function checkoutsPerDisk(): number {
  const count = Number(process.env.MOUSSE_CHECKOUTS_PER_DISK)
  return Number.isInteger(count) && count >= 1 && count <= 16 ? count : CHECKOUTS_PER_DISK_DEFAULT
}

const WINDOWS_PARTITIONS = "Get-Partition -ErrorAction Stop | ForEach-Object { $disk = $_.DiskNumber; $_.AccessPaths | ForEach-Object { '$disk:' + $disk + ' ' + $_ } }"
let windowsPartitions: { expires: number; rows: Promise<{ key: string; root: string }[]> } | undefined

async function windowsDisk(path: string): Promise<string | undefined> {
  if (!windowsPartitions || windowsPartitions.expires <= Date.now()) {
    windowsPartitions = { expires: Date.now() + 60_000, rows: run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PARTITIONS], {
      windowsHide: true, timeout: 5000, encoding: 'utf8'
    }).then(({ stdout }) => stdout.split(/\r?\n/).flatMap((row) => {
      const match = /^\$disk:(\d+) (.+)$/.exec(row.trim())
      return match ? [{ key: 'disk:' + match[1], root: match[2]!.toLowerCase() }] : []
    }).sort((a, b) => b.root.length - a.root.length), () => []) }
  }
  const full = path.toLowerCase()
  const volume = volumeKey(path).toLowerCase()
  return (await windowsPartitions.rows).find(({ root }) => full === root || full.startsWith(root.endsWith('\\') ? root : root + '\\') || root === volume)?.key
}

async function linuxDisk(path: string): Promise<string | undefined> {
  const { dev } = await stat(path, { bigint: true })
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn)
  const minor = (dev & 0xffn) | ((dev >> 12n) & ~0xffn)
  const block = await realpath('/sys/dev/block/' + major + ':' + minor)
  // Virtual devices can have several backing disks, which a volume ID cannot distinguish.
  if (block.includes('/virtual/')) return undefined
  const partition = await stat(join(block, 'partition')).then(() => true, () => false)
  return 'block:' + basename(partition ? dirname(block) : block)
}

async function macDisk(path: string): Promise<string | undefined> {
  const { stdout: mounts } = await run('/bin/df', ['-P', path], { timeout: 5000, encoding: 'utf8' })
  const dev = /^\/dev\/disk[0-9]+(?:s[0-9]+)*\b/m.exec(mounts)?.[0]
  if (!dev) return undefined
  const { stdout: plist } = await run('/usr/sbin/diskutil', ['info', '-plist', dev], { timeout: 5000, encoding: 'utf8' })
  const stores = /<key>APFSPhysicalStores<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1]
  const disks = new Set([...stores?.matchAll(/<string>(disk[0-9]+)(?:s[0-9]+)*<\/string>/g) ?? []].map((match) => match[1]!))
  if (disks.size === 1) return disks.values().next().value
  if (disks.size > 1 || !/<key>VirtualOrPhysical<\/key>\s*<string>Physical<\/string>/.test(plist)) return undefined
  return /<key>ParentWholeDisk<\/key>\s*<string>(disk[0-9]+)<\/string>/.exec(plist)?.[1]
}

async function physicalDisk(path: string): Promise<string> {
  try {
    if (process.platform === 'win32') return await windowsDisk(await realpath(path)) ?? 'unknown'
    if (process.platform === 'darwin') return await macDisk(path) ?? 'unknown'
    if (process.platform === 'linux') return await linuxDisk(path) ?? 'unknown'
  } catch { /* Multiple unresolved volumes share the conservative fallback. */ }
  return 'unknown'
}

/**
 * The operating system shares the SQLite locks across profiles and processes. An unresolved device takes the
 * installation-wide lock exclusively because it may be any known device. Known devices share that lock and
 * take a slot of their own. Asynchronous waits let a stopped caller leave immediately.
 */
export async function withCheckoutSlot<T>(path: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  const disk = await untilAborted(physicalDisk(path), signal)
  const owner = createHash('sha256').update(homedir().toLowerCase()).digest('hex').slice(0, 16)
  const directory = join(tmpdir(), 'mousse-checkout-slots-' + owner)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const key = createHash('sha256').update(disk).digest('hex').slice(0, 16)
  const gate = sqliteFilePath(join(directory, 'devices.sqlite'))
  const slots = disk === 'unknown' ? [] : Array.from({ length: checkoutsPerDisk() }, (_, i) => sqliteFilePath(join(directory, key + '-' + i + '.sqlite')))
  return runInCheckoutSlot(path, [gate, ...slots], work, signal)
}
