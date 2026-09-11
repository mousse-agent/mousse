import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

it('loads the actual main bundle highlighting imports through native package exports', () => {
  // Like built-CLI checks, this verifies npm run build output. Checking the
  // generated specifiers catches externalizer regressions source imports miss.
  const root = resolve('out/main')
  const files = readdirSync(root, { recursive: true }).filter((file) => String(file).endsWith('.js'))
  const specifiers = new Set<string>()
  for (const file of files) {
    const source = readFileSync(resolve(root, String(file)), 'utf8')
    for (const match of source.matchAll(/(?:from\s*|import\s*|import\(\s*)["'](highlight\.js(?:\/[^"']*)?)["']/g)) {
      specifiers.add(match[1])
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
})
