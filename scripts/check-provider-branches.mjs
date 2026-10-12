#!/usr/bin/env node
// Provider-literal ratchet (Run Engine SPEC §10). Counts provider-name string literals in the
// orchestrator and run-engine sources and fails when the total rises above the committed
// baseline. Provider names belong in src/mms/run/adapters/**, which is excluded.
//
// Usage: node scripts/check-provider-branches.mjs [--write-baseline] [--root <dir>]
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROVIDER_LITERAL = /'(claude-subscription|antigravity|codex|claude-code|cursor-agents-cli|opencode)'/g
const SCANNED_DIRS = ['src/mms/orchestrator', 'src/mms/run']
const EXCLUDED_PREFIXES = ['src/mms/run/adapters/']
const BASELINE_PATH = 'scripts/provider-branch-baseline.json'

function parseCliArgs(argv) {
  const options = { writeBaseline: false, root: resolve(dirname(fileURLToPath(import.meta.url)), '..') }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--write-baseline') options.writeBaseline = true
    else if (arg === '--root' && argv[i + 1]) options.root = resolve(argv[++i])
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return options
}

function listTsFiles(root, dir) {
  const absolute = join(root, dir)
  if (!existsSync(absolute)) return []
  return readdirSync(absolute, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .filter((path) => !EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix)))
    .sort()
}

function countProviderLiterals(root) {
  const files = {}
  let total = 0
  for (const dir of SCANNED_DIRS) {
    for (const path of listTsFiles(root, dir)) {
      const count = (readFileSync(join(root, path), 'utf8').match(PROVIDER_LITERAL) ?? []).length
      if (count === 0) continue
      files[path] = count
      total += count
    }
  }
  return { total, files }
}

function main() {
  const options = parseCliArgs(process.argv.slice(2))
  const summary = countProviderLiterals(options.root)
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)

  const baselinePath = join(options.root, BASELINE_PATH)
  if (options.writeBaseline) {
    writeFileSync(baselinePath, `${JSON.stringify({ total: summary.total }, null, 2)}\n`)
    process.stdout.write(`Wrote provider-literal baseline ${summary.total} to ${BASELINE_PATH}\n`)
    return
  }

  if (!existsSync(baselinePath)) {
    process.stderr.write(`Missing ${BASELINE_PATH}; run with --write-baseline to create it.\n`)
    process.exit(1)
  }
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
  if (typeof baseline.total !== 'number') {
    process.stderr.write(`${BASELINE_PATH} must contain a numeric "total".\n`)
    process.exit(1)
  }
  if (summary.total > baseline.total) {
    process.stderr.write(
      `Provider-literal ratchet failed: found ${summary.total} provider literals in ${SCANNED_DIRS.join(', ')} ` +
        `but the baseline allows ${baseline.total}. Move provider-specific branches into src/mms/run/adapters/ ` +
        'instead of adding new provider string literals.\n'
    )
    process.exit(1)
  }
  if (summary.total < baseline.total) {
    process.stdout.write(
      `Provider-literal count dropped to ${summary.total} (baseline ${baseline.total}); ` +
        'run with --write-baseline to lock in the reduction.\n'
    )
  }
}

main()
