import { constants, promises as fs, type Stats } from 'node:fs'
import { join } from 'node:path'
import type { ServerChannel } from 'ssh2'
import type { SftpPaths } from './paths'
import {
  OPEN_FLAG,
  PACKET,
  PacketReader,
  PacketSplitter,
  PacketWriter,
  SFTP_EXTENSIONS,
  SFTP_MAX_HANDLES,
  SFTP_MAX_PACKET,
  SFTP_MAX_TRANSFER,
  SftpProtocolError,
  STATUS,
  type FileAttributes
} from './wire'

/**
 * The SFTP subsystem of the endpoint: OpenSSH's `sftp-server` for the real file system, with the rights of the
 * user the daemon runs as. It reaches everything that user can reach; the thread's folder is where a session
 * starts, not a boundary (docs/net/threat-model.md, "Editor connections").
 *
 * Requests are answered one after another, in the order they came, as OpenSSH's server does: a `CLOSE` never
 * overtakes the `WRITE`s before it. The channel is paused while a client has more than `QUEUE_PAUSE` requests
 * waiting, so a client that sends faster than the disk takes them is slowed and the daemon holds a bounded amount.
 */

export interface SftpOptions {
  paths: SftpPaths
  /** The login name, which `home-directory` answers for. */
  user: string
  /** Called once for each request that is not an answer to the client's read of a folder: counts only, never a name. */
  onRequest?: (kind: string) => void
  /** The places above the root of the paths (the drives of a Windows computer), when the paths have a virtual root. */
  listRoots?: () => Promise<string[]>
}

const QUEUE_PAUSE = 32
const QUEUE_RESUME = 8
/** At most this many entries, and about this many bytes of names, in one `READDIR` answer. */
const READDIR_ENTRIES = 100
const READDIR_BYTES = 128 * 1024
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

type Handle =
  { kind: 'file'; file: fs.FileHandle } | { kind: 'dir'; path: string | null; names: string[] }

function statusOf(error: unknown): number {
  switch ((error as NodeJS.ErrnoException | undefined)?.code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return STATUS.NO_SUCH_FILE
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return STATUS.PERMISSION_DENIED
    default:
      return STATUS.FAILURE
  }
}

/** What `sftp` shows after "Couldn't ...": OpenSSH's server sends the text of the error. */
function messageOf(error: unknown): string {
  switch ((error as NodeJS.ErrnoException | undefined)?.code) {
    case 'ENOENT':
      return 'No such file'
    case 'ENOTDIR':
      return 'Not a directory'
    case 'EISDIR':
      return 'Is a directory'
    case 'EACCES':
    case 'EPERM':
      return 'Permission denied'
    case 'EROFS':
      return 'Read-only file system'
    case 'EEXIST':
      return 'File exists'
    case 'ENOTEMPTY':
      return 'Directory not empty'
    case 'ENOSPC':
      return 'No space left on device'
    default:
      return 'Failure'
  }
}

function attributesOf(stats: Stats): FileAttributes {
  return {
    size: stats.size,
    uid: stats.uid >= 0 ? stats.uid : 0,
    gid: stats.gid >= 0 ? stats.gid : 0,
    mode: stats.mode >>> 0,
    atime: Math.floor(stats.atimeMs / 1000),
    mtime: Math.floor(stats.mtimeMs / 1000)
  }
}

/** The `ls -l` line a v3 server sends with each name; `sftp`'s `ls -l` shows it as it is. */
function longName(name: string, stats: Stats, owner: string): string {
  const kind = stats.isDirectory() ? 'd' : stats.isSymbolicLink() ? 'l' : '-'
  const bits = 'rwxrwxrwx'
    .split('')
    .map((letter, i) => (stats.mode & (1 << (8 - i)) ? letter : '-'))
    .join('')
  const when = new Date(stats.mtimeMs)
  const stamp = `${MONTHS[when.getMonth()]} ${String(when.getDate()).padStart(2)} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
  return `${kind}${bits}    1 ${owner.padEnd(8)} ${String(Math.max(stats.gid, 0)).padEnd(8)} ${String(stats.size).padStart(8)} ${stamp} ${name}`
}

/** The flags of an `OPEN` as the numbers `open(2)` takes. */
function openFlagsOf(pflags: number): number {
  const read = (pflags & OPEN_FLAG.READ) !== 0
  const write = (pflags & OPEN_FLAG.WRITE) !== 0
  let flags = write ? (read ? constants.O_RDWR : constants.O_WRONLY) : constants.O_RDONLY
  if (pflags & OPEN_FLAG.APPEND) flags |= constants.O_APPEND
  if (pflags & OPEN_FLAG.CREAT) flags |= constants.O_CREAT
  if (pflags & OPEN_FLAG.TRUNC) flags |= constants.O_TRUNC
  if (pflags & OPEN_FLAG.EXCL) flags |= constants.O_EXCL
  return flags
}

/**
 * Serves one `sftp` subsystem channel until the client ends it or sends something that is not SFTP. When the
 * client sends EOF (which is how `sftp`, `scp` and every editor end an SFTP session), the channel ends with
 * `exit-status 0`, as `sshd` reports the exit of `sftp-server`: without it OpenSSH 10's `scp` exits 1 although
 * the file arrived, and `sftp` waits for the channel for good.
 */
export function serveSftp(channel: ServerChannel, options: SftpOptions): void {
  const { paths, user } = options
  const handles = new Map<number, Handle>()
  let nextHandle = 1
  const splitter = new PacketSplitter()
  const queue: Buffer[] = []
  let draining = false
  let closed = false
  let ended = false
  let initialised = false

  const sendPacket = async (packet: Buffer): Promise<void> => {
    if (closed) return
    if (!channel.write(packet))
      await new Promise<void>((resolve) => {
        const done = (): void => {
          channel.removeListener('drain', done)
          channel.removeListener('close', done)
          resolve()
        }
        channel.once('drain', done)
        channel.once('close', done)
      })
  }
  const status = (id: number, code: number, message = ''): Promise<void> =>
    sendPacket(
      new PacketWriter().u32(id).u32(code).string(message).string('').packet(PACKET.STATUS)
    )
  const failure = (id: number, error: unknown): Promise<void> =>
    status(id, statusOf(error), messageOf(error))
  const attributes = (id: number, value: FileAttributes): Promise<void> =>
    sendPacket(new PacketWriter().u32(id).attributes(value).packet(PACKET.ATTRS))
  const names = (
    id: number,
    entries: Array<{ name: string; long?: string; attributes?: FileAttributes }>
  ): Promise<void> => {
    const writer = new PacketWriter().u32(id).u32(entries.length)
    for (const entry of entries)
      writer
        .string(entry.name)
        .string(entry.long ?? entry.name)
        .attributes(entry.attributes ?? {})
    return sendPacket(writer.packet(PACKET.NAME))
  }
  const addHandle = (value: Handle): Buffer | undefined => {
    if (handles.size >= SFTP_MAX_HANDLES) return undefined
    const key = nextHandle++
    handles.set(key, value)
    const out = Buffer.alloc(4)
    out.writeUInt32BE(key)
    return out
  }
  const handleOf = (value: Buffer): { key: number; handle: Handle } | undefined => {
    if (value.length !== 4) return undefined
    const key = value.readUInt32BE(0)
    const handle = handles.get(key)
    return handle ? { key, handle } : undefined
  }
  /** The local path for a client path, or the answer that has been sent because it names nothing. */
  const place = async (id: number, path: string): Promise<string | undefined> => {
    const local = paths.toLocal(path)
    if (local === undefined) {
      await status(id, STATUS.NO_SUCH_FILE)
      return undefined
    }
    if (local === null) {
      await status(id, STATUS.PERMISSION_DENIED)
      return undefined
    }
    return local
  }
  const closeAll = (): void => {
    for (const handle of handles.values())
      if (handle.kind === 'file') void handle.file.close().catch(() => {})
    handles.clear()
  }
  const finish = (): void => {
    if (closed) return
    closed = true
    closeAll()
    try {
      // Reported as `sftp-server`'s exit would be; then the channel goes.
      if (ended) channel.exit(0)
      channel.end()
    } catch {
      // The channel is already gone.
    }
  }

  async function applyAttributes(
    target: string | fs.FileHandle,
    value: FileAttributes
  ): Promise<void> {
    const file = typeof target === 'string' ? undefined : target
    if (value.size !== undefined)
      await (file ? file.truncate(value.size) : fs.truncate(target as string, value.size))
    if (value.mode !== undefined)
      await (file
        ? file.chmod(value.mode & 0o7777)
        : fs.chmod(target as string, value.mode & 0o7777))
    if (value.atime !== undefined && value.mtime !== undefined)
      await (file
        ? file.utimes(value.atime, value.mtime)
        : fs.utimes(target as string, value.atime, value.mtime))
    // `uid` and `gid` are not applied: a server that does not run as root cannot, and says nothing either.
  }

  async function extended(id: number, reader: PacketReader): Promise<void> {
    const name = reader.string()
    options.onRequest?.('extended')
    switch (name) {
      case 'posix-rename@openssh.com': {
        const from = await place(id, reader.string())
        if (from === undefined) return
        const to = await place(id, reader.string())
        if (to === undefined) return
        await fs.rename(from, to)
        return void (await status(id, STATUS.OK))
      }
      case 'hardlink@openssh.com': {
        const from = await place(id, reader.string())
        if (from === undefined) return
        const to = await place(id, reader.string())
        if (to === undefined) return
        await fs.link(from, to)
        return void (await status(id, STATUS.OK))
      }
      case 'fsync@openssh.com': {
        const found = handleOf(reader.bytes())
        if (!found || found.handle.kind !== 'file') return void (await status(id, STATUS.FAILURE))
        await found.handle.file.sync()
        return void (await status(id, STATUS.OK))
      }
      case 'statvfs@openssh.com':
      case 'fstatvfs@openssh.com': {
        let local: string | undefined
        if (name === 'statvfs@openssh.com') local = await place(id, reader.string())
        else {
          // There is no `fstatfs` in Node: the path the handle was opened with is not kept, so this answers for home.
          if (!handleOf(reader.bytes())) return void (await status(id, STATUS.FAILURE))
          local = paths.home
        }
        if (local === undefined) return
        const info = await fs.statfs(local)
        const reply = new PacketWriter().u32(id)
        // f_bsize f_frsize f_blocks f_bfree f_bavail f_files f_ffree f_favail f_fsid f_flag f_namemax
        for (const value of [
          info.bsize,
          info.bsize,
          info.blocks,
          info.bfree,
          info.bavail,
          info.files,
          info.ffree,
          info.ffree,
          0,
          0,
          255
        ])
          reply.u64(Number(value))
        return void (await sendPacket(reply.packet(PACKET.EXTENDED_REPLY)))
      }
      case 'limits@openssh.com': {
        const reply = new PacketWriter()
          .u32(id)
          .u64(SFTP_MAX_PACKET)
          .u64(SFTP_MAX_TRANSFER)
          .u64(SFTP_MAX_TRANSFER)
          .u64(SFTP_MAX_HANDLES)
        return void (await sendPacket(reply.packet(PACKET.EXTENDED_REPLY)))
      }
      case 'expand-path@openssh.com': {
        const path = reader.string()
        let expanded = path
        // `~` and `~/x` are this user's home; another account's `~name` is not a place the server names.
        if (path === '~' || path.startsWith('~/'))
          expanded = paths.toRemote(paths.home) + path.slice(1)
        else if (path.startsWith('~')) return void (await status(id, STATUS.NO_SUCH_FILE))
        const local = await place(id, expanded)
        if (local === undefined) return
        return void (await names(id, [{ name: paths.toRemote(local) }]))
      }
      case 'home-directory': {
        const who = reader.string()
        if (who !== '' && who !== user) return void (await status(id, STATUS.FAILURE))
        return void (await names(id, [{ name: paths.toRemote(paths.home) }]))
      }
      default:
        return void (await status(id, STATUS.OP_UNSUPPORTED))
    }
  }

  async function handle(packet: Buffer): Promise<void> {
    const reader = new PacketReader(packet)
    const type = reader.byte()
    if (type === PACKET.INIT) {
      if (initialised) throw new SftpProtocolError('second INIT')
      initialised = true
      // The client's version and extensions are read and ignored: this server speaks version 3.
      const version = new PacketWriter().u32(3)
      for (const [name, data] of SFTP_EXTENSIONS) version.string(name).string(data)
      return sendPacket(version.packet(PACKET.VERSION))
    }
    if (!initialised) throw new SftpProtocolError('request before INIT')
    const id = reader.u32()
    try {
      switch (type) {
        case PACKET.OPEN: {
          options.onRequest?.('open')
          const local = await place(id, reader.string())
          if (local === undefined) return
          const pflags = reader.u32()
          const wanted = reader.attributes()
          if (handles.size >= SFTP_MAX_HANDLES)
            return void (await status(id, STATUS.FAILURE, 'too many handles'))
          const file = await fs.open(
            local,
            openFlagsOf(pflags),
            wanted.mode !== undefined ? wanted.mode & 0o7777 : 0o666
          )
          const out = addHandle({ kind: 'file', file })
          if (!out) {
            await file.close()
            return void (await status(id, STATUS.FAILURE, 'too many handles'))
          }
          return sendPacket(new PacketWriter().u32(id).bytes(out).packet(PACKET.HANDLE))
        }
        case PACKET.CLOSE: {
          const found = handleOf(reader.bytes())
          if (!found) return status(id, STATUS.FAILURE, 'bad handle')
          handles.delete(found.key)
          if (found.handle.kind === 'file') await found.handle.file.close()
          return status(id, STATUS.OK)
        }
        case PACKET.READ: {
          const found = handleOf(reader.bytes())
          const offset = reader.u64()
          const length = Math.min(reader.u32(), SFTP_MAX_TRANSFER)
          if (!found || found.handle.kind !== 'file')
            return status(id, STATUS.FAILURE, 'bad handle')
          const buffer = Buffer.allocUnsafe(length)
          const { bytesRead } = await found.handle.file.read(buffer, 0, length, offset)
          if (bytesRead === 0) return status(id, STATUS.EOF)
          return sendPacket(
            new PacketWriter().u32(id).bytes(buffer.subarray(0, bytesRead)).packet(PACKET.DATA)
          )
        }
        case PACKET.WRITE: {
          const found = handleOf(reader.bytes())
          const offset = reader.u64()
          const data = reader.bytes()
          if (!found || found.handle.kind !== 'file')
            return status(id, STATUS.FAILURE, 'bad handle')
          let written = 0
          while (written < data.length) {
            const { bytesWritten } = await found.handle.file.write(
              data,
              written,
              data.length - written,
              offset + written
            )
            if (bytesWritten === 0) throw Object.assign(new Error('write'), { code: 'EIO' })
            written += bytesWritten
          }
          return status(id, STATUS.OK)
        }
        case PACKET.STAT:
        case PACKET.LSTAT: {
          options.onRequest?.('stat')
          const path = reader.string()
          const local = paths.toLocal(path)
          if (local === undefined) return status(id, STATUS.NO_SUCH_FILE)
          // The virtual root above the drives is a folder with nothing to say about it.
          if (local === null)
            return attributes(id, {
              size: 0,
              uid: 0,
              gid: 0,
              mode: constants.S_IFDIR | 0o755,
              atime: 0,
              mtime: 0
            })
          return attributes(
            id,
            attributesOf(await (type === PACKET.STAT ? fs.stat(local) : fs.lstat(local)))
          )
        }
        case PACKET.FSTAT: {
          const found = handleOf(reader.bytes())
          if (!found || found.handle.kind !== 'file')
            return status(id, STATUS.FAILURE, 'bad handle')
          return attributes(id, attributesOf(await found.handle.file.stat()))
        }
        case PACKET.SETSTAT: {
          options.onRequest?.('setstat')
          const local = await place(id, reader.string())
          if (local === undefined) return
          await applyAttributes(local, reader.attributes())
          return status(id, STATUS.OK)
        }
        case PACKET.FSETSTAT: {
          const found = handleOf(reader.bytes())
          if (!found || found.handle.kind !== 'file')
            return status(id, STATUS.FAILURE, 'bad handle')
          await applyAttributes(found.handle.file, reader.attributes())
          return status(id, STATUS.OK)
        }
        case PACKET.OPENDIR: {
          options.onRequest?.('opendir')
          const path = reader.string()
          const local = paths.toLocal(path)
          if (local === undefined) return status(id, STATUS.NO_SUCH_FILE)
          if (handles.size >= SFTP_MAX_HANDLES)
            return status(id, STATUS.FAILURE, 'too many handles')
          let listing: string[]
          if (local === null) listing = (await options.listRoots?.()) ?? []
          else listing = ['.', '..', ...(await fs.readdir(local))]
          const out = addHandle({ kind: 'dir', path: local, names: listing })
          if (!out) return status(id, STATUS.FAILURE, 'too many handles')
          return sendPacket(new PacketWriter().u32(id).bytes(out).packet(PACKET.HANDLE))
        }
        case PACKET.READDIR: {
          const found = handleOf(reader.bytes())
          if (!found || found.handle.kind !== 'dir') return status(id, STATUS.FAILURE, 'bad handle')
          const dir = found.handle
          const entries: Array<{ name: string; long: string; attributes: FileAttributes }> = []
          let size = 0
          while (dir.names.length && entries.length < READDIR_ENTRIES && size < READDIR_BYTES) {
            const name = dir.names.shift()!
            try {
              const stats = await fs.lstat(dir.path === null ? `${name}\\` : join(dir.path, name))
              entries.push({
                name,
                long: longName(name, stats, String(stats.uid)),
                attributes: attributesOf(stats)
              })
              size += name.length + 120
            } catch {
              // An entry that cannot be read (a locked system file) is left out, as `sftp-server` leaves it out.
            }
          }
          if (!entries.length) return status(id, STATUS.EOF)
          return names(
            id,
            entries.map((entry) => ({
              name: entry.name,
              long: entry.long,
              attributes: entry.attributes
            }))
          )
        }
        case PACKET.REMOVE: {
          options.onRequest?.('remove')
          const local = await place(id, reader.string())
          if (local === undefined) return
          await fs.unlink(local)
          return status(id, STATUS.OK)
        }
        case PACKET.MKDIR: {
          options.onRequest?.('mkdir')
          const local = await place(id, reader.string())
          if (local === undefined) return
          const wanted = reader.attributes()
          await fs.mkdir(local, { mode: wanted.mode !== undefined ? wanted.mode & 0o7777 : 0o777 })
          return status(id, STATUS.OK)
        }
        case PACKET.RMDIR: {
          options.onRequest?.('rmdir')
          const local = await place(id, reader.string())
          if (local === undefined) return
          await fs.rmdir(local)
          return status(id, STATUS.OK)
        }
        case PACKET.REALPATH: {
          const local = paths.toLocal(reader.string())
          if (local === undefined) return status(id, STATUS.NO_SUCH_FILE)
          if (local === null) return names(id, [{ name: '/' }])
          // The real path when there is one, and the path made tidy when there is not (a file about to be created).
          const real = await fs.realpath(local).catch(() => local)
          return names(id, [{ name: paths.toRemote(real) }])
        }
        case PACKET.RENAME: {
          options.onRequest?.('rename')
          const from = await place(id, reader.string())
          if (from === undefined) return
          const to = await place(id, reader.string())
          if (to === undefined) return
          // Version 3 does not replace: a name that exists is a failure (`posix-rename` is the one that replaces).
          const exists = await fs.lstat(to).then(
            () => true,
            () => false
          )
          if (exists) return status(id, STATUS.FAILURE, 'exists')
          await fs.rename(from, to)
          return status(id, STATUS.OK)
        }
        case PACKET.READLINK: {
          const local = await place(id, reader.string())
          if (local === undefined) return
          return names(id, [{ name: await fs.readlink(local) }])
        }
        case PACKET.SYMLINK: {
          // OpenSSH's order, which the clients follow: the text the link holds, then the path of the link.
          const target = reader.string()
          const local = await place(id, reader.string())
          if (local === undefined) return
          await fs.symlink(target, local)
          return status(id, STATUS.OK)
        }
        case PACKET.EXTENDED:
          return await extended(id, reader)
        default:
          return status(id, STATUS.OP_UNSUPPORTED)
      }
    } catch (error) {
      if (error instanceof SftpProtocolError) throw error
      return failure(id, error)
    }
  }

  async function drain(): Promise<void> {
    if (draining) return
    draining = true
    try {
      while (queue.length && !closed) {
        const packet = queue.shift()!
        if (queue.length <= QUEUE_RESUME) channel.resume()
        await handle(packet)
      }
    } catch {
      // Not SFTP, or a request that cannot be read: the connection of OpenSSH's server would end here too.
      return finish()
    } finally {
      draining = false
    }
    if (ended && !queue.length) finish()
  }

  channel.on('data', (chunk: Buffer) => {
    if (closed) return
    try {
      for (const packet of splitter.push(chunk)) queue.push(packet)
    } catch {
      return finish()
    }
    if (queue.length > QUEUE_PAUSE) channel.pause()
    void drain()
  })
  channel.on('end', () => {
    ended = true
    void drain().then(() => {
      if (!queue.length && !draining) finish()
    })
  })
  channel.on('error', () => finish())
  channel.on('close', () => {
    closed = true
    closeAll()
  })
}
