import { createServer } from 'vite'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({
  configFile: false,
  root,
  cacheDir: resolve(root, '.mousse-dev/fixtures/agent-editor/vite-cache'),
  esbuild: { jsx: 'automatic' },
  optimizeDeps: {
    include: [
      'react',
      'react-dom/client',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'lucide-react'
    ]
  },
  server: { host: '127.0.0.1', port: 0, strictPort: false }
})
let child
try {
  await server.listen()
  const address = server.httpServer.address()
  if (!address || typeof address === 'string') throw new Error('No fixture server port')
  const env = {
    ...process.env,
    MOUSSE_AGENT_EDITOR_FIXTURE_URL:
      'http://127.0.0.1:' + address.port + '/tests/fixtures/agent-platform/agent-editor-preview.html'
  }
  delete env.ELECTRON_RUN_AS_NODE
  const result = await new Promise((resolveResult, reject) => {
    child = spawn(electron, [resolve(root, 'scripts/check-agent-editor-visuals.cjs')], {
      cwd: root,
      env,
      windowsHide: true,
      stdio: 'inherit'
    })
    child.once('error', reject)
    child.once('exit', (code) => resolveResult(code ?? 1))
  })
  process.exitCode = result
} finally {
  if (child && child.exitCode === null) child.kill()
  await server.close()
}
