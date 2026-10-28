/**
 * SFTP version 3 on the wire (draft-ietf-secsh-filexfer-02, with the OpenSSH extensions the editors use).
 *
 * The endpoint writes its own SFTP packets rather than using the SFTP class of `ssh2`: that class always
 * answers `INIT` with a fixed version and no extensions, so a client cannot learn that the server can replace a
 * file by renaming it (`posix-rename`), report free space (`statvfs`) or tell how large a packet may be
 * (`limits`), and it cannot send the reply of an extension request at all.
 */

export const PACKET = {
  INIT: 1,
  VERSION: 2,
  OPEN: 3,
  CLOSE: 4,
  READ: 5,
  WRITE: 6,
  LSTAT: 7,
  FSTAT: 8,
  SETSTAT: 9,
  FSETSTAT: 10,
  OPENDIR: 11,
  READDIR: 12,
  REMOVE: 13,
  MKDIR: 14,
  RMDIR: 15,
  REALPATH: 16,
  STAT: 17,
  RENAME: 18,
  READLINK: 19,
  SYMLINK: 20,
  STATUS: 101,
  HANDLE: 102,
  DATA: 103,
  NAME: 104,
  ATTRS: 105,
  EXTENDED: 200,
  EXTENDED_REPLY: 201
} as const

export const STATUS = {
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
  BAD_MESSAGE: 5,
  NO_CONNECTION: 6,
  CONNECTION_LOST: 7,
  OP_UNSUPPORTED: 8
} as const

/** The `pflags` of an `OPEN`. */
export const OPEN_FLAG = {
  READ: 0x01,
  WRITE: 0x02,
  APPEND: 0x04,
  CREAT: 0x08,
  TRUNC: 0x10,
  EXCL: 0x20
} as const

const ATTR = { SIZE: 0x01, UIDGID: 0x02, PERMISSIONS: 0x04, ACMODTIME: 0x08, EXTENDED: 0x80000000 }

/** The largest packet the server takes or sends: what OpenSSH's own server allows, and what `limits` reports. */
export const SFTP_MAX_PACKET = 256 * 1024
/** One `READ` or `WRITE` is held to this, as `limits` tells the client. */
export const SFTP_MAX_TRANSFER = SFTP_MAX_PACKET - 1024
export const SFTP_MAX_HANDLES = 256

/** What `INIT` answers with: the extensions the server implements, each with its version. */
export const SFTP_EXTENSIONS: ReadonlyArray<readonly [string, string]> = [
  ['posix-rename@openssh.com', '1'],
  ['statvfs@openssh.com', '2'],
  ['fstatvfs@openssh.com', '2'],
  ['hardlink@openssh.com', '1'],
  ['fsync@openssh.com', '1'],
  ['limits@openssh.com', '1'],
  ['expand-path@openssh.com', '1'],
  ['home-directory', '1']
]

export interface FileAttributes {
  size?: number
  uid?: number
  gid?: number
  mode?: number
  atime?: number
  mtime?: number
}

/** A malformed packet: the connection ends, as OpenSSH's server ends it. */
export class SftpProtocolError extends Error {}

export class PacketReader {
  private position = 0
  constructor(private readonly buffer: Buffer) {}

  private need(bytes: number): void {
    if (this.position + bytes > this.buffer.length) throw new SftpProtocolError('short packet')
  }
  byte(): number {
    this.need(1)
    return this.buffer[this.position++]!
  }
  u32(): number {
    this.need(4)
    const value = this.buffer.readUInt32BE(this.position)
    this.position += 4
    return value
  }
  u64(): number {
    this.need(8)
    const value = this.buffer.readBigUInt64BE(this.position)
    this.position += 8
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new SftpProtocolError('number too large')
    return Number(value)
  }
  bytes(): Buffer {
    const length = this.u32()
    this.need(length)
    const out = this.buffer.subarray(this.position, this.position + length)
    this.position += length
    return out
  }
  string(): string {
    return this.bytes().toString('utf8')
  }
  rest(): Buffer {
    const out = this.buffer.subarray(this.position)
    this.position = this.buffer.length
    return out
  }
  done(): boolean {
    return this.position >= this.buffer.length
  }
  attributes(): FileAttributes {
    const flags = this.u32()
    const out: FileAttributes = {}
    if (flags & ATTR.SIZE) out.size = this.u64()
    if (flags & ATTR.UIDGID) {
      out.uid = this.u32()
      out.gid = this.u32()
    }
    if (flags & ATTR.PERMISSIONS) out.mode = this.u32()
    if (flags & ATTR.ACMODTIME) {
      out.atime = this.u32()
      out.mtime = this.u32()
    }
    if (flags & ATTR.EXTENDED) {
      const count = this.u32()
      if (count > 64) throw new SftpProtocolError('too many attribute extensions')
      for (let i = 0; i < count; i++) {
        this.bytes()
        this.bytes()
      }
    }
    return out
  }
}

export class PacketWriter {
  private readonly parts: Buffer[] = []
  byte(value: number): this {
    this.parts.push(Buffer.from([value]))
    return this
  }
  u32(value: number): this {
    const part = Buffer.alloc(4)
    part.writeUInt32BE(value >>> 0)
    this.parts.push(part)
    return this
  }
  u64(value: number): this {
    const part = Buffer.alloc(8)
    part.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(value))))
    this.parts.push(part)
    return this
  }
  bytes(value: Uint8Array): this {
    this.u32(value.length)
    this.parts.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
    return this
  }
  string(value: string): this {
    return this.bytes(Buffer.from(value, 'utf8'))
  }
  attributes(attributes: FileAttributes): this {
    let flags = 0
    if (attributes.size !== undefined) flags |= ATTR.SIZE
    if (attributes.uid !== undefined && attributes.gid !== undefined) flags |= ATTR.UIDGID
    if (attributes.mode !== undefined) flags |= ATTR.PERMISSIONS
    if (attributes.atime !== undefined && attributes.mtime !== undefined) flags |= ATTR.ACMODTIME
    this.u32(flags)
    if (flags & ATTR.SIZE) this.u64(attributes.size!)
    if (flags & ATTR.UIDGID) this.u32(attributes.uid!).u32(attributes.gid!)
    if (flags & ATTR.PERMISSIONS) this.u32(attributes.mode!)
    if (flags & ATTR.ACMODTIME) this.u32(attributes.atime!).u32(attributes.mtime!)
    return this
  }
  /** The finished packet: its length, its type, then the body. */
  packet(type: number): Buffer {
    const body = Buffer.concat(this.parts)
    const head = Buffer.alloc(5)
    head.writeUInt32BE(body.length + 1)
    head[4] = type
    return Buffer.concat([head, body])
  }
}

/**
 * Cuts a byte stream into packets. A length above the limit is a protocol error, so a client cannot make the
 * server hold more than one packet's worth while it waits for the rest.
 */
export class PacketSplitter {
  private pending: Buffer[] = []
  private pendingBytes = 0
  /** The size of the packet being read (its length field and its body), once the length field is in. */
  private need = 0

  push(chunk: Buffer): Buffer[] {
    this.pending.push(chunk)
    this.pendingBytes += chunk.length
    const out: Buffer[] = []
    for (;;) {
      if (!this.need) {
        if (this.pendingBytes < 4) return out
        const first = this.pending[0]!.length >= 4 ? this.pending[0]! : Buffer.concat(this.pending)
        const length = first.readUInt32BE(0)
        if (length < 1 || length > SFTP_MAX_PACKET + 1024)
          throw new SftpProtocolError('bad packet length')
        this.need = 4 + length
      }
      // A packet that arrives in pieces is joined once, when it is whole.
      if (this.pendingBytes < this.need) return out
      const buffer = this.pending.length === 1 ? this.pending[0]! : Buffer.concat(this.pending)
      out.push(buffer.subarray(4, this.need))
      const rest = buffer.subarray(this.need)
      this.pending = rest.length ? [rest] : []
      this.pendingBytes = rest.length
      this.need = 0
    }
  }
}
