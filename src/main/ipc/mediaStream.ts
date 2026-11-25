import { randomUUID } from 'node:crypto'
import type { CustomScheme, Session } from 'electron'
import type { AssetPiece } from './assetPieces'

export const MOUSSE_MEDIA_SCHEME = 'mousse-media'

/**
 * Scheme privileges registered before `app.whenReady()`. `stream: true` lets Chromium's media
 * pipeline issue HTTP `Range` requests (`206 Partial Content`) and seek without buffering the
 * whole video in memory.
 */
export const MOUSSE_MEDIA_SCHEME_PRIVILEGES: CustomScheme = {
  scheme: MOUSSE_MEDIA_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
    corsEnabled: true
  }
}

/** Bytes pulled per daemon `files.readAsset` request while streaming video. */
export const MEDIA_STREAM_CHUNK_BYTES = 1024 * 1024

const MAX_MEDIA_HANDLES = 64

export type ParsedByteRange =
  | { kind: 'full' }
  | { kind: 'partial'; start: number; end: number }
  | { kind: 'invalid' }

/** Parses a single HTTP `Range: bytes=...` header against a file of `size` bytes (RFC 9110). */
export function parseByteRange(header: string | null, size: number): ParsedByteRange {
  if (header === null || header.trim() === '') return { kind: 'full' }
  if (size <= 0) return { kind: 'invalid' }
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim())
  if (!match) return { kind: 'invalid' }
  const [, startText, endText] = match
  if (!startText && !endText) return { kind: 'invalid' }
  if (!startText) {
    const suffix = Number(endText)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { kind: 'invalid' }
    return { kind: 'partial', start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(startText)
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return { kind: 'invalid' }
  if (!endText) return { kind: 'partial', start, end: size - 1 }
  const rawEnd = Number(endText)
  if (!Number.isSafeInteger(rawEnd) || rawEnd < start) return { kind: 'invalid' }
  return { kind: 'partial', start, end: Math.min(rawEnd, size - 1) }
}

export interface MediaStreamEntry {
  senderId: number
  profileId: string | undefined
  mimeType: string
  size: number
  mtimeMs?: number
  readPiece: (offset: number, length: number) => Promise<AssetPiece>
}

interface StoredMediaStream extends MediaStreamEntry {
  token: string
}

function tokenFromUrl(urlOrToken: string): string | null {
  if (!urlOrToken) return null
  if (!urlOrToken.includes('://')) return urlOrToken
  try {
    const parsed = new URL(urlOrToken)
    if (parsed.protocol !== `${MOUSSE_MEDIA_SCHEME}:` || parsed.hostname !== 'asset') return null
    const token = parsed.pathname.replace(/^\/+/, '')
    return token && !token.includes('/') ? token : null
  } catch {
    return null
  }
}

/**
 * Holds opaque streaming tokens for media files opened in the Files panel.
 *
 * Each token points to a daemon-validated `files.readAsset` reader bound to one window and profile,
 * so the renderer never names raw filesystem paths to the protocol handler and isolated browser /
 * applet partitions cannot reach it.
 */
export class MediaStreamRegistry {
  private readonly handles = new Map<string, StoredMediaStream>()

  constructor(private readonly chunkBytes = MEDIA_STREAM_CHUNK_BYTES) {}

  register(entry: MediaStreamEntry): { token: string; url: string } {
    const token = randomUUID()
    if (this.handles.size >= MAX_MEDIA_HANDLES) {
      const oldest = this.handles.keys().next().value
      if (oldest) this.handles.delete(oldest)
    }
    this.handles.set(token, { ...entry, token })
    return { token, url: `${MOUSSE_MEDIA_SCHEME}://asset/${token}` }
  }

  release(urlOrToken: string, senderId?: number): boolean {
    const token = tokenFromUrl(urlOrToken)
    if (!token) return false
    const handle = this.handles.get(token)
    if (!handle) return false
    if (senderId !== undefined && handle.senderId !== senderId) return false
    this.handles.delete(token)
    return true
  }

  releaseForSender(senderId: number): void {
    for (const [token, handle] of this.handles) {
      if (handle.senderId === senderId) this.handles.delete(token)
    }
  }

  get size(): number {
    return this.handles.size
  }

  async handleRequest(
    request: Request,
    currentProfileForSender?: (senderId: number) => string | undefined
  ): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' } })
    }
    const token = tokenFromUrl(request.url)
    const handle = token ? this.handles.get(token) : undefined
    if (!handle) {
      return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } })
    }
    if (currentProfileForSender && handle.profileId !== undefined && currentProfileForSender(handle.senderId) !== handle.profileId) {
      return new Response(null, { status: 403, headers: { 'Cache-Control': 'no-store' } })
    }

    const range = parseByteRange(request.headers.get('range'), handle.size)
    if (range.kind === 'invalid') {
      return new Response(null, {
        status: 416,
        headers: {
          'Content-Range': `bytes */${handle.size}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store'
        }
      })
    }

    const start = range.kind === 'partial' ? range.start : 0
    const end = range.kind === 'partial' ? range.end : Math.max(0, handle.size - 1)
    const contentLength = handle.size === 0 ? 0 : end - start + 1
    const status = range.kind === 'partial' ? 206 : 200
    const headers: Record<string, string> = {
      'Content-Type': handle.mimeType,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(contentLength),
      'Cache-Control': 'no-store'
    }
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${handle.size}`

    if (request.method === 'HEAD' || contentLength === 0) {
      return new Response(null, { status, headers })
    }

    const chunkBytes = this.chunkBytes
    let cursor = start
    const limit = end + 1
    let cancelled = false
    const onAbort = () => { cancelled = true }
    request.signal?.addEventListener('abort', onAbort, { once: true })

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (cancelled || cursor >= limit) {
          request.signal?.removeEventListener('abort', onAbort)
          controller.close()
          return
        }
        try {
          const want = Math.min(chunkBytes, limit - cursor)
          const piece = await handle.readPiece(cursor, want)
          if (cancelled) return
          if (piece.size !== handle.size || (handle.mtimeMs !== undefined && piece.mtimeMs !== handle.mtimeMs)) {
            request.signal?.removeEventListener('abort', onAbort)
            controller.error(new Error('The file changed while streaming'))
            return
          }
          const bytes = Buffer.from(piece.data, 'base64')
          if (bytes.length === 0) {
            request.signal?.removeEventListener('abort', onAbort)
            controller.close()
            return
          }
          const slice = bytes.length > limit - cursor ? bytes.subarray(0, limit - cursor) : bytes
          cursor += slice.length
          controller.enqueue(new Uint8Array(slice.buffer, slice.byteOffset, slice.byteLength))
          if (cursor >= limit) {
            request.signal?.removeEventListener('abort', onAbort)
            controller.close()
          }
        } catch (error) {
          request.signal?.removeEventListener('abort', onAbort)
          if (!cancelled) controller.error(error)
        }
      },
      cancel() {
        cancelled = true
        request.signal?.removeEventListener('abort', onAbort)
      }
    })

    return new Response(stream, { status, headers })
  }
}

/** Registers `mousse-media://` on `targetSession` (the main window's default session only). */
export function attachMediaProtocol(
  targetSession: Session | undefined,
  registry: MediaStreamRegistry,
  currentProfileForSender: (senderId: number) => string | undefined
): void {
  if (!targetSession?.protocol?.handle) return
  if (typeof targetSession.protocol.isProtocolHandled === 'function' && targetSession.protocol.isProtocolHandled(MOUSSE_MEDIA_SCHEME)) {
    targetSession.protocol.unhandle(MOUSSE_MEDIA_SCHEME)
  }
  targetSession.protocol.handle(MOUSSE_MEDIA_SCHEME, (request) =>
    registry.handleRequest(request, currentProfileForSender)
  )
}
