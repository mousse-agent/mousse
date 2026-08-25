const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  bat: 'bat', c: 'c', cc: 'cpp', cpp: 'cpp', cs: 'csharp', css: 'css',
  cxx: 'cpp', dockerfile: 'dockerfile', go: 'go', gql: 'graphql', graphql: 'graphql',
  h: 'cpp', hpp: 'cpp', html: 'html', ini: 'ini', java: 'java', js: 'javascript',
  json: 'json', jsonc: 'json', jsx: 'javascript', kt: 'kotlin', less: 'less', lua: 'lua',
  md: 'markdown', markdown: 'markdown', php: 'php', ps1: 'powershell', py: 'python',
  rb: 'ruby', rs: 'rust', scss: 'scss', sh: 'shell', sql: 'sql', svg: 'xml',
  toml: 'ini', ts: 'typescript', tsx: 'typescript', vue: 'html', xml: 'xml',
  yaml: 'yaml', yml: 'yaml', zsh: 'shell'
}

const LANGUAGE_BY_FILENAME: Record<string, string> = {
  dockerfile: 'dockerfile', makefile: 'plaintext', '.gitignore': 'plaintext',
  '.env': 'ini', '.editorconfig': 'ini'
}

export function languageForPath(filePath: string): string {
  const filename = filePath.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? ''
  const exact = LANGUAGE_BY_FILENAME[filename]
  if (exact) return exact
  const extension = filename.includes('.') ? filename.split('.').pop() ?? '' : ''
  return LANGUAGE_BY_EXTENSION[extension] ?? 'plaintext'
}

/** IPC returns UTF-8 text; embedded NULs reliably identify files that must not be edited as text. */
export function isBinaryContent(content: string): boolean {
  return content.includes('\0')
}

export type FileViewKind = 'text' | 'markdown' | 'html' | 'pdf' | 'image' | 'video'

export function viewKindForPath(filePath: string): FileViewKind {
  const extension = filePath.replace(/\\/g, '/').split('/').pop()?.split('.').pop()?.toLowerCase()
  if (extension === 'md' || extension === 'markdown') return 'markdown'
  if (extension === 'html' || extension === 'htm') return 'html'
  if (extension === 'pdf') return 'pdf'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'].includes(extension ?? '')) return 'image'
  if (['mp4', 'webm', 'ogv', 'mov', 'm4v'].includes(extension ?? '')) return 'video'
  return 'text'
}

export function isAssetView(kind: FileViewKind): boolean {
  return kind === 'pdf' || kind === 'image' || kind === 'video'
}
