import type { FileAsset } from '../../shared/types'
import { FILE_ASSET_PIECE_BYTES } from '../../shared/fileAssets'

/** One `files.readAsset` reply: the daemon sends a preview in base64 pieces that fit a message. */
interface AssetPiece {
  mimeType: string
  /** Bytes in the whole file. */
  size: number
  /** Base64 bytes of this piece. */
  data: string
}

const CHANGED = 'The file changed while it was being read'

/** Reads a preview piece by piece, as `request` answers each `offset`, and joins the pieces. */
export async function readAssetInPieces(request: (offset: number, length: number) => Promise<AssetPiece>): Promise<FileAsset> {
  let whole: Buffer | null = null
  let received = 0
  for (;;) {
    const piece = await request(received, FILE_ASSET_PIECE_BYTES)
    // One buffer for the whole preview, filled in place (never pooled: it is sent on as it is).
    whole ??= Buffer.alloc(piece.size)
    // A file that grew or shrank between pieces would give a preview made of two versions.
    if (piece.size !== whole.length) throw new Error(CHANGED)
    const bytes = Buffer.from(piece.data, 'base64')
    if (received + bytes.length > whole.length) throw new Error(CHANGED)
    bytes.copy(whole, received)
    received += bytes.length
    if (received === whole.length) return { data: new Uint8Array(whole.buffer, whole.byteOffset, whole.length), mimeType: piece.mimeType, size: piece.size }
    // The file shrank while it was read: stop rather than ask for bytes that are not there.
    if (bytes.length === 0) throw new Error(CHANGED)
  }
}
