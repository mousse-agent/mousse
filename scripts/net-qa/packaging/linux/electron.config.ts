import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import production from '../../../../electron.vite.config'
// Production main remains unchanged; this inert extra entry is supplemental QA.
export default defineConfig({ main: { ...production.main, build: { ...production.main?.build,
  outDir: resolve('.mousse-dev/net-packaging/linux/main'), rollupOptions: { ...production.main?.build?.rollupOptions,
    input: { index: resolve('src/main/index.ts'), cli: resolve('src/main/cli.ts'), linuxProbe: resolve('scripts/net-qa/packaging/linux/asar-runtime.ts') }
  } } } })
