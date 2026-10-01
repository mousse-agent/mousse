#!/usr/bin/env node
/**
 * Bounded Windows packaged CLI/daemon qualification.
 *
 *   node scripts/qualification/windows/run.mjs \
 *     --package C:\path\to\win-unpacked \
 *     --work-root C:\path\to\task-owned-root
 *
 * Does not rebuild the package, install OS startup, download Chrome,
 * or use ~/.mousse / default AppData.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_WINDOWS_PACKAGE,
  parseRunnerArgs,
  runWindowsPackageQualification
} from './windowsPackageQualification.mjs'

const HELP = `Usage:
  node scripts/qualification/windows/run.mjs --package <win-unpacked> --work-root <dir>

Exercises the packaged Windows CLI/daemon against task-owned MOUSSE_HOME
and Electron userData. Writes evidence/report.json under --work-root.
`

const argv = process.argv.slice(2)
let args
try {
  args = parseRunnerArgs(argv)
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 2
  process.exit()
}

if (args.help || argv.length === 0) {
  process.stdout.write(HELP)
  if (argv.length === 0) process.exitCode = 2
  process.exit()
}

const packageDir = resolve(args.packageDir || DEFAULT_WINDOWS_PACKAGE)
const workRoot = resolve(
  args.workRoot ||
    join(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../runtime/windows-lifecycle-qualification'
    )
)
mkdirSync(workRoot, { recursive: true })

const report = await runWindowsPackageQualification({ packageDir, workRoot })
writeFileSync(join(workRoot, 'evidence', 'report.json'), JSON.stringify(report, null, 2))
process.stdout.write(
  JSON.stringify(
    {
      ok: report.ok,
      worktreeSha: report.worktreeSha,
      evidenceDir: report.evidenceDir,
      clientKind: report.clientKind,
      resultCounts: report.resultCounts,
      cases: report.cases.map((item) => ({ id: item.id, status: item.status }))
    },
    null,
    2
  ) + '\n'
)
process.exitCode = report.ok ? 0 : 1
