import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { THEME_OPTIONS, type ThemeId } from '../../shared/settings'
import { normalizeUserTheme, type UserTheme } from '../../shared/themes/userThemes'

/** Which theme is in use: a built-in theme, and the user theme on top of it (empty for none). */
export interface ThemeChoice {
  theme: ThemeId
  userTheme: string
}

/**
 * How Mousse looked before agents started changing its theme, so `theme_set { restore: true }` can put it back from any
 * thread, after a restart too. Taken at the first agent change and kept through the next ones; it ends when it is
 * restored, or when the person picks another theme (the choice in use is then no longer `after`).
 */
export interface ThemeRestorePoint {
  savedAt: string
  /** The theme in use before. */
  before: ThemeChoice
  /** Each user theme agents changed since, as it was before; null for one an agent made. */
  themes: Record<string, UserTheme | null>
  /** The theme in use after the agents' last change. */
  after: ThemeChoice
}

const BUILT_IN_IDS: ReadonlySet<string> = new Set(THEME_OPTIONS.map((option) => option.id))

export function sameChoice(a: ThemeChoice, b: ThemeChoice): boolean {
  return a.theme === b.theme && a.userTheme === b.userTheme
}

function choice(raw: unknown): ThemeChoice | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  if (typeof value.theme !== 'string' || !BUILT_IN_IDS.has(value.theme) || typeof value.userTheme !== 'string') return undefined
  return { theme: value.theme as ThemeId, userTheme: value.userTheme }
}

/** A restore point read from disk, or undefined when it is missing or unreadable. */
export function normalizeThemeRestorePoint(raw: unknown): ThemeRestorePoint | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  const before = choice(value.before)
  const after = choice(value.after)
  if (!before || !after || !value.themes || typeof value.themes !== 'object') return undefined
  const themes: Record<string, UserTheme | null> = {}
  for (const [id, entry] of Object.entries(value.themes as Record<string, unknown>)) {
    if (entry === null) themes[id] = null
    else {
      const theme = normalizeUserTheme(entry)
      if (theme && theme.id === id) themes[id] = theme
    }
  }
  return { savedAt: typeof value.savedAt === 'string' ? value.savedAt : '', before, themes, after }
}

/** The profile's one theme restore point, in `<home>/appearance/theme-restore.json`. */
export class ThemeRestoreStore {
  private readonly dir: string
  private readonly path: string

  constructor(homeDir: string) {
    this.dir = join(homeDir, 'appearance')
    this.path = join(this.dir, 'theme-restore.json')
  }

  get(): ThemeRestorePoint | undefined {
    if (!existsSync(this.path)) return undefined
    try {
      return normalizeThemeRestorePoint(JSON.parse(readFileSync(this.path, 'utf8')))
    } catch {
      return undefined
    }
  }

  set(point: ThemeRestorePoint | undefined): void {
    if (!point) {
      rmSync(this.path, { force: true })
      return
    }
    mkdirSync(this.dir, { recursive: true })
    atomicWriteJsonSync(this.path, point)
  }
}
