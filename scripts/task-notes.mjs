#!/usr/bin/env node
// Reads and writes .task-notes.json, the untracked per-worktree record of a task: its tier,
// related-work verdict, claim, tested commit and results, and PR number. Read it after a
// context reset instead of rerunning checks.
import { pathToFileURL } from 'node:url';
import { getPath, mergeNotes, parseArgv, readNotes, repoRoot, setPath, timeAgo, workingTreeFingerprint, writeNotes } from './work-lib.mjs';

const HELP = `Usage: node scripts/task-notes.mjs <command> [args]

Commands:
  show [--json]        compact summary (default); --json prints the file
  get <key>            print one value (dotted keys, e.g. tested.sha)
  set <key> <value>    set a value; JSON is parsed, anything else is a string (e.g. set tier 3, set pr 1234)
  unset <key>          remove a value
  path                 print the notes file path
  --help               this text

Keys used by the scripts: tier, related, claim, tested, pr. The file is untracked (.gitignore).
Exit codes: 0 ok, 1 key missing or file unwritable, 2 usage error.`;

/**
 * One-screen summary of the notes. A tested record is called current only when its working-tree fingerprint
 * (`tree`) equals the one passed in; anything else, including an old record without one, is not verified.
 */
export function formatNotes(notes, { tree = null, now = Date.now() } = {}) {
  if (!Object.keys(notes).length) return 'no task notes yet';
  const lines = [];
  if (notes.tier !== undefined) lines.push(`tier: ${notes.tier}`);
  if (notes.related) {
    const r = notes.related;
    const hits = [...(r.openPrs ?? []).map((n) => `#${n}`), ...(r.termHits ?? [])];
    lines.push(`related-work: ${r.verdict} @ ${String(r.baseSha ?? '').slice(0, 7)} ${r.checkedAt ? timeAgo(r.checkedAt, now) : ''}${hits.length ? ` hits: ${hits.slice(0, 8).join(' ')}` : ''}`.trimEnd());
    if (r.review) lines.push(`related-work review: ${r.review}`);
  }
  if (notes.claim) lines.push(`claim: ${notes.claim.task} session ${notes.claim.session} until ${notes.claim.expiresAt}`);
  if (notes.tested) {
    const t = notes.tested;
    const state = !tree ? 'unchecked (could not fingerprint the working tree)'
      : t.tree && t.tree === tree ? 'current'
        : 'NOT VERIFIED for the files as they are now (edited since the run); rerun verify';
    lines.push(`tested: @ ${t.sha.slice(0, 7)}${t.dirty ? ' + uncommitted' : ''} ${state}`);
    for (const r of t.results ?? []) lines.push(`  ${r.ok ? 'PASS' : 'FAIL'} ${r.name}: ${r.summary}${r.command ? `\n    $ ${r.command}` : ''}`);
  }
  if (notes.pr !== undefined) lines.push(`pr: #${notes.pr}`);
  return lines.join('\n');
}

function parseValue(text) {
  try { return JSON.parse(text); } catch { return text; }
}

export function main(argv, { cwd = process.cwd() } = {}) {
  const [command, ...rest] = argv;
  if (!command || command === '--help') { console.log(HELP); return command ? 0 : 2; }
  const args = parseArgv(rest, { bool: ['json', 'help'] });
  if (args.bool.help) { console.log(HELP); return 0; }
  if (args.errors.length) { console.error(`${args.errors.join('; ')}\n\n${HELP}`); return 2; }
  let root;
  try { root = repoRoot(cwd); } catch (error) { console.error(error.message); return 1; }
  const notes = readNotes(root);
  switch (command) {
    case 'show': {
      if (args.bool.json) { console.log(JSON.stringify(notes, null, 2)); return 0; }
      let tree = null;
      try { tree = workingTreeFingerprint(root).tree; } catch { /* unchecked */ }
      console.log(formatNotes(notes, { tree }));
      return 0;
    }
    case 'get': {
      if (args.positional.length !== 1) { console.error(HELP); return 2; }
      const value = getPath(notes, args.positional[0]);
      if (value === undefined) return 1;
      console.log(typeof value === 'string' ? value : JSON.stringify(value));
      return 0;
    }
    case 'set':
    case 'unset': {
      const need = command === 'set' ? 2 : 1;
      if (args.positional.length !== need) { console.error(HELP); return 2; }
      try {
        const next = command === 'set'
          ? setPath(notes, args.positional[0], parseValue(args.positional[1]))
          : setPath(notes, args.positional[0], null);
        const merged = command === 'set' ? mergeNotes(next, {}) : mergeNotes(stripNulls(next), {});
        writeNotes(root, merged);
      } catch (error) { console.error(error.message); return 1; }
      return 0;
    }
    case 'path':
      console.log(`${root}/.task-notes.json`);
      return 0;
    default:
      console.error(`unknown command ${command}\n\n${HELP}`);
      return 2;
  }
}

function stripNulls(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null).map(([k, v]) => [k, stripNulls(v)]));
  }
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
