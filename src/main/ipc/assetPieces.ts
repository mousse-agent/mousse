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

/** Reads a preview piece by piece, as `request` answers each `offset`, and joins the pieces. */
export async function readAssetInPieces(request: (offset: number, length: number) => Promise<AssetPiece>): Promise<FileAsset> {
  const pieces: Buffer[] = []
  let received = 0
  for (;;) {
    const piece = await request(received, FILE_ASSET_PIECE_BYTES)
    const bytes = Buffer.from(piece.data, 'base64')
    pieces.push(bytes)
    received += bytes.length
    if (received >= piece.size) return { data: new Uint8Array(Buffer.concat(pieces)), mimeType: piece.mimeType, size: piece.size }
    // The file shrank while it was read: stop rather than ask for bytes that are not there.
    if (bytes.length === 0) throw new Error('The file changed while it was being read')
  }
}
