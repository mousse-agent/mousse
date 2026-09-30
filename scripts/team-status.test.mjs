import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { teamStatus } from './team-status.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'team-status-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, 'remote.git');
  const repo = join(root, 'repo');
  const git = (cwd, ...args) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  git(root, 'init', '--bare', '--initial-branch=trunk/team', remote);
  git(root, 'clone', remote, repo);
  git(repo, 'config', 'user.name', 'Workflow test');
  git(repo, 'config', 'user.email', 'workflow-test@example.invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'example.txt'), 'initial\n');
  git(repo, 'add', 'example.txt');
  git(repo, 'commit', '-m', 'initial');
  git(repo, 'push', '-u', 'origin', 'trunk/team');
  git(repo, 'remote', 'set-head', 'origin', '-a');
  return { root, remote, repo, git };
}

test('fresh status detects a nonstandard default and does not confuse its upstream with a task backup', (t) => {
  const { repo, git } = fixture(t);
  git(repo, 'checkout', '-b', 'task-one', 'origin/trunk/team');
  writeFileSync(join(repo, 'example.txt'), 'task work\n');
  const before = git(repo, 'status', '--porcelain=v1');
  const status = teamStatus({ cwd: repo, fetch: true });
  assert.equal(status.defaultBranch, 'trunk/team');
  assert.equal(status.upstream, 'origin/trunk/team');
  assert.equal(status.publishedBranch, null);
  assert.equal(status.headMatchesPublished, false);
  assert.equal(status.taskDelta, null);
  assert.equal(git(repo, 'status', '--porcelain=v1'), before);
  assert.equal(git(repo, 'branch', '--show-current'), 'task-one');
});

test('reports unpublished commits and verifies a later pushed checkpoint', (t) => {
  const { repo, git } = fixture(t);
  git(repo, 'checkout', '-b', 'task-two');
  git(repo, 'push', '-u', 'origin', 'task-two');
  writeFileSync(join(repo, 'example.txt'), 'checkpoint\n');
  git(repo, 'commit', '-am', 'checkpoint');
  const pending = teamStatus({ cwd: repo, fetch: true });
  assert.deepEqual(pending.taskDelta, { ahead: 1, behind: 0 });
  assert.equal(pending.headMatchesPublished, false);
  git(repo, 'push');
  const published = teamStatus({ cwd: repo, fetch: true });
  assert.deepEqual(published.taskDelta, { ahead: 0, behind: 0 });
  assert.equal(published.headMatchesPublished, true);
});

test('discovers a changed remote default instead of trusting cached origin/HEAD', (t) => {
  const { repo, remote, git } = fixture(t);
  git(repo, 'branch', 'accepted');
  git(repo, 'push', 'origin', 'accepted');
  git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/accepted');
  assert.equal(teamStatus({ cwd: repo }).defaultBranch, 'trunk/team');
  assert.equal(teamStatus({ cwd: repo, fetch: true }).defaultBranch, 'accepted');
});

test('does not report a deleted remote task branch as backed up from a stale tracking ref', (t) => {
  const { repo, remote, git } = fixture(t);
  git(repo, 'checkout', '-b', 'deleted-task');
  git(repo, 'push', '-u', 'origin', 'deleted-task');
  git(repo, 'config', 'fetch.prune', 'true');
  git(remote, 'update-ref', '-d', 'refs/heads/deleted-task');
  assert.equal(teamStatus({ cwd: repo }).headMatchesPublished, true);
  const fresh = teamStatus({ cwd: repo, fetch: true });
  assert.equal(fresh.publishedHead, null);
  assert.equal(fresh.headMatchesPublished, false);
  assert.ok(git(repo, 'rev-parse', '--verify', 'refs/remotes/origin/deleted-task'));
});

test('marks cached and detached state without inventing a task branch', (t) => {
  const { repo, git } = fixture(t);
  git(repo, 'checkout', '--detach');
  const status = teamStatus({ cwd: repo });
  assert.equal(status.branch, null);
  assert.equal(status.remoteState, 'cached');
  assert.equal(status.publishedBranch, null);
});

test('surfaces fetch failure rather than reporting fresh remote state', (t) => {
  const { repo, root, git } = fixture(t);
  git(repo, 'remote', 'set-url', 'origin', join(root, 'missing.git'));
  assert.throws(() => teamStatus({ cwd: repo, fetch: true }), /git fetch .* failed/);
});
