import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

// Resource membership is an audited inventory, not a search over test source text.
// Resource groups run sequentially so different worker budgets cannot overlap.
const lanes = JSON.parse(readFileSync(new URL('./tests/test-lanes.json', import.meta.url), 'utf8')) as {
  process: string[]; serviceTls: string[]; daemon: string[]; browser: string[]
}
const processTests = lanes.process
const heavyTests = [...lanes.serviceTls, ...lanes.daemon, ...lanes.browser]
const budgetedTests = [...processTests, ...heavyTests]

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
  '**/tests/test-lanes.json',
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
          exclude: budgetedTests,
          maxWorkers: '50%',
          sequence: { groupOrder: 0 }
        }
      },
      {
        test: {
          ...shared,
          name: 'process',
          include: processTests,
          maxWorkers: 3,
          sequence: { groupOrder: 1 }
        }
      },
      {
        test: {
          ...shared,
          name: 'heavy',
          include: heavyTests,
          maxWorkers: 2,
          sequence: { groupOrder: 2 }
        }
      }
    ]
  }
})
