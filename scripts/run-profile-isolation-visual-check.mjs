import { createServer } from 'vite'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({
  configFile: false,
  root,
  server: { host: '127.0.0.1', port: 0, strictPort: true }
})
let child
try {
  await server.listen()
  const address = server.httpServer.address()
  if (!address || typeof address === 'string') throw new Error('No fixture server port')
  const env = {
    ...process.env,
    MOUSSE_PROFILE_FIXTURE_URL:
      `http://127.0.0.1:${address.port}/tests/fixtures/profile-isolation/profile-isolation-preview.html`
  }
  delete env.ELECTRON_RUN_AS_NODE
  const result = await new Promise((resolveResult, reject) => {
    child = spawn(electron, [resolve(root, 'scripts/check-profile-isolation-visuals.cjs')], {
      cwd: root, env, windowsHide: true, stdio: 'inherit'
    })
    child.once('error', reject)
    child.once('exit', (code) => resolveResult(code ?? 1))
  })
  process.exitCode = result
} finally {
  if (child && child.exitCode === null) child.kill()
  await server.close()
}
