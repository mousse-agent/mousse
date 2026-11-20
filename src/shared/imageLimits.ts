/**
 * What one message may carry as inline images, everywhere they travel: the composer fits images to these before a
 * send, the service's validators check them, the providers take what they allow, and a send to another computer
 * stages up to them. No Electron or Node imports: the renderer uses these too.
 *
 * The Claude API takes an image up to 10 MB of base64 (5 MB on Bedrock), at most 8000 px on a side, as JPEG, PNG,
 * GIF or WebP, and the newest models scale anything past a 2576 px long edge down themselves. A message may carry up
 * to 80 MB of images: a thread that grows past what the model takes is compacted, rather than the person refused.
 */

/** Base64 characters in one inline image. */
export const IMAGE_MAX_DATA_CHARS = 10 * 1024 * 1024
/** Bytes of image (before base64) in all of one message's inline images together: 80 MiB. */
export const MESSAGE_IMAGES_MAX_BYTES = 80 * 1024 * 1024
/** Base64 characters in all of one message's inline images together: `MESSAGE_IMAGES_MAX_BYTES` as base64. */
export const MESSAGE_IMAGES_MAX_DATA_CHARS = 4 * Math.ceil(MESSAGE_IMAGES_MAX_BYTES / 3)
/**
 * Base64 characters in all of one message's images sent to a thread on another computer. The message is shown to
 * every remote reader of that thread, whose events and snapshots are bounded (25 and 32 MiB), so it stays well under
 * them; the composer fits a remote thread's images to it.
 */
export const REMOTE_MESSAGE_IMAGES_MAX_DATA_CHARS = 8 * 1024 * 1024
/** Inline images in one message. */
export const MESSAGE_MAX_IMAGES = 16
/** Pixels on an image's longer side. */
export const IMAGE_MAX_EDGE_PX = 8000
/**
 * Base64 characters of images all of one thread's waiting messages hold together: one full message. Queued images are
 * kept in files beside `queue.json` (written once each), so a change to the queue writes only the small `queue.json`;
 * this bounds what a thread's queue holds on disk and in memory.
 */
export const QUEUE_IMAGES_MAX_DATA_CHARS = MESSAGE_IMAGES_MAX_DATA_CHARS
/**
 * Base64 characters of image data one update sent to a window keeps (a thread's queue, or messages as they are
 * written); the images past it go by name and type, and a window fetches one when it shows it (`thread.messageImage`).
 * Keeps each update, and the replay ring that holds it, small however large a message's images are.
 */
export const IMAGE_PREVIEW_DATA_CHARS = 2 * 1024 * 1024
/**
 * Base64 characters of image data a thread's transcript keeps when a window opens it: its newest images; older ones go
 * by name and type and are fetched when shown. Keeps the snapshot inside one response with 80 MB messages.
 */
export const SNAPSHOT_IMAGE_DATA_CHARS = 8 * 1024 * 1024

/**
 * Refusals of a message's images, whose messages already say what happened: an image or the images together past
 * these limits, an image of a type no provider takes, a thread's queue holding too many images, a request past what
 * the service takes.
 */
export const SIZE_ERROR_CODES: readonly string[] = ['image_too_large', 'image_unsupported', 'queue_images_full', 'request_too_large']

/** Base64 characters of all the images of `items`. */
export function imageDataChars(items: ReadonlyArray<{ images?: ReadonlyArray<{ data?: string }> }>): number {
  let chars = 0
  for (const item of items) for (const image of item.images ?? []) chars += typeof image.data === 'string' ? image.data.length : 0
  return chars
}

/** The image types every provider takes inline. */
export const INLINE_IMAGE_MIME_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']

export function isInlineImageMimeType(mimeType: string): boolean {
  return INLINE_IMAGE_MIME_TYPES.includes(mimeType.toLowerCase())
}

/** Whether a provider takes this image inline: a supported type within the per-image size. */
export function providerTakesImage(image: { mimeType: string; data: string }): boolean {
  return isInlineImageMimeType(image.mimeType) && image.data.length <= IMAGE_MAX_DATA_CHARS
}
