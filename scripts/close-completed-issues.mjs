#!/usr/bin/env node
// Closes issues that a merged PR said it completes ("Closes #N", "Fixes #N", "Resolves #N" in the
// body, or GitHub's own closing references) when they are still open. It never closes on a title or
// file match. --report lists open issues that merged PRs mention without closing, for people to review.
import { pathToFileURL } from 'node:url';
import { gh, parseArgv, parseClosingRefs, parsePartialRefs, pool, runAsync } from './work-lib.mjs';

const HELP = `Usage: node scripts/close-completed-issues.mjs [options]

Closes still-open issues named by a closing keyword in the body of a PR merged into the default branch.
Options:
  --since <days>   merged PRs to look at (default 3; the nightly run uses 14)
  --pr <n>         look at one merged PR only
  --dry-run        print what would be closed; change nothing
  --report         list open issues that merged PRs only mention (Refs/Related to) for human review; closes nothing
  --repo <o/r>     repository (default: the current checkout's)
  --help           this text

Exit codes: 0 ok, 1 a GitHub call failed (nothing is assumed closed), 2 usage error.
An issue is skipped when it was opened after the merge, reopened after the merge, or is a pull request.`;

/** Issue numbers a merged PR completes: body keywords plus GitHub's closing references, same repo only. */
export function closingIssues(pr, repo) {
  const fromBody = parseClosingRefs(pr.body, { repo });
  const fromGitHub = (pr.closingIssuesReferences ?? [])
    .filter((ref) => !ref.repository?.nameWithOwner || ref.repository.nameWithOwner.toLowerCase() === repo.toLowerCase())
    .map((ref) => ref.number);
  return [...new Set([...fromBody, ...fromGitHub])].filter((n) => n !== pr.number).sort((a, b) => a - b);
}

/** Whether to close `issue` for `pr`. `reopenedAt` is the latest reopen time, if any. */
export function decideClose({ pr, issue, reopenedAt = null }) {
  if (issue.pull_request) return { close: false, why: 'is a pull request' };
  if (issue.state !== 'open') return { close: false, why: 'already closed' };
  const merged = Date.parse(pr.mergedAt);
  if (Date.parse(issue.created_at) > merged) return { close: false, why: 'opened after the merge' };
  if (reopenedAt && Date.parse(reopenedAt) > merged) return { close: false, why: 'reopened after the merge' };
  return { close: true, why: 'closing keyword in a merged PR' };
}

export const closeComment = (pr) => `Completed in #${pr.number}.`;

async function listMergedPrs(repo, defaultBranch, sinceDays, onlyPr) {
  const fields = 'number,title,body,mergedAt,baseRefName,closingIssuesReferences,url';
  if (onlyPr) {
    const pr = JSON.parse(await runAsync('gh', ['pr', 'view', String(onlyPr), '-R', repo, '--json', `${fields},state`]));
    return pr.state === 'MERGED' && pr.baseRefName === defaultBranch ? [pr] : [];
  }
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10);
  const prs = JSON.parse(await runAsync('gh', [
    'pr', 'list', '-R', repo, '--state', 'merged', '--base', defaultBranch, '--search', `merged:>=${since}`,
    '--limit', '300', '--json', fields,
  ], { timeout: 120_000 }));
  return prs;
}

const issueApi = async (repo, n) => JSON.parse(await runAsync('gh', ['api', `repos/${repo}/issues/${n}`]));

async function lastReopen(repo, n) {
  const out = await runAsync('gh', ['api', '--paginate', `repos/${repo}/issues/${n}/events?per_page=100`, '--jq', '.[] | select(.event=="reopened") | .created_at']);
  const times = out.split('\n').map((line) => line.trim()).filter(Boolean).sort();
  return times.at(-1) ?? null;
}

export async function run({ repo: repoArg, sinceDays = 3, onlyPr = null, dryRun = false, report = false }) {
  const info = JSON.parse(gh(['repo', 'view', ...(repoArg ? [repoArg] : []), '--json', 'nameWithOwner,defaultBranchRef']));
  const repo = info.nameWithOwner;
  const prs = await listMergedPrs(repo, info.defaultBranchRef.name, report ? Math.max(sinceDays, 30) : sinceDays, onlyPr);
  const lines = [];

  if (report) {
    const mentions = new Map();
    for (const pr of prs) {
      const closing = new Set(closingIssues(pr, repo));
      for (const n of parsePartialRefs(pr.body, { repo })) {
        if (closing.has(n) || n === pr.number) continue;
        (mentions.get(n) ?? mentions.set(n, []).get(n)).push(pr.number);
      }
    }
    const rows = await pool([...mentions].map(([n, from]) => async () => ({ n, from, issue: await issueApi(repo, n) })), 6);
    const open = rows.filter(({ issue }) => !issue.pull_request && issue.state === 'open').sort((a, b) => a.n - b.n);
    lines.push(`report: ${prs.length} merged PR(s) examined; open issues they mention without closing (human review only, nothing closed):`);
    for (const { n, from, issue } of open) lines.push(`  #${n} ${issue.title}  <- ${from.map((p) => `#${p}`).join(' ')}`);
    if (!open.length) lines.push('  none');
    return { lines, closed: [] };
  }

  const wanted = new Map();
  for (const pr of prs) for (const n of closingIssues(pr, repo)) if (!wanted.has(n)) wanted.set(n, pr);
  const closed = [];
  const skipped = [];
  const rows = await pool([...wanted].map(([n, pr]) => async () => {
    const issue = await issueApi(repo, n);
    const reopenedAt = issue.state === 'open' && !issue.pull_request ? await lastReopen(repo, n) : null;
    return { n, pr, issue, decision: decideClose({ pr, issue, reopenedAt }) };
  }), 4);
  for (const { n, pr, issue, decision } of rows) {
    if (!decision.close) { if (issue.state === 'open') skipped.push(`#${n} (${decision.why})`); continue; }
    if (!dryRun) await runAsync('gh', ['issue', 'close', String(n), '-R', repo, '--reason', 'completed', '--comment', closeComment(pr)]);
    closed.push(`#${n} by #${pr.number}`);
  }
  lines.push(`${dryRun ? 'would close' : 'closed'}: ${closed.length ? closed.join(', ') : 'none'} (${prs.length} merged PR(s) examined)`);
  if (skipped.length) lines.push(`left open: ${skipped.join(', ')}`);
  return { lines, closed };
}

async function main(argv) {
  const args = parseArgv(argv, { bool: ['help', 'dry-run', 'report'], value: ['since', 'pr', 'repo'] });
  if (args.bool.help) { console.log(HELP); return 0; }
  const sinceDays = args.value.since === undefined ? 3 : Number(args.value.since);
  const onlyPr = args.value.pr === undefined ? null : Number(args.value.pr);
  const problems = [...args.errors, ...args.positional.map((a) => `unexpected argument ${a}`)];
  if (!Number.isFinite(sinceDays) || sinceDays <= 0) problems.push('--since must be a positive number of days');
  if (onlyPr !== null && !Number.isInteger(onlyPr)) problems.push('--pr must be a PR number');
  if (problems.length) { console.error(`${problems.join('; ')}\n\n${HELP}`); return 2; }
  try {
    const { lines } = await run({ repo: args.value.repo, sinceDays, onlyPr, dryRun: Boolean(args.bool['dry-run']), report: Boolean(args.bool.report) });
    console.log(lines.join('\n'));
    return 0;
  } catch (error) {
    console.error(`FAILED: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
