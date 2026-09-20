#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function teamStatus({ cwd = process.cwd(), fetch = false } = {}) {
  function git(args, optional = false) {
    try {
      return execFileSync('git', args, {
        cwd, encoding: 'utf8', timeout: 60_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trimEnd();
    } catch (error) {
      if (optional) return null;
      throw new Error(`git ${args.join(' ')} failed: ${error.stderr?.trim() || error.message}`);
    }
  }

  const root = git(['rev-parse', '--show-toplevel']);
  cwd = root;
  let defaultRef;
  let advertisedHeads;
  if (fetch) {
    git(['fetch', '--no-prune', '--no-prune-tags', 'origin']);
    const remoteHead = git(['ls-remote', '--symref', 'origin', 'HEAD', 'refs/heads/*']);
    const match = /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(remoteHead);
    if (!match) throw new Error('origin did not advertise a default branch; no branch name was assumed.');
    defaultRef = `refs/remotes/origin/${match[1]}`;
    advertisedHeads = new Map(remoteHead.split('\n')
      .filter((line) => /^[a-f0-9]+\trefs\/heads\//.test(line))
      .map((line) => {
        const [sha, ref] = line.split('\t');
        return [ref.slice('refs/heads/'.length), sha];
      }));
  } else {
    defaultRef = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], true);
  }

  const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], true);
  const head = git(['rev-parse', '--verify', 'HEAD'], true);
  const defaultBranch = defaultRef?.replace(/^refs\/remotes\/origin\//, '') ?? null;
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], true);
  const branchRef = branch ? `refs/remotes/origin/${branch}` : null;
  const cachedBranchHead = branchRef ? git(['rev-parse', '--verify', branchRef], true) : null;
  const publishedHead = advertisedHeads ? (advertisedHeads.get(branch) ?? null) : cachedBranchHead;
  const defaultHead = defaultRef ? git(['rev-parse', '--verify', defaultRef], true) : null;
  if (advertisedHeads && (
    (publishedHead && publishedHead !== cachedBranchHead) ||
    advertisedHeads.get(defaultBranch) !== defaultHead
  )) throw new Error('Remote refs changed after fetching or are not covered by the fetch refspec; refresh before trusting this snapshot.');
  const status = git(['status', '--porcelain=v1', '--untracked-files=all']);
  const conflicts = git(['diff', '--name-only', '--diff-filter=U']);
  const operations = ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']
    .filter((name) => existsSync(git(['rev-parse', '--path-format=absolute', '--git-path', name])));

  function delta(base) {
    if (!head || !base) return null;
    const [behind, ahead] = git(['rev-list', '--left-right', '--count', `${base}...${head}`])
      .trim().split(/\s+/).map(Number);
    return { ahead, behind };
  }

  const warnings = [];
  if (!fetch) warnings.push('Remote information is cached; run with --fetch before coordinating work.');
  if (!defaultBranch || !defaultHead) warnings.push('Default branch state is unavailable; verify it before branching.');
  if (!branch) warnings.push('Detached HEAD: create or select a task branch before publishing.');
  if (branch && branch === defaultBranch) warnings.push('On the default branch; use a task branch for implementation.');
  if (!publishedHead) warnings.push('No origin branch found for this task; publishing is not verified.');
  if (status) warnings.push('Working tree contains changes; inspect ownership before staging.');
  if (operations.length || conflicts) warnings.push('Unfinished Git operation or conflicts require attention.');

  return {
    root, branch, head, defaultBranch, upstream,
    remoteState: fetch ? 'fetched' : 'cached',
    publishedBranch: publishedHead ? `origin/${branch}` : null,
    publishedHead,
    headMatchesPublished: Boolean(head && publishedHead && head === publishedHead),
    taskDelta: delta(publishedHead),
    defaultDelta: delta(defaultHead),
    status, conflicts, operations, warnings,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== '--fetch')) throw new Error('Usage: node scripts/team-status.mjs [--fetch]');
    console.log(JSON.stringify(teamStatus({ fetch: args.includes('--fetch') }), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
