#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const DAY_MS = 24 * 60 * 60 * 1000;
const PROTECTED_BRANCH = /^(backup|mousse)\//;
const APP_MANAGED_PATH = /[\\/]\.mousse(-worktrees)?[\\/]/;

function ghPullRequests(cwd) {
  const out = execFileSync('gh', [
    'pr', 'list', '--state', 'all', '--limit', '1000',
    '--json', 'number,headRefName,headRefOid,state,isCrossRepository',
  ], { cwd, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out).filter((pr) => !pr.isCrossRepository);
}

// Removes worktrees and branches whose work is already on the default branch.
// Dry run unless apply is set. A dry run changes nothing: no fetch, no prune,
// no ref update; it reads origin with ls-remote and compares against commits
// already fetched. Anything uncertain is kept and reported.
export function teamCleanup({
  cwd = process.cwd(), apply = false, branch: only = null,
  recentMs = DAY_MS, now = Date.now(), listPullRequests = ghPullRequests,
} = {}) {
  function git(args, optional = false, at = cwd) {
    try {
      return execFileSync('git', args, {
        cwd: at, encoding: 'utf8', timeout: 60_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trimEnd();
    } catch (error) {
      if (optional) return null;
      throw new Error(`git ${args.join(' ')} failed: ${error.stderr?.trim() || error.message}`);
    }
  }
  const isAncestor = (sha, ref) => git(['merge-base', '--is-ancestor', sha, ref], true) !== null;

  const here = resolve(git(['rev-parse', '--show-toplevel']));
  if (apply) git(['fetch', '--prune', 'origin']);
  const remoteHeads = git(['ls-remote', '--symref', 'origin', 'HEAD', 'refs/heads/*']);
  const match = /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(remoteHeads);
  if (!match) throw new Error('origin did not advertise a default branch; nothing was cleaned.');
  const defaultBranch = match[1];
  const remoteTips = new Map(remoteHeads.split('\n')
    .filter((line) => /^[a-f0-9]+\trefs\/heads\//.test(line))
    .map((line) => {
      const [sha, ref] = line.split('\t');
      return [ref.slice('refs/heads/'.length), sha];
    }));
  const warnings = [];
  // The default branch's tip on origin when this clone has it; a dry run that
  // has not fetched it compares against the last fetched one and says so.
  const remoteDefault = remoteTips.get(defaultBranch);
  let defaultHead = remoteDefault && git(['rev-parse', '--verify', '--quiet', `${remoteDefault}^{commit}`], true);
  if (!defaultHead) {
    defaultHead = git(['rev-parse', '--verify', `refs/remotes/origin/${defaultBranch}`]);
    warnings.push(`origin/${defaultBranch} has commits this clone has not fetched; the dry run used the last fetched ${defaultBranch}. Run git fetch origin for a current check.`);
  }

  let pulls = null;
  try {
    pulls = listPullRequests(here);
  } catch (error) {
    warnings.push(`Pull requests unavailable (${error.message.split('\n')[0]}); only branches already on ${defaultBranch} were considered.`);
  }
  const openNames = new Set((pulls ?? []).filter((pr) => pr.state === 'OPEN').map((pr) => pr.headRefName));
  const mergedHeads = new Map((pulls ?? []).filter((pr) => pr.state === 'MERGED')
    .map((pr) => [`${pr.headRefName}\0${pr.headRefOid}`, pr.number]));

  // Why a branch tip counts as delivered, or null when it may hold live work.
  function delivered(name, sha) {
    if (openNames.has(name)) return null;
    const pr = mergedHeads.get(`${name}\0${sha}`);
    if (pr) return `PR #${pr} merged`;
    if (sha !== defaultHead && isAncestor(sha, defaultHead)) return `already on ${defaultBranch}`;
    return null;
  }

  if (apply) git(['worktree', 'prune']);
  const worktrees = [];
  for (const block of git(['worktree', 'list', '--porcelain']).split(/\n\n+/)) {
    const entry = {};
    for (const line of block.split('\n')) {
      const [key, ...rest] = line.split(' ');
      entry[key] = rest.join(' ') || true;
    }
    if (!entry.worktree) continue;
    worktrees.push({
      path: resolve(entry.worktree), head: entry.HEAD,
      branch: typeof entry.branch === 'string' ? entry.branch.replace(/^refs\/heads\//, '') : null,
      locked: Boolean(entry.locked), prunable: Boolean(entry.prunable),
    });
  }
  const primary = worktrees[0]?.path;
  const inside = (path) => here === path || here.startsWith(path + sep);

  function lastUsed(path) {
    const gitDir = git(['rev-parse', '--absolute-git-dir'], true, path);
    if (!gitDir) return 0;
    return Math.max(...['HEAD', 'index'].map((name) => {
      try { return statSync(resolve(gitDir, name)).mtimeMs; } catch { return 0; }
    }));
  }

  // Reason a worktree must stay, or null when it is safe to remove.
  function worktreeHold(tree, targeted) {
    if (tree.path === primary) return 'primary checkout';
    if (inside(tree.path)) return 'current checkout';
    if (APP_MANAGED_PATH.test(tree.path)) return 'managed by the Mousse app';
    if (tree.locked) return 'locked';
    if (tree.prunable) return 'missing directory';
    // A dirty tree is reported as such even when it was also used recently: that is the
    // reason that matters to whoever reads the list, and it does not depend on timing.
    const status = git(['status', '--porcelain=v1', '--untracked-files=all'], true, tree.path);
    if (status === null) return 'status unavailable';
    if (status) return 'uncommitted changes';
    // A file touched after this run began has a negative idle time; it is recent, never "never".
    const idle = Math.max(0, now - lastUsed(tree.path));
    if (!targeted && idle < recentMs) return 'used recently';
    return null;
  }

  const result = {
    mode: apply ? 'apply' : 'dry-run', defaultBranch,
    worktrees: [], branches: [], remoteBranches: [], kept: [],
    warnings,
  };
  const keep = (kind, name, reason) => result.kept.push({ kind, name, reason });
  const checkedOut = new Map(worktrees.filter((tree) => tree.branch).map((tree) => [tree.branch, tree]));
  // Returns false, after recording why, when Git refuses the change.
  function act(args, kind, name) {
    if (!apply) return true;
    try {
      git(args, false, primary);
      return true;
    } catch (error) {
      keep(kind, name, error.message.split('\n')[0]);
      return false;
    }
  }

  if (!only) {
    for (const tree of worktrees.filter((tree) => !tree.branch && tree.path !== primary)) {
      keep('worktree', tree.path, 'detached checkout; remove it manually if unused');
    }
  }

  const locals = git(['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads'])
    .split('\n').filter(Boolean).map((line) => line.split(' '));
  for (const [name, sha] of locals) {
    if (only && name !== only) continue;
    if (name === defaultBranch) continue;
    if (PROTECTED_BRANCH.test(name)) { keep('branch', name, 'protected prefix'); continue; }
    const reason = delivered(name, sha);
    if (!reason) {
      if (only) keep('branch', name, openNames.has(name) ? 'open PR' : 'has work not on the default branch');
      continue;
    }
    const tree = checkedOut.get(name);
    if (tree) {
      const hold = worktreeHold(tree, Boolean(only));
      if (hold) { keep('branch', name, `worktree ${tree.path}: ${hold}`); continue; }
      if (!act(['worktree', 'remove', tree.path], 'worktree', tree.path)) continue;
      result.worktrees.push({ path: tree.path, reason });
    }
    if (!act(['branch', '-D', name], 'branch', name)) continue;
    result.branches.push({ name, reason });
  }

  // Remote branches are removed only for merged PRs, as GitHub's own
  // delete-on-merge would. The lease guards against a push since the check.
  for (const [name, sha] of remoteTips) {
    if (only && name !== only) continue;
    if (name === defaultBranch || PROTECTED_BRANCH.test(name) || openNames.has(name)) continue;
    const pr = mergedHeads.get(`${name}\0${sha}`);
    if (!pr) continue;
    const lease = `--force-with-lease=refs/heads/${name}:${sha}`;
    if (!act(['push', lease, 'origin', `:refs/heads/${name}`], 'remoteBranch', name)) continue;
    result.remoteBranches.push({ name, reason: `PR #${pr} merged` });
  }
  if (apply && result.remoteBranches.length) git(['fetch', '--prune', 'origin']);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    const options = { apply: false, branch: null };
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === '--apply') options.apply = true;
      else if (args[i] === '--branch' && args[i + 1]) options.branch = args[(i += 1)];
      else throw new Error('Usage: node scripts/team-cleanup.mjs [--apply] [--branch <name>]');
    }
    console.log(JSON.stringify(teamCleanup(options), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
