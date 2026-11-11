/**
 * The size of the chat's render caches in this window (parsed Markdown, highlighted code), for the
 * memory monitor. Each cache notes its bytes as they change; a few seconds later the sizes are put on
 * the document element in KB (`data-mousse-markdown-cache-kb`, `data-mousse-code-cache-kb`), where
 * the preload reads them once a minute.
 */
export type RenderCacheName = 'markdown' | 'code'

const PUBLISH_AFTER_MS = 5_000
const sizes = new Map<RenderCacheName, number>()
let timer: ReturnType<typeof setTimeout> | null = null

function publish(): void {
  timer = null
  const root = typeof document === 'undefined' ? undefined : document.documentElement
  if (!root) return
  const kb = (name: RenderCacheName) => String(Math.round((sizes.get(name) ?? 0) / 1024))
  root.dataset.mousseMarkdownCacheKb = kb('markdown')
  root.dataset.mousseCodeCacheKb = kb('code')
}

export function noteRenderCacheBytes(name: RenderCacheName, bytes: number): void {
  sizes.set(name, bytes)
  if (timer === null) {
    timer = setTimeout(publish, PUBLISH_AFTER_MS)
    ;(timer as { unref?: () => void }).unref?.()
  }
}
