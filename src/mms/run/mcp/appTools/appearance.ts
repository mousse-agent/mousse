import { PERMISSION_KEYS } from '../../../../shared/permissionKeys'
import { THEME_OPTIONS, type AppearanceSettings, type ThemeId } from '../../../../shared/settings'
import { externalLoadIn } from '../../../../shared/themes/cssSafety'
import {
  activeUserTheme,
  isThemeColorValue,
  isThemeTokenName,
  isUserThemeBase,
  normalizeUserTheme,
  themeStylingGuide,
  USER_THEME_BASES,
  USER_THEME_LIMITS,
  userThemeIdFor,
  type UserTheme
} from '../../../../shared/themes/userThemes'
import type { AppToolHost } from './host'
import { disabledInSettings, json, type Availability, type AppToolTurn, type MousseTool, type ToolOutcome } from './types'

/** What the theme tools reach: the profile's appearance settings, read and saved at every call. */
export interface AppearanceToolHost {
  get(): AppearanceSettings
  /** Saves `patch` over the appearance settings and tells every window of the profile; returns what was saved. */
  set(patch: Partial<AppearanceSettings>): AppearanceSettings
}

export const THEME_READ_TOOL = 'theme_read'
export const THEME_SET_TOOL = 'theme_set'

const BUILT_IN_IDS: ReadonlySet<string> = new Set(THEME_OPTIONS.map((option) => option.id))

/** The pieces of `css` (top-level rules, split at their closing brace) that the window will drop. */
function rulesThatWillBeDropped(css: string): Array<{ rule: string; reason: string }> {
  const out: Array<{ rule: string; reason: string }> = []
  let depth = 0
  let start = 0
  const check = (piece: string): void => {
    const reason = piece.trim() ? externalLoadIn(piece) : null
    if (reason && out.length < 20) out.push({ rule: piece.replace(/\s+/g, ' ').trim().slice(0, 160), reason })
  }
  for (let index = 0; index < css.length; index++) {
    const ch = css[index]
    if (ch === '{') depth++
    else if (ch === '}' && depth > 0 && --depth === 0) {
      check(css.slice(start, index + 1))
      start = index + 1
    } else if (ch === ';' && depth === 0) {
      check(css.slice(start, index + 1))
      start = index + 1
    }
  }
  check(css.slice(start))
  return out
}

function summary(theme: UserTheme, withCss: boolean): Record<string, unknown> {
  return {
    id: theme.id,
    name: theme.name,
    base: theme.base,
    ...(theme.accent ? { accent: theme.accent } : {}),
    colors: theme.colors,
    ...(withCss ? { css: theme.css } : { cssLength: theme.css.length })
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
        `Change how Mousse looks. Either theme: switch to a built-in theme (${builtIns}; "system" follows the computer's light or dark mode) or an existing user theme id. Or userTheme: create a user theme (no id) or update one (its id) and switch to it. Read theme_read first for the tokens and selectors. CSS that could load anything from outside Mousse is dropped.`,
      inputSchema: {
        type: 'object',
        properties: {
          theme: { type: 'string', description: 'A built-in theme id, or a user theme id.' },
          userTheme: {
            type: 'object',
            description: 'A user theme to save and switch to.',
            properties: {
              id: { type: 'string', description: 'An existing user theme id to update; leave out to create one.' },
              name: { type: 'string', description: `A short name (at most ${USER_THEME_LIMITS.name} characters).` },
              base: { type: 'string', enum: [...USER_THEME_BASES], description: 'The built-in theme it starts from: dark or light, usually.' },
              accent: { type: 'string', description: 'Accent color as #rrggbb; leave out to keep the person\'s accent.' },
              colors: { type: 'object', additionalProperties: { type: 'string' }, description: 'Color tokens by name (--surface-base: "#101418"). Plain colors only.' },
              css: { type: 'string', description: 'Extra CSS, using the stable selectors from theme_read.' }
            },
            required: ['name', 'base']
          }
        }
      },
      access: 'changesSettings',
      permissionKey: PERMISSION_KEYS.mousseAppearance,
      class: 'mutation',
      approvalPrompt: 'Allow this agent to change how Mousse looks?',
      listed: () => Boolean(host.appearance?.()),
      available: mayChangeSettings,
      describe: (args) => (args.userTheme ? 'Save and use a theme' : 'Switch theme'),
      handler: (args): ToolOutcome => {
        const tools = reach()
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
        if (!isUserThemeBase(input.base)) return { text: `base must be one of ${USER_THEME_BASES.join(', ')}.`, isError: true }
        const colors = input.colors && typeof input.colors === 'object' ? input.colors as Record<string, unknown> : {}
        const badColor = Object.entries(colors).find(([name, value]) => !isThemeTokenName(name) || !isThemeColorValue(value))
        if (badColor) return { text: `colors["${badColor[0]}"] is not a plain color token (a lower-case --name and a hex, rgb(), hsl() or named color).`, isError: true }
        if (input.accent !== undefined && input.accent !== '' && !(typeof input.accent === 'string' && /^#[0-9a-f]{6}$/i.test(input.accent)))
          return { text: 'accent must be #rrggbb.', isError: true }
        if (typeof input.css === 'string' && input.css.length > USER_THEME_LIMITS.css) return { text: `css is longer than ${USER_THEME_LIMITS.css} characters.`, isError: true }
        const existing = typeof input.id === 'string' ? appearance.userThemes.find((theme) => theme.id === input.id) : undefined
        if (typeof input.id === 'string' && !existing) return { text: `No user theme ${input.id}; leave id out to create one.`, isError: true }
        if (!existing && appearance.userThemes.length >= USER_THEME_LIMITS.themes)
          return { text: `There are already ${USER_THEME_LIMITS.themes} user themes; update one instead.`, isError: true }
        const id = existing?.id ?? userThemeIdFor(typeof input.name === 'string' ? input.name : '', appearance.userThemes.map((theme) => theme.id))
        const theme = normalizeUserTheme({ ...input, id })
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
