import { PERMISSION_KEYS } from '../../../../shared/permissionKeys'
import { THEME_OPTIONS, type AppearanceSettings, type ThemeId } from '../../../../shared/settings'
import { themeCssTooLong, withoutExternalLoads } from '../../../../shared/themes/cssSafety'
import {
  activeUserTheme,
  isThemeColorValue,
  isThemeTokenName,
  isUserThemeBase,
  normalizeThemeWallpaper,
  normalizeUserTheme,
  themeStylingGuide,
  USER_THEME_BASES,
  USER_THEME_LIMITS,
  userThemeIdFor,
  WALLPAPER_DEFAULT_DIM,
  WALLPAPER_FITS,
  WALLPAPER_MAX_DIM,
  WALLPAPER_POSITIONS,
  type ThemeWallpaper,
  type UserTheme
} from '../../../../shared/themes/userThemes'
import { WALLPAPER_REFUSED, type WallpaperImageInfo } from '../../../../shared/themes/wallpaperImage'
import type { AppToolHost } from './host'
import { disabledInSettings, json, type Availability, type AppToolTurn, type MousseTool, type ToolOutcome } from './types'

/** What the theme tools reach: the profile's appearance settings, read and saved at every call. */
export interface AppearanceToolHost {
  get(): AppearanceSettings
  /** Saves `patch` over the appearance settings and tells every window of the profile; returns what was saved. */
  set(patch: Partial<AppearanceSettings>): AppearanceSettings
  /**
   * Stores the image at `path` (absolute, on this computer, never a network share) in the profile's wallpaper store and
   * returns its id. Rejects for any file it cannot use.
   */
  importWallpaper?(path: string): Promise<WallpaperImageInfo & { id: string }>
}

export const THEME_READ_TOOL = 'theme_read'
export const THEME_SET_TOOL = 'theme_set'

const BUILT_IN_IDS: ReadonlySet<string> = new Set(THEME_OPTIONS.map((option) => option.id))

/** What the window will leave out of `css`, as written (the same check it runs before parsing). */
function rulesThatWillBeDropped(css: string): Array<{ rule: string; reason: string }> {
  const dropped: Array<{ text: string; reason: string }> = []
  withoutExternalLoads(css, dropped)
  return dropped.slice(0, 20).map((entry) => ({ rule: entry.text, reason: entry.reason }))
}

function summary(theme: UserTheme, withCss: boolean): Record<string, unknown> {
  return {
    id: theme.id,
    name: theme.name,
    base: theme.base,
    ...(theme.accent ? { accent: theme.accent } : {}),
    colors: theme.colors,
    ...(withCss ? { css: theme.css } : { cssLength: theme.css.length }),
    ...(theme.wallpaper ? { wallpaper: theme.wallpaper } : {})
  }
}

function state(appearance: AppearanceSettings): Record<string, unknown> {
  const user = activeUserTheme(appearance)
  return { theme: appearance.theme, ...(user ? { userTheme: { id: user.id, name: user.name } } : { userTheme: null }) }
}

/** Refused where settings may not change: read-only and Plan turns, discovery, subagents and bots. */
function mayChangeSettings(turn: AppToolTurn): Availability {
  if (!turn.settingsEnabled(THEME_SET_TOOL)) return disabledInSettings(THEME_SET_TOOL)
  if (turn.modeFacts.readOnly || turn.modeCeiling === 'plan' || turn.discovery)
    return 'Changing the theme changes Mousse\'s settings, which a read-only turn cannot do. Ask the person to switch to Agent mode.'
  if (turn.subagent) return 'Only the thread\'s own agent can change the theme, not a subagent.'
  if (turn.bot) return 'A bot cannot change how Mousse looks.'
  return true
}

/** The `wallpaper` field of a theme_set call: an object, null (remove), or absent. */
function wallpaperInput(input: Record<string, unknown>): Record<string, unknown> | null | undefined {
  if (input.wallpaper === null) return null
  return input.wallpaper && typeof input.wallpaper === 'object' && !Array.isArray(input.wallpaper) ? input.wallpaper as Record<string, unknown> : undefined
}

/** The image path a theme_set call would read, if any. */
function wallpaperPath(args: Record<string, unknown>): string | undefined {
  const theme = args.userTheme && typeof args.userTheme === 'object' ? args.userTheme as Record<string, unknown> : undefined
  const path = theme ? wallpaperInput(theme)?.path : undefined
  return typeof path === 'string' && path.trim() ? path.trim() : undefined
}

/**
 * An agent's path as the approval shows it: one line, no control or direction-changing characters (which could make it
 * read as another path), at most 200 characters with the end kept, where the file name is.
 */
export function shownPath(path: string): string {
  const plain = path.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
  return plain.length > 200 ? `…${plain.slice(-199)}` : plain
}

/** What is wrong with a wallpaper's fields, or null. */
function wallpaperFieldsError(wallpaper: Record<string, unknown>): string | null {
  if (wallpaper.fit !== undefined && !(WALLPAPER_FITS as readonly unknown[]).includes(wallpaper.fit)) return `wallpaper.fit must be ${WALLPAPER_FITS.join(' or ')}.`
  if (wallpaper.position !== undefined && !(WALLPAPER_POSITIONS as readonly unknown[]).includes(wallpaper.position)) return `wallpaper.position must be one of ${WALLPAPER_POSITIONS.join(', ')}.`
  if (wallpaper.dim !== undefined && !(typeof wallpaper.dim === 'number' && wallpaper.dim >= 0 && wallpaper.dim <= WALLPAPER_MAX_DIM)) return `wallpaper.dim must be a number from 0 to ${WALLPAPER_MAX_DIM}.`
  if (wallpaper.path !== undefined && (typeof wallpaper.path !== 'string' || !wallpaper.path.trim())) return 'wallpaper.path must be an absolute path.'
  return null
}

/**
 * The wallpaper a theme_set call leaves the theme with: removed (null), the new image with the given or kept display
 * fields, the current one with changed fields, or unchanged (absent). `missing` when fields are given and no image.
 */
function nextWallpaper(
  current: ThemeWallpaper | undefined,
  input: Record<string, unknown> | null | undefined,
  image: (WallpaperImageInfo & { id: string }) | undefined
): ThemeWallpaper | undefined | 'missing' {
  if (input === null) return undefined
  if (input === undefined) return current
  const base = image ?? current
  if (!base) return 'missing'
  return normalizeThemeWallpaper({
    dim: WALLPAPER_DEFAULT_DIM,
    ...(current ?? {}),
    ...(image ? { id: image.id, type: image.type, width: image.width, height: image.height } : {}),
    ...(input.fit !== undefined ? { fit: input.fit } : {}),
    ...(input.position !== undefined ? { position: input.position } : {}),
    ...(input.dim !== undefined ? { dim: input.dim } : {})
  })
}

/**
 * `theme_read` and `theme_set` (#1142): an agent reads the themes and a short styling guide, then writes a user theme
 * and switches to it, or switches to a built-in theme or another user theme. `theme_set` changes settings: it is
 * refused in read-only turns and asks the person unless the run's permission mode allows edits (`changesSettings`).
 */
export function appearanceTools(host: AppToolHost): MousseTool[] {
  const reach = (): AppearanceToolHost => {
    const tools = host.appearance?.()
    if (!tools) throw new Error('Themes are not available in this profile.')
    return tools
  }
  const builtIns = THEME_OPTIONS.map((option) => `${option.id} (${option.label})`).join(', ')
  return [
    {
      name: THEME_READ_TOOL,
      description:
        'Read Mousse\'s themes: the one in use, the built-in themes, the user themes and a short styling guide (color tokens and stable selectors for CSS). Pass id to get one user theme\'s full CSS. Read this before theme_set.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'A user theme id, to include its CSS.' } }
      },
      access: 'reads',
      class: 'read',
      readOnlySafe: true,
      listed: () => Boolean(host.appearance?.()),
      available: (turn) => (turn.settingsEnabled(THEME_READ_TOOL) ? true : disabledInSettings(THEME_READ_TOOL)),
      describe: () => 'Read themes',
      handler: (args): ToolOutcome => {
        const appearance = reach().get()
        const wanted = typeof args.id === 'string' ? args.id : undefined
        if (wanted && !appearance.userThemes.some((theme) => theme.id === wanted)) return { text: `No user theme ${wanted}.`, isError: true }
        return json({
          ...state(appearance),
          builtIn: THEME_OPTIONS.map((option) => ({ id: option.id, label: option.label, scheme: option.scheme })),
          userThemes: appearance.userThemes.map((theme) => summary(theme, theme.id === wanted || (!wanted && theme.id === appearance.userTheme))),
          guide: themeStylingGuide()
        })
      }
    },
    {
      name: THEME_SET_TOOL,
      description:
        `Change how Mousse looks. Either theme: switch to a built-in theme (${builtIns}; "system" follows the computer's light or dark mode) or an existing user theme id. Or userTheme: create a user theme (no id) or update one (its id; fields left out keep their values) and switch to it. Theme CSS asks the person unless the run is in Full access. Read theme_read first for the tokens and selectors. CSS that could load anything from outside Mousse is dropped.`,
      inputSchema: {
        type: 'object',
        properties: {
          theme: { type: 'string', description: 'A built-in theme id, or a user theme id.' },
          userTheme: {
            type: 'object',
            description: 'A user theme to save and switch to.',
            properties: {
              id: { type: 'string', description: 'An existing user theme id to update; leave out to create one.' },
              name: { type: 'string', description: `A short name (at most ${USER_THEME_LIMITS.name} characters). Needed for a new theme.` },
              base: { type: 'string', enum: [...USER_THEME_BASES], description: 'The built-in theme it starts from: dark or light, usually. Needed for a new theme.' },
              accent: { type: 'string', description: 'Accent color as #rrggbb; leave out to keep the person\'s accent.' },
              colors: { type: 'object', additionalProperties: { type: 'string' }, description: 'Color tokens by name (--surface-base: "#101418"). Plain colors only.' },
              css: { type: 'string', description: `Extra CSS, using the stable selectors from theme_read; at most ${USER_THEME_LIMITS.css} characters. The only url() allowed is a quoted data: address.` },
              wallpaper: {
                type: ['object', 'null'],
                description: 'An image behind the chat; null removes it. Give path to use a new image (Mousse checks it and keeps its own copy); leave path out to change only how the current one shows.',
                properties: {
                  path: { type: 'string', description: 'Absolute path of a PNG, JPEG or WebP on the computer Mousse runs on (not a network share); at most 32 MB, 16,384 px a side and 40 megapixels.' },
                  fit: { type: 'string', enum: [...WALLPAPER_FITS], description: 'cover crops the image to fill the chat (default); contain shows all of it.' },
                  position: { type: 'string', enum: [...WALLPAPER_POSITIONS], description: 'The part that stays in view when cropped. Default center.' },
                  dim: { type: 'number', minimum: 0, maximum: WALLPAPER_MAX_DIM, description: `How much the theme's background covers the image, in percent (default ${WALLPAPER_DEFAULT_DIM}). Mousse dims more when needed to keep text readable.` }
                }
              }
            },
          }
        }
      },
      access: 'changesSettings',
      permissionKey: PERMISSION_KEYS.mousseAppearance,
      class: 'mutation',
      approvalPrompt: (args) => {
        const path = wallpaperPath(args)
        return path ? `Allow this agent to use ${shownPath(path)} as the wallpaper and change how Mousse looks?` : 'Allow this agent to change how Mousse looks?'
      },
      // CSS can lay anything over the window (an invisible link or control under every click), and a new wallpaper makes
      // Mousse read a file the agent named: both ask unless the run is in Full access. Switching themes, colors and how a
      // wallpaper shows ask like any edit.
      runsWithoutAsking: (args) => {
        const css = args.userTheme && typeof args.userTheme === 'object' ? (args.userTheme as Record<string, unknown>).css : undefined
        return (typeof css === 'string' && css.trim()) || wallpaperPath(args) ? 'full' : 'edit'
      },
      listed: () => Boolean(host.appearance?.()),
      available: mayChangeSettings,
      describe: (args) => (args.userTheme ? 'Save and use a theme' : 'Switch theme'),
      handler: async (args): Promise<ToolOutcome> => {
        const tools = reach()
        // A new wallpaper image is stored first and the themes are read after it, so a change made meanwhile (another
        // window, another agent) is not overwritten: nothing below waits.
        const given = args.userTheme && typeof args.userTheme === 'object' ? wallpaperInput(args.userTheme as Record<string, unknown>) : undefined
        if (given) {
          const error = wallpaperFieldsError(given)
          if (error) return { text: error, isError: true }
        }
        const path = wallpaperPath(args)
        let image: (WallpaperImageInfo & { id: string }) | undefined
        if (path && args.theme === undefined) {
          if (!tools.importWallpaper) return { text: 'Wallpapers are not available in this profile.', isError: true }
          try {
            image = await tools.importWallpaper(path)
          } catch {
            return { text: WALLPAPER_REFUSED, isError: true }
          }
        }
        const appearance = tools.get()
        const hasTheme = typeof args.theme === 'string' && args.theme.trim() !== ''
        const hasUser = args.userTheme !== undefined
        if (hasTheme === hasUser) return { text: 'Pass either theme or userTheme.', isError: true }
        if (hasTheme) {
          const id = (args.theme as string).trim()
          if (BUILT_IN_IDS.has(id)) return json({ ...state(tools.set({ theme: id as ThemeId, userTheme: '' })) })
          if (!appearance.userThemes.some((theme) => theme.id === id))
            return { text: `No theme ${id}. Built-in: ${[...BUILT_IN_IDS].join(', ')}; user themes: ${appearance.userThemes.map((theme) => theme.id).join(', ') || 'none'}.`, isError: true }
          return json({ ...state(tools.set({ userTheme: id })) })
        }
        const input = args.userTheme && typeof args.userTheme === 'object' ? args.userTheme as Record<string, unknown> : {}
        const existing = typeof input.id === 'string' ? appearance.userThemes.find((theme) => theme.id === input.id) : undefined
        if (typeof input.id === 'string' && !existing) return { text: `No user theme ${input.id}; leave id out to create one.`, isError: true }
        if ((input.base !== undefined || !existing) && !isUserThemeBase(input.base)) return { text: `base must be one of ${USER_THEME_BASES.join(', ')}.`, isError: true }
        const colors = input.colors && typeof input.colors === 'object' ? input.colors as Record<string, unknown> : {}
        const badColor = Object.entries(colors).find(([name, value]) => !isThemeTokenName(name) || !isThemeColorValue(value))
        if (badColor) return { text: `colors["${badColor[0]}"] is not a plain color token (a lower-case --name and a hex, rgb(), hsl() or named color).`, isError: true }
        if (input.accent !== undefined && input.accent !== '' && !(typeof input.accent === 'string' && /^#[0-9a-f]{6}$/i.test(input.accent)))
          return { text: 'accent must be #rrggbb.', isError: true }
        if (typeof input.css === 'string' && input.css.length > USER_THEME_LIMITS.css) return { text: `${themeCssTooLong(input.css.length)} Nothing was saved; shorten the CSS and call theme_set again.`, isError: true }
        if (!existing && appearance.userThemes.length >= USER_THEME_LIMITS.themes)
          return { text: `There are already ${USER_THEME_LIMITS.themes} user themes; update one instead.`, isError: true }
        const id = existing?.id ?? userThemeIdFor(typeof input.name === 'string' ? input.name : '', appearance.userThemes.map((theme) => theme.id))
        const wallpaper = nextWallpaper(existing?.wallpaper, wallpaperInput(input), image)
        if (wallpaper === 'missing') return { text: 'This theme has no wallpaper yet: give wallpaper.path to choose an image.', isError: true }
        // An update keeps what it leaves out (its CSS, colors, accent, wallpaper), so a change of name or base loses nothing.
        const theme = normalizeUserTheme({ ...(existing ?? {}), ...input, wallpaper, id })
        if (!theme) return { text: 'The theme needs a name.', isError: true }
        const userThemes = existing
          ? appearance.userThemes.map((entry) => (entry.id === theme.id ? theme : entry))
          : [...appearance.userThemes, theme]
        const saved = tools.set({ userThemes, userTheme: theme.id })
        const dropped = rulesThatWillBeDropped(theme.css)
        return json({
          ...state(saved),
          saved: theme.id,
          ...(dropped.length ? { dropped, note: 'These rules will not be applied: a theme cannot load anything from outside Mousse.' } : {})
        })
      }
    }
  ]
}
