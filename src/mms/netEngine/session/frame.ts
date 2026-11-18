import { NetError } from '../../../shared/net/errors'
import { engineLimits } from '../limits'

/**
 * One message on an engine stream: `u32 BE header length | JSON header | binary parts`. The header lists the
 * byte length of each part in `parts`, so a reader knows where the message ends. A message is at most
 * `maxMessageBytes` (64 KiB by default, as on v1).
 */
export interface EngineMessage {
  header: { t: string; [key: string]: unknown }
  parts: Uint8Array[]
}

export function encodeMessage(
  header: EngineMessage['header'],
  parts: readonly Uint8Array[] = []
): Uint8Array {
  if ('parts' in header) throw new NetError('bad_request', 'The header names its parts itself.')
  const json = Buffer.from(
    JSON.stringify(parts.length ? { ...header, parts: parts.map((part) => part.byteLength) } : header)
  )
  const total = 4 + json.byteLength + parts.reduce((sum, part) => sum + part.byteLength, 0)
  if (total > engineLimits().maxMessageBytes) throw new NetError('too_large')
  const out = Buffer.allocUnsafe(total)
  out.writeUInt32BE(json.byteLength, 0)
  json.copy(out, 4)
  let at = 4 + json.byteLength
  for (const part of parts) {
    out.set(part, at)
    at += part.byteLength
  }
  return out
}

/** Splits a byte stream into messages; bytes may arrive in any chunking. */
export class MessageReader {
  private buffered = Buffer.alloc(0)

  push(bytes: Uint8Array): EngineMessage[] {
    this.buffered = this.buffered.length
      ? Buffer.concat([this.buffered, bytes])
      : Buffer.from(bytes)
    const out: EngineMessage[] = []
    for (;;) {
      if (this.buffered.length < 4) return out
      const headerBytes = this.buffered.readUInt32BE(0)
      if (headerBytes > engineLimits().maxMessageBytes - 4) throw new NetError('too_large')
      if (this.buffered.length < 4 + headerBytes) return out
      let header: EngineMessage['header'] & { parts?: unknown }
      try {
        header = JSON.parse(this.buffered.subarray(4, 4 + headerBytes).toString('utf8'))
      } catch {
        throw new NetError('bad_request', 'Unreadable message header.')
      }
      if (!header || typeof header !== 'object' || typeof header.t !== 'string')
        throw new NetError('bad_request', 'Unreadable message header.')
      const sizes = header.parts === undefined ? [] : header.parts
      if (
        !Array.isArray(sizes) ||
        sizes.some((size) => !Number.isSafeInteger(size) || (size as number) < 0)
      )
        throw new NetError('bad_request', 'Unreadable message header.')
      const total = 4 + headerBytes + (sizes as number[]).reduce((sum, size) => sum + size, 0)
      if (total > engineLimits().maxMessageBytes) throw new NetError('too_large')
      if (this.buffered.length < total) return out
      const parts: Uint8Array[] = []
      let at = 4 + headerBytes
      for (const size of sizes as number[]) {
        parts.push(Uint8Array.prototype.slice.call(this.buffered, at, at + size))
        at += size
      }
      delete header.parts
      out.push({ header, parts })
      this.buffered = this.buffered.subarray(total)
    }
  }
}
