#!/usr/bin/env node
// Shared task claims kept as one JSON file (claims.json) on the remote branch `agent-claims`.
// Every update is fetch + commit + non-forced push; a rejected push means someone else wrote
// first, so the change is recomputed from the fresh state and pushed again (compare-and-swap).
// The commit is built with git plumbing, so the working tree and index are never touched.
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  formatSpan, git, parseArgv, parseDuration, pathSetsOverlap, readNotes, recordNotes, repoRoot, run,
} from './work-lib.mjs';

const HELP = `Usage: node scripts/work-claim.mjs <command> [options]

Commands:
  claim     claim a task: --task <id> [--path <p>]... [--ttl 2h] [--branch <b>]
  renew     extend your claim from now: --task <id> [--ttl 2h]
  release   drop your claim: --task <id> [--force to drop another session's]
  list      show live claims (--all includes expired ones)

Options:
  --task <id>       task id (default: the current branch name)
  --path <p>        planned file or directory (repeatable); --paths a,b also works
  --ttl <dur>       claim length, e.g. 90m, 2h, 1d (default 2h)
  --session <id>    session id (default: WORK_SESSION_ID, the one in .task-notes.json, or a new one)
  --machine <name>  machine name (default: this host)
  --remote <r>      remote name or URL holding the agent-claims branch (default origin)
  --dry-run         compute and print the change without pushing
  --json            print JSON
  --help            this text

A live claim on the same task by another session refuses (exit 3, prints the holder).
Overlapping paths with another live claim only warn. Expired claims are ignored.
Exit codes: 0 ok, 1 could not reach the remote or push (NOT CLAIMED), 2 usage error, 3 refused.`;

export const CLAIMS_BRANCH = 'agent-claims';
export const CLAIMS_FILE = 'claims.json';
export const DEFAULT_TTL_MS = 2 * 3_600_000;
const PRUNE_AFTER_MS = 24 * 3_600_000;

// ---------- pure logic ----------

export const emptyState = () => ({ version: 1, claims: [] });

export const isLive = (claim, now) => Date.parse(claim.expiresAt) > now;

export const liveClaims = (state, now) => state.claims.filter((claim) => isLive(claim, now));

const describe = (claim, now) => ({
  task: claim.task, session: claim.session, machine: claim.machine, branch: claim.branch,
  expiresIn: formatSpan(Date.parse(claim.expiresAt) - now), paths: claim.paths,
});

function finish(state, now, change) {
  const claims = state.claims
    .filter((claim) => now - Date.parse(claim.expiresAt) < PRUNE_AFTER_MS)
    .sort((a, b) => a.task.localeCompare(b.task));
  return { ...change, state: { ...state, claims } };
}

/** Claims or re-claims a task. Refuses while another session holds it live; warns on path overlap. */
export function applyClaim(state, request, now) {
  const { task, session, machine, branch = null, paths = [], ttlMs = DEFAULT_TTL_MS } = request;
  const existing = state.claims.find((claim) => claim.task === task);
  if (existing && existing.session !== session && isLive(existing, now)) {
    return { ok: false, reason: 'held', changed: false, holder: describe(existing, now), state };
  }
  const warnings = [];
  for (const other of liveClaims(state, now)) {
    if (other.task === task || other.session === session) continue;
    const shared = pathSetsOverlap(paths, other.paths ?? []);
    if (shared.length) warnings.push({ holder: describe(other, now), paths: shared });
  }
  const record = {
    task, session, machine, branch, paths: [...new Set(paths)],
    claimedAt: existing && existing.session === session ? existing.claimedAt : new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
  const others = state.claims.filter((claim) => claim.task !== task);
  const action = existing && existing.session === session ? 'renewed' : existing ? 'took over an expired claim' : 'claimed';
  return finish({ ...state, claims: [...others, record] }, now, { ok: true, changed: true, action, claim: record, warnings });
}

/** Extends the caller's own claim from now. */
export function applyRenew(state, request, now) {
  const { task, session, ttlMs = DEFAULT_TTL_MS, paths } = request;
  const existing = state.claims.find((claim) => claim.task === task);
  if (!existing) return { ok: false, reason: 'missing', changed: false, state };
  if (existing.session !== session) {
    return isLive(existing, now)
      ? { ok: false, reason: 'held', changed: false, holder: describe(existing, now), state }
      : { ok: false, reason: 'missing', changed: false, state };
  }
  const record = {
    ...existing, expiresAt: new Date(now + ttlMs).toISOString(),
    ...(paths?.length ? { paths: [...new Set(paths)] } : {}),
  };
  return finish({ ...state, claims: state.claims.map((claim) => (claim.task === task ? record : claim)) }, now,
    { ok: true, changed: true, action: 'renewed', claim: record, warnings: [] });
}

/** Drops the caller's claim. Dropping another live session's claim needs `force`. */
export function applyRelease(state, request, now) {
  const { task, session, force = false } = request;
  const existing = state.claims.find((claim) => claim.task === task);
  if (!existing) return { ok: true, changed: false, action: 'nothing to release', state };
  if (existing.session !== session && isLive(existing, now) && !force) {
    return { ok: false, reason: 'held', changed: false, holder: describe(existing, now), state };
  }
  return finish({ ...state, claims: state.claims.filter((claim) => claim.task !== task) }, now,
    { ok: true, changed: true, action: 'released' });
}

export function formatClaims(state, now, { all = false } = {}) {
  const rows = (all ? state.claims : liveClaims(state, now));
  if (!rows.length) return 'no live claims';
  return rows.map((claim) => {
    const left = Date.parse(claim.expiresAt) - now;
    const when = left > 0 ? `${formatSpan(left)} left` : `expired ${formatSpan(left)} ago`;
    const paths = (claim.paths ?? []).slice(0, 4).join(', ') + ((claim.paths ?? []).length > 4 ? ` +${claim.paths.length - 4}` : '');
    return `${claim.task}  ${claim.machine}/${claim.session}  ${claim.branch ?? '-'}  ${when}${paths ? `  ${paths}` : ''}`;
  }).join('\n');
}

export const formatHolder = (holder) =>
  `held by session ${holder.session} on ${holder.machine} (branch ${holder.branch ?? '-'}, ${holder.expiresIn} left)`;

// ---------- remote access (git plumbing) ----------

const LOCAL_REF = `refs/work-claims/${CLAIMS_BRANCH}`;
const NON_FAST_FORWARD = /non-fast-forward|fetch first|stale info|rejected|cannot lock ref|failed to update ref/i;

function readRemote(remote, cwd) {
  const advertised = git(['ls-remote', remote, `refs/heads/${CLAIMS_BRANCH}`], { cwd, timeout: 60_000 });
  if (!advertised) return { sha: null, state: emptyState() };
  git(['fetch', '--no-tags', '--quiet', remote, `+refs/heads/${CLAIMS_BRANCH}:${LOCAL_REF}`], { cwd, timeout: 120_000 });
  const sha = git(['rev-parse', '--verify', LOCAL_REF], { cwd });
  const parsed = JSON.parse(git(['show', `${sha}:${CLAIMS_FILE}`], { cwd }));
  if (!parsed || !Array.isArray(parsed.claims)) throw new Error(`${CLAIMS_FILE} on ${CLAIMS_BRANCH} is not a claims file`);
  return { sha, state: parsed };
}

function commitState(parent, state, message, cwd) {
  const blob = git(['hash-object', '-w', '--stdin'], { cwd, input: `${JSON.stringify(state, null, 2)}\n` });
  const tree = git(['mktree'], { cwd, input: `100644 blob ${blob}\t${CLAIMS_FILE}\n` });
  const env = { ...process.env };
  const configured = (key) => { try { return git(['config', key], { cwd }); } catch { return ''; } };
  if (!configured('user.name')) { env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = 'work-claim'; }
  if (!configured('user.email')) { env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = 'work-claim@localhost'; }
  return git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message], { cwd, env });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reads the remote state, applies `change(state)` and pushes; on a rejected push re-reads and
 * recomputes. A change that results in no change (or `dryRun`) pushes nothing.
 */
export async function mutateClaims({ remote = 'origin', cwd = process.cwd(), change, message, dryRun = false, retries = 6, now = () => Date.now() }) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const { sha, state } = readRemote(remote, cwd);
    const result = change(state, now());
    if (!result.changed || dryRun) return { ...result, pushed: false, attempts: attempt + 1 };
    const commit = commitState(sha, result.state, message, cwd);
    try {
      run('git', ['push', '--quiet', remote, `${commit}:refs/heads/${CLAIMS_BRANCH}`], { cwd, timeout: 120_000 });
      return { ...result, pushed: true, attempts: attempt + 1 };
    } catch (error) {
      if (!NON_FAST_FORWARD.test(error.stderr ?? error.message) || attempt === retries) throw error;
      await sleep(100 + Math.random() * 400);
    }
  }
  throw new Error('unreachable');
}

export async function listClaims({ remote = 'origin', cwd = process.cwd() } = {}) {
  return readRemote(remote, cwd).state;
}

// ---------- command line ----------

function currentBranch(cwd) {
  try { return git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd }); } catch { return null; }
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === 'help') { console.log(HELP); return command ? 0 : 2; }
  const args = parseArgv(rest, {
    bool: ['help', 'dry-run', 'json', 'force', 'all'],
    value: ['task', 'ttl', 'session', 'machine', 'remote', 'branch', 'paths'], multi: ['path'],
  });
  if (args.bool.help) { console.log(HELP); return 0; }
  const usage = (message) => { console.error(`${message}\n\n${HELP}`); return 2; };
  if (args.errors.length) return usage(args.errors.join('; '));
  if (!['claim', 'renew', 'release', 'list'].includes(command)) return usage(`unknown command ${command}`);

  let root = null;
  try { root = repoRoot(); } catch { /* list/claim still need a repository for git plumbing */ }
  if (!root) { console.log('NOT CLAIMED: not inside a git repository'); return 1; }

  const remote = args.value.remote ?? 'origin';
  const dryRun = Boolean(args.bool['dry-run']);
  const json = Boolean(args.bool.json);
  const ttlMs = args.value.ttl === undefined ? DEFAULT_TTL_MS : parseDuration(args.value.ttl);
  if (!ttlMs) return usage(`cannot read --ttl ${args.value.ttl}`);
  const notes = readNotes(root);
  const task = args.value.task ?? currentBranch(root);
  const session = args.value.session ?? process.env.WORK_SESSION_ID ?? notes.claim?.session ?? `${hostname()}-${randomBytes(3).toString('hex')}`;
  const machine = args.value.machine ?? hostname();
  const paths = [...(args.multi.path ?? []), ...(args.value.paths ? args.value.paths.split(',') : [])].map((p) => p.trim()).filter(Boolean);

  try {
    if (command === 'list') {
      const state = await listClaims({ remote, cwd: root });
      const now = Date.now();
      console.log(json ? JSON.stringify({ claims: args.bool.all ? state.claims : liveClaims(state, now) }) : formatClaims(state, now, { all: args.bool.all }));
      return 0;
    }
    if (!task) return usage('give --task <id> (no current branch to default to)');
    const change = {
      claim: (state, now) => applyClaim(state, { task, session, machine, branch: args.value.branch ?? currentBranch(root), paths, ttlMs }, now),
      renew: (state, now) => applyRenew(state, { task, session, ttlMs, paths }, now),
      release: (state, now) => applyRelease(state, { task, session, force: Boolean(args.bool.force) }, now),
    }[command];
    const result = await mutateClaims({ remote, cwd: root, change, message: `claims: ${command} ${task}`, dryRun });

    if (!result.ok) {
      if (json) console.log(JSON.stringify(result));
      else if (result.reason === 'held') console.log(`REFUSED: ${task} is ${formatHolder(result.holder)}. Coordinate with the holder, or wait for expiry.`);
      else console.log(`NOT RENEWED: no claim of yours on ${task}; run claim first.`);
      return result.reason === 'held' ? 3 : 1;
    }
    if (command === 'release') recordNotes(root, { claim: null });
    else if (!dryRun) recordNotes(root, { claim: { task, session, remote, expiresAt: result.claim.expiresAt } });
    if (json) { console.log(JSON.stringify({ ...result, state: undefined })); return 0; }
    const suffix = dryRun ? ' (dry run, nothing pushed)' : '';
    console.log(`${result.action}: ${task}${result.claim ? ` until ${result.claim.expiresAt}` : ''} session ${session}${suffix}`);
    for (const warning of result.warnings ?? []) {
      console.log(`WARNING: paths overlap with ${warning.holder.task}, ${formatHolder(warning.holder)}: ${warning.paths.join(', ')}`);
    }
    return 0;
  } catch (error) {
    console.log(`NOT ${command === 'list' ? 'LISTED' : command === 'release' ? 'RELEASED' : command === 'renew' ? 'RENEWED' : 'CLAIMED'}: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
