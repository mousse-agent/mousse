/**
 * ACP registry icons: small SVG marks the registry hosts next to its list. Mousse fetches one
 * only from the registry's own host, keeps it only when it passes `sanitizeRegistrySvg`, caches it
 * under `<installationHome>/agents/icons/<agentId>.svg`, and hands the renderer a `data:` URL, so
 * the app never loads an icon from the network and never shows markup that could run or load
 * anything. (Browsers already run no script and load nothing for an SVG shown as an image or a
 * mask; the checks here are the second wall, not the first.)
 */
import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import { atomicWriteFileSync, atomicWriteJsonSync } from '../../data/AtomicFs'

/** A registry icon is a few KiB; anything larger is not an icon. */
export const ICON_MAX_BYTES = 32 * 1024
export const ICON_MAX_URL_LENGTH = 2_048

const AGENT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
/** Names Windows reads as devices (`con.svg` is the console), refused on every platform. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)(\..*)?$/i

/** A cleaned icon: its markup, and whether it is one ink that should follow the text colour. */
export interface SanitizedIcon {
  svg: string
  /**
   * Every painted part is one ink (`currentColor`, black or a single grey or white): drawn as a
   * mask in the text colour so it reads on light and dark themes. A mark with two or more colours
   * (a solid tile with a white cut-out, a brand palette) is drawn as an image instead, since a mask
   * would flatten it to a solid shape.
   */
  monochrome: boolean
}

/** What a snapshot or a search row carries for an icon: never a remote URL. */
export interface IconView {
  iconDataUrl: string
  iconMonochrome: boolean
}

/**
 * An icon URL from the registry: HTTPS on the registry's own host, an `.svg` path, no
 * credentials, at most 2 KiB. Anything else is dropped, so no icon is fetched from elsewhere.
 */
export function registryIconUrl(value: unknown, registryHost: string): string | undefined {
  if (typeof value !== 'string' || value.length > ICON_MAX_URL_LENGTH) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return undefined
    if (url.host !== registryHost || !url.pathname.toLowerCase().endsWith('.svg')) return undefined
    return url.href
  } catch {
    return undefined
  }
}

/** The only absolute URLs an icon may contain: XML and SVG namespace names, which are never fetched. */
const NAMESPACES = new Set(['http://www.w3.org/2000/svg', 'http://www.w3.org/1999/xlink', 'http://www.w3.org/XML/1998/namespace'])

/** Elements an icon may use: shapes, text, grouping and descriptions. Nothing that loads, links, animates or styles. */
const ELEMENTS = new Set([
  'svg', 'g', 'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'rect', 'text', 'tspan',
  'title', 'desc', 'defs', 'clippath', 'mask', 'lineargradient', 'radialgradient', 'stop'
])

/** Constructs that run, load, link, animate or restyle, wherever they appear (names in any prefix). */
const FORBIDDEN: readonly RegExp[] = [
  /<\s*\/?\s*(?:[\w.-]+:)?(?:script|foreignobject|iframe|object|embed|style|animate\w*|set|use|image|feimage|a|audio|video|handler|listener)\b/i,
  // Event handler attributes (`onload=`, `onclick =`).
  /[\s"'/]on[a-z]+\s*=/i,
  // A CSS escape (`u\72l(`) could spell any word the other checks look for.
  /\\/,
  /javascript\s*:/i,
  /vbscript\s*:/i,
  /data\s*:/i,
  /@import/i,
  /<!DOCTYPE/i,
  /<!ENTITY/i,
  // Any other markup declaration or CDATA section, and character or entity references, which
  // could spell a word the checks above look for.
  /<!/,
  /&(?!(?:amp|lt|gt|quot|apos);)/i,
  // A processing instruction after the XML declaration (`<?xml-stylesheet href=…?>`).
  /<\?/
]

const SHAPES = /<\s*(?:[\w.-]+:)?(?:path|circle|ellipse|line|polyline|polygon|rect|text)\b([^>]*)>/gi

/** Every quoted `name="value"` in the icon. */
const ATTRIBUTES = /(?<=^|[\s"'])((?:[\w.-]+:)?[\w.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
/** Every `style=`, quoted or not, so none goes unchecked. */
const STYLE_ATTRIBUTE = /(?<![\w.-])(?:[\w.-]+:)?style\s*=/gi

/** The one URL an attribute may hold: a part of the icon itself (`clip-path="url(#clip0)"`). */
const LOCAL_URL = /^\s*url\(\s*#[A-Za-z_][\w.-]*\s*\)\s*$/i

/** What a `style` attribute may set: how shapes are painted and laid out, nothing that loads or moves. */
const STYLE_PROPERTIES = new Set([
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin',
  'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'color', 'stop-color', 'stop-opacity',
  'clip-rule', 'display', 'visibility', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor',
  'letter-spacing', 'isolation', 'mix-blend-mode'
])

/** A plain style value: words, numbers, units, `#hex` and `rgb()`/`rgba()` of numbers, nothing else. */
function plainStyle(style: string): boolean {
  for (const declaration of style.split(';')) {
    if (!declaration.trim()) continue
    const colon = declaration.indexOf(':')
    if (colon < 0) return false
    const property = declaration.slice(0, colon).trim().toLowerCase()
    const value = declaration.slice(colon + 1).replace(/rgba?\([\d.%\s,]*\)/gi, '')
    if (!STYLE_PROPERTIES.has(property) || !/^[-#\w.%\s,]*$/.test(value)) return false
  }
  return true
}

/**
 * Attributes are where styles and URLs hide: every `style` must be plain, and the only `url(` the
 * icon may hold is a whole attribute value pointing inside it (`url(#clip0)`), never in a `style`.
 */
function attributesAreSafe(text: string): boolean {
  let unsafe = false
  let styles = 0
  const rest = text.replace(ATTRIBUTES, (whole, name: string, double?: string, single?: string) => {
    const value = double ?? single ?? ''
    const local = name.slice(name.indexOf(':') + 1).toLowerCase()
    if (local === 'style') {
      styles += 1
      if (!plainStyle(value)) unsafe = true
      return whole
    }
    return LOCAL_URL.test(value) ? `${name}=""` : whole
  })
  return !unsafe && styles === (text.match(STYLE_ATTRIBUTE) ?? []).length && !/url\s*\(/i.test(rest)
}

/**
 * The icon cleaned for display, or undefined when it is not a plain SVG mark of at most
 * `ICON_MAX_BYTES` UTF-8 bytes. A leading XML declaration and an external DOCTYPE (no internal
 * subset) are removed; a DOCTYPE with one, entities, scripts, styles, links, images, animation,
 * event handlers, backslashes (CSS escapes), a `style` attribute beyond plain paint and any URL
 * other than a namespace name or a `url(#part)` of the icon itself reject the icon.
 */
export function sanitizeRegistrySvg(input: string | Uint8Array): SanitizedIcon | undefined {
  let text: string
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > ICON_MAX_BYTES) return undefined
    text = input
  } else {
    if (input.byteLength > ICON_MAX_BYTES) return undefined
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(input)
    } catch {
      return undefined
    }
  }
  text = text.replace(/^﻿/, '').trim()
  // `<?xml version="1.0" encoding="UTF-8" standalone="no"?>`
  text = text.replace(/^<\?xml\s[^<>?]*\?>\s*/, '')
  // `<!DOCTYPE svg PUBLIC "…" "…dtd">`: an external DTD, which no image or mask ever loads.
  text = text.replace(/^<!DOCTYPE\s+svg\b[^<>[\]]*>\s*/i, '')
  text = text.replace(/<!--[\s\S]*?-->/g, '')
  if (!/^<svg[\s>]/.test(text) || !/<\/svg\s*>$/.test(text)) return undefined
  if (FORBIDDEN.some((pattern) => pattern.test(text)) || !attributesAreSafe(text)) return undefined
  for (const match of text.matchAll(/<\s*\/?\s*([A-Za-z_][\w.:-]*)/g)) {
    const name = match[1]!.toLowerCase()
    if (!ELEMENTS.has(name.slice(name.indexOf(':') + 1))) return undefined
  }
  // References stay inside the icon (`href="#gradient"`). Each quote style is matched on its own,
  // as in `ATTRIBUTES`, so a value holding the other kind (`href="x.svg#g'"`) is checked too.
  for (const match of text.matchAll(/(?:^|[\s"'])(?:[\w.-]+:)?href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi))
    if (!(match[1] ?? match[2] ?? '').trim().startsWith('#')) return undefined
  for (const match of text.matchAll(/(?:https?|ftp|file|wss?):\/\/[^\s"'<>]*/gi)) if (!NAMESPACES.has(match[0])) return undefined
  if (/\b(?:https?|ftp|file):/i.test(text.replace(/(?:https?):\/\/[^\s"'<>]*/gi, ''))) return undefined
  // An SVG shown as an image needs its namespace.
  const svg = /^<svg\b[^>]*\sxmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/.test(text)
    ? text
    : text.replace(/^<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"')
  return { svg, monochrome: isMonochrome(svg) }
}

const NO_PAINT = new Set(['', 'none', 'transparent', 'inherit', 'initial', 'unset', 'context-fill', 'context-stroke'])

/** A paint value as a comparable colour: `ink` for `currentColor` and black, `#rrggbb` where it can be read. */
function paintKey(value: string): string | undefined {
  const paint = value.trim().toLowerCase()
  if (NO_PAINT.has(paint)) return undefined
  if (paint === 'currentcolor' || paint === 'black') return 'ink'
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])(?:[0-9a-f])?$/.exec(paint)
  const hex = short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : /^#[0-9a-f]{6}/.exec(paint)?.[0]
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/.exec(paint)
  const color = hex ?? (rgb ? `#${rgb.slice(1, 4).map((part) => Number(part).toString(16).padStart(2, '0')).join('')}` : paint === 'white' ? '#ffffff' : paint)
  return color === '#000000' ? 'ink' : color
}

function isNeutral(color: string): boolean {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(color)
  return Boolean(hex && hex[1] === hex[2] && hex[2] === hex[3])
}

/**
 * Whether every painted part is one ink. Counts each fill, stroke and stop colour in attributes and
 * `style`, plus the default black of a shape with no fill when nothing above it sets one, so a
 * black tile with a white cut-out counts as two colours, never as one white mark. The insides of
 * a `clipPath` or `mask` are left out: they cut shapes and are never painted themselves (a design
 * tool's `<clipPath><rect fill="white"/></clipPath>` does not make a dark mark two colours).
 */
function isMonochrome(icon: string): boolean {
  const svg = icon.replace(/<\s*(?:[\w.-]+:)?(clippath|mask)\b[\s\S]*?<\/\s*(?:[\w.-]+:)?\1\s*>/gi, '')
  const colors = new Set<string>()
  const add = (value: string) => {
    const key = paintKey(value)
    if (key) colors.add(key)
  }
  for (const match of svg.matchAll(/[\s"'](?:fill|stroke|color|stop-color|flood-color|lighting-color)\s*=\s*(["'])([^"']*)\1/gi)) add(match[2]!)
  for (const match of svg.matchAll(/(?:^|[;\s"'])(?:fill|stroke|color|stop-color|flood-color|lighting-color)\s*:\s*([^;"']+)/gi)) add(match[1]!)
  // A shape without a fill paints black, unless the root or a group sets one for it.
  const inherited = /<\s*(?:[\w.-]+:)?(?:svg|g)\b[^>]*[\s"'](?:fill\s*=|style\s*=\s*["'][^"']*fill\s*:)/i.test(svg)
  if (!inherited)
    for (const match of svg.matchAll(SHAPES))
      if (!/[\s"'/](?:fill\s*=|style\s*=\s*["'][^"']*fill\s*:)/i.test(` ${match[1]!}`)) colors.add('ink')
  if (colors.size === 0) return true
  if (colors.size > 1) return false
  const only = [...colors][0]!
  return only === 'ink' || isNeutral(only)
}

/** An icon as a `data:` URL. */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}

/** How an agent's last icon fetch ended: stored, refused by `sanitizeRegistrySvg`, or not fetched. */
export type IconOutcome = 'stored' | 'rejected' | 'failed'

/** An agent's last icon fetch, and the registry entry it was for (`registryIconSource`). */
export interface IconAttempt {
  outcome: IconOutcome
  source: string
}

/** The file next to the icons that remembers each agent's last fetch, across restarts and profiles. */
export const ICON_ATTEMPTS_FILE = 'attempts.json'
const ATTEMPTS_MAX_BYTES = 256 * 1024
const OUTCOMES: ReadonlySet<string> = new Set<IconOutcome>(['stored', 'rejected', 'failed'])

/**
 * What an icon fetch is about: the agent's registry version and icon URL. A fetch is tried again
 * for the same agent only when this changes (or, for a failed one, when the user browses the list).
 */
export function registryIconSource(agent: { version: string; icon?: string }): string {
  return `${agent.version} ${agent.icon ?? ''}`
}

/**
 * The icon cache directory, `<installationHome>/agents/icons`: one `<agentId>.svg` per agent,
 * written atomically, never read through a symbolic link or from outside the directory, and
 * `attempts.json`, the outcome of each agent's last fetch.
 */
export class RegistryIconCache {
  /** Decoded icons by agent id, with the file's modification time they were read at. */
  private readonly memory = new Map<string, { mtimeMs: number; view: IconView | undefined }>()
  /** `attempts.json` as last read or written. */
  private saved?: { mtimeMs: number; byAgent: ReadonlyMap<string, IconAttempt> }
  /** Outcomes this run could not write (a read-only folder): they win over the file, so nothing is fetched twice. */
  private readonly unsaved = new Map<string, IconAttempt>()

  constructor(readonly dir: string) {}

  /** The last icon fetch of an agent, by any Mousse profile on this computer. */
  attempt(agentId: string): IconAttempt | undefined {
    return this.unsaved.get(agentId) ?? this.loadAttempts().get(agentId)
  }

  /** Remembers how an agent's icon fetch ended, on disk when it can. */
  record(agentId: string, attempt: IconAttempt): void {
    if (!this.pathOf(agentId)) return
    this.unsaved.set(agentId, attempt)
    const byAgent = new Map([...this.loadAttempts(), ...this.unsaved])
    try {
      mkdirSync(this.dir, { recursive: true })
      if (!this.dirIsReal()) return
      const path = join(this.dir, ICON_ATTEMPTS_FILE)
      atomicWriteJsonSync(path, { attempts: Object.fromEntries(byAgent) })
      this.saved = { mtimeMs: lstatSync(path).mtimeMs, byAgent }
      this.unsaved.clear()
    } catch {
      // Not written: `unsaved` keeps it for this run.
    }
  }

  /** `attempts.json`, read again only when it changed; an unreadable file counts as empty. */
  private loadAttempts(): ReadonlyMap<string, IconAttempt> {
    const path = join(this.dir, ICON_ATTEMPTS_FILE)
    try {
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.size > ATTEMPTS_MAX_BYTES || !this.inside(path)) return new Map()
      if (this.saved?.mtimeMs === stat.mtimeMs) return this.saved.byAgent
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
      const byAgent = new Map<string, IconAttempt>()
      const entries = raw && typeof raw === 'object' ? (raw as { attempts?: unknown }).attempts : undefined
      if (entries && typeof entries === 'object')
        for (const [agentId, value] of Object.entries(entries)) {
          const { outcome, source } = (value ?? {}) as Partial<IconAttempt>
          if (this.pathOf(agentId) && typeof outcome === 'string' && OUTCOMES.has(outcome) && typeof source === 'string' && source.length <= 4_096)
            byAgent.set(agentId, { outcome, source })
        }
      this.saved = { mtimeMs: stat.mtimeMs, byAgent }
      return byAgent
    } catch {
      return new Map()
    }
  }

  /** The cache file of an agent, or undefined for an id that could not be a file name. */
  pathOf(agentId: string): string | undefined {
    if (!AGENT_ID.test(agentId) || /\.\.|\.$/.test(agentId) || WINDOWS_RESERVED.test(agentId)) return undefined
    const path = join(this.dir, `${agentId}.svg`)
    const rel = relative(this.dir, path)
    return rel && !rel.startsWith('..') && !isAbsolute(rel) && !/[\\/]/.test(rel) ? path : undefined
  }

  /** The cached icon, read from disk (and checked again) only when the file changed. */
  read(agentId: string): IconView | undefined {
    const path = this.pathOf(agentId)
    if (!path) return undefined
    try {
      const stat = lstatSync(path)
      // A link, a folder or a device is never an icon.
      if (!stat.isFile() || stat.size > ICON_MAX_BYTES || !this.inside(path)) return undefined
      const known = this.memory.get(agentId)
      if (known?.mtimeMs === stat.mtimeMs) return known.view
      const icon = sanitizeRegistrySvg(readFileSync(path))
      const view = icon ? { iconDataUrl: svgDataUrl(icon.svg), iconMonochrome: icon.monochrome } : undefined
      this.memory.set(agentId, { mtimeMs: stat.mtimeMs, view })
      return view
    } catch {
      return undefined
    }
  }

  /** Stores a cleaned icon. Returns false when the id or the directory does not allow it. */
  write(agentId: string, icon: SanitizedIcon): boolean {
    const path = this.pathOf(agentId)
    if (!path) return false
    mkdirSync(this.dir, { recursive: true })
    if (!this.dirIsReal()) return false
    try {
      // Never replace a link or a folder someone put in the icon's place.
      if (!lstatSync(path).isFile()) return false
    } catch {
      // No file yet.
    }
    atomicWriteFileSync(path, icon.svg)
    this.memory.delete(agentId)
    return true
  }

  /** The directory itself is not a link (so a write cannot land elsewhere). */
  private dirIsReal(): boolean {
    try {
      return lstatSync(this.dir).isDirectory()
    } catch {
      return false
    }
  }

  private inside(path: string): boolean {
    if (!this.dirIsReal()) return false
    try {
      const rel = relative(realpathSync(this.dir), realpathSync(path))
      return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel)
    } catch {
      return false
    }
  }
}
