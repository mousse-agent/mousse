// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fitImages, type ImageCodec, type ImageFitLimits } from '../../src/renderer/lib/imageFit'
import {
  AttachmentPreparation,
  admitAttachments,
  chipStatus,
  resizeText,
  preparedSend,
  sendBlockedReason,
  type PreparableFile
} from '../../src/renderer/lib/attachmentPreparation'
import { MESSAGE_MAX_IMAGES } from '../../src/shared/imageLimits'
import { MAX_STAGED_FILE_BYTES } from '../../src/shared/attachedFilesMarker'

/**
 * Attached images are fitted to what one message carries as they are attached. Inputs: an image already within its
 * share (sent byte for byte), a type providers don't take (BMP), one too large for its share, one with see-through
 * pixels, one that can't be decoded (HEIC), one whose share shrinks when another image is attached, and the same
 * on a thread of another computer (which takes no files).
 */

const LIMITS: ImageFitLimits = { perImage: 4000, total: 6000, maxImages: 16, maxEdge: 8000 }

/** Decodes the files named in `images` at their size; any other is undecodable. Encoding writes about w×h×quality/8 bytes. */
function codec(images: Record<string, { width: number; height: number; alpha?: boolean }>): ImageCodec & { decodes: number } {
  const state = {
    decodes: 0,
    size: async (file: Blob) => images[(file as File).name] ?? null,
    decode: async (file: Blob) => {
      const known = images[(file as File).name]
      if (!known) return null
      state.decodes += 1
      return {
        width: known.width,
        height: known.height,
        hasAlpha: known.alpha === true,
        encode: async (width: number, height: number, type: string, quality: number) =>
          new Blob([new Uint8Array(Math.ceil((width * height * quality) / 8))], { type }),
        close: () => undefined
      }
    }
  }
  return state
}

const file = (name: string, bytes: number, type: string) => new File([new Uint8Array(bytes).fill(7)], name, { type })
const attached = (id: string, f: File): PreparableFile => ({ id, file: f })

describe('fitting attached images', () => {
  it('keeps, converts, shrinks or sends as a file each image by what it is', async () => {
    const images = codec({
      'small.png': { width: 40, height: 40 },
      'scan.bmp': { width: 60, height: 60 },
      'photo.jpg': { width: 400, height: 300 },
      'logo.png': { width: 400, height: 300, alpha: true }
    })
    const rows: Array<[string, File, (result: Awaited<ReturnType<typeof fitImages>>) => void]> = [
      ['within its share: the same bytes', file('small.png', 900, 'image/png'), (result) => {
        expect(result.images[0]).toMatchObject({ changed: false, image: { name: 'small.png', mimeType: 'image/png' } })
        expect(atob(result.images[0]!.image.data).length).toBe(900)
      }],
      ['a BMP: written again as JPEG', file('scan.bmp', 900, 'image/bmp'), (result) => {
        expect(result.images[0]).toMatchObject({ changed: true, image: { name: 'scan.jpg', mimeType: 'image/jpeg' } })
      }],
      ['too large for its share: smaller until it fits', file('photo.jpg', 50_000, 'image/jpeg'), (result) => {
        const fit = result.images[0]!
        expect(fit.changed).toBe(true)
        expect(fit.image.data.length).toBeLessThanOrEqual(LIMITS.perImage)
        expect(fit.to!.width! < 400 && fit.from!.width === 400).toBe(true)
      }],
      ['see-through pixels: kept, as WebP', file('logo.png', 50_000, 'image/png'), (result) => {
        expect(result.images[0]!.image.mimeType).toBe('image/webp')
      }],
      ['undecodable: sent as a file', file('photo.heic', 900, 'image/heic'), (result) => {
        expect(result.images).toEqual([])
        expect(result.asFiles).toEqual([{ id: 'x', reason: 'unreadable' }])
      }]
    ]
    for (const [label, f, check] of rows) {
      const result = await fitImages([{ id: 'x', file: f }], images, LIMITS)
      try { check(result) } catch (error) { throw new Error(`${label}: ${(error as Error).message}`) }
    }
  })
})

describe('preparing attachments as they are attached', () => {
  const setup = (images: Parameters<typeof codec>[0]) => {
    const fake = codec(images)
    const fit = vi.fn((entries: ReadonlyArray<{ id: string; file: File }>, cache: Parameters<typeof fitImages>[3]) => fitImages(entries, fake, LIMITS, cache))
    const preparation = new AttachmentPreparation(fit)
    const settled = () => vi.waitFor(() => expect(preparation.getSnapshot().fitting).toBe(false))
    return { fake, fit, preparation, settled }
  }

  it('holds Send while preparing, then sends what was prepared without fitting again', async () => {
    const { fit, preparation, settled } = setup({ 'scan.bmp': { width: 60, height: 60 } })
    const files = [attached('a', file('scan.bmp', 900, 'image/bmp'))]
    preparation.update(files, false)
    expect(sendBlockedReason(files, preparation.getSnapshot())).toMatch(/being prepared/)
    expect(chipStatus(preparation.getSnapshot().images.get('a'), false)?.label).toBe('Preparing')
    await settled()
    expect(sendBlockedReason(files, preparation.getSnapshot())).toBeNull()
    expect(chipStatus(preparation.getSnapshot().images.get('a'), false)).toMatchObject({ label: 'Will be resized', title: expect.stringContaining('original is also attached') })

    const sent = preparedSend(files, preparation.getSnapshot())!
    expect(sent.images.map((image) => image.mimeType)).toEqual(['image/jpeg'])
    // The original goes beside it as a file, for the agent to open at full size.
    expect(sent.files.map((entry) => [entry.label ?? entry.file.name, entry.asPath === true])).toEqual([['scan.bmp', false], ['scan.bmp (original)', true]])
    preparation.update(files, false)
    expect(fit).toHaveBeenCalledTimes(1)
  })

  it('sends every inline image with its file too, so it can still be opened after a compaction; a remote thread gets none', async () => {
    const { preparation, settled } = setup({ 'small.png': { width: 40, height: 40 } })
    const files = [attached('s', file('small.png', 900, 'image/png'))]
    preparation.update(files, false)
    await settled()
    const sent = preparedSend(files, preparation.getSnapshot())!
    expect(sent.images.map((image) => image.name)).toEqual(['small.png'])
    expect(sent.files.map((entry) => [entry.label ?? entry.file.name, entry.asPath === true])).toEqual([['small.png', false], ['small.png', true]])

    const remote = setup({ 'small.png': { width: 40, height: 40 } })
    remote.preparation.update(files, true)
    await remote.settled()
    expect(preparedSend(files, remote.preparation.getSnapshot())!.files.filter((entry) => entry.asPath)).toEqual([])
  })

  it('fits existing images again when another one takes part of the message total, and their chips change', async () => {
    const { fake, preparation, settled } = setup({ 'one.png': { width: 50, height: 50 }, 'two.png': { width: 50, height: 50 } })
    const one = attached('one', file('one.png', 2700, 'image/png'))
    preparation.update([one], false)
    await settled()
    expect(preparation.getSnapshot().images.get('one')).toMatchObject({ kind: 'inline', fit: { changed: false } })
    const both = [one, attached('two', file('two.png', 2700, 'image/png'))]
    preparation.update(both, false)
    await settled()
    // Together they are past the total: the first no longer fits its share and goes smaller (its chip says so); the
    // send carries both within the total instead of failing.
    expect(chipStatus(preparation.getSnapshot().images.get('one'), false)?.label).toBe('Will be resized')
    const sent = preparedSend(both, preparation.getSnapshot())!
    expect(sent.images).toHaveLength(2)
    expect(sent.images.reduce((sum, image) => sum + image.data.length, 0)).toBeLessThanOrEqual(LIMITS.total)
    expect(fake.decodes).toBe(1)
  })

  it('sends an undecodable image as a file, and on a thread of another computer refuses Send until it is removed', async () => {
    const local = setup({})
    const heic = [attached('h', file('photo.heic', 900, 'image/heic'))]
    local.preparation.update(heic, false)
    await local.settled()
    expect(chipStatus(local.preparation.getSnapshot().images.get('h'), false)).toMatchObject({ label: 'Sent as file', noPreview: true })
    expect(preparedSend(heic, local.preparation.getSnapshot())).toMatchObject({ images: [], files: [{ id: 'h', asPath: true }] })

    const remote = setup({})
    remote.preparation.update(heic, true)
    await remote.settled()
    expect(chipStatus(remote.preparation.getSnapshot().images.get('h'), true)?.label).toBe("Can't be sent")
    expect(sendBlockedReason(heic, remote.preparation.getSnapshot())).toMatch(/photo\.heic can't be sent/)
    expect(preparedSend(heic, remote.preparation.getSnapshot())).toBeNull()
  })
})

describe('the resize tooltip', () => {
  it('names the dimensions once when only the size changed, and both when they changed too', () => {
    const mb = 1024 * 1024
    expect(resizeText({ bytes: 13.8 * mb, width: 2400, height: 2000 }, { bytes: 3.8 * mb, width: 2400, height: 2000 })).toBe('13.8 MB → 3.8 MB (2400×2000)')
    expect(resizeText({ bytes: 13.8 * mb, width: 4800, height: 4000 }, { bytes: 3.8 * mb, width: 2400, height: 2000 })).toBe('4800×4000, 13.8 MB → 2400×2000, 3.8 MB')
  })
})

describe('refusing attachments a message cannot take', () => {
  const png = (index: number) => ({ file: file(`shot-${index}.png`, 10, 'image/png') })
  const rows: Array<[string, PreparableFile[], Array<Omit<PreparableFile, 'id'>>, boolean, string | undefined]> = [
    ['an image past the message count', Array.from({ length: MESSAGE_MAX_IMAGES }, (_, index) => ({ id: `${index}`, ...png(index) })), [png(99)], false, `shot-99.png wasn't attached`],
    ['a paste larger than can be staged', [], [{ file: Object.defineProperty(file('dump.bin', 1, 'application/octet-stream'), 'size', { value: MAX_STAGED_FILE_BYTES + 1 }) }], false, 'dump.bin is larger than 200 MB'],
    ['a file for a thread on another computer', [], [{ file: file('clip.mp4', 10, 'video/mp4') }], true, `clip.mp4 wasn't attached`],
    ['an image for a thread on another computer', [], [png(1)], true, undefined],
    ['a long paste for a thread on another computer', [], [{ file: file('Pasted text.txt', 10, 'text/plain'), pastedText: true }], true, undefined]
  ]
  it.each(rows)('%s', (_label, current, incoming, remote, refusal) => {
    const result = admitAttachments(current, incoming, { remote, pathOf: () => '' })
    if (refusal) {
      expect(result.accepted).toEqual([])
      expect(result.refusal).toContain(refusal)
    } else {
      expect(result.accepted).toHaveLength(incoming.length)
      expect(result.refusal).toBeUndefined()
    }
  })
})
