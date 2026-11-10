import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, expect, it } from 'vitest'
import { appBuild } from './support/build'

/**
 * The main window parses its whole entry chunk before the first paint. Pages and panels that are not on that
 * paint load as their own chunks (src/renderer/lib/lazySurfaces.tsx); an eager import of one of them, or of a
 * heavy library, pulls it back in. The budget sits about 10% above the entry's size when it was set (4.04 MB,
 * down from 7.31 MB): raise it only for something the first paint needs.
 *
 * It checks a production build of the current sources, made in the shared test build cache (support/build.ts).
 */
const ENTRY_BUDGET_BYTES = 4_500_000

let renderer: string
beforeAll(async () => {
  renderer = join(await appBuild(), 'renderer')
}, 5 * 60_000)

it('keeps the renderer entry chunk within its budget', () => {
  const html = readFileSync(join(renderer, 'index.html'), 'utf8')
  const scripts = [...html.matchAll(/<script type="module"[^>]*src="\.\/([^"]+\.js)"/g)].map((match) => match[1])
  expect(scripts).toHaveLength(1)
  const size = statSync(join(renderer, scripts[0])).size
  expect(size, `${scripts[0]} is ${(size / 1e6).toFixed(2)} MB; the budget is ${ENTRY_BUDGET_BYTES / 1e6} MB`).toBeLessThanOrEqual(ENTRY_BUDGET_BYTES)
  // Nothing else loads before the first paint: no chunk is preloaded beside the entry.
  expect(html).not.toMatch(/rel="modulepreload"/)
})

it('ships the split-out surfaces as chunks of their own', () => {
  const assets = readdirSync(join(renderer, 'assets'))
  const chunks = assets.filter((file) => file.endsWith('.js'))
  for (const name of ['SettingsPage', 'AutomationsPage', 'SubscriptionUsagePage', 'ChatWorkspace', 'FilesPanel',
    'ProjectTerminalPanel', 'BrowserPanel', 'ChangesPanel', 'PullRequestPanel', 'DocumentPanel', 'edit-diff']) {
    expect(chunks.some((file) => file.startsWith(`${name}-`)), name).toBe(true)
  }
  // Styles stay in the one stylesheet loaded at startup.
  expect(assets.filter((file) => file.endsWith('.css'))).toHaveLength(1)
})
