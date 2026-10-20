import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

// The team workflow helpers ship their own node:test files. Running them from the suite keeps
// `npm test` the one local gate; the runner stays node:test so the files need no adapter code.
it('team workflow scripts pass their node:test files', () => {
  const root = resolve(import.meta.dirname, '..')
  const result = spawnSync(process.execPath, ['--test', 'scripts/team-status.test.mjs', 'scripts/team-cleanup.test.mjs'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, NO_COLOR: '1' }
  })
  expect(result.error).toBeUndefined()
  expect(result.status, `${result.stdout.slice(-4000)}\n${result.stderr.slice(-4000)}`).toBe(0)
}, 150_000)
