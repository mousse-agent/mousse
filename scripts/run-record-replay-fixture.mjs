#!/usr/bin/env node
// Manual recorder for Run Engine replay fixtures (docs/run-engine/SPEC.md §13.6). Run by hand with
// real credentials; never in CI. Fixtures live at tests/run/fixtures/<scenario>/<adapter>.ndjson and
// are replayed by tests/run/scenarios/scenarios.test.ts.
//
// Usage: node scripts/run-record-replay-fixture.mjs --adapter <id> --scenario <name>
//
// This is a stub: it checks the environment and prints the recording procedure. It exits 2 when
// the adapter's credentials are missing and 3 once they are present (automated capture is the
// #79 follow-up).
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scenariosDir = join(root, 'tests', 'run', 'scenarios')

const ADAPTERS = {
  'claude-subscription': {
    boundary: 'Agent SDK query() seam (src/mms/run/testkit/sdkQueryReplay.ts)',
    env: {
      MOUSSE_RECORD_CLAUDE_BINARY: 'absolute path of the official Claude Code CLI',
      MOUSSE_RECORD_CLAUDE_CONFIG_DIR: 'CLAUDE_CONFIG_DIR of a profile signed in to a Claude subscription'
    }
  },
  antigravity: {
    boundary: 'ACP JSON-RPC on the agent connection (src/mms/run/testkit/acpReplay.ts)',
    env: {
      MOUSSE_RECORD_ANTIGRAVITY_BINARY: 'absolute path of the official agy_acp_server binary',
      MOUSSE_RECORD_ANTIGRAVITY_PROFILE: 'Mousse profile home whose providers/antigravity is signed in'
    }
  }
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if ((arg === '--adapter' || arg === '--scenario') && argv[i + 1]) args[arg.slice(2)] = argv[++i]
    else if (arg === '--help' || arg === '-h') args.help = true
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return args
}

function scenarios() {
  if (!existsSync(scenariosDir)) return []
  return readdirSync(scenariosDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

function usage() {
  const lines = [
    'Usage: node scripts/run-record-replay-fixture.mjs --adapter <id> --scenario <name>',
    '',
    `Adapters: ${Object.keys(ADAPTERS).join(', ')}`,
    `Scenarios: ${scenarios().join(', ')}`,
    '',
    'Environment per adapter:'
  ]
  for (const [id, adapter] of Object.entries(ADAPTERS)) {
    lines.push(`  ${id} (boundary: ${adapter.boundary})`)
    for (const [name, description] of Object.entries(adapter.env)) lines.push(`    ${name}  ${description}`)
  }
  return lines.join('\n')
}

function procedure(adapterId, scenario) {
  return [
    `Recording ${adapterId}/${scenario}:`,
    '  1. Wrap the boundary with TranscriptRecorder (src/mms/run/testkit/ReplayTransport.ts): call',
    '     recorder.out(frame) with the same projection the replay binding sends, recorder.in(frame)',
    '     for every value the provider returns, and recorder.cue({ action, text }) when you steer or',
    '     stop the run.',
    `  2. Send the prompt from tests/run/scenarios/${scenario}/input.ts through a profile using the`,
    '     credentials above, performing the scenario\'s steer/stop at the moment the cue marks.',
    `  3. recorder.write('tests/run/fixtures/${scenario}/${adapterId}.ndjson'); the header records`,
    '     the boundary and recordedAt. Remove account identifiers and secrets before committing.',
    `  4. TMPDIR=/private/tmp npx vitest run tests/run/scenarios -t ${scenario}`
  ].join('\n')
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.adapter || !args.scenario) {
    process.stderr.write(`${usage()}\n`)
    process.exit(args.help ? 0 : 2)
  }
  const adapter = ADAPTERS[args.adapter]
  if (!adapter) throw new Error(`Unknown adapter ${args.adapter}`)
  if (!scenarios().includes(args.scenario)) throw new Error(`Unknown scenario ${args.scenario}`)
  const missing = Object.keys(adapter.env).filter((name) => !process.env[name])
  if (missing.length) {
    process.stderr.write(
      `Cannot record ${args.adapter}/${args.scenario}: set ${missing.join(', ')}.\n\n${usage()}\n\n` +
        `${procedure(args.adapter, args.scenario)}\n`
    )
    process.exit(2)
  }
  process.stdout.write(
    `Credentials for ${args.adapter} are set. Automated capture is not wired yet; record by hand:\n\n` +
      `${procedure(args.adapter, args.scenario)}\n`
  )
  process.exit(3)
}

try {
  main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}\n`)
  process.exit(2)
}
