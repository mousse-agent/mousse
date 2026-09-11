#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')
const viteNode = join(repoRoot, 'node_modules', 'vite-node', 'vite-node.mjs')
const cli = join(repoRoot, 'tests', 'fixtures', 'browser', 'evaluation', 'cli.ts')

const child = spawn(process.execPath, [viteNode, cli, ...process.argv.slice(2)], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    MOUSSE_EVALUATION: '1'
  }
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 1)
})
