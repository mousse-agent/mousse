import { readFileSync } from 'fs'
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const mousseVersion: string = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')).version
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
    // The Mousse ID service this build signs in to (src/renderer/lib/plusSignIn.ts). Official
    // releases set MOUSSE_ID_ORIGIN; builds without it show no Mousse ID UI.
    // The package version, which release builds stamp before building (shown in settings).
    define: {
      __MOUSSE_ID_ORIGIN__: JSON.stringify(process.env.MOUSSE_ID_ORIGIN || process.env.MOUSSE_PLUS_ORIGIN || ''),
      __MOUSSE_VERSION__: JSON.stringify(mousseVersion)
    },
    resolve: {
      alias: [
        // Read aloud runs Kokoro on the CPU WebAssembly build only; the default entry bundles the
        // 21 MB WebGPU build that is never used.
        { find: /^onnxruntime-web$/, replacement: 'onnxruntime-web/wasm' },
        // The package exports do not expose dist/*; the worker imports the runtime files as assets.
        { find: '@onnxruntime-web-dist', replacement: resolve(__dirname, 'node_modules/onnxruntime-web/dist') }
      ]
    },
    optimizeDeps: {
      // The local speech workers load only when a voice or dictation model first runs. Bundling
      // their dependencies at startup keeps that first run from re-optimizing mid-session.
      include: ['kokoro-js', '@huggingface/transformers', 'onnxruntime-web'],
      // The alias looks like a package, so the dev server would pre-bundle the `?url` runtime
      // import. That fails the whole optimization and the worker cannot load.
      exclude: ['@onnxruntime-web-dist']
    },
    // Module workers can import dynamically, which needs ES output instead of IIFE.
    worker: { format: 'es' },
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
