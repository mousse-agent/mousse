import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

/**
 * The main window parses its whole entry chunk before the first paint. Pages and panels that are not on that
 * paint load as their own chunks (src/renderer/lib/lazySurfaces.ts); an eager import of one of them, or of a
 * heavy library, pulls it back in. The budget sits about 10% above the entry's size when it was set (4.04 MB,
 * down from 7.31 MB): raise it only for something the first paint needs.
 *
 * Like the other built-output checks, this reads `npm run build` output (out/renderer).
 */
const ENTRY_BUDGET_BYTES = 4_500_000

const renderer = resolve('out/renderer')

it('keeps the renderer entry chunk within its budget', () => {
  const html = readFileSync(resolve(renderer, 'index.html'), 'utf8')
  const scripts = [...html.matchAll(/<script type="module"[^>]*src="\.\/([^"]+\.js)"/g)].map((match) => match[1])
  expect(scripts).toHaveLength(1)
  const size = statSync(resolve(renderer, scripts[0])).size
  expect(size, `${scripts[0]} is ${(size / 1e6).toFixed(2)} MB; the budget is ${ENTRY_BUDGET_BYTES / 1e6} MB`).toBeLessThanOrEqual(ENTRY_BUDGET_BYTES)
  // Nothing else loads before the first paint: no chunk is preloaded beside the entry.
  expect(html).not.toMatch(/rel="modulepreload"/)
})

it('ships the split-out surfaces as chunks of their own', () => {
  const chunks = readdirSync(resolve(renderer, 'assets')).filter((file) => file.endsWith('.js'))
  for (const name of ['SettingsPage', 'AutomationsPage', 'SubscriptionUsagePage', 'ChatWorkspace', 'FilesPanel',
    'ProjectTerminalPanel', 'BrowserPanel', 'ChangesPanel', 'PullRequestPanel', 'DocumentPanel', 'edit-diff']) {
    expect(chunks.some((file) => file.startsWith(`${name}-`)), name).toBe(true)
  }
  // Styles stay in the one stylesheet loaded at startup.
  expect(readdirSync(resolve(renderer, 'assets')).filter((file) => file.endsWith('.css'))).toHaveLength(1)
})
