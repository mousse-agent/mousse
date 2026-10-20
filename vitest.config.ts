import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

// Tests that start real processes (daemons, the built CLI, Electron, Chrome, git
// shells, native compiles) or several full profiles over real TLS each hold
// hundreds of MB and starve CPU-bound neighbours into timeouts. They run as a
// separate, narrow group after the in-process tests finish.
const PROCESS_MARKERS = [
  /from '(node:)?child_process'/,
  /electron|chromium|puppeteer|playwright/i,
  /fixtures\/(gitFoundation|resource-lifecycle-qualification)/,
  /\/(ownedTemp|terminateChild|http-fixture|pin|environment)'/,
  /\/support\/(build|daemon)'/,
  /buildNativeReader/
]
const PROCESS_PATHS = [/^tests\/net\/chats\//]

const testFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return testFiles(path)
    return entry.name.endsWith('.test.ts') ? [path] : []
  })

const processTests = testFiles('tests').filter((file) => {
  if (PROCESS_PATHS.some((path) => path.test(file.replaceAll('\\', '/')))) return true
  const source = readFileSync(file, 'utf8')
  return PROCESS_MARKERS.some((marker) => marker.test(source))
})

const shared = {
  environment: 'node',
  setupFiles: ['tests/setup/mousseHome.ts'],
  testTimeout: 20_000
} as const

// Changes to these affect every test, so `--changed`, `related` and scripts/test-select.mjs run everything.
const FULL_RUN_TRIGGERS = [
  '**/tests/setup/**',
  '**/tests/support/**',
  '**/tests/fixtures/**',
  '**/tests/test-dependencies.json',
  '**/vitest.config.*',
  '**/vite.config.*',
  '**/electron.vite.config.*',
  '**/package.json',
  '**/package-lock.json',
  '**/tsconfig*.json',
  '**/scripts/test-select.mjs'
]

export default defineConfig({
  test: {
    forceRerunTriggers: FULL_RUN_TRIGGERS,
    projects: [
      {
        test: {
          ...shared,
          name: 'unit',
          include: ['tests/**/*.test.ts'],
          exclude: processTests,
          maxWorkers: '50%',
          sequence: { groupOrder: 0 }
        }
      },
      {
        test: {
          ...shared,
          name: 'process',
          include: processTests,
          maxWorkers: 2,
          sequence: { groupOrder: 1 }
        }
      }
    ]
  }
})
