#!/usr/bin/env node
// Compact related-work check: searches issues and PRs (open and closed) by terms, intersects the planned
// paths with the changed files of open PRs and of recent remote branches that have no PR, and prints only
// hits. Read-only; writes nothing to GitHub. Anything incomplete is said so and never reported as CLEAR.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  coversWholeRepo, gh, git, gitCommonDir, parseArgv, pathsOverlap, pool, recordNotes, repoRoot, runAsync, timeAgo,
} from './work-lib.mjs';

const HELP = `Usage: node scripts/related-work.mjs [terms and planned paths] [options]

Finds open and closed work that overlaps a task, plus recent remote branches without a PR. Prints only hits.

Arguments (a bare argument with a "/" or a file extension, or "." for the whole repository, is a planned path):
  --term <text>    search term (repeatable; quote phrases)
  --path <path>    planned file or directory (repeatable); "." means everything and matches every open change
Options:
  --days <n>       how recent a remote branch must be to be examined (default 14)
  --self <branch>  head branch to ignore (default: the current branch)
  --repo <o/r>     repository (default: the current checkout's)
  --no-fetch       skip "git fetch origin"
  --no-notes       do not record the verdict in .task-notes.json
  --json           print the result as JSON
  --help           this text

Exit codes: 0 checked completely (hits or clear), 1 NOT CHECKED (any gh/git failure, or the open PR list hit its
limit), 2 usage error, 3 INCOMPLETE (ran, but coverage was cut short; candidates are still printed and this takes
precedence over hits). CLEAR is printed only when every check completed and found nothing.
Each term search fetches up to 301 rows; only a search with more than 300 matches is
incomplete. The report shows a short ranked list (12 lines), not everything retrieved.`;

const ROOT_LIKE = /^(\.|\.\/|\/|\*{1,2})$/;
const PATH_LIKE = /[\\/]|\.[A-Za-z0-9]{1,8}$/;
export const OPEN_PR_LIMIT = 1000;
export const TERM_CEILING = 300;
export const MAX_BRANCHES = 400;
const MAX_TERM_LINES = 12;
const TERM_WORDS = (term) => term.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 3);

/**
 * Orders term matches for display: open work first, then the share of each term's words found in the title,
 * then the most recently updated. Retrieval is separate: every row up to the ceiling is fetched and ranked.
 */
export function rankTermHits(hits, terms) {
  const score = (hit) => {
    const title = hit.title.toLowerCase();
    return Math.max(0, ...terms.map((term) => {
      const words = TERM_WORDS(term);
      return words.length ? words.filter((word) => title.includes(word)).length / words.length : 0;
    }));
  };
  return hits
    .map((hit) => ({ hit, score: score(hit) }))
    .sort((a, b) => (a.hit.state === 'open' ? 0 : 1) - (b.hit.state === 'open' ? 0 : 1) || b.score - a.score || Date.parse(b.hit.updatedAt) - Date.parse(a.hit.updatedAt))
    .map(({ hit }) => hit);
}

/** One note per search that reached the ceiling, naming its term; none when every search was exhausted. */
export function ceilingNotes(results, ceiling = TERM_CEILING) {
  return results.filter(({ rows }) => rows.length > ceiling)
    .map(({ search }) => `term "${search.term}": more than ${ceiling} ${search.state} ${search.kind === 'PR' ? 'PRs' : 'issues'} matched; only the newest ${ceiling} were ranked`);
}
const MAX_FILES_SHOWN = 5;
const MAX_BRANCH_LINES = 10;

export function classifyArgs(positional) {
  const terms = [];
  const paths = [];
  for (const arg of positional) (ROOT_LIKE.test(arg) || (PATH_LIKE.test(arg) && !/\s/.test(arg)) ? paths : terms).push(arg);
  return { terms, paths };
}

/** A list that came back at its limit may have more rows: the check is incomplete, so it must not pass. */
export function assertComplete(count, limit, what) {
  if (count >= limit) throw new Error(`incomplete: ${what} reached its limit of ${limit}; there may be more`);
}

/** The PR is the current task's own: same branch name in this repository, not a fork's branch of that name. */
export function isOwnPr(pr, branch, repoOwner) {
  if (!branch || pr.headRefName !== branch) return false;
  if (pr.isCrossRepository) return false;
  const headOwner = pr.headRepositoryOwner?.login;
  return !headOwner || !repoOwner || headOwner.toLowerCase() === repoOwner.toLowerCase();
}

/** Open PRs whose changed files intersect the plan. `filesByPr` maps PR number to its file list. */
export function findOverlaps(prs, filesByPr, planned) {
  const hits = [];
  for (const pr of prs) {
    const files = filesByPr.get(pr.number) ?? [];
    const truncated = Number.isFinite(pr.changedFiles) && pr.changedFiles > files.length;
    const overlap = pathsOverlap(planned, files);
    if (overlap.length || (truncated && planned.length)) hits.push({ pr, overlap, truncated });
  }
  return hits;
}

/** Whether every term's words (3+ letters) appear in a branch name. */
export function branchNameMatches(name, terms) {
  const lower = name.toLowerCase();
  return terms.some((term) => {
    const words = term.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 3);
    return words.length > 0 && words.every((word) => lower.includes(word));
  });
}

/**
 * Recent remote branches (already without an open PR) that match a term by name or change a planned path.
 * `aheadOf(name)` is the number of commits not on the default branch; `filesOf(name)` the files it changes
 * against the default branch. A branch whose diff cannot be read counts in `failed`, never as clear.
 */
export function findBranchHits(branches, { terms, planned, aheadOf, filesOf }) {
  const hits = [];
  let failed = 0;
  for (const branch of branches) {
    try {
      if (aheadOf(branch.name) === 0) continue;
      const byName = branchNameMatches(branch.name, terms);
      const files = planned.length ? pathsOverlap(planned, filesOf(branch.name)) : [];
      if (byName || files.length) hits.push({ ...branch, byName, files });
    } catch {
      failed += 1;
    }
  }
  return { hits, failed };
}

const limited = (items, max) => (items.length > max ? [...items.slice(0, max), `+${items.length - max}`] : items);
const stateLabel = (hit, now) => (hit.state === 'open' ? 'open' : `${hit.state} ${timeAgo(hit.updatedAt, now).replace(' ago', '')}`);

export function formatReport({ repo, baseSha, openCount, terms, planned, overlaps, termHits, branchHits = [], incomplete = [], now = Date.now() }) {
  const lines = [`related-work ${repo} @ ${baseSha.slice(0, 7)}: ${openCount} open PRs, ${terms.length} term(s), ${planned.length} path(s)`];
  if (planned.some((path) => coversWholeRepo([path]))) lines.push('Planned path is the whole repository: every open change counts as overlapping.');
  if (overlaps.length) {
    lines.push('OPEN PRs touching planned paths:');
    for (const { pr, overlap, truncated } of overlaps) {
      const flags = [pr.isDraft ? 'draft' : null, pr.baseRefName && pr.baseRefName !== 'master' && pr.baseRefName !== 'main' ? `base ${pr.baseRefName}` : null].filter(Boolean);
      lines.push(`  #${pr.number} ${pr.title}${flags.length ? ` [${flags.join(', ')}]` : ''}`);
      lines.push(`    @${pr.author?.login ?? '?'}  ${pr.headRefName}  updated ${timeAgo(pr.updatedAt, now)}`);
      lines.push(`    files: ${limited(overlap, MAX_FILES_SHOWN).join(', ')}${truncated ? ' (file list truncated by GitHub)' : ''}`);
    }
  }
  if (branchHits.length) {
    lines.push('Remote branches without a PR (recent):');
    for (const branch of limited(branchHits, MAX_BRANCH_LINES)) {
      if (typeof branch === 'string') { lines.push(`  ${branch} more`); continue; }
      lines.push(`  origin/${branch.name}  ${timeAgo(branch.date, now)}${branch.byName ? '  name matches a term' : ''}${branch.files.length ? `  files: ${limited(branch.files, MAX_FILES_SHOWN).join(', ')}` : ''}`);
    }
  }
  const shownNumbers = new Set(overlaps.map(({ pr }) => pr.number));
  const rest = termHits.filter((hit) => !(hit.kind === 'PR' && hit.state === 'open' && shownNumbers.has(hit.number)));
  if (rest.length) {
    lines.push('Matches by term, open and closed (number and title; read only if the plan overlaps):');
    for (const hit of limited(rest, MAX_TERM_LINES)) {
      lines.push(typeof hit === 'string' ? `  ${hit} more` : `  ${hit.kind} #${hit.number} ${stateLabel(hit, now)}: ${hit.title}`);
    }
  }
  if (!planned.length) lines.push('Files: NOT CHECKED (no planned paths given), so overlap with open PRs and branches is unknown.');
  for (const note of incomplete) lines.push(`INCOMPLETE: ${note}`);
  const anyHit = overlaps.length || branchHits.length || rest.length;
  if (!anyHit && !incomplete.length) {
    lines.push(planned.length ? 'CLEAR: no open PR or recent branch touches the planned paths and no open or closed item matched a term.' : 'No term matched. Not clear: planned paths were not checked.');
  }
  return lines.join('\n');
}

function loadCache(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}

function saveCache(path, cache) {
  mkdirSync(join(path, '..'), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(cache));
  renameSync(temp, path);
}

const ghJson = async (args) => JSON.parse(await runAsync('gh', args));

async function fetchPrFiles(repo, number) {
  const out = await runAsync('gh', ['api', '--paginate', `repos/${repo}/pulls/${number}/files?per_page=100`, '--jq', '.[].filename']);
  return out.split('\n').map((line) => line.trim()).filter(Boolean);
}

/** A cached file list is valid for one head commit against one base commit (the diff moves with either). */
export const cacheStamp = (pr) => `${pr.headRefOid}|${pr.baseRefName}|${pr.baseRefOid}`;

function recentBranches(cwd, days, defaultBranch) {
  const out = git(['for-each-ref', '--sort=-committerdate', '--format=%(refname)%09%(committerdate:iso-strict)', 'refs/remotes/origin'], { cwd });
  const cutoff = Date.now() - days * 86_400_000;
  const prefix = 'refs/remotes/origin/';
  return out.split('\n').filter(Boolean).map((line) => {
    const [ref, date] = line.split('\t');
    return { name: ref.slice(prefix.length), date };
  }).filter(({ name, date }) => name && name !== 'HEAD' && name !== defaultBranch && name !== 'agent-claims' && Date.parse(date) >= cutoff);
}

export async function check({ terms, paths, days, self, repo: repoArg, fetch = true, cwd = process.cwd() }) {
  const info = JSON.parse(gh(['repo', 'view', ...(repoArg ? [repoArg] : []), '--json', 'nameWithOwner,defaultBranchRef'], { cwd }));
  const repo = info.nameWithOwner;
  const repoOwner = repo.split('/')[0];
  const defaultBranch = info.defaultBranchRef.name;
  if (fetch) git(['fetch', '--no-prune', '--no-tags', 'origin'], { cwd, timeout: 120_000 });
  const baseSha = git(['rev-parse', '--verify', `refs/remotes/origin/${defaultBranch}`], { cwd });

  const sort = ' sort:updated-desc';
  const searches = terms.flatMap((term) => [
    { term, kind: 'issue', state: 'open', args: ['issue', 'list', '-R', repo, '--state', 'open', '--search', term + sort, '--limit', String(TERM_CEILING + 1), '--json', 'number,title,updatedAt'] },
    { term, kind: 'issue', state: 'closed', args: ['issue', 'list', '-R', repo, '--state', 'closed', '--search', term + sort, '--limit', String(TERM_CEILING + 1), '--json', 'number,title,updatedAt'] },
    { term, kind: 'PR', state: 'open', args: ['pr', 'list', '-R', repo, '--state', 'open', '--search', term + sort, '--limit', String(TERM_CEILING + 1), '--json', 'number,title,updatedAt'] },
    { term, kind: 'PR', state: 'closed', args: ['pr', 'list', '-R', repo, '--state', 'closed', '--search', term + sort, '--limit', String(TERM_CEILING + 1), '--json', 'number,title,updatedAt,mergedAt'] },
  ]);

  const [openPrs, searchResults] = await Promise.all([
    ghJson(['pr', 'list', '-R', repo, '--state', 'open', '--limit', String(OPEN_PR_LIMIT),
      '--json', 'number,title,author,headRefName,headRefOid,baseRefName,baseRefOid,updatedAt,isDraft,changedFiles,isCrossRepository,headRepositoryOwner']),
    pool(searches.map((search) => async () => ({ search, rows: await ghJson(search.args) })), 6),
  ]);
  assertComplete(openPrs.length, OPEN_PR_LIMIT, 'the open PR list');

  const incomplete = [];
  const termHits = [];
  const seen = new Set();
  for (const { search, rows } of searchResults) {
    for (const row of rows.slice(0, TERM_CEILING)) {
      const key = `${search.kind}#${row.number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const state = search.state === 'closed' && search.kind === 'PR' ? (row.mergedAt ? 'merged' : 'closed') : search.state;
      termHits.push({ kind: search.kind, number: row.number, state, title: row.title, updatedAt: row.updatedAt });
    }
  }
  incomplete.push(...ceilingNotes(searchResults));
  termHits.splice(0, termHits.length, ...rankTermHits(termHits, terms));

  let branch = self;
  if (!branch) { try { branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd }); } catch { branch = null; } }
  const others = openPrs.filter((pr) => !isOwnPr(pr, branch, repoOwner));
  const filesByPr = new Map();
  if (paths.length) {
    const cachePath = join(gitCommonDir(cwd), 'work-cache', 'pr-files.json');
    const cache = loadCache(cachePath);
    const next = {};
    const missing = [];
    for (const pr of others) {
      const key = `${repo}#${pr.number}`;
      if (cache[key]?.stamp === cacheStamp(pr)) { next[key] = cache[key]; filesByPr.set(pr.number, cache[key].files); } else missing.push(pr);
    }
    const fetched = await pool(missing.map((pr) => async () => ({ pr, files: await fetchPrFiles(repo, pr.number) })), 6);
    for (const { pr, files } of fetched) {
      next[`${repo}#${pr.number}`] = { stamp: cacheStamp(pr), files };
      filesByPr.set(pr.number, files);
    }
    try { saveCache(cachePath, next); } catch { /* the cache is an optimisation only */ }
  }
  const overlaps = paths.length ? findOverlaps(others, filesByPr, paths) : [];

  // Recent remote branches that have no open PR: matched by name, or by files changed against the default branch.
  const withPr = new Set(openPrs.filter((pr) => !pr.isCrossRepository).map((pr) => pr.headRefName));
  const candidates = recentBranches(cwd, days, defaultBranch).filter(({ name }) => !withPr.has(name) && name !== branch);
  if (candidates.length > MAX_BRANCHES) incomplete.push(`${candidates.length} recent remote branches have no PR; only the newest ${MAX_BRANCHES} were examined`);
  const base = `refs/remotes/origin/${defaultBranch}`;
  const { hits: branchHits, failed } = findBranchHits(candidates.slice(0, MAX_BRANCHES), {
    terms, planned: paths,
    aheadOf: (name) => {
      // A branch with no common history (such as an assets branch) is not work on this code.
      try { git(['merge-base', base, `refs/remotes/origin/${name}`], { cwd }); } catch (error) { if (error.status === 1) return 0; throw error; }
      return Number(git(['rev-list', '--count', `${base}..refs/remotes/origin/${name}`], { cwd }));
    },
    filesOf: (name) => git(['diff', '--name-only', `${base}...refs/remotes/origin/${name}`], { cwd }).split('\n').filter(Boolean),
  });
  if (failed) incomplete.push(`${failed} remote branch(es) could not be compared`);

  return { repo, baseSha, openCount: others.length, terms, planned: paths, overlaps, termHits, branchHits, incomplete };
}

/** Incomplete coverage outranks hits: candidates are still reported, but the verdict is never a complete one. */
export function verdictOf({ hasHits, incomplete, hasPaths }) {
  if (incomplete.length) return 'incomplete';
  if (hasHits) return 'hits';
  return hasPaths ? 'clear' : 'terms-only';
}

export const exitCodeFor = (verdict) => (verdict === 'incomplete' ? 3 : 0);

async function main(argv) {
  const args = parseArgv(argv, {
    bool: ['help', 'no-fetch', 'no-notes', 'json'], value: ['days', 'self', 'repo'], multi: ['term', 'path'],
  });
  if (args.bool.help) { console.log(HELP); return 0; }
  const days = args.value.days === undefined ? 14 : Number(args.value.days);
  if (args.errors.length || !Number.isFinite(days) || days <= 0) {
    console.error(`${args.errors.join('; ') || '--days must be a positive number'}\n\n${HELP}`);
    return 2;
  }
  const guess = classifyArgs(args.positional);
  const terms = [...(args.multi.term ?? []), ...guess.terms];
  const paths = [...(args.multi.path ?? []), ...guess.paths];
  if (!terms.length && !paths.length) { console.error(`Give at least one term or path.\n\n${HELP}`); return 2; }

  let result;
  try {
    result = await check({ terms, paths, days, self: args.value.self, repo: args.value.repo, fetch: !args.bool['no-fetch'] });
  } catch (error) {
    console.log(`NOT CHECKED: ${error.message}`);
    return 1;
  }

  const hasHits = result.overlaps.length > 0 || result.termHits.length > 0 || result.branchHits.length > 0;
  const verdict = verdictOf({ hasHits, incomplete: result.incomplete, hasPaths: paths.length > 0 });
  if (!args.bool['no-notes']) {
    try {
      recordNotes(repoRoot(), {
        related: {
          verdict, baseSha: result.baseSha, checkedAt: new Date().toISOString(), terms, paths,
          openPrs: result.overlaps.map(({ pr }) => pr.number),
          branches: result.branchHits.map((hit) => hit.name),
          termHits: result.termHits.slice(0, 20).map((hit) => `${hit.kind}#${hit.number}`),
          incomplete: result.incomplete,
        },
      });
    } catch { /* not in a checkout: nothing to record */ }
  }
  if (args.bool.json) console.log(JSON.stringify({ verdict, ...result, overlaps: result.overlaps.map(({ pr, overlap, truncated }) => ({ number: pr.number, title: pr.title, author: pr.author?.login, branch: pr.headRefName, updatedAt: pr.updatedAt, files: overlap, truncated })) }));
  else console.log(formatReport(result));
  return exitCodeFor(verdict);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
