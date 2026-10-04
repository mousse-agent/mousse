import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import production from '../../../electron.vite.config'

// Build the actual production main/CLI entries with one additional QA entry.
// Renderer and preload qualification wait for the complete application composition.
export default defineConfig({
  main: {
    ...production.main,
    build: {
      ...production.main?.build,
      outDir: resolve('.mousse-dev/net-packaging/main'),
      rollupOptions: {
        ...production.main?.build?.rollupOptions,
        input: {
          index: resolve('src/main/index.ts'),
          cli: resolve('src/main/cli.ts'),
          probe: resolve('scripts/net-qa/packaging/probe.ts')
        }
      }
    }
  }
})
