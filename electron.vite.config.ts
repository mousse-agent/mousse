import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const highlightJsEntry = resolve(__dirname, 'node_modules/highlight.js/lib/index.js')
const piCodingAgentShim = resolve(__dirname, 'src/mms/providers/piCodingAgentShim.ts')

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@earendil-works/pi-coding-agent': piCodingAgentShim,
        // Fallback if any transitive import survives the shim.
        'highlight.js/lib/index.js': highlightJsEntry
      }
    },
    // Keep pi-coding-agent excluded from externalization so the alias shim is
    // applied. The real package (and its undici dependency) is incompatible with
    // Electron's Node build; tools are loaded from dist/core/tools at runtime.
    plugins: [
      externalizeDepsPlugin({
        exclude: ['pi-cursor-sdk', '@earendil-works/pi-coding-agent']
      })
    ],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          cli: resolve(__dirname, 'src/main/cli.ts')
        },
        external: ['@cursor/sdk', 'bun:sqlite']
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          agentsTasks: resolve(__dirname, 'src/renderer/agentsTasks.html')
        }
      }
    },
    plugins: [react()]
  }
})
