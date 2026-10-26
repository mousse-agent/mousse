#!/usr/bin/env node
/**
 * Downloads the Codex release managed ChatGPT entries pin, through Mousse's own installer (pinned
 * size and SHA-256, unpacked and checked, `codex --version`), into `.cache/codex-pin/`. The wire
 * test (`tests/harness/codexManagedWire.test.ts`) runs this binary against local fakes.
 *
 *   npm run codex:pin
 */
import { build } from 'esbuild'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const CODEX_PIN_HOME = join(root, '.cache', 'codex-pin')

const runner = join(root, '.cache', 'codex-pin-runner.mjs')
mkdirSync(dirname(runner), { recursive: true })
await build({
  stdin: {
    contents: "export { CodexInstallation } from './src/mms/harness/codex/installation'",
    resolveDir: root,
    loader: 'ts'
  },
  outfile: runner,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  logLevel: 'error'
})
try {
  const { CodexInstallation } = await import(pathToFileURL(runner).href)
  const installation = new CodexInstallation({ installationHome: CODEX_PIN_HOME })
  const unsupported = installation.unsupportedMessage()
  if (unsupported) throw new Error(unsupported)
  const present = installation.installed()
  if (present && !present.broken && !(await installation.verify(new AbortController().signal))) {
    console.log(`Codex ${present.version} is already pinned and checked: ${present.path}`)
  } else {
    let last = ''
    const installed = await installation.install((progress) => {
      if (progress.message !== last) process.stdout.write(`\r${(last = progress.message)}      `)
    })
    console.log(`\nCodex ${installed.version} pinned and checked: ${installed.path}`)
  }
} finally {
  rmSync(runner, { force: true })
}
