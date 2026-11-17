#!/usr/bin/env node
// Runs the named test files (vitest, quiet) and optional typechecks, prints only a pass/fail
// summary with the first failures trimmed, and records HEAD, commands and results in
// .task-notes.json so later steps reuse them instead of rerunning. A record is reusable only while the
// working-tree fingerprint (the exact file contents) is the same; any edit makes it not verified.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseArgv, readNotes, recordNotes, repoRoot, stripAnsi, trimText, workingTreeFingerprint } from './work-lib.mjs';

const HELP = `Usage: node scripts/verify.mjs [test files...] [--typecheck web|node|all] [options]

Runs only the named vitest files and/or the typecheck, then prints a short summary.
Options:
  --typecheck <p>    web, node or all (tsc --noEmit on tsconfig.web.json / tsconfig.node.json)
  --max-failures <n> failures to print (default 3)
  --no-notes         do not record the run in .task-notes.json
  --help             this text

Exit codes: 0 everything passed, 1 something failed or could not run, 2 usage error.
The record (HEAD sha, working-tree fingerprint, commands, results) lives in .task-notes.json under "tested".
Rerunning with the same fingerprint replaces the entry for the same command; any change to the files starts a new record.`;

const TYPECHECKS = { web: 'tsconfig.web.json', node: 'tsconfig.node.json' };

// ---------- pure digesting ----------

/** Summarises vitest's JSON report: counts plus the first failing tests with trimmed messages. */
export function summarizeVitestJson(report, { maxFailures = 3 } = {}) {
  const files = report.testResults ?? [];
  const failures = [];
  for (const file of files) {
    const failedTests = (file.assertionResults ?? []).filter((test) => test.status === 'failed');
    for (const test of failedTests) {
      failures.push({ where: `${shortName(file.name)} > ${test.fullName ?? test.title}`, message: (test.failureMessages ?? []).join('\n') });
    }
    if (file.status === 'failed' && !failedTests.length) {
      failures.push({ where: shortName(file.name), message: file.message || 'the file failed to run' });
    }
  }
  const failedTests = report.numFailedTests ?? failures.length;
  const ok = report.success === true && failures.length === 0 && failedTests === 0;
  const total = report.numTotalTests ?? 0;
  const summary = `${files.length} file(s), ${total} test(s)${ok ? '' : `, ${failedTests} failed`}`;
  const clean = (message) => stripAnsi(message).split(/\r?\n/).filter((line) => !/^\s*at /.test(line)).join('\n');
  const shown = failures.slice(0, maxFailures).map(({ where, message }) =>
    `  x ${where}\n${indent(trimText(clean(message), { maxLines: 6, maxLineChars: 160 }), '      ')}`);
  if (failures.length > maxFailures) shown.push(`  … ${failures.length - maxFailures} more failure(s)`);
  return { ok, summary, failures: shown };
}

/** Summarises tsc output: error count plus the first errors. */
export function summarizeTsc(output, { maxFailures = 3, ok = false } = {}) {
  const errors = stripAnsi(output).split(/\r?\n/).filter((line) => /error TS\d+/.test(line));
  const first = errors.slice(0, maxFailures).map((line) => `  ${trimText(line, { maxLines: 1, maxLineChars: 200 })}`);
  if (errors.length > maxFailures) first.push(`  … ${errors.length - maxFailures} more error(s)`);
  return { ok: ok && errors.length === 0, summary: errors.length ? `${errors.length} error(s)` : 'no errors', failures: first };
}

function shortName(name) {
  const normalized = String(name ?? '').replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/tests/');
  return index === -1 ? normalized : normalized.slice(index + 1);
}

const indent = (text, prefix) => text.split('\n').map((line) => `${prefix}${line}`).join('\n');

/** Merges a new result into the recorded run: only the same working-tree fingerprint keeps older results. */
export function mergeTested(previous, { sha, tree, dirty, at }, result) {
  const sameRun = Boolean(previous && tree && previous.tree === tree);
  const results = (sameRun ? previous.results : []).filter((entry) => entry.command !== result.command);
  return { sha, tree, dirty, at, results: [...results, result] };
}

// ---------- running ----------

function nodeTool(root, relative) {
  const path = join(root, 'node_modules', ...relative);
  return existsSync(path) ? path : null;
}

function runTool(root, script, args, { timeout }) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root, encoding: 'utf8', timeout, maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  return { result, ms: Date.now() - started };
}

function runVitest(root, files, maxFailures) {
  const vitest = nodeTool(root, ['vitest', 'vitest.mjs']);
  const command = `npx vitest run ${files.join(' ')}`;
  if (!vitest) return { command, ok: false, summary: 'vitest is not installed here (run npm ci or link node_modules)', failures: [], ms: 0 };
  const dir = mkdtempSync(join(tmpdir(), 'verify-'));
  const outputFile = join(dir, 'report.json');
  try {
    const { result, ms } = runTool(root, vitest, ['run', ...files, '--reporter=json', `--outputFile=${outputFile}`], { timeout: 20 * 60_000 });
    if (existsSync(outputFile)) {
      try {
        const summary = summarizeVitestJson(JSON.parse(readFileSync(outputFile, 'utf8')), { maxFailures });
        return { command, ...summary, ok: summary.ok && result.status === 0, ms };
      } catch { /* fall through to the raw tail */ }
    }
    const tail = trimText(stripAnsi(`${result.stderr ?? ''}\n${result.stdout ?? ''}`).split('\n').slice(-30).join('\n'), { maxLines: 8 });
    return { command, ok: false, summary: result.error ? `could not run: ${result.error.message}` : 'vitest produced no report', failures: tail ? [indent(tail, '  ')] : [], ms };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runTsc(root, which, maxFailures) {
  const tsc = nodeTool(root, ['typescript', 'bin', 'tsc']);
  const command = `tsc --noEmit -p ${TYPECHECKS[which]}`;
  if (!tsc) return { name: `typecheck:${which}`, command, ok: false, summary: 'typescript is not installed here', failures: [], ms: 0 };
  const { result, ms } = runTool(root, tsc, ['--noEmit', '-p', TYPECHECKS[which]], { timeout: 20 * 60_000 });
  const summary = summarizeTsc(`${result.stdout ?? ''}\n${result.stderr ?? ''}`, { maxFailures, ok: result.status === 0 });
  if (!summary.ok && !summary.failures.length) summary.summary = result.error ? `could not run: ${result.error.message}` : `tsc exited ${result.status} without errors listed`;
  return { name: `typecheck:${which}`, command, ...summary, ms };
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

export function main(argv, { cwd = process.cwd() } = {}) {
  const args = parseArgv(argv, { bool: ['help', 'no-notes'], value: ['typecheck', 'max-failures'] });
  if (args.bool.help) { console.log(HELP); return 0; }
  const maxFailures = args.value['max-failures'] === undefined ? 3 : Number(args.value['max-failures']);
  const typecheck = args.value.typecheck;
  const problems = [...args.errors];
  if (typecheck && !['web', 'node', 'all'].includes(typecheck)) problems.push('--typecheck must be web, node or all');
  if (!Number.isInteger(maxFailures) || maxFailures < 1) problems.push('--max-failures must be a positive integer');
  if (!args.positional.length && !typecheck) problems.push('name at least one test file or --typecheck');
  if (problems.length) { console.error(`${problems.join('; ')}\n\n${HELP}`); return 2; }

  let root;
  let sha;
  let tree;
  let dirty;
  try {
    root = repoRoot(cwd);
    ({ head: sha, tree, dirty } = workingTreeFingerprint(root));
  } catch (error) {
    console.log(`NOT VERIFIED: ${error.message}`);
    return 1;
  }
  const missing = args.positional.filter((file) => !existsSync(resolve(root, file)));
  if (missing.length) { console.error(`test file(s) not found: ${missing.join(', ')}`); return 2; }

  const results = [];
  if (args.positional.length) results.push({ name: 'tests', ...runVitest(root, args.positional, maxFailures) });
  if (typecheck) for (const which of typecheck === 'all' ? ['node', 'web'] : [typecheck]) results.push(runTsc(root, which, maxFailures));

  const lines = [];
  for (const result of results) {
    lines.push(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}: ${result.summary} (${seconds(result.ms)})`);
    lines.push(`  $ ${result.command}`);
    if (!result.ok) lines.push(...result.failures);
  }
  const ok = results.every((result) => result.ok);
  lines.push(`verify: ${ok ? 'PASS' : 'FAIL'} @ ${sha.slice(0, 7)}${dirty ? ' + uncommitted changes' : ''} (tree ${tree.slice(0, 7)})`);
  console.log(lines.join('\n'));

  if (!args.bool['no-notes']) {
    const at = new Date().toISOString();
    let tested = readNotes(root).tested;
    for (const result of results) {
      tested = mergeTested(tested, { sha, tree, dirty, at }, {
        name: result.name, command: result.command, ok: result.ok, summary: result.summary, seconds: Number((result.ms / 1000).toFixed(1)),
      });
    }
    if (!recordNotes(root, { tested })) console.error('note: could not write .task-notes.json');
  }
  return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
