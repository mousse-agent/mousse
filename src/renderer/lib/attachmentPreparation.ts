import { MAX_STAGED_FILE_BYTES, stagedFileTooLargeText } from '../../shared/attachedFilesMarker'
import { MESSAGE_MAX_IMAGES, REMOTE_MESSAGE_IMAGES_MAX_DATA_CHARS } from '../../shared/imageLimits'
import type { ImageAttachmentPayload } from '../utils/imageAttachments'
import {
  fitImages,
  MESSAGE_IMAGE_LIMITS,
  type AsFileReason,
  type FitCache,
  type FitResult,
  type ImageFitLimits,
  type ImageSize,
  type InlineFit
} from './imageFit'

/**
 * Attached images are made ready to send as soon as they are attached, not at Send: each is fitted to what one message
 * carries (`imageFit.ts`, in a worker) and the outcome kept by attachment, so its chip says right away whether it goes
 * as it is, smaller, or as a file, and Send only reads what was prepared. Problems that are known from the file alone
 * (too many images, a paste too large to stage, files on a thread of another computer) refuse the file at attach.
 */

/** An attached file as the composer holds it. */
export interface PreparableFile {
  id: string
  file: File
  /** Where the file already is on the thread's computer: it goes as this path. */
  path?: string
  label?: string
  /** A long text paste kept as a file. */
  pastedText?: boolean
  /** Sent as its path, not inline. */
  asPath?: boolean
}

/** What getting one attached image ready came to. */
export type ImagePreparation =
  | { kind: 'preparing' }
  /** Goes inline: as attached, or (`fit.changed`) a smaller or converted copy. */
  | { kind: 'inline'; fit: InlineFit }
  /** Goes as its file instead. */
  | { kind: 'file'; reason: AsFileReason }
  /** Can't be sent: it can't go inline, and the thread (on another computer) takes no files. */
  | { kind: 'error'; reason: AsFileReason }

export interface PreparationSnapshot {
  /** By attachment id, for each attached image. */
  readonly images: ReadonlyMap<string, ImagePreparation>
  /** The thread runs on another computer: it takes no files. */
  readonly remote: boolean
  /** A fit is running: what `images` holds may still change, so Send waits. */
  readonly fitting: boolean
}

const EMPTY: PreparationSnapshot = { images: new Map(), remote: false, fitting: false }

/** An image the composer tries to send inline: any image type but SVG (which is text an agent can read as a file). */
export function isInlineCandidate(file: File): boolean {
  const type = file.type.toLowerCase()
  return type.startsWith('image/') && !type.startsWith('image/svg')
}

/** The attached files that are prepared as images. */
export function preparedImages<T extends PreparableFile>(files: readonly T[]): T[] {
  return files.filter((attached) => !attached.asPath && !attached.path && !attached.pastedText && isInlineCandidate(attached.file))
}

export type FitFn = (images: ReadonlyArray<{ id: string; file: File }>, cache: FitCache, limits: ImageFitLimits) => Promise<FitResult>

const defaultFit: FitFn = (images, cache, limits) => fitImages(images, undefined, limits, cache)

/** What a thread on another computer takes in one message: its images together within the remote message's size. */
export const REMOTE_IMAGE_LIMITS: ImageFitLimits = {
  ...MESSAGE_IMAGE_LIMITS,
  perImage: Math.min(MESSAGE_IMAGE_LIMITS.perImage, REMOTE_MESSAGE_IMAGES_MAX_DATA_CHARS),
  total: REMOTE_MESSAGE_IMAGES_MAX_DATA_CHARS
}

/**
 * Keeps one composer's attached images prepared. `update` is called with the attached files whenever they change; a
 * change of the images (one attached or removed) fits them again, which reuses what each one came to before unless its
 * share of the message changed, and a newer change wins over one still running.
 */
export class AttachmentPreparation {
  private readonly cache: FitCache = new WeakMap()
  private readonly listeners = new Set<() => void>()
  private snapshot: PreparationSnapshot = EMPTY
  private key = ''
  private generation = 0

  constructor(private readonly fit: FitFn = defaultFit) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): PreparationSnapshot => this.snapshot

  update(files: readonly PreparableFile[], remote: boolean): void {
    const images = preparedImages(files)
    const key = `${remote ? 'remote' : 'local'}|${images.map((image) => image.id).join('|')}`
    if (key === this.key) return
    this.key = key
    const generation = ++this.generation
    // What each image still attached came to stays shown while the new fit runs; a new image shows as preparing.
    const shown = new Map<string, ImagePreparation>()
    for (const image of images) shown.set(image.id, this.snapshot.images.get(image.id) ?? { kind: 'preparing' })
    this.publish({ images: shown, remote, fitting: images.length > 0 })
    if (!images.length) return
    const entries = images.map(({ id, file }) => ({ id, file }))
    void this.fit(entries, this.cache, remote ? REMOTE_IMAGE_LIMITS : MESSAGE_IMAGE_LIMITS).then(
      (result) => {
        if (generation !== this.generation) return
        const next = new Map<string, ImagePreparation>()
        for (const fit of result.images) next.set(fit.id, { kind: 'inline', fit })
        for (const { id, reason } of result.asFiles) next.set(id, remote ? { kind: 'error', reason } : { kind: 'file', reason })
        this.publish({ images: next, remote, fitting: false })
      },
      () => {
        if (generation !== this.generation) return
        const next = new Map<string, ImagePreparation>()
        for (const { id } of entries) next.set(id, remote ? { kind: 'error', reason: 'unreadable' } : { kind: 'file', reason: 'unreadable' })
        this.publish({ images: next, remote, fitting: false })
      }
    )
  }

  private publish(snapshot: PreparationSnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}

/** What one attached image's preparation came to so far. */
function preparationOf(snapshot: PreparationSnapshot, id: string): ImagePreparation {
  return snapshot.images.get(id) ?? { kind: 'preparing' }
}

/** Why Send waits or is refused: an image still being prepared, or one that can't be sent; null when it can send. */
export function sendBlockedReason(files: readonly PreparableFile[], snapshot: PreparationSnapshot): string | null {
  const images = preparedImages(files)
  let preparing = snapshot.fitting && images.length > 0
  for (const attached of images) {
    const state = preparationOf(snapshot, attached.id)
    if (state.kind === 'error') return `${attached.label ?? attached.file.name} can't be sent. Remove it to send.`
    if (state.kind === 'preparing') preparing = true
  }
  return preparing ? 'Images are still being prepared.' : null
}

/**
 * The message's files and inline images from what was prepared, without fitting anything again. Every inline image is
 * followed by its file, so the agent can still open it once a compaction drops the image: one sent as attached under
 * its own name, one made smaller as its original (named "(original)"). Not for a thread of another computer, which
 * takes no files. One that goes as a file is sent as its path. Null while any image is not ready to send.
 */
export function preparedSend<T extends PreparableFile>(
  files: readonly T[],
  snapshot: PreparationSnapshot
): { files: T[]; images: ImageAttachmentPayload[] } | null {
  if (sendBlockedReason(files, snapshot) !== null) return null
  const candidates = new Set(preparedImages(files).map((attached) => attached.id))
  const out: T[] = []
  const images: ImageAttachmentPayload[] = []
  for (const attached of files) {
    if (!candidates.has(attached.id)) {
      out.push(attached)
      continue
    }
    const state = preparationOf(snapshot, attached.id)
    if (state.kind === 'file') {
      out.push({ ...attached, asPath: true })
      continue
    }
    if (state.kind !== 'inline') return null
    out.push(attached)
    images.push(state.fit.image)
    if (!snapshot.remote) {
      const name = attached.label ?? attached.file.name
      out.push({ ...attached, id: `${attached.id}:file`, asPath: true, label: state.fit.changed ? `${name} (original)` : name })
    }
  }
  return { files: out, images }
}

function megabytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

const dimensions = (size: ImageSize | undefined): string => (size?.width && size.height ? `${size.width}×${size.height}` : '')

/** What a resize changed: "13.8 MB → 3.8 MB (2400×2000)" when only the size did, both dimensions when they changed too. */
export function resizeText(from: ImageSize | undefined, to: ImageSize | undefined): string {
  const before = dimensions(from)
  const after = dimensions(to)
  const bytes = `${from ? megabytes(from.bytes) : '?'} → ${to ? megabytes(to.bytes) : '?'}`
  if (before === after) return before ? `${bytes} (${before})` : bytes
  return `${before || '?'}, ${from ? megabytes(from.bytes) : '?'} → ${after || '?'}, ${to ? megabytes(to.bytes) : '?'}`
}

const FILE_REASONS: Record<AsFileReason, string> = {
  unreadable: "This image can't be read here",
  too_large: "Even made smaller, it doesn't fit in one message",
  too_many: `A message takes at most ${MESSAGE_MAX_IMAGES} images`
}

/**
 * What an attached image's chip shows: a short line that fits the chip and its tooltip; nothing once it is ready as it
 * is. `noPreview`: the image can't be read here, so the chip is a file chip, not a broken thumbnail.
 */
export interface ChipStatus {
  tone: 'pending' | 'info' | 'error'
  label: string
  title: string
  noPreview?: boolean
}

export function chipStatus(state: ImagePreparation | undefined, remote: boolean): ChipStatus | undefined {
  if (!state) return undefined
  const noPreview = (state.kind === 'file' || state.kind === 'error') && state.reason === 'unreadable' ? { noPreview: true } : {}
  switch (state.kind) {
    case 'preparing':
      return { tone: 'pending', label: 'Preparing', title: 'Getting it ready to send.' }
    case 'inline':
      if (!state.fit.changed) return undefined
      return {
        tone: 'info',
        label: 'Will be resized',
        title: `${resizeText(state.fit.from, state.fit.to)}.${remote ? '' : ' The original is also attached as a file.'}`
      }
    case 'file':
      return { tone: 'info', label: 'Sent as file', title: `${FILE_REASONS[state.reason]}, so the agent gets it as a file.`, ...noPreview }
    case 'error':
      return { tone: 'error', label: "Can't be sent", title: `${FILE_REASONS[state.reason]}, and a thread on another computer takes no files.`, ...noPreview }
  }
}

/**
 * Of the files being attached, those the composer takes, and a line naming the first one it refused: past the
 * message's image count, a paste larger than can be staged (`MAX_STAGED_FILE_BYTES`), or a file for a thread on another
 * computer (which takes images and long pastes only). `pathOf` is the file's own path on this computer ('' for a paste).
 */
export function admitAttachments<T extends Omit<PreparableFile, 'id'>>(
  current: readonly PreparableFile[],
  incoming: readonly T[],
  options: { remote: boolean; pathOf?: (file: File) => string }
): { accepted: T[]; refusal?: string } {
  const accepted: T[] = []
  const refused: string[] = []
  let images = preparedImages(current).length
  const pathOf = options.pathOf ?? ((file: File) => window.mousse?.fileDrag?.pathOf?.(file) ?? '')
  for (const attached of incoming) {
    const name = attached.label ?? attached.file.name
    const image = !attached.path && !attached.pastedText && isInlineCandidate(attached.file)
    if (attached.pastedText) {
      accepted.push(attached)
      continue
    }
    if (options.remote && !image) {
      refused.push(`${name} wasn't attached: threads on another computer take images only.`)
      continue
    }
    if (image && images >= MESSAGE_MAX_IMAGES) {
      refused.push(`${name} wasn't attached: a message takes at most ${MESSAGE_MAX_IMAGES} images.`)
      continue
    }
    if (!attached.path && attached.file.size > MAX_STAGED_FILE_BYTES && !pathOf(attached.file)) {
      refused.push(stagedFileTooLargeText(name))
      continue
    }
    if (image) images += 1
    accepted.push(attached)
  }
  if (!refused.length) return { accepted }
  return { accepted, refusal: refused.length === 1 ? refused[0] : `${refused[0]} (${refused.length - 1} more not attached)` }
}
