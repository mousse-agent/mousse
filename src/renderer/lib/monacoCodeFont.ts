import { useEffect } from 'react'
import { loader } from '@monaco-editor/react'
import { codeFontStack, useAppFontsVersion } from './appFonts'

/**
 * The code font for a Monaco editor's `fontFamily` option. Monaco caches glyph widths, so when
 * the font changes or finishes loading it measures again.
 */
export function useMonacoCodeFont(): string {
  const version = useAppFontsVersion()
  useEffect(() => {
    if (version > 0) loader.__getMonacoInstance()?.editor.remeasureFonts()
  }, [version])
  return codeFontStack()
}
