/**
 * Bytes of a file preview in one `files.readAsset` reply. A preview can be 100 MB, a daemon message
 * is limited, and the bytes travel as base64 (a third larger), so a caller joins pieces of this size.
 */
export const FILE_ASSET_PIECE_BYTES = 8 * 1024 * 1024

/**
 * Bytes of a save one `files.writeDirect` request can carry. A request to the daemon is one frame of at
 * most 4 MiB, and the text travels JSON-escaped, so this is the 4 MiB less room for the rest of the request.
 */
export const FILES_WRITE_DIRECT_MAX_BYTES = 4 * 1024 * 1024 - 64 * 1024

/** Whether a save is too large for one `files.writeDirect` request, counting the bytes it takes on the wire. */
export function saveExceedsRequest(content: string): boolean {
  // Cheap bound first: JSON never shrinks a string below its UTF-16 length, and an escape-free
  // ASCII string is exactly that long.
  if (content.length > FILES_WRITE_DIRECT_MAX_BYTES) return true
  return Buffer.byteLength(JSON.stringify(content), 'utf8') > FILES_WRITE_DIRECT_MAX_BYTES
}

export const SAVE_TOO_LARGE_MESSAGE = 'This file is too large to save from the editor (the limit is about 4 MB). Nothing was written.'
