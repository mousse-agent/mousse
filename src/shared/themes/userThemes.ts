import { THEME_CSS_MAX_LENGTH, themeCssTooLong } from './cssSafety'
import { isWallpaperId, WALLPAPER_UPLOAD_MAX_BASE64, type WallpaperImageType } from './wallpaperImage'

/**
 * A theme a person or an agent made: a built-in theme to start from, color tokens over it and optional CSS. Saved in
 * the profile's appearance settings and exported as one JSON file (`UserThemeFile`). The same shape is what an
 * extension's appearance contribution can carry later (#568).
 */
export interface UserTheme {
  /** Stable id, `user-` and a slug of the first name it was saved under. */
  id: string
  name: string
  /** The built-in theme it starts from. Light and dark are the usual bases; `system` is not one. */
  base: UserThemeBase
  /** Accent color (`#rrggbb`) used while the theme is active; empty: the accent chosen in Settings. */
  accent: string
  /** CSS custom properties set over the base, by name (`--surface-base`), each a color. */
  colors: Record<string, string>
  /** Extra CSS, at most `THEME_CSS_MAX_LENGTH` characters. Rules that could load anything are dropped when it is applied (`sanitizeThemeCss`). */
  css: string
  /** An image behind the chat, kept by the daemon in the profile's wallpaper store; absent: none. */
  wallpaper?: ThemeWallpaper
}

/** How the wallpaper fills the chat: cover crops it to fill, contain shows all of it. */
export type WallpaperFit = 'cover' | 'contain'
export const WALLPAPER_FITS: readonly WallpaperFit[] = ['cover', 'contain']
/** Which part of the image stays in view when it is cropped (`cover`), or where it sits (`contain`). */
export type WallpaperPosition = 'center' | 'top' | 'bottom' | 'left' | 'right' | 'top left' | 'top right' | 'bottom left' | 'bottom right'
export const WALLPAPER_POSITIONS: readonly WallpaperPosition[] = ['center', 'top', 'bottom', 'left', 'right', 'top left', 'top right', 'bottom left', 'bottom right']
/** The most a person can dim the wallpaper by, in percent; the window may dim it more to keep text readable. */
export const WALLPAPER_MAX_DIM = 90
export const WALLPAPER_DEFAULT_DIM = 40

/**
 * A theme's wallpaper: which stored image (the sha-256 of its bytes, never a path) and how it shows. Its type and size
 * are what the daemon read from the image when it was stored, for display only.
 */
export interface ThemeWallpaper {
  id: string
  type: WallpaperImageType
  width: number
  height: number
  fit: WallpaperFit
  position: WallpaperPosition
  /** 0 to `WALLPAPER_MAX_DIM`. */
  dim: number
}

/** A stored or written wallpaper, or undefined when it does not name a stored image. Bad display fields get defaults. */
export function normalizeThemeWallpaper(raw: unknown): ThemeWallpaper | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  if (!isWallpaperId(value.id)) return undefined
  const type: WallpaperImageType = value.type === 'image/png' || value.type === 'image/jpeg' || value.type === 'image/webp' ? value.type : 'image/png'
  const side = (n: unknown): number => (typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= 16_384 ? n : 0)
  const dim = typeof value.dim === 'number' && Number.isFinite(value.dim) ? Math.round(Math.min(WALLPAPER_MAX_DIM, Math.max(0, value.dim))) : WALLPAPER_DEFAULT_DIM
  return {
    id: value.id,
    type,
    width: side(value.width),
    height: side(value.height),
    fit: (WALLPAPER_FITS as readonly unknown[]).includes(value.fit) ? value.fit as WallpaperFit : 'cover',
    position: (WALLPAPER_POSITIONS as readonly unknown[]).includes(value.position) ? value.position as WallpaperPosition : 'center',
    dim
  }
}

export type UserThemeBase = 'dark' | 'light' | 'blacksphere-plus' | 'solarized-dark' | 'github-dark' | 'high-contrast'

export const USER_THEME_BASES: readonly UserThemeBase[] = ['dark', 'light', 'blacksphere-plus', 'solarized-dark', 'github-dark', 'high-contrast']

/** Limits that keep settings small and a theme readable. */
export const USER_THEME_LIMITS = {
  themes: 24,
  name: 60,
  colors: 48,
  css: THEME_CSS_MAX_LENGTH
} as const

/** The `kind` an exported theme file carries, and its version. */
export const USER_THEME_FILE_KIND = 'mousse-theme'
export const USER_THEME_FILE_VERSION = 1

/** One exported theme. Its id is not part of the file: an imported theme gets its own. */
export interface UserThemeFile {
  kind: typeof USER_THEME_FILE_KIND
  version: typeof USER_THEME_FILE_VERSION
  name: string
  base: UserThemeBase
  accent?: string
  colors?: Record<string, string>
  css?: string
  /** The wallpaper, carried in the file: a WebP display copy as base64 (older builds ignore it). */
  wallpaper?: UserThemeFileWallpaper
}

export interface UserThemeFileWallpaper {
  type: 'image/webp'
  /** Base64 of the image, at most `WALLPAPER_UPLOAD_MAX_BYTES` bytes. */
  data: string
  fit: WallpaperFit
  position: WallpaperPosition
  dim: number
}

const TOKEN_NAME = /^--[a-z][a-z0-9-]{0,62}$/
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
/** Numbers, percentages, angles and the separators of a color function; no names, quotes or nested calls. */
const COLOR_FUNCTION = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*[0-9.+\-eE%\s,/]*(?:deg|turn|rad|grad)?[0-9.+\-eE%\s,/]*\)$/i
/** An `r, g, b` triplet, as the `*-rgb` tokens hold. */
const RGB_CHANNELS = /^\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}$/
const NAMED_COLOR = /^(?:[a-z]{3,20})$/i

/** The user theme `appearance` has on, if any. */
export function activeUserTheme(appearance: { userThemes?: readonly UserTheme[]; userTheme?: string } | null | undefined): UserTheme | undefined {
  if (!appearance?.userTheme) return undefined
  return appearance.userThemes?.find((theme) => theme.id === appearance.userTheme)
}

/** Whether `name` can be a color token: a lower-case CSS custom property. */
export function isThemeTokenName(name: unknown): name is string {
  return typeof name === 'string' && TOKEN_NAME.test(name)
}

/** Whether `value` is a plain color a token may hold: hex, a color function of numbers, an `r, g, b` triplet or a name. */
export function isThemeColorValue(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const text = value.trim()
  if (!text || text.length > 64) return false
  return HEX.test(text) || COLOR_FUNCTION.test(text) || RGB_CHANNELS.test(text) || NAMED_COLOR.test(text)
}

export function isUserThemeBase(value: unknown): value is UserThemeBase {
  return typeof value === 'string' && (USER_THEME_BASES as readonly string[]).includes(value)
}

/** A user theme id: `user-` and a slug. */
export function isUserThemeId(value: unknown): value is string {
  return typeof value === 'string' && /^user-[a-z0-9-]{1,48}$/.test(value)
}

/** An id for a new theme called `name` that none of `taken` uses. */
export function userThemeIdFor(name: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'theme'
  let id = `user-${slug}`
  for (let n = 2; used.has(id); n++) id = `user-${slug}-${n}`
  return id
}

function normalizeColors(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= USER_THEME_LIMITS.colors) break
    if (isThemeTokenName(name) && isThemeColorValue(value)) out[name] = value.trim()
  }
  return out
}

function normalizeAccent(raw: unknown): string {
  return typeof raw === 'string' && /^#[0-9a-f]{6}$/i.test(raw.trim()) ? raw.trim().toLowerCase() : ''
}

function normalizeName(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, USER_THEME_LIMITS.name) : ''
}

/** A stored or written theme, or null when it has no valid id or name. Colors that are not plain colors are left out. */
export function normalizeUserTheme(raw: unknown): UserTheme | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const name = normalizeName(value.name)
  if (!isUserThemeId(value.id) || !name) return null
  return {
    id: value.id,
    name,
    base: isUserThemeBase(value.base) ? value.base : 'dark',
    accent: normalizeAccent(value.accent),
    colors: normalizeColors(value.colors),
    // Never cut: CSS over the limit is refused where it is written (settings, theme_set, import, the editor).
    css: typeof value.css === 'string' ? value.css : '',
    ...withWallpaper(normalizeThemeWallpaper(value.wallpaper))
  }
}

function withWallpaper(wallpaper: ThemeWallpaper | undefined): { wallpaper?: ThemeWallpaper } {
  return wallpaper ? { wallpaper } : {}
}

/** The stored list: valid themes only, each id once, at most `USER_THEME_LIMITS.themes`. */
export function normalizeUserThemes(raw: unknown): UserTheme[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: UserTheme[] = []
  for (const entry of raw) {
    const theme = normalizeUserTheme(entry)
    if (!theme || seen.has(theme.id)) continue
    seen.add(theme.id)
    out.push(theme)
    if (out.length >= USER_THEME_LIMITS.themes) break
  }
  return out
}

/** The file a theme exports as; `image` is its wallpaper's display copy as base64, when it has one that could be read. */
export function userThemeFile(theme: UserTheme, image?: string): UserThemeFile {
  const wallpaper = theme.wallpaper
  return {
    kind: USER_THEME_FILE_KIND,
    version: USER_THEME_FILE_VERSION,
    name: theme.name,
    base: theme.base,
    ...(theme.accent ? { accent: theme.accent } : {}),
    ...(Object.keys(theme.colors).length ? { colors: theme.colors } : {}),
    ...(theme.css ? { css: theme.css } : {}),
    ...(wallpaper && image ? { wallpaper: { type: 'image/webp' as const, data: image, fit: wallpaper.fit, position: wallpaper.position, dim: wallpaper.dim } } : {})
  }
}

/** The largest theme file read, in bytes: the CSS limit and a wallpaper with room to spare. */
export const USER_THEME_FILE_MAX_BYTES = 6 * 1024 * 1024

/** A theme read from an exported file, with a new id that none of `taken` uses; an error says what is wrong. */
export function parseUserThemeFile(text: string, taken: Iterable<string>): { theme: UserTheme; wallpaper?: UserThemeFileWallpaper } | { error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { error: 'This file is not a Mousse theme.' }
  }
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  if (value.kind !== USER_THEME_FILE_KIND) return { error: 'This file is not a Mousse theme.' }
  if (value.version !== USER_THEME_FILE_VERSION) return { error: 'This theme was made by a newer Mousse.' }
  const name = normalizeName(value.name)
  if (!name) return { error: 'The theme has no name.' }
  if (typeof value.css === 'string' && value.css.length > USER_THEME_LIMITS.css) return { error: themeCssTooLong(value.css.length) }
  // A file never names a stored image: its wallpaper travels as bytes, stored on import (`wallpaperImportBytes`).
  const theme = normalizeUserTheme({ ...value, wallpaper: undefined, id: userThemeIdFor(name, taken), name })
  if (!theme) return { error: 'This file is not a Mousse theme.' }
  const wallpaper = fileWallpaper(value.wallpaper)
  return wallpaper ? { theme, wallpaper } : { theme }
}

function fileWallpaper(raw: unknown): UserThemeFileWallpaper | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  if (typeof value.data !== 'string' || !value.data || value.data.length > WALLPAPER_UPLOAD_MAX_BASE64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)) return undefined
  // The id is a stand-in: only the display fields are kept from it.
  const shown = normalizeThemeWallpaper({ ...value, id: '0'.repeat(64) })
  return shown ? { type: 'image/webp', data: value.data, fit: shown.fit, position: shown.position, dim: shown.dim } : undefined
}

/** The color tokens a theme usually sets, with what each one paints. Listed in the guide and offered in the editor. */
export const THEME_TOKENS: ReadonlyArray<{ name: string; use: string }> = [
  { name: '--surface-base', use: 'window background' },
  { name: '--surface-strong', use: 'sidebar and raised panels' },
  { name: '--surface-soft', use: 'hovered rows, inputs' },
  { name: '--surface-elevated', use: 'menus and popovers' },
  { name: '--text-primary', use: 'main text' },
  { name: '--text-secondary', use: 'secondary text' },
  { name: '--border', use: 'borders and dividers' },
  { name: '--accent', use: 'accent (prefer the theme\'s accent field, which also sets its shades)' }
]

/** Stable selectors theme CSS may rely on. `tests/themeSelectors.test.ts` fails when one disappears from the app. */
export const THEME_SELECTORS: ReadonlyArray<{ selector: string; part: string }> = [
  { selector: '[data-mousse="rail"]', part: 'navigation rail (far left)' },
  { selector: '[data-mousse="sidebar"]', part: 'threads and projects sidebar' },
  { selector: '[data-mousse="titlebar"]', part: 'title bar' },
  { selector: '[data-mousse="chat-header"]', part: 'the open thread\'s path and back/forward in the title bar; a chat\'s header in Chats' },
  { selector: '[data-mousse="chat"]', part: 'an open thread\'s chat pane' },
  { selector: '[data-mousse="transcript"]', part: 'the scrolling list of messages' },
  { selector: '[data-mousse="user-message"]', part: 'one message bubble the person sent' },
  { selector: '[data-mousse="assistant-message"]', part: 'one reply from the agent' },
  { selector: '[data-mousse="composer"]', part: 'the message box' },
  { selector: '[data-mousse="project-icon"]', part: 'a project\'s icon (an image, or a wrapper around its folder glyph or initials)' },
  { selector: '[data-mousse="side-card"]', part: 'the thread details card' },
  { selector: '[data-mousse="settings"]', part: 'the Settings page (themed on Appearance only)' },
  { selector: '[data-mousse="wallpaper"]', part: 'the theme\'s wallpaper layer behind the chat (present only while a wallpaper shows)' }
]

/** The short styling guide the theme tools give an agent. */
export function themeStylingGuide(): string {
  return [
    'A user theme = base (a built-in theme), accent (#rrggbb, optional), colors (CSS custom properties, plain colors only) and css (optional).',
    `The page root is html[data-theme="<base>"]; while a user theme is on it also has data-user-theme="<id>".`,
    'Tokens (set them in colors; in css they need !important, because Mousse sets them inline):',
    ...THEME_TOKENS.map((token) => `  ${token.name}: ${token.use}`),
    'Stable selectors (other class names change without notice):',
    ...THEME_SELECTORS.map((entry) => `  ${entry.selector}: ${entry.part}`),
    'Wallpaper: set userTheme.wallpaper = { path: "<absolute path of a PNG, JPEG or WebP on this computer>", fit, position, dim }. Mousse checks the image, keeps its own copy and shows a screen-sized copy behind the chat, dimmed by the theme\'s background color (more than dim when text needs it to stay readable). Leave path out to change only fit, position or dim; null removes it. Never put an image in css as a data: address.',
    'While a wallpaper shows, html has data-wallpaper and var(--mousse-wallpaper) holds it, so css can reuse it elsewhere: [data-mousse="sidebar"] { background: var(--mousse-wallpaper) center / cover; }. Text on it must stay readable.',
    'Where a person decides something (an approval, an ask, a host key) and on Settings pages other than Appearance, the theme is off, wallpaper included.',
    `Rules: nothing may load from outside. The only url() allowed is a quoted data: address, url("data:..."); @import, image-set(), src(), attr() and every other url() are dropped, declaration by declaration; invalid CSS is dropped by the browser rule by rule. CSS over ${THEME_CSS_MAX_LENGTH.toLocaleString('en-US')} characters is refused. Keep text readable (4.5:1 contrast) and do not hide controls.`
  ].join('\n')
}
