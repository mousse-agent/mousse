import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { appBuild } from './support/build'

it('loads every package subpath the actual main bundle imports through native package exports', async () => {
  // This checks a production build of the current sources (support/build.ts), not the checkout's out/. The
  // generated specifiers catch externalizer regressions source imports miss,
  // such as a subpath (highlight.js/lib/index.js once) that the package does not export.
  const root = join(await appBuild(), 'main')
  const files = readdirSync(root, { recursive: true }).filter((file) => String(file).endsWith('.js'))
  const specifiers = new Set<string>()
  for (const file of files) {
    const source = readFileSync(resolve(root, String(file)), 'utf8')
    for (const match of source.matchAll(/(?:from\s*|import\s*|import\(\s*)["']((?:@[\w-][\w.-]*\/)?[\w-][\w.-]*\/[^"']+)["']/g)) {
      if (!match[1].startsWith('node:')) specifiers.add(match[1])
    }
  }
  expect(specifiers.size).toBeGreaterThan(0)
  const result = spawnSync(process.execPath, [
    '--input-type=module', '-e',
    'for (const name of JSON.parse(process.argv[1])) await import(name)',
    JSON.stringify([...specifiers])
  ], { cwd: process.cwd(), encoding: 'utf8', timeout: 15_000, windowsHide: true })
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
}, 5 * 60_000)
