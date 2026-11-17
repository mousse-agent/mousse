// Shared helpers for the work-skill scripts (related-work, work-claim, verify,
// task-notes, close-completed-issues). Node ESM, no dependencies; uses git and gh.
import { execFile, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------- processes ----------

export function run(cmd, args, { cwd, timeout = 60_000, input, env } = {}) {
  const result = spawnSync(cmd, args, {
    cwd, encoding: 'utf8', timeout, input, env: env ?? process.env,
    maxBuffer: 64 * 1024 * 1024,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  if (result.error) throw new Error(`${cmd} ${args[0] ?? ''} failed: ${result.error.message}`);
  if (result.status !== 0) {
    const error = new Error(`${cmd} ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim().split('\n')[0]}`);
    error.stderr = result.stderr ?? '';
    error.status = result.status;
    throw error;
  }
  return result.stdout;
}

export function runAsync(cmd, args, { cwd, timeout = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const wrapped = new Error(`${cmd} ${args.slice(0, 3).join(' ')} failed: ${(stderr || error.message).trim().split('\n')[0]}`);
        wrapped.stderr = stderr ?? '';
        reject(wrapped);
      } else resolve(stdout);
    });
  });
}

export const git = (args, opts) => run('git', args, opts).trimEnd();
export const gh = (args, opts) => run('gh', args, opts);

/** Runs `tasks` (functions returning promises) with at most `limit` in flight; keeps order. */
export async function pool(tasks, limit = 6) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

export function repoRoot(cwd = process.cwd()) {
  return git(['rev-parse', '--show-toplevel'], { cwd });
}

export function gitCommonDir(cwd = process.cwd()) {
  return git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
}

// ---------- arguments ----------

/**
 * Minimal option parser. `bool` options take no value, `value` options keep the last
 * value, `multi` options collect every value. Anything else starting with `--` is an error.
 */
export function parseArgv(argv, { bool = [], value = [], multi = [] } = {}) {
  const out = { bool: {}, value: {}, multi: {}, positional: [], errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { out.positional.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith('--')) { out.positional.push(arg); continue; }
    const eq = arg.indexOf('=');
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    if (bool.includes(key)) { out.bool[key] = true; continue; }
    if (value.includes(key) || multi.includes(key)) {
      const next = inline ?? argv[++i];
      if (next === undefined) { out.errors.push(`--${key} needs a value`); continue; }
      if (multi.includes(key)) (out.multi[key] ??= []).push(next);
      else out.value[key] = next;
      continue;
    }
    out.errors.push(`unknown option --${key}`);
  }
  return out;
}

// ---------- paths ----------

/**
 * Normalises a planned path: forward slashes, no leading ./, and `dir/**` or `dir/*` become `dir/`.
 * The repository root ("", ".", "./", "/", "*", "**") normalises to the empty string and means every file.
 */
export function normalizePath(path) {
  let value = String(path ?? '').trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/{2,}/g, '/');
  if (/^(\.|\/|\*{1,2})?$/.test(value)) return '';
  value = value.replace(/\/\*\*$/, '/').replace(/\/\*$/, '/');
  return value;
}

/** True when `a` names `b` or a directory containing it. Both are normalised; the root covers everything. */
function covers(a, b) {
  if (a === '' || a === b) return true;
  if (a.endsWith('/')) return b.startsWith(a) || `${b}/` === a;
  return b.startsWith(`${a}/`);
}

/** Changed files that fall under any planned path (a planned entry is a file or a directory, or the root). */
export function pathsOverlap(planned, changed) {
  const plans = planned.map(normalizePath);
  if (!plans.length) return [];
  return changed.map(normalizePath).filter((file) => file && plans.some((plan) => covers(plan, file)));
}

/** True when a planned path is the repository root, which overlaps every open change. */
export const coversWholeRepo = (planned) => planned.some((path) => normalizePath(path) === '');

/** Paths shared by two planned sets: for each overlapping pair, the more specific path (the root shows as "."). */
export function pathSetsOverlap(left, right) {
  const shared = new Set();
  for (const a of left.map(normalizePath)) {
    for (const b of right.map(normalizePath)) {
      if (covers(a, b)) shared.add(b === '' ? '.' : b);
      else if (covers(b, a)) shared.add(a);
    }
  }
  return [...shared].sort();
}

// ---------- time ----------

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** "90m", "2h", "1d", "45s"; a bare number is minutes. Returns null when it cannot be read. */
export function parseDuration(text) {
  const match = /^(\d+(?:\.\d+)?)\s*([smhd]?)$/i.exec(String(text ?? '').trim());
  if (!match) return null;
  const ms = Number(match[1]) * UNIT_MS[(match[2] || 'm').toLowerCase()];
  return ms > 0 ? ms : null;
}

export function formatSpan(ms) {
  const abs = Math.abs(ms);
  if (abs < 60_000) return `${Math.round(abs / 1000)}s`;
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m`;
  if (abs < 86_400_000) {
    const hours = Math.floor(abs / 3_600_000);
    const minutes = Math.round((abs % 3_600_000) / 60_000);
    return minutes ? `${hours}h${minutes}m` : `${hours}h`;
  }
  return `${Math.round(abs / 86_400_000)}d`;
}

export const timeAgo = (iso, now = Date.now()) => {
  const then = Date.parse(iso);
  return Number.isNaN(then) ? '?' : `${formatSpan(now - then)} ago`;
};

// ---------- PR body rules ----------

/** Removes HTML comments and code, where a closing keyword is not a real reference. */
export function stripNonProse(body) {
  return String(body ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
}

const ISSUE_REF = String.raw`(?:(?<repo1>[\w.-]+\/[\w.-]+)#(?<num1>\d+)|#(?<num2>\d+)|https?:\/\/github\.com\/(?<repo3>[\w.-]+\/[\w.-]+)\/issues\/(?<num3>\d+))`;
const closingPattern = () => new RegExp(String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?[ \t]+${ISSUE_REF}`, 'gi');
const refsPattern = () => new RegExp(String.raw`\b(?:refs?|related to|part of)\b:?[ \t]+${ISSUE_REF}`, 'gi');

function collect(pattern, text, repo) {
  const found = new Set();
  for (const match of text.matchAll(pattern)) {
    const { repo1, num1, num2, repo3, num3 } = match.groups;
    const where = repo1 ?? repo3;
    if (where && repo && where.toLowerCase() !== repo.toLowerCase()) continue;
    if (where && !repo) continue;
    found.add(Number(num1 ?? num2 ?? num3));
  }
  return [...found].sort((a, b) => a - b);
}

/** Issue numbers a PR body closes (`Closes #1`, `Fixes owner/repo#2`, issue URLs). Other repos are ignored. */
export function parseClosingRefs(body, { repo } = {}) {
  return collect(closingPattern(), stripNonProse(body), repo);
}

/** Issue numbers a PR body mentions with `Refs`, `Related to` or `Part of`. */
export function parsePartialRefs(body, { repo } = {}) {
  return collect(refsPattern(), stripNonProse(body), repo);
}

/** The PR body rule: Closes/Fixes/Resolves/Refs #N, or the words "No issue". */
export function checkPrBody(body, { repo } = {}) {
  const prose = stripNonProse(body);
  const closes = collect(closingPattern(), prose, repo);
  if (closes.length) return { ok: true, kind: 'closes', numbers: closes };
  const refs = collect(refsPattern(), prose, repo);
  if (refs.length) return { ok: true, kind: 'refs', numbers: refs };
  if (/\bno issue\b/i.test(prose)) return { ok: true, kind: 'none', numbers: [] };
  return {
    ok: false, kind: 'missing', numbers: [],
    reason: 'The PR body needs "Closes #N" (finishes the issue), "Refs #N" (partial) or "No issue". Text inside comments or code does not count.',
  };
}

// ---------- output digesting ----------

/** Keeps the first `maxLines` lines of text, each cut to `maxLineChars`, with a note for what was dropped. */
export function trimText(text, { maxLines = 8, maxLineChars = 200 } = {}) {
  const lines = String(text ?? '').split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim() !== '');
  const kept = lines.slice(0, maxLines).map((line) => (line.length > maxLineChars ? `${line.slice(0, maxLineChars - 1)}…` : line));
  if (lines.length > maxLines) kept.push(`… ${lines.length - maxLines} more line(s)`);
  return kept.join('\n');
}

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
export const stripAnsi = (text) => String(text ?? '').replace(ANSI, '');

// ---------- task notes (.task-notes.json in the worktree root) ----------

export const NOTES_FILE = '.task-notes.json';

export const notesPath = (root) => join(root, NOTES_FILE);

export function readNotes(root) {
  try {
    const parsed = JSON.parse(readFileSync(notesPath(root), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function writeNotes(root, notes) {
  const target = notesPath(root);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(notes, null, 2)}\n`);
  renameSync(temp, target);
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Returns a copy of `object` with the dotted `path` set to `value`. */
export function setPath(object, path, value) {
  const keys = String(path).split('.').filter(Boolean);
  if (!keys.length) throw new Error('empty key');
  if (keys.some((key) => UNSAFE_KEYS.has(key))) throw new Error(`unsafe key in ${path}`);
  const copy = structuredClone(object ?? {});
  let cursor = copy;
  for (const key of keys.slice(0, -1)) {
    if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[keys.at(-1)] = value;
  return copy;
}

export function getPath(object, path) {
  let cursor = object;
  for (const key of String(path).split('.').filter(Boolean)) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

/** Shallow-merges `patch` over the notes. A `null` value removes the key. */
export function mergeNotes(notes, patch, now = new Date()) {
  const merged = { ...notes, ...patch };
  for (const [key, value] of Object.entries(merged)) if (value === null) delete merged[key];
  merged.updatedAt = now.toISOString();
  return merged;
}

/** Best-effort update: a notes failure never fails the command that called it. */
export function recordNotes(root, patch) {
  try {
    writeNotes(root, mergeNotes(readNotes(root), patch));
    return true;
  } catch {
    return false;
  }
}

export function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
  return path;
}


// ---------- working-tree fingerprint ----------

/**
 * Identity of the exact contents of the working tree: the git tree object of every tracked file and every
 * untracked, non-ignored file as they are on disk now. It is built in a throwaway copy of the index, so the
 * real index is untouched. Committing the same contents gives the same value, so a check run before a commit
 * still matches after it, while any later edit, new file or deletion changes it.
 */
export function workingTreeFingerprint(cwd = process.cwd()) {
  const head = git(['rev-parse', 'HEAD'], { cwd });
  const headTree = git(['rev-parse', 'HEAD^{tree}'], { cwd });
  const scratch = mkdtempSync(join(tmpdir(), 'tree-fingerprint-'));
  try {
    const temp = join(scratch, 'index');
    const realIndex = git(['rev-parse', '--path-format=absolute', '--git-path', 'index'], { cwd });
    if (existsSync(realIndex)) copyFileSync(realIndex, temp);
    else git(['read-tree', 'HEAD'], { cwd, env: { ...process.env, GIT_INDEX_FILE: temp } });
    const env = { ...process.env, GIT_INDEX_FILE: temp };
    run('git', ['add', '-A', '--', '.'], { cwd, env, timeout: 300_000 });
    const tree = git(['write-tree'], { cwd, env });
    return { head, tree, dirty: tree !== headTree };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
