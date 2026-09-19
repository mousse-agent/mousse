import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const piCodingAgentShim = resolve(__dirname, 'src/mms/providers/piCodingAgentShim.ts')
const rendererPort = process.env.MOUSSE_RENDERER_PORT ? Number(process.env.MOUSSE_RENDERER_PORT) : 5713
if (!Number.isInteger(rendererPort) || rendererPort < 1024 || rendererPort > 65535) {
  throw new Error('MOUSSE_RENDERER_PORT must be an integer between 1024 and 65535')
}

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@earendil-works/pi-coding-agent': piCodingAgentShim,
        // Fallback if any transitive import survives the shim.
        'highlight.js/lib/index.js': 'highlight.js'
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
        plugins: [
          {
            name: 'normalize-highlight-js-external',
            renderChunk(code) {
              // The dependency externalizer emits resolved filenames. These
              // subpaths must instead match highlight.js's package exports;
              // language filenames otherwise resolve to a doubled .js suffix.
              const normalized = code.replace(
                /(["'])highlight\.js\/lib\/(index|core|common|languages\/[\w-]+)\.js\1/g,
                (_match, quote: string, subpath: string) =>
                  `${quote}${subpath === 'index' ? 'highlight.js' : `highlight.js/lib/${subpath}`}${quote}`
              )
              return normalized === code ? null : { code: normalized, map: null }
            }
          }
        ],
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          cli: resolve(__dirname, 'src/main/cli.ts')
        },
        // Keep the public package id. Vite's dependency externalizer resolves
        // highlight.js to lib/index.js, which is not an exported ESM subpath.
        external: ['@cursor/sdk', 'bun:sqlite', 'highlight.js']
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
    server: { host: '127.0.0.1', port: rendererPort, strictPort: true },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          agentsTasks: resolve(__dirname, 'src/renderer/agentsTasks.html')
        }
      }
    },
    plugins: [tailwindcss(), react()]
  }
})
