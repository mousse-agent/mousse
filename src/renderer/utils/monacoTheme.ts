import type { Monaco } from '@monaco-editor/react'

export const MOUSSE_EDITOR_THEME = 'mousse-editor'

function isLightTheme(): boolean {
  const theme = document.documentElement.dataset.theme
  return theme === 'light' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches)
}

export function applyEditorTheme(monaco: Monaco): void {
  const styles = getComputedStyle(document.documentElement)
  const color = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback
  const vc = (name: string, fallback: string) => color(`--vscode-${name}`, fallback)
  const light = isLightTheme()
  const isBlack = document.documentElement.dataset.theme === 'blacksphere-plus'
  const rules: { token: string; foreground?: string; fontStyle?: string }[] = []
  if (isBlack) {
    rules.push({ token: 'comment', foreground: '6D6D6D', fontStyle: 'italic' })
    rules.push({ token: 'keyword', foreground: '83D6C5' })
    rules.push({ token: 'string', foreground: 'E394DC' })
    rules.push({ token: 'number', foreground: 'EBC88D' })
    rules.push({ token: 'type', foreground: '87C3FF' })
    rules.push({ token: 'class', foreground: 'efb080' })
    rules.push({ token: 'function', foreground: 'efb080' })
    rules.push({ token: 'variable', foreground: 'd6d6d6' })
    rules.push({ token: 'operator', foreground: 'd6d6d6' })
    rules.push({ token: 'tag', foreground: '87C3FF' })
    rules.push({ token: 'attribute.name', foreground: 'AAA0FA' })
  }
  monaco.editor.defineTheme(MOUSSE_EDITOR_THEME, {
    base: light ? 'vs' : 'vs-dark',
    inherit: true,
    rules,
    colors: {
      'editor.background': vc('editor-background', color('--terminal-bg', light ? '#ffffff' : '#141414')),
      'editor.foreground': vc('editor-foreground', color('--text-primary', light ? '#242424' : '#d6d6dd')),
      'editorCursor.foreground': vc('editorCursor-foreground', color('--accent', '#7c6ee6')),
      'editorCursor.background': vc('editorCursor-background', color('--terminal-bg', '#131313')),
      'editorLineNumber.foreground': vc('editorLineNumber-foreground', color('--text-secondary', '#535353')),
      'editorLineNumber.activeForeground': vc('editorLineNumber-activeForeground', color('--text-primary', '#cccccc')),
      'editor.selectionBackground': vc('editor-selectionBackground', 'rgba(22,55,97,0.4)'),
      'editor.inactiveSelectionBackground': vc('editor-inactiveSelectionBackground', 'rgba(54,54,54,0.5)'),
      'editorIndentGuide.background': vc('editorIndentGuide-background1', 'rgba(51,51,51,0.5)'),
      'editorIndentGuide.activeBackground': vc('editorIndentGuide-activeBackground1', '#666666'),
      'editorGutter.background': vc('editorGutter-background', color('--terminal-bg', '#131313')),
      'editorHoverWidget.background': vc('editorHoverWidget-background', color('--floating-surface', '#161616')),
      'editorHoverWidget.border': vc('editorHoverWidget-border', color('--border', '#272727')),
      'editorSuggestWidget.background': vc('editorSuggestWidget-background', color('--floating-surface', '#161616')),
      'editorSuggestWidget.border': vc('editorSuggestWidget-border', color('--border', '#272727')),
      'editorSuggestWidget.foreground': vc('editorSuggestWidget-foreground', color('--text-primary', '#d6d6d6')),
      'editorSuggestWidget.selectedBackground': vc('editorSuggestWidget-selectedBackground', '#163761'),
      'input.background': vc('input-background', color('--terminal-bg', '#131313')),
      'input.border': vc('input-border', color('--border', '#272727')),
      'list.hoverBackground': vc('list-hoverBackground', 'rgba(214,214,214,0.06)'),
      'list.activeSelectionBackground': vc('list-activeSelectionBackground', 'rgba(214,214,214,0.1)'),
      'scrollbarSlider.background': vc('scrollbarSlider-background', 'rgba(214,214,214,0.08)'),
      'scrollbarSlider.hoverBackground': vc('scrollbarSlider-hoverBackground', 'rgba(214,214,214,0.1)'),
      'scrollbarSlider.activeBackground': vc('scrollbarSlider-activeBackground', 'rgba(214,214,214,0.1)'),
      'focusBorder': vc('focusBorder', 'transparent')
    }
  })
  monaco.editor.setTheme(MOUSSE_EDITOR_THEME)
}
