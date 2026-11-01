import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { teamCleanup } from './team-cleanup.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'team-cleanup-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, 'remote.git');
  const repo = join(root, 'repo');
  const git = (cwd, ...args) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  git(root, 'init', '--bare', '--initial-branch=trunk', remote);
  git(root, 'clone', remote, repo);
  git(repo, 'config', 'user.name', 'Workflow test');
  git(repo, 'config', 'user.email', 'workflow-test@example.invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
  git(repo, 'add', '.gitignore');
  git(repo, 'commit', '-m', 'initial');
  git(repo, 'push', '-u', 'origin', 'trunk');
  const commitOn = (branch, file) => {
    git(repo, 'switch', '-c', branch, 'trunk');
    writeFileSync(join(repo, file), `${file}\n`);
    git(repo, 'add', file);
    git(repo, 'commit', '-m', file);
    git(repo, 'switch', 'trunk');
    return git(repo, 'rev-parse', branch);
  };
  // Lands a branch on trunk the way a PR merge commit does.
  const mergeToTrunk = (branch) => {
    git(repo, 'merge', '--no-ff', '-m', `merge ${branch}`, branch);
    git(repo, 'push', 'origin', 'trunk');
  };
  const run = (options = {}) => teamCleanup({ cwd: repo, recentMs: 0, listPullRequests: () => [], ...options });
  return { root, remote, repo, git, commitOn, mergeToTrunk, run };
}

test('dry run reports a merged branch and its clean worktree without changing anything', (t) => {
  const { root, repo, git, commitOn, mergeToTrunk, run } = fixture(t);
  commitOn('done', 'done.txt');
  mergeToTrunk('done');
  const tree = join(root, 'done-tree');
  git(repo, 'worktree', 'add', tree, 'done');
  symlinkSync(join(root, 'remote.git'), join(tree, 'node_modules'));
  const result = run();
  assert.deepEqual(result.branches.map((b) => b.name), ['done']);
  assert.equal(result.worktrees[0].path.endsWith('done-tree'), true);
  assert.ok(existsSync(tree));
  assert.ok(git(repo, 'rev-parse', '--verify', 'done'));
});

test('dry run fetches and prunes nothing: stale remote refs and worktree registrations stay', (t) => {
  const { root, repo, git, commitOn, run } = fixture(t);
  commitOn('gone', 'gone.txt');
  git(repo, 'push', 'origin', 'gone');
  git(repo, 'push', 'origin', '--delete', 'gone');
  git(repo, 'update-ref', 'refs/remotes/origin/gone', git(repo, 'rev-parse', 'gone'));
  const missing = join(root, 'missing-tree');
  git(repo, 'worktree', 'add', missing, 'gone');
  rmSync(missing, { recursive: true, force: true });
  const refsBefore = git(repo, 'for-each-ref');
  const result = run();
  assert.equal(result.mode, 'dry-run');
  assert.equal(git(repo, 'for-each-ref'), refsBefore);
  assert.ok(git(repo, 'worktree', 'list', '--porcelain').includes('missing-tree'));
  assert.ok(!existsSync(join(repo, '.git', 'FETCH_HEAD')));
});

test('apply removes a merged branch and its worktree, keeping one with uncommitted changes', (t) => {
  const { root, repo, git, commitOn, mergeToTrunk, run } = fixture(t);
  commitOn('done', 'done.txt');
  commitOn('dirty', 'dirty.txt');
  mergeToTrunk('done');
  mergeToTrunk('dirty');
  const doneTree = join(root, 'done-tree');
  const dirtyTree = join(root, 'dirty-tree');
  git(repo, 'worktree', 'add', doneTree, 'done');
  git(repo, 'worktree', 'add', dirtyTree, 'dirty');
  writeFileSync(join(dirtyTree, 'notes.md'), 'unsaved\n');
  const result = run({ apply: true });
  assert.deepEqual(result.branches.map((b) => b.name), ['done']);
  assert.equal(existsSync(doneTree), false);
  assert.ok(existsSync(join(dirtyTree, 'notes.md')));
  assert.match(result.kept.find((k) => k.name === 'dirty').reason, /uncommitted changes/);
  assert.equal(git(repo, 'branch', '--list', 'done'), '');
});

test('keeps unmerged work, protected prefixes, open PRs, and recently used worktrees', (t) => {
  const { root, repo, git, commitOn, mergeToTrunk, run } = fixture(t);
  commitOn('active', 'active.txt');
  commitOn('backup/snapshot', 'snap.txt');
  commitOn('reopened', 'reopened.txt');
  commitOn('recent', 'recent.txt');
  mergeToTrunk('backup/snapshot');
  mergeToTrunk('reopened');
  mergeToTrunk('recent');
  git(repo, 'worktree', 'add', join(root, 'recent-tree'), 'recent');
  const result = run({
    apply: true, recentMs: 60 * 60 * 1000,
    listPullRequests: () => [{ number: 7, headRefName: 'reopened', headRefOid: 'x', state: 'OPEN' }],
  });
  assert.deepEqual(result.branches, []);
  for (const name of ['active', 'backup/snapshot', 'reopened', 'recent']) {
    assert.ok(git(repo, 'rev-parse', '--verify', name), name);
  }
  assert.match(result.kept.find((k) => k.name === 'recent').reason, /used recently/);
});

test('removes a squash-merged branch only when the merged PR head matches, locally and on origin', (t) => {
  const { repo, git, commitOn, run } = fixture(t);
  const squashed = commitOn('squashed', 'a.txt');
  commitOn('moved-on', 'b.txt');
  git(repo, 'push', 'origin', 'squashed', 'moved-on');
  const result = run({
    apply: true,
    listPullRequests: () => [
      { number: 1, headRefName: 'squashed', headRefOid: squashed, state: 'MERGED' },
      { number: 2, headRefName: 'moved-on', headRefOid: 'stale', state: 'MERGED' },
    ],
  });
  assert.deepEqual(result.branches.map((b) => b.name), ['squashed']);
  assert.deepEqual(result.remoteBranches.map((b) => b.name), ['squashed']);
  assert.equal(git(repo, 'ls-remote', 'origin', 'refs/heads/squashed'), '');
  assert.ok(git(repo, 'ls-remote', 'origin', 'refs/heads/moved-on'));
});

test('never removes the current or primary checkout and can target one branch despite recent use', (t) => {
  const { root, repo, git, commitOn, mergeToTrunk } = fixture(t);
  commitOn('mine', 'mine.txt');
  commitOn('other', 'other.txt');
  mergeToTrunk('mine');
  mergeToTrunk('other');
  const mine = join(root, 'mine-tree');
  const other = join(root, 'other-tree');
  git(repo, 'worktree', 'add', mine, 'mine');
  git(repo, 'worktree', 'add', other, 'other');
  const options = { apply: true, recentMs: 60 * 60 * 1000, listPullRequests: () => [] };
  const fromMine = teamCleanup({ ...options, cwd: mine, branch: 'mine' });
  assert.match(fromMine.kept[0].reason, /current checkout/);
  assert.ok(existsSync(mine));
  const fromPrimary = teamCleanup({ ...options, cwd: repo, branch: 'mine' });
  assert.deepEqual(fromPrimary.branches.map((b) => b.name), ['mine']);
  assert.equal(existsSync(mine), false);
  assert.ok(existsSync(other));
  assert.ok(existsSync(repo));
});
