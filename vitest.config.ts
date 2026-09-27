import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['tests/setup/mousseHome.ts'],
    include: ['tests/**/*.test.ts'],
    testTimeout: 20_000
  }
})
