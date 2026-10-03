import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

if (process.env.MOUSSE_NET_QA_OPT_IN !== '1') throw new Error('Set MOUSSE_NET_QA_OPT_IN=1 to run a real transport/network probe.')
const kind = process.argv[2]
if (!['cloudflared', 'tailscale'].includes(kind)) throw new Error('Choose cloudflared or tailscale.')
const directory = await mkdtemp(join(tmpdir(), 'mousse-transport-qa-build-'))
try {
  const outfile = join(directory, 'probe.cjs')
  await build({ entryPoints: [join(dirname(fileURLToPath(import.meta.url)), 'probe.ts')], bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent' })
  const code = await new Promise(resolve => { const child = spawn(process.execPath, [outfile, kind], { stdio: 'inherit', env: process.env }); child.once('error', () => resolve(1)); child.once('exit', status => resolve(status ?? 1)) })
  process.exitCode = code
} finally { await rm(directory, { recursive: true, force: true }) }
