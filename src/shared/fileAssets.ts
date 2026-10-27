/**
 * Bytes of a file preview in one `files.readAsset` reply. A preview can be 100 MB, a daemon message
 * is limited, and the bytes travel as base64 (a third larger), so a caller joins pieces of this size.
 */
export const FILE_ASSET_PIECE_BYTES = 8 * 1024 * 1024

/** Characters one `files.writeDirect` save may carry: a daemon message is at most 32 MiB. */
export const FILES_WRITE_DIRECT_MAX_CHARS = 16 * 1024 * 1024
