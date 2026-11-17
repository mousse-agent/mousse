#!/usr/bin/env node
// Compact related-work check: searches issues and PRs by terms, intersects the planned paths
// with the changed files of open PRs, and prints only hits. Read-only; writes nothing to GitHub.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  gh, git, gitCommonDir, parseArgv, pathsOverlap, pool, recordNotes, repoRoot, runAsync, timeAgo,
} from './work-lib.mjs';

const HELP = `Usage: node scripts/related-work.mjs [terms and planned paths] [options]

Finds open and recently merged work that overlaps a task. Prints only hits.

Arguments (a bare argument with a "/" or a file extension is a planned path, the rest are terms):
  --term <text>    search term (repeatable; quote phrases)
  --path <path>    planned file or directory (repeatable)
Options:
  --days <n>       how far back "recently merged" reaches (default 14)
  --self <branch>  head branch to ignore (default: the current branch)
  --repo <o/r>     repository (default: the current checkout's)
  --no-fetch       skip "git fetch origin"
  --no-notes       do not record the verdict in .task-notes.json
  --json           print the result as JSON
  --help           this text

Exit codes: 0 checked (hits or clear), 1 NOT CHECKED (any gh/git failure), 2 usage error.
CLEAR is printed only when every check completed and found nothing.`;

const PATH_LIKE = /[\\/]|\.[A-Za-z0-9]{1,8}$/;
const MAX_TERM_LINES = 10;
const MAX_FILES_SHOWN = 5;

export function classifyArgs(positional) {
  const terms = [];
  const paths = [];
  for (const arg of positional) (PATH_LIKE.test(arg) && !/\s/.test(arg) ? paths : terms).push(arg);
  return { terms, paths };
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

const limited = (items, max) => (items.length > max ? [...items.slice(0, max), `+${items.length - max}`] : items);

export function formatReport({ repo, baseSha, openCount, terms, planned, overlaps, termHits, now = Date.now() }) {
  const lines = [`related-work ${repo} @ ${baseSha.slice(0, 7)}: ${openCount} open PRs, ${terms.length} term(s), ${planned.length} path(s)`];
  if (overlaps.length) {
    lines.push('OPEN PRs touching planned paths:');
    for (const { pr, overlap, truncated } of overlaps) {
      const flags = [pr.isDraft ? 'draft' : null, pr.baseRefName && pr.baseRefName !== 'master' && pr.baseRefName !== 'main' ? `base ${pr.baseRefName}` : null].filter(Boolean);
      lines.push(`  #${pr.number} ${pr.title}${flags.length ? ` [${flags.join(', ')}]` : ''}`);
      lines.push(`    @${pr.author?.login ?? '?'}  ${pr.headRefName}  updated ${timeAgo(pr.updatedAt, now)}`);
      lines.push(`    files: ${limited(overlap, MAX_FILES_SHOWN).join(', ')}${truncated ? ' (file list truncated by GitHub)' : ''}`);
    }
  }
  const shownNumbers = new Set(overlaps.map(({ pr }) => pr.number));
  const rest = termHits.filter((hit) => !(hit.kind === 'PR' && hit.state === 'open' && shownNumbers.has(hit.number)));
  if (rest.length) {
    lines.push('Matches by term (number and title; read only if the plan overlaps):');
    for (const hit of limited(rest, MAX_TERM_LINES)) {
      lines.push(typeof hit === 'string' ? `  ${hit} more` : `  ${hit.kind} #${hit.number} ${hit.state}: ${hit.title}`);
    }
  }
  if (!planned.length) lines.push('Files: NOT CHECKED (no planned paths given), so overlap with open PRs is unknown.');
  if (!overlaps.length && !rest.length) {
    lines.push(planned.length ? 'CLEAR: no open PR touches the planned paths and no term matched.' : 'No term matched. Not clear: planned paths were not checked.');
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

export async function check({ terms, paths, days, self, repo: repoArg, fetch = true, cwd = process.cwd() }) {
  const info = JSON.parse(gh(['repo', 'view', ...(repoArg ? [repoArg] : []), '--json', 'nameWithOwner,defaultBranchRef'], { cwd }));
  const repo = info.nameWithOwner;
  const defaultBranch = info.defaultBranchRef.name;
  if (fetch) git(['fetch', '--no-prune', '--no-tags', 'origin'], { cwd, timeout: 120_000 });
  const baseSha = git(['rev-parse', '--verify', `refs/remotes/origin/${defaultBranch}`], { cwd });

  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const fields = 'number,title';
  const searches = terms.flatMap((term) => [
    { kind: 'issue', state: 'open', args: ['issue', 'list', '-R', repo, '--state', 'open', '--search', term, '--limit', '15', '--json', fields] },
    { kind: 'PR', state: 'open', args: ['pr', 'list', '-R', repo, '--state', 'open', '--search', term, '--limit', '15', '--json', fields] },
    { kind: 'PR', state: 'merged', args: ['pr', 'list', '-R', repo, '--state', 'merged', '--search', `${term} merged:>=${since}`, '--limit', '15', '--json', fields] },
  ]);

  const [openPrs, searchResults] = await Promise.all([
    ghJson(['pr', 'list', '-R', repo, '--state', 'open', '--limit', '1000',
      '--json', 'number,title,author,headRefName,headRefOid,updatedAt,isDraft,baseRefName,changedFiles']),
    pool(searches.map((search) => async () => ({ search, rows: await ghJson(search.args) })), 6),
  ]);

  const termHits = [];
  const seen = new Set();
  for (const { search, rows } of searchResults) {
    for (const row of rows) {
      const key = `${search.kind}#${row.number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      termHits.push({ kind: search.kind, number: row.number, state: search.state, title: row.title });
    }
  }

  let branch = self;
  if (!branch) { try { branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd }); } catch { branch = null; } }
  const others = openPrs.filter((pr) => pr.headRefName !== branch);
  const filesByPr = new Map();
  if (paths.length) {
    const cachePath = join(gitCommonDir(cwd), 'work-cache', 'pr-files.json');
    const cache = loadCache(cachePath);
    const next = {};
    const missing = [];
    for (const pr of others) {
      const key = `${repo}#${pr.number}`;
      if (cache[key]?.sha === pr.headRefOid) { next[key] = cache[key]; filesByPr.set(pr.number, cache[key].files); } else missing.push(pr);
    }
    const fetched = await pool(missing.map((pr) => async () => ({ pr, files: await fetchPrFiles(repo, pr.number) })), 6);
    for (const { pr, files } of fetched) {
      next[`${repo}#${pr.number}`] = { sha: pr.headRefOid, files };
      filesByPr.set(pr.number, files);
    }
    try { saveCache(cachePath, next); } catch { /* the cache is an optimisation only */ }
  }

  const overlaps = findOverlaps(others, filesByPr, paths);
  return { repo, baseSha, openCount: others.length, terms, planned: paths, overlaps, termHits };
}

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

  const hasHits = result.overlaps.length > 0 || result.termHits.length > 0;
  const verdict = hasHits ? 'hits' : (paths.length ? 'clear' : 'terms-only');
  if (!args.bool['no-notes']) {
    try {
      recordNotes(repoRoot(), {
        related: {
          verdict, baseSha: result.baseSha, checkedAt: new Date().toISOString(), terms, paths,
          openPrs: result.overlaps.map(({ pr }) => pr.number),
          termHits: result.termHits.slice(0, 20).map((hit) => `${hit.kind}#${hit.number}`),
        },
      });
    } catch { /* not in a checkout: nothing to record */ }
  }
  if (args.bool.json) console.log(JSON.stringify({ verdict, ...result, overlaps: result.overlaps.map(({ pr, overlap, truncated }) => ({ number: pr.number, title: pr.title, author: pr.author?.login, branch: pr.headRefName, updatedAt: pr.updatedAt, files: overlap, truncated })) }));
  else console.log(formatReport(result));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
