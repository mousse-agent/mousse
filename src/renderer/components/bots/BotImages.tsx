import { useEffect, useRef, useState } from 'react'
import { Image as ImageIcon, Paperclip } from '../../lib/icons'
import type { BotChatMessage } from '../../../shared/bots/personal/chat'
import { useImageGallery } from '../../chat/components/agent-elements/image-gallery'
import { ImageLightbox, type LightboxImage } from '../../chat/components/agent-elements/image-lightbox'
import { fileLocation } from '../../utils/filesBrowse'
import { routeLink } from '../../utils/chatLinks'
import { SHOWN_IMAGE_TYPES, botImageSource, fileNameOf, isImageAttachment } from './imageSources'

/**
 * Pictures in a bot's chat, as a messaging app shows them: a rounded thumbnail in a fixed box (so nothing moves
 * when it loads), the name or alt text on hover, and a click opens the chat's preview with Previous and Next.
 */

type FileImage = { url?: string; failed?: true }

/** Image files read once per window: a chat's copies never change, so each path's picture is kept for the session. */
const fileImages = new Map<string, FileImage>()
const loading = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()

/** The picture of an image file of this computer, once read; undefined while it is read or when it can't be. */
export function botFileImageUrl(path: string): string | undefined {
  return fileImages.get(path)?.url
}

/** Reads an image file through the Files panel's preview path; only PNG, JPEG, GIF and WebP become a picture. */
function loadFileImage(path: string): Promise<void> {
  const known = loading.get(path)
  if (known) return known
  const done = (image: FileImage) => {
    fileImages.set(path, image)
    for (const listener of listeners) listener()
  }
  const at = fileLocation(path)
  const read = (async () => {
    try {
      const asset = await window.mousse.fs.readAsset(at.path, undefined, null, at.root)
      if (!SHOWN_IMAGE_TYPES.has(asset.mimeType)) return done({ failed: true })
      const bytes = Uint8Array.from(asset.data)
      done({ url: URL.createObjectURL(new Blob([bytes.buffer], { type: asset.mimeType })) })
    } catch {
      done({ failed: true })
    }
  })()
  loading.set(path, read)
  return read
}

/** An image file's picture, read once per window (the Files pane shows it too). */
export function useFileImage(path: string | undefined): FileImage | undefined {
  const [image, setImage] = useState(() => (path ? fileImages.get(path) : undefined))
  useEffect(() => {
    if (!path) return
    const update = () => setImage(fileImages.get(path))
    listeners.add(update)
    update()
    void loadFileImage(path)
    return () => { listeners.delete(update) }
  }, [path])
  return image
}

/**
 * The image files among `paths` that could not be read as a picture (gone, unreadable, or not a picture after all),
 * once each has been tried. A path still being read is not among them.
 */
export function useFailedFileImages(paths: readonly string[]): ReadonlySet<string> {
  // The paths by value: a new array with the same paths reads nothing again.
  const key = paths.join('\n')
  const current = useRef(paths)
  current.current = paths
  const failedNow = () => new Set(current.current.filter((path) => fileImages.get(path)?.failed))
  const [failed, setFailed] = useState<ReadonlySet<string>>(failedNow)
  useEffect(() => {
    const update = () => setFailed((was) => {
      const next = new Set(current.current.filter((path) => fileImages.get(path)?.failed))
      return next.size === was.size && [...next].every((path) => was.has(path)) ? was : next
    })
    listeners.add(update)
    update()
    for (const path of current.current) void loadFileImage(path)
    return () => { listeners.delete(update) }
  }, [key])
  return failed
}

/** Forgets the pictures read so far. Tests start clean. */
export function resetBotFileImages(): void {
  for (const image of fileImages.values()) if (image.url) URL.revokeObjectURL(image.url)
  fileImages.clear()
  loading.clear()
}

/**
 * One thumbnail. `url` is the picture (a file's once read, or a `data:` image); without one the box shows empty
 * (still reading, or a file not sent yet) or, when the file can't be read, its name.
 */
function Thumb({ id, url, name, failed, className }: { id: string; url?: string; name?: string; failed?: boolean; className?: string }) {
  const gallery = useImageGallery()
  const [open, setOpen] = useState(false)
  const [broken, setBroken] = useState(false)
  const label = name?.trim() || undefined
  const classes = `bot-image${className ? ` ${className}` : ''}`
  if (!url || broken) {
    return <span className={`${classes} is-empty${failed || broken ? ' is-failed' : ''}`} title={label} role={failed || broken ? 'img' : undefined} aria-label={failed || broken ? `${label ?? 'Image'} (can't be shown)` : undefined}>
      {(failed || broken) && <><ImageIcon size={16} aria-hidden /><span>{label ?? 'Image'}</span></>}
    </span>
  }
  const image: LightboxImage = { id, url, filename: label }
  return <>
    <button type="button" className={classes} title={label} aria-label={label ? `Open image: ${label}` : 'Open image'} onClick={() => (gallery ? gallery.open(image) : setOpen(true))}>
      <img src={url} alt={label ?? ''} loading="lazy" decoding="async" draggable={false} onError={() => setBroken(true)} />
    </button>
    {!gallery && <ImageLightbox open={open} onClose={() => setOpen(false)} images={[image]} />}
  </>
}

function FileThumb({ path, name, className }: { path: string; name: string; className?: string }) {
  const image = useFileImage(path || undefined)
  return <Thumb id={path} url={image?.url} name={name} failed={image?.failed} className={className} />
}

type BotFiles = NonNullable<BotChatMessage['attachments']>

/**
 * A message's attached images as thumbnails: one large, several in a small grid. A file still on its way has no
 * copy yet: its box waits empty, the size the picture will take.
 */
export function BotImageFiles({ files }: { files: BotFiles }) {
  const images = files.filter(isImageAttachment)
  if (!images.length) return null
  return <div className="bot-images" data-count={Math.min(images.length, 4)}>
    {images.map((file, index) => <FileThumb key={`${index}:${file.path || file.name}`} path={file.path} name={file.name} />)}
  </div>
}

/** A message's other files, as name pills. */
export function BotOtherFiles({ files }: { files: BotFiles }) {
  const others = files.filter((file) => !isImageAttachment(file))
  if (!others.length) return null
  return <div className="bot-you-files">{others.map((file, index) => <span key={`${index}:${file.name}`} className="bot-file-pill" title={file.path || undefined}><Paperclip size={12} aria-hidden />{file.name}</span>)}</div>
}

/**
 * An image in a message's text. A `data:` image (PNG, JPEG, GIF, WebP) or an image file of this computer shows as a
 * thumbnail; a web image is never loaded and shows as a link that opens in the browser; anything else is left out.
 */
export function BotMarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const source = botImageSource(src)
  if (source.kind === 'data') return <Thumb id={source.url} url={source.url} name={alt} className="is-inline" />
  if (source.kind === 'file') return <FileThumb path={source.path} name={alt?.trim() || fileNameOf(source.path)} className="is-inline" />
  if (source.kind === 'link') {
    const label = alt?.trim() || new URL(source.url).hostname
    return <a className="bot-image-link" href={source.url} title={source.url} onClick={(event) => { event.preventDefault(); routeLink(source.url) }}>
      <ImageIcon size={13} aria-hidden /><span>{label}</span>
    </a>
  }
  return <span className="bot-image-link is-blocked" title="This image can't be shown"><ImageIcon size={13} aria-hidden /><span>{alt?.trim() || 'Image'}</span></span>
}
