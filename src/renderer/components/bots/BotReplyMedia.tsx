import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, Download, FolderOpen } from '../../lib/icons'
import { FloatingPortal } from '../../lib/floatingLayer'
import { useImageGallery } from '../../chat/components/agent-elements/image-gallery'
import type { LightboxImage } from '../../chat/components/agent-elements/image-lightbox'
import { botFileImageUrl, useFileImage } from './BotImages'
import { fileActions, useBotFiles } from './BotFiles'
import type { ReplyImage } from './botReplyImages'
// The app's shared row menu, which the picture's right-click menu is.
import '../integrations/rowMenu.css'

/**
 * A bot's pictures as a messenger shows them: above the reply's words, one at a good size, several side by side in a
 * carousel that scrolls with snap (arrows on hover, Left and Right once it has the focus, "2/4" while they don't all
 * fit). A click opens the app's preview, which steps through the reply's pictures and offers Save and Show in folder;
 * a right-click (or the menu key) offers Open, Save as…, Show in folder and Copy image.
 */

/** The picture's address once it can show: a file's once read, a `data:` image's own. */
const urlOf = (image: ReplyImage, read?: string) => image.url ?? read
/** The reply's pictures that can show now, for the preview's Previous and Next. */
const lightboxSet = (images: readonly ReplyImage[]): LightboxImage[] => images.flatMap((image) => {
  const url = image.url ?? (image.path ? botFileImageUrl(image.path) : undefined)
  return url ? [{ id: image.key, url, filename: image.name, ...(image.path ? { path: image.path } : {}) }] : []
})

/** Save and Show in folder beside the preview's Close, for a picture that is a file of this computer. */
export function BotPictureActions({ image }: { image: LightboxImage }) {
  const host = useBotFiles()
  if (!image.path) return null
  const path = image.path
  const look = 'inline-flex h-9 items-center gap-1.5 rounded-full bg-white/10 px-3 text-xs font-medium text-white/85 transition-colors hover:bg-white/20 hover:text-white focus-visible:bg-white/25 outline-none'
  return <>
    <button type="button" className={look} aria-label="Save" title="Save a copy" onClick={() => fileActions.saveAs(path, host?.failed)}><Download size={14} aria-hidden />Save</button>
    <button type="button" className={look} aria-label="Show in folder" title="Show in folder" onClick={() => fileActions.showInFolder(path, host?.failed)}><FolderOpen size={14} aria-hidden />Show in folder</button>
  </>
}

/** Where the menu opens, and for which picture. */
type MenuAt = { image: ReplyImage; x: number; y: number }

/** The right-click menu on a picture: the app's row menu, at the pointer. */
function PictureMenu({ at, onOpen, onClose }: { at: MenuAt; onOpen(): void; onClose(): void }) {
  const host = useBotFiles()
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    panel.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    const away = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node)) onClose() }
    const keys = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      const items = [...(panel.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
      const at = items.indexOf(document.activeElement as HTMLButtonElement)
      items[(at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
      event.preventDefault()
    }
    document.addEventListener('pointerdown', away, true)
    document.addEventListener('keydown', keys, true)
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', keys, true) }
  }, [onClose])
  const path = at.image.path
  const pick = (action: () => void) => () => { onClose(); action() }
  // A little off the pointer, and kept 8px inside the window: the menu is about 180 by 150.
  const left = Math.max(8, Math.min(at.x + 4, window.innerWidth - 188 - 8))
  const top = Math.max(8, Math.min(at.y + 4, window.innerHeight - 158 - 8))
  return <FloatingPortal>
    <div ref={panel} className="row-menu bot-picture-menu" role="menu" aria-label={`Actions for ${at.image.name}`} style={{ position: 'fixed', left, top, zIndex: 60 }}>
      <button type="button" role="menuitem" className="row-menu-item" onClick={pick(onOpen)}>Open</button>
      {path && <>
        <button type="button" role="menuitem" className="row-menu-item" onClick={pick(() => fileActions.saveAs(path, host?.failed))}>Save as…</button>
        <button type="button" role="menuitem" className="row-menu-item" onClick={pick(() => fileActions.showInFolder(path, host?.failed))}>Show in folder</button>
        <button type="button" role="menuitem" className="row-menu-item" onClick={pick(() => fileActions.copyImage(path, host?.failed))}>Copy image</button>
      </>}
    </div>
  </FloatingPortal>
}

/**
 * One picture: a click opens the preview, a right-click or the menu key its menu. Before it is read its box waits
 * empty; one that can't be read never shows (the reply keeps its chip). Its name is its alt text and label, never a
 * tooltip, which would cover what is above it.
 */
function Picture({ image, images, single, onMenu }: { image: ReplyImage; images: readonly ReplyImage[]; single: boolean; onMenu(at: MenuAt): void }) {
  const file = useFileImage(image.path)
  const gallery = useImageGallery()
  const url = urlOf(image, file?.url)
  const open = () => {
    if (!url || !gallery) return
    const set = lightboxSet(images)
    gallery.open({ id: image.key, url, filename: image.name, ...(image.path ? { path: image.path } : {}) }, set.length ? set : undefined)
  }
  const menu = (event: MouseEvent<HTMLElement>) => { event.preventDefault(); onMenu({ image, x: event.clientX, y: event.clientY }) }
  const keys = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
    event.preventDefault()
    const box = event.currentTarget.getBoundingClientRect()
    onMenu({ image, x: box.left + 12, y: box.top + 12 })
  }
  if (!url && file?.failed) return null
  const className = `bot-picture${single ? ' is-single' : ''}${url ? '' : ' is-empty'}`
  return <button type="button" className={className} aria-label={`Open picture: ${image.name}`} disabled={!url}
    onClick={open} onContextMenu={menu} onKeyDown={keys}>
    {url && <img src={url} alt={image.name} loading="lazy" decoding="async" draggable={false} />}
  </button>
}

/** Several pictures side by side: snap scrolling, arrows on hover, Left and Right once focused, a count while they overflow. */
/** `menuOpen`: a picture's menu is open, and the arrows step aside for it. */
function Carousel({ images, menuOpen = false, children }: { images: readonly ReplyImage[]; menuOpen?: boolean; children: ReactNode }) {
  const track = useRef<HTMLDivElement>(null)
  const [index, setIndex] = useState(0)
  const [overflows, setOverflows] = useState(false)
  // Which edges have more pictures past them: those fade out, rather than cut a picture hard.
  const [more, setMore] = useState({ before: false, after: false })
  const edges = useCallback(() => {
    const element = track.current
    if (!element) return
    const before = element.scrollLeft > 2
    const after = element.scrollLeft + element.clientWidth < element.scrollWidth - 2
    setMore((was) => (was.before === before && was.after === after ? was : { before, after }))
  }, [])
  const measure = useCallback(() => {
    const element = track.current
    if (element) setOverflows(element.scrollWidth > element.clientWidth + 1)
    edges()
  }, [edges])
  useLayoutEffect(() => {
    measure()
    const element = track.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [measure, images.length])
  const slides = () => [...(track.current?.children ?? [])] as HTMLElement[]
  const go = (next: number) => {
    const target = Math.max(0, Math.min(images.length - 1, next))
    const slide = slides()[target]
    const element = track.current
    if (slide && element) {
      if (typeof element.scrollTo === 'function') element.scrollTo({ left: slide.offsetLeft, behavior: 'smooth' })
      else element.scrollLeft = slide.offsetLeft
    }
    setIndex(target)
  }
  // Which picture is at the start, as the owner scrolls.
  const scrolled = () => {
    const element = track.current
    if (!element) return
    const all = slides()
    let nearest = 0
    all.forEach((slide, at) => { if (Math.abs(slide.offsetLeft - element.scrollLeft) < Math.abs(all[nearest]!.offsetLeft - element.scrollLeft)) nearest = at })
    // The last pictures can't reach the start: scrolled to the end, the count is at the last.
    if (all.length && element.scrollLeft + element.clientWidth >= element.scrollWidth - 2) nearest = all.length - 1
    setIndex(nearest)
    edges()
  }
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
    event.preventDefault()
    go(index + (event.key === 'ArrowRight' ? 1 : -1))
  }
  const fades = `${overflows && more.before ? ' fades-before' : ''}${overflows && more.after ? ' fades-after' : ''}`
  return <div className={`bot-carousel${overflows ? ' is-overflowing' : ''}${menuOpen ? ' is-menu-open' : ''}`} role="group" aria-roledescription="carousel" aria-label={`${images.length} pictures`} tabIndex={0} onKeyDown={keys}>
    <div className={`bot-carousel-strip${fades}`}>
      <div className="bot-carousel-track" ref={track} onScroll={scrolled}>{children}</div>
      {/* An arrow only where there is more to see. */}
      {overflows && (index > 0 || more.before) && <button type="button" className="bot-carousel-arrow is-previous" aria-label="Previous picture" tabIndex={-1} onClick={() => go(index - 1)}><ChevronLeft size={16} aria-hidden /></button>}
      {overflows && more.after && index < images.length - 1 && <button type="button" className="bot-carousel-arrow is-next" aria-label="Next picture" tabIndex={-1} onClick={() => go(index + 1)}><ChevronRight size={16} aria-hidden /></button>}
    </div>
    {/* Under the strip, never on a picture. */}
    {overflows && <span className="bot-carousel-count" aria-live="polite">{index + 1}/{images.length}</span>}
  </div>
}

/** A reply's pictures, above its words: one alone, or several in a carousel. */
export function BotReplyMedia({ images }: { images: readonly ReplyImage[] }) {
  const [menu, setMenu] = useState<MenuAt | null>(null)
  const gallery = useImageGallery()
  const closeMenu = useCallback(() => setMenu(null), [])
  if (!images.length) return null
  const openFromMenu = () => {
    if (!menu || !gallery) return
    const set = lightboxSet(images)
    const shown = set.find((image) => image.id === menu.image.key)
    if (shown) gallery.open(shown, set)
  }
  const pictures = images.map((image) => <Picture key={image.key} image={image} images={images} single={images.length === 1} onMenu={setMenu} />)
  return <div className="bot-reply-media">
    {images.length === 1 ? pictures : <Carousel images={images} menuOpen={menu !== null}>{pictures}</Carousel>}
    {menu && <PictureMenu at={menu} onOpen={openFromMenu} onClose={closeMenu} />}
  </div>
}
