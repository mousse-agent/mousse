import { createServer } from 'vite'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'
import tailwindcss from '@tailwindcss/vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Exercise the real MainViewPanel, BrowserPanel, KeepMounted and store. Unrelated
// destinations are static: this fixture must not connect providers, PTYs or MMS.
const unrelated = new Set(['AgentsWorkspace', 'ProjectTerminalPanel', 'FilesPanel', 'GitPanel', 'DocumentPanel'])
const server = await createServer({
  configFile: false, root, cacheDir: resolve(root, '.mousse-dev/browser-lifetime-vite'),
  esbuild: { jsx: 'automatic' },
  plugins: [tailwindcss(), { name: 'owned-browser-lifetime-host', enforce: 'pre',
    resolveId(id, importer) {
      const name = id.replace(/^\.\//, '')
      if (importer?.replaceAll('\\', '/').endsWith('/MainViewPanel.tsx') && unrelated.has(name)) return '\0fixture-' + name
    },
    load(id) { if (id.startsWith('\0fixture-')) return `export function ${id.slice(9)}(){return null}` }
  }],
  optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-runtime', 'lucide-react'] },
  server: { host: '127.0.0.1', port: 0, strictPort: true }
})
let child
try {
  await server.listen()
  const address = server.httpServer.address()
  if (!address || typeof address === 'string') throw new Error('No fixture port')
  const env = { ...process.env, MOUSSE_BROWSER_LIFETIME_URL: `http://127.0.0.1:${address.port}/tests/fixtures/agent-platform/browser-lifetime.html` }
  delete env.ELECTRON_RUN_AS_NODE
  process.exitCode = await new Promise((done, reject) => {
    child = spawn(electron, [resolve(root, 'scripts/check-browser-lifetime.cjs')], { cwd: root, env, windowsHide: true, stdio: 'inherit' })
    child.once('error', reject); child.once('exit', (code) => done(code ?? 1))
  })
} finally {
  if (child && child.exitCode === null) child.kill()
  await server.close()
}
