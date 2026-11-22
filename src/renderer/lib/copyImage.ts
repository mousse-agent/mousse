/**
 * Puts a picture the window shows on the clipboard as an image, so other apps paste the picture itself, not its
 * address. The window draws it (any format it can show: PNG, JPEG, GIF's first frame, WebP, SVG) and hands the main
 * process PNG bytes, which it writes with the system clipboard.
 */

/** The picture at `url` drawn as PNG bytes at its own size. */
export async function pngBytesOf(url: string): Promise<Uint8Array> {
  const image = new Image()
  await new Promise<void>((done, fail) => {
    image.onload = () => done()
    image.onerror = () => fail(new Error("This picture can't be copied."))
    image.src = url
  })
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth || image.width
  canvas.height = image.naturalHeight || image.height
  const context = canvas.getContext('2d')
  if (!context || !canvas.width || !canvas.height) throw new Error("This picture can't be copied.")
  context.drawImage(image, 0, 0)
  const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/png'))
  if (!blob) throw new Error("This picture can't be copied.")
  return new Uint8Array(await blob.arrayBuffer())
}

/** Copies the picture at `url` to the clipboard as an image. */
export async function copyImage(url: string): Promise<void> {
  await window.mousse.clipboard.writeImage(await pngBytesOf(url))
}
