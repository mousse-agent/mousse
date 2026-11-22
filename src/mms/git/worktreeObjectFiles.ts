import { createHash } from 'node:crypto'
import { lstat, open, readdir, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { inflate } from 'node:zlib'

const inflateObject = promisify(inflate)
const SHA1 = /^[0-9a-f]{40}$/
const OID_BYTES = 20
const PACK_INDEX_HEADER_BYTES = 8 + 256 * 4
// Leave unusually large loose commits and trees to Git. Both compressed and inflated reads are bounded.
const MAX_LOOSE_BYTES = 4 * 1024 * 1024
type ObjectType = 'commit' | 'tree'

async function readBytes(file: FileHandle, offset: number, size: number): Promise<Buffer> {
  const bytes = Buffer.alloc(size)
  if ((await file.read(bytes, 0, size, offset)).bytesRead !== size) throw new Error('Short Git object file')
  return bytes
}

async function withFile<T>(path: string, read: (file: FileHandle, size: number) => Promise<T>): Promise<T> {
  if (!(await lstat(path)).isFile()) throw new Error('Unexpected Git object file')
  const file = await open(path, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile() || !Number.isSafeInteger(stat.size)) throw new Error('Unexpected Git object file')
    return await read(file, stat.size)
  } finally {
    await file.close()
  }
}

/** The root tree ID of a valid loose commit, or an empty string for a valid loose tree. Undefined means no loose file. */
async function readLooseObject(objects: string, oid: string, type: ObjectType): Promise<string | undefined> {
  const path = join(objects, oid.slice(0, 2), oid.slice(2))
  return withFile(path, async (file, size) => {
    if (!size || size > MAX_LOOSE_BYTES) throw new Error('Unexpected loose Git object size')
    const bytes = await inflateObject(await readBytes(file, 0, size), { maxOutputLength: MAX_LOOSE_BYTES })
    const nul = bytes.indexOf(0)
    if (nul < 0 || bytes.subarray(0, nul).toString('latin1') !== type + ' ' + (bytes.length - nul - 1) ||
        createHash('sha1').update(bytes).digest('hex') !== oid) throw new Error('Invalid loose Git object')
    if (type === 'tree') return ''
    const newline = bytes.indexOf(10, nul + 1)
    if (newline !== nul + 46) throw new Error('Missing tree in loose Git commit')
    const treeLine = bytes.subarray(nul + 1, newline).toString('latin1')
    if (!treeLine.startsWith('tree ') || !SHA1.test(treeLine.slice(5))) throw new Error('Invalid tree in loose Git commit')
    return treeLine.slice(5)
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
}

/** Search only the OID's fanout bucket in a SHA-1 pack index v2. Read the matching entry's offset and pack identity. */
async function findPackedObject(indexPath: string, oid: Buffer): Promise<{ offset: number; count: number; checksum: Buffer } | undefined> {
  return withFile(indexPath, async (file, size) => {
    const header = await readBytes(file, 0, PACK_INDEX_HEADER_BYTES)
    if (header.readUInt32BE(0) !== 0xff744f63 || header.readUInt32BE(4) !== 2) throw new Error('Unsupported Git pack index')
    const fanout = Array.from({ length: 256 }, (_, i) => header.readUInt32BE(8 + i * 4))
    if (fanout.some((count, i) => i > 0 && count < fanout[i - 1]!)) throw new Error('Invalid Git pack index fanout')
    const count = fanout[255]!
    const offsetsStart = PACK_INDEX_HEADER_BYTES + count * (OID_BYTES + 4) // Names, then CRCs.
    const largeOffsetsStart = offsetsStart + count * 4
    const largeOffsetBytes = size - largeOffsetsStart - 2 * OID_BYTES
    if (largeOffsetBytes < 0 || largeOffsetBytes % 8 || largeOffsetBytes / 8 > count) throw new Error('Invalid Git pack index size')

    const prefix = oid[0]!
    let low = prefix === 0 ? 0 : fanout[prefix - 1]!
    let high = fanout[prefix]!
    while (low < high) {
      const mid = Math.floor((low + high) / 2)
      const candidate = await readBytes(file, PACK_INDEX_HEADER_BYTES + mid * OID_BYTES, OID_BYTES)
      const order = candidate.compare(oid)
      if (order < 0) {
        low = mid + 1
      } else if (order > 0) {
        high = mid
      } else {
        let offset = (await readBytes(file, offsetsStart + mid * 4, 4)).readUInt32BE()
        if (offset >= 0x80000000) {
          const largeOffset = (offset - 0x80000000) * 8
          if (largeOffset >= largeOffsetBytes) throw new Error('Invalid large offset in Git pack index')
          offset = Number((await readBytes(file, largeOffsetsStart + largeOffset, 8)).readBigUInt64BE())
        }
        if (!Number.isSafeInteger(offset) || offset < 12) throw new Error('Invalid Git pack offset')
        return { offset, count, checksum: await readBytes(file, size - 2 * OID_BYTES, OID_BYTES) }
      }
    }
    return undefined
  })
}

async function hasPackedObject(packDir: string, indexes: string[], oid: string, type: ObjectType): Promise<boolean> {
  const name = Buffer.from(oid, 'hex')
  for (const index of indexes) {
    const entry = await findPackedObject(join(packDir, index), name)
    if (!entry) continue
    const stem = index.slice(0, -4)
    return withFile(join(packDir, stem + '.pack'), async (file, size) => {
      if (stem !== 'pack-' + entry.checksum.toString('hex') || entry.offset >= size - OID_BYTES) return false
      const header = await readBytes(file, 0, 12)
      const version = header.readUInt32BE(4)
      if (header.toString('latin1', 0, 4) !== 'PACK' || (version !== 2 && version !== 3) || header.readUInt32BE(8) !== entry.count) return false
      if (!(await readBytes(file, size - OID_BYTES, OID_BYTES)).equals(entry.checksum)) return false
      const packType = ((await readBytes(file, entry.offset, 1))[0]! >> 4) & 7
      // Delta entries inherit their type from their base object.
      return packType === (type === 'commit' ? 1 : 2) || packType === 6 || packType === 7
    })
  }
  return false
}

/**
 * Confirm the commits still live in a checkout's own object store, after the caller has checked its layout and ruled
 * out alternates. Loose commits also have their root trees checked. Packed objects are checked through their index
 * entry and matching pack rather than unpacking deltas or walking the object graph on turn start.
 */
export async function hasLocalWorktreeCommits(commonDir: string, ...commits: string[]): Promise<boolean> {
  const objects = join(commonDir, 'objects')
  const packDir = join(objects, 'pack')
  let indexes: string[] | undefined
  const inPack = async (oid: string, type: ObjectType) => {
    indexes ??= (await readdir(packDir)).filter((name) => name.endsWith('.idx'))
    return hasPackedObject(packDir, indexes, oid, type)
  }
  try {
    const trees = new Set<string>()
    for (const commit of new Set(commits)) {
      if (!SHA1.test(commit)) return false
      const tree = await readLooseObject(objects, commit, 'commit')
      if (tree) trees.add(tree)
      else if (!await inPack(commit, 'commit')) return false
    }
    for (const tree of trees) {
      if (await readLooseObject(objects, tree, 'tree') === undefined && !await inPack(tree, 'tree')) return false
    }
    return true
  } catch {
    return false
  }
}
