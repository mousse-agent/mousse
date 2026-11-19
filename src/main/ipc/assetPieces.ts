import type { FileAsset } from '../../shared/types'
import { FILE_ASSET_PIECE_BYTES } from '../../shared/fileAssets'

/** One `files.readAsset` reply: the daemon sends a preview in base64 pieces that fit a message. */
interface AssetPiece {
  mimeType: string
  /** Bytes in the whole file. */
  size: number
  /** When the file was last written; absent from an older daemon. */
  mtimeMs?: number
  /** Base64 bytes of this piece. */
  data: string
}

const CHANGED = 'The file changed while it was being read'

/** What a file is now, without its bytes: one one-byte piece. A picture shown from an earlier read is still right while both match. */
export async function readAssetStamp(request: (offset: number, length: number) => Promise<AssetPiece>): Promise<{ size: number; mtimeMs?: number }> {
  const piece = await request(0, 1)
  return { size: piece.size, ...(typeof piece.mtimeMs === 'number' ? { mtimeMs: piece.mtimeMs } : {}) }
}

/** Reads a preview piece by piece, as `request` answers each `offset`, and joins the pieces. */
export async function readAssetInPieces(request: (offset: number, length: number) => Promise<AssetPiece>): Promise<FileAsset> {
  let whole: Buffer | null = null
  let first: AssetPiece | null = null
  let received = 0
  for (;;) {
    const piece = await request(received, FILE_ASSET_PIECE_BYTES)
    // One buffer for the whole preview, filled in place (never pooled: it is sent on as it is).
    whole ??= Buffer.alloc(piece.size)
    first ??= piece
    // A file that grew, shrank or was rewritten between pieces would give a preview made of two versions.
    if (piece.size !== whole.length || piece.mtimeMs !== first.mtimeMs) throw new Error(CHANGED)
    const bytes = Buffer.from(piece.data, 'base64')
    if (received + bytes.length > whole.length) throw new Error(CHANGED)
    bytes.copy(whole, received)
    received += bytes.length
    if (received === whole.length) return {
      data: new Uint8Array(whole.buffer, whole.byteOffset, whole.length), mimeType: piece.mimeType, size: piece.size,
      ...(typeof first.mtimeMs === 'number' ? { mtimeMs: first.mtimeMs } : {})
    }
    // The file shrank while it was read: stop rather than ask for bytes that are not there.
    if (bytes.length === 0) throw new Error(CHANGED)
  }
}
