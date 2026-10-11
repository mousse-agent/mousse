import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import production from '../../../electron.vite.config'
export default defineConfig({
  main: {
    ...production.main,
    build: {
      ...production.main?.build,
      outDir: resolve('.mousse-dev/owned-process-qa/main'),
      rollupOptions: {
        ...production.main?.build?.rollupOptions,
        input: { index: resolve('src/main/index.ts'), cli: resolve('src/main/cli.ts'), 'owned-process-probe': resolve('scripts/net-qa/owned-process/probe.ts') }
      }
    }
  }
})
