import { useSyncExternalStore } from 'react'
import {
  DEFAULT_FONT_STACKS,
  fontStack,
  normalizeFontChoice,
  type FontChoice,
  type FontRole,
  type LoadedGoogleFont
} from '../../shared/fontSettings'

/**
 * The interface and code fonts. Each role has one CSS variable on the root element:
 * `--font-sans` for interface text and `--font-mono` for code, diffs, the file editor and
 * terminals. Monaco and xterm cannot read CSS variables, so they take the resolved stack from
 * `codeFontStack()` and follow `subscribeAppFonts`.
 */

export const FONT_VARIABLES: Readonly<Record<FontRole, string>> = Object.freeze({
  interface: '--font-sans',
  code: '--font-mono'
})

const stacks: Record<FontRole, string> = { ...DEFAULT_FONT_STACKS }
const listeners = new Set<() => void>()
/** Families whose cached files are registered with `document.fonts`, by `role|family`. */
const loads = new Map<string, Promise<boolean>>()
/** Google families with at least one face registered. */
const loadedFamilies = new Set<string>()
let version = 0

function notify(): void {
  version += 1
  for (const listener of listeners) listener()
}

/** Called when a stack changes or a chosen font finishes loading. */
export function subscribeAppFonts(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Whether a Google family's files are registered, so text can be drawn in it. */
export function isGoogleFontLoaded(family: string): boolean {
  return loadedFamilies.has(family)
}

export function codeFontStack(): string {
  return stacks.code
}

export function interfaceFontStack(): string {
  return stacks.interface
}

/**
 * Point the two variables at the chosen fonts. A Google font is read from the local cache only;
 * when it is not cached or fails to load, the stack falls through to the system font.
 */
export function applyFontSettings(choices: { interfaceFont?: FontChoice; codeFont?: FontChoice }): void {
  const root = typeof document === 'undefined' ? null : document.documentElement
  let changed = false
  for (const [role, raw] of [['interface', choices.interfaceFont], ['code', choices.codeFont]] as const) {
    const choice = normalizeFontChoice(raw)
    const stack = fontStack(role, choice)
    if (stack !== stacks[role]) {
      stacks[role] = stack
      changed = true
    }
    if (root) {
      if (choice.source === 'default') root.style.removeProperty(FONT_VARIABLES[role])
      else root.style.setProperty(FONT_VARIABLES[role], stack)
    }
    if (choice.source === 'google' && choice.family) void loadGoogleFont(choice.family, role, false)
  }
  if (changed) notify()
}

/**
 * Register a Google font's cached files with `document.fonts`. With `download`, fetch the files
 * from Google first if they are not cached (only when the user picks the font). Resolves false
 * when the font is not available; never rejects unless `download` was asked for and failed.
 */
export function loadGoogleFont(family: string, role: FontRole, download: boolean): Promise<boolean> {
  const key = `${role}|${family}`
  const existing = loads.get(key)
  if (existing) return existing
  const bridge = typeof window !== 'undefined' ? window.mousse?.fonts : undefined
  if (!bridge) return Promise.resolve(false)
  const pending = bridge
    .loadGoogle(family, role, download)
    .then((font) => {
      if (!font) return false
      return registerFontFaces(font)
    })
    .then((ok) => {
      if (!ok) loads.delete(key)
      else {
        loadedFamilies.add(family)
        notify()
      }
      return ok
    }, (error: unknown) => {
      loads.delete(key)
      if (download) throw error
      return false
    })
  loads.set(key, pending)
  return pending
}

/** Add the faces to `document.fonts`. Faces that fail to decode are skipped; true if any loaded. */
export async function registerFontFaces(font: LoadedGoogleFont, fonts: FontFaceSet = document.fonts): Promise<boolean> {
  const results = await Promise.all(
    font.faces.map(async (face) => {
      try {
        const descriptor: FontFaceDescriptors = { weight: String(face.weight), style: face.style, display: 'swap' }
        if (face.unicodeRange) descriptor.unicodeRange = face.unicodeRange
        const fontFace = new FontFace(font.family, face.data as Uint8Array<ArrayBuffer>, descriptor)
        await fontFace.load()
        fonts.add(fontFace)
        return true
      } catch {
        return false
      }
    })
  )
  return results.some(Boolean)
}

/** Changes whenever a stack changes or a chosen font finishes loading. */
export function useAppFontsVersion(): number {
  return useSyncExternalStore(subscribeAppFonts, () => version)
}
