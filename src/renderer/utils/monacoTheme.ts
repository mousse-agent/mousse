import type { Monaco } from '@monaco-editor/react'

export const MOUSSE_EDITOR_THEME = 'mousse-editor'

function isLightTheme(): boolean {
  const theme = document.documentElement.dataset.theme
  return theme === 'light' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches)
}

export function applyEditorTheme(monaco: Monaco): void {
  const styles = getComputedStyle(document.documentElement)
  const color = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback
  const light = isLightTheme()
  monaco.editor.defineTheme(MOUSSE_EDITOR_THEME, {
    base: light ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': color('--terminal-bg', light ? '#ffffff' : '#141414'),
      'editor.foreground': color('--text-primary', light ? '#242424' : '#d6d6dd'),
      'editorCursor.foreground': color('--accent', '#7c6ee6')
    }
  })
  monaco.editor.setTheme(MOUSSE_EDITOR_THEME)
}
