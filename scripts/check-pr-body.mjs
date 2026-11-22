#!/usr/bin/env node
// PR rule: the body must say "Closes #N" (or Fixes/Resolves), "Refs #N", or "No issue".
// Reads the body from the PR_BODY environment variable, or from a file given as the argument,
// so the workflow never interpolates untrusted text into a shell command.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { checkPrBody } from './work-lib.mjs';

const HELP = `Usage: PR_BODY="..." node scripts/check-pr-body.mjs [--repo o/r]
       node scripts/check-pr-body.mjs <body-file> [--repo o/r]

Exits 0 when the body has Closes/Fixes/Resolves #N, Refs #N or "No issue"; 1 otherwise; 2 on usage error.
Text inside HTML comments or code does not count, so the unedited template fails.`;

function main(argv, env) {
  if (argv.includes('--help')) { console.log(HELP); return 0; }
  const repoIndex = argv.indexOf('--repo');
  const repo = repoIndex === -1 ? env.GITHUB_REPOSITORY : argv[repoIndex + 1];
  const file = argv.find((arg, i) => !arg.startsWith('--') && argv[i - 1] !== '--repo');
  let body;
  try {
    body = file ? readFileSync(file, 'utf8') : env.PR_BODY;
  } catch (error) { console.error(error.message); return 2; }
  if (body === undefined) { console.error(`No body given.\n\n${HELP}`); return 2; }
  const result = checkPrBody(body, { repo });
  if (result.ok) {
    console.log(`PR body ok: ${result.kind === 'none' ? 'No issue' : `${result.kind === 'closes' ? 'Closes' : 'Refs'} ${result.numbers.map((n) => `#${n}`).join(', ')}`}`);
    return 0;
  }
  console.log(`PR body check failed. ${result.reason}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
