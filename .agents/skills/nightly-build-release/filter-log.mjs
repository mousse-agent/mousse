#!/usr/bin/env node
// Digests a failed GitHub Actions log so it can be read in a few dozen lines, in any shell.
//   node .agents/skills/nightly-build-release/filter-log.mjs --run <run id> [--context 4] [--max 150]
//   node .agents/skills/nightly-build-release/filter-log.mjs <log file> [--context 4] [--max 150]
// With --run it saves the full failed log to the system temp folder and prints where. Output has three parts:
// the test summary lines, every "Unhandled Errors" section in full (no line cap), and the other matching
// lines with surrounding context, limited to --max lines.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const HELP = `Usage: node filter-log.mjs --run <run id> | <log file> [--context <n>] [--max <n>]
Prints test summaries, every "Unhandled Errors" section in full, then matching lines with context (at most --max, default 150).
Exit codes: 0 printed, 1 could not read the log, 2 usage error.`;

const STAMP = /^.*?\d{4}-\d\d-\d\dT[\d:.]+Z ?/;
const content = (line) => line.replace(STAMP, '');
const SUMMARY = /^\s*(Test Files|Tests|Errors)\s+\d/;
const MATCH = /\bFAIL\b|✗|×|Error:|AssertionError|error TS\d+|ELIFECYCLE|exit code [1-9]|Unhandled/;
// Log lines read "job<TAB>step<TAB>timestamp text"; a section stays inside the job and step it started in.
const origin = (line) => (STAMP.test(line) ? line.match(STAMP)[0].replace(/\d{4}-\d\d-\d\dT[\d:.]+Z ?$/, '') : '');
const SECTION_END = /^\s*(Test Files|Tests)\s+\d|^\s*Duration\s/;

export function filterLog(text, { context = 4, maxLines = 150 } = {}) {
  const lines = text.split(/\r?\n/);
  const summary = lines.filter((line) => SUMMARY.test(content(line)));

  // Every Unhandled Errors section, whole: from its header to the test summary that follows it, or until the
  // log moves to another job or step. There is no length cap.
  const unhandledSections = [];
  const inUnhandled = new Set();
  for (let start = 0; start < lines.length; start++) {
    if (inUnhandled.has(start) || !content(lines[start]).includes('Unhandled Errors')) continue;
    const where = origin(lines[start]);
    let end = start + 1;
    while (end < lines.length && !SECTION_END.test(content(lines[end])) && origin(lines[end]) === where) end += 1;
    unhandledSections.push(lines.slice(start, end));
    for (let i = start; i < end; i++) inUnhandled.add(i);
  }

  const wanted = new Set();
  lines.forEach((line, i) => {
    if (inUnhandled.has(i) || SUMMARY.test(content(line)) || !MATCH.test(line)) return;
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) if (!inUnhandled.has(j)) wanted.add(j);
  });
  const ordered = [...wanted].sort((a, b) => a - b);
  const matches = ordered.slice(0, maxLines).map((i) => lines[i]);
  return { summary, unhandledSections, unhandled: unhandledSections.flat(), matches, omitted: Math.max(0, ordered.length - maxLines) };
}

export function formatFiltered(result, { logPath = null } = {}) {
  const out = [];
  if (logPath) out.push(`full log: ${logPath}`);
  out.push('== test summary ==', ...(result.summary.length ? result.summary : ['(none found)']));
  result.unhandledSections.forEach((section, i) => {
    out.push(`== Unhandled Errors (full section ${i + 1} of ${result.unhandledSections.length}) ==`, ...section);
  });
  out.push('== matching lines ==', ...(result.matches.length ? result.matches : ['(none found)']));
  if (result.omitted) out.push(`… ${result.omitted} more matching line(s) omitted; see the full log${logPath ? ` at ${logPath}` : ''}`);
  return out.join('\n');
}

function main(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help') { console.log(HELP); return 0; }
    if (['--run', '--context', '--max'].includes(argv[i])) options[argv[i].slice(2)] = argv[++i];
    else positional.push(argv[i]);
  }
  const context = options.context === undefined ? 4 : Number(options.context);
  const maxLines = options.max === undefined ? 150 : Number(options.max);
  if (!Number.isInteger(context) || context < 0 || !Number.isInteger(maxLines) || maxLines < 1 || (!options.run && positional.length !== 1)) {
    console.error(HELP);
    return 2;
  }
  let text;
  let logPath = null;
  try {
    if (options.run) {
      if (!/^\d+$/.test(options.run)) { console.error('--run needs a numeric run id'); return 2; }
      const result = spawnSync('gh', ['run', 'view', options.run, '--log-failed'], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: 300_000 });
      if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr.trim());
      text = result.stdout;
      logPath = join(tmpdir(), `nightly-${options.run}.log`);
      writeFileSync(logPath, text);
    } else {
      logPath = positional[0];
      text = readFileSync(logPath, 'utf8');
    }
  } catch (error) {
    console.log(`could not read the log: ${error.message}`);
    return 1;
  }
  console.log(formatFiltered(filterLog(text, { context, maxLines }), { logPath }));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
