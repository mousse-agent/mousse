// Native check of the applet runtime: runs scripts/applet-runtime-probe.ts in Electron with temporary user data.
// macOS reads window pixels with `screencapture`; Linux needs X11 and ImageMagick `import`.
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import electron from 'electron'

const directory = await mkdtemp(join(tmpdir(), 'mousse-applet-probe-'))
try {
  await build({
    entryPoints: ['scripts/applet-runtime-probe.ts'],
    outfile: join(directory, 'probe.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron']
  })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  await new Promise((resolve, reject) => {
    const child = spawn(
      electron,
      [join(directory, 'probe.cjs'), directory, ...process.argv.slice(2), ...(process.platform === 'linux' ? ['--ozone-platform=x11'] : [])],
      { env, stdio: 'inherit' }
    )
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Applet probe timed out'))
    }, 90_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      code === 0 ? resolve() : reject(new Error('Applet probe failed: ' + code))
    })
  })
} finally {
  if (!process.env.KEEP_PROBE) await rm(directory, { recursive: true, force: true })
}
