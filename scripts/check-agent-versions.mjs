#!/usr/bin/env node
/**
 * Lists the agents found on PATH, and those Mousse installed, against the compatibility table
 * (`src/mms/harness/compatibility.ts`): version, tested range, known problems.
 *
 *   node scripts/check-agent-versions.mjs [--search <dir>]... [--installation-home <dir>]
 *
 * Developer-run and offline. It only runs each agent's version flag (`probeVersion`): it never
 * starts an agent for a turn, checks or changes a sign-in, or opens a session. `--installation-home`
 * is a Mousse installation folder; its install receipts are read as files.
 */
import { mkdirSync, rmdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const options = { search: [], installationHome: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--search' && value) options.search.push(resolve(value))
    else if (flag === '--installation-home' && value) options.installationHome = resolve(value)
    else throw new Error(`Unknown option ${flag}. Use --search <dir> or --installation-home <dir>.`)
    index += 1
  }
  return options
}

const ENTRY = `
import { checkAgentVersions, formatAgentVersions } from './src/mms/harness/versionCheck'
import { claudeCodeDriver } from './src/mms/harness/drivers/claudeCode'
import { codexDriver } from './src/mms/harness/drivers/codex'
import { grokDriver } from './src/mms/harness/drivers/grok'

/** The drivers' static descriptors only: no runtime is created. */
const DRIVERS = [
  { key: 'claude', driver: claudeCodeDriver() },
  { key: 'codex', driver: codexDriver({ builtIn: () => { throw new Error('not used') } }) },
  { key: 'grok', driver: grokDriver() }
]

export async function run(options) {
  const drivers = DRIVERS.map(({ key, driver }) => ({
    key,
    kind: driver.kind,
    label: driver.label,
    binaryNames: driver.binaryNames,
    canInstall: driver.canInstall,
    ...(driver.testedVersions ? { testedVersions: driver.testedVersions } : {}),
    ...(driver.knownBroken ? { knownBroken: driver.knownBroken } : {}),
    ...(driver.versionArgs ? { versionArgs: driver.versionArgs } : {})
  }))
  return formatAgentVersions(await checkAgentVersions({ drivers, searchPath: options.search, ...(options.installationHome ? { installationHome: options.installationHome } : {}) }))
}
`

async function main() {
  const options = parseArgs(process.argv.slice(2))
  // Inside the repository, so the bundle finds its packages in node_modules.
  const outDir = join(repo, 'node_modules', '.cache', 'mousse-check-agent-versions')
  mkdirSync(outDir, { recursive: true })
  const outfile = join(outDir, `check-${process.pid}.mjs`)
  try {
    await build({
      stdin: { contents: ENTRY, resolveDir: repo, loader: 'ts' },
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      logLevel: 'error'
    })
    const { run } = await import(pathToFileURL(outfile).href)
    console.log(await run(options))
  } finally {
    rmSync(outfile, { force: true })
    try {
      rmdirSync(outDir)
    } catch {
      // Another run still uses it.
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
