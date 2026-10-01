#!/usr/bin/env node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createServer } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')
const cacheDir = await mkdtemp(resolve(tmpdir(), 'mousse-browser-eval-vite-'))
const server = await createServer({
  root: repoRoot,
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  cacheDir,
  server: { middlewareMode: true }
})

try {
  const module = await server.ssrLoadModule('/tests/fixtures/browser/evaluation/cli.ts')
  await module.runCli(process.argv.slice(2))
} catch (error) {
  process.stderr.write(String(error instanceof Error ? error.stack ?? error.message : error) + '\n')
  process.exitCode = 1
} finally {
  await server.close()
  await rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
}
