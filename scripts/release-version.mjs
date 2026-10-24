#!/usr/bin/env node
// Decides what the nightly and stable release workflows build, and prints it as
// GitHub Actions step outputs (key=value lines). See docs/releases.md.
//
//   node scripts/release-version.mjs nightly   # GH_REPO, GH_TOKEN, GITHUB_SHA, GITHUB_RUN_NUMBER; FORCE=true rebuilds
//   node scripts/release-version.mjs stable    # GH_REPO, GH_TOKEN, GITHUB_REF_NAME (the pushed tag)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const STABLE_VERSION = /^\d+\.\d+\.\d+$/;
const STABLE_TAG = /^v\d+\.\d+\.\d+$/;
const NIGHTLY_TAG = /^v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/;

/** `0.1.2` → `0.1.2-nightly.20261022.17`, with the UTC date of `now`. */
export function nightlyVersion(base, now, runNumber) {
  if (!STABLE_VERSION.test(base)) throw new Error(`package.json version ${base} is not a plain x.y.z version`);
  if (!/^\d+$/.test(String(runNumber))) throw new Error(`run number ${runNumber} is not a number`);
  const date = now.toISOString().slice(0, 10).replaceAll('-', '');
  return `${base}-nightly.${date}.${runNumber}`;
}

/** The newest nightly release tag by creation time, from `[{ tagName, createdAt }]`. */
export function latestNightlyTag(releases) {
  return releases
    .filter((release) => NIGHTLY_TAG.test(release.tagName))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.tagName;
}

function compareStable(a, b) {
  const [x, y] = [a, b].map((tag) => tag.slice(1).split('.').map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** The highest stable tag below `current`, from a list of tag names. */
export function previousStableTag(tags, current) {
  return tags
    .filter((tag) => STABLE_TAG.test(tag) && compareStable(tag, current) < 0)
    .sort(compareStable)
    .at(-1);
}

/**
 * Whether master needs a nightly. `aheadBy` is how many commits HEAD has past the last
 * nightly; it is unused when there is no nightly yet.
 */
export function nightlyDecision({ previous, aheadBy, force }) {
  if (force) return { build: true, reason: 'forced by hand' };
  if (!previous) return { build: true, reason: 'no earlier nightly' };
  if (aheadBy > 0) return { build: true, reason: `${aheadBy} new commit(s) since ${previous}` };
  return { build: false, reason: `no new commits since ${previous}` };
}

function gh(...args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}

function tagExists(tag) {
  try {
    execFileSync('gh', ['api', `repos/${process.env.GH_REPO}/git/ref/tags/${tag}`, '--silent'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function packageVersion() {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
}

function output(values) {
  for (const [key, value] of Object.entries(values)) process.stdout.write(`${key}=${value ?? ''}\n`);
}

function resolveNightly() {
  const base = packageVersion();
  // A nightly sorts before its stable version, so one built after that release would go backwards.
  if (tagExists(`v${base}`)) {
    throw new Error(`v${base} is already tagged. Bump package.json on master to the next version.`);
  }
  const releases = JSON.parse(gh('release', 'list', '--limit', '200', '--json', 'tagName,createdAt'));
  const previous = latestNightlyTag(releases);
  const aheadBy = previous
    ? Number(gh('api', `repos/${process.env.GH_REPO}/compare/${previous}...${process.env.GITHUB_SHA}`, '--jq', '.ahead_by'))
    : undefined;
  const decision = nightlyDecision({ previous, aheadBy, force: process.env.FORCE === 'true' });
  const version = nightlyVersion(base, new Date(), process.env.GITHUB_RUN_NUMBER);
  console.error(decision.build ? `Building ${version}: ${decision.reason}.` : `Skipping: ${decision.reason}.`);
  output({ build: decision.build, version, previous });
}

function resolveStable() {
  const tag = process.env.GITHUB_REF_NAME;
  const version = packageVersion();
  if (tag !== `v${version}`) {
    throw new Error(`Tag ${tag} does not match package.json version ${version}. Tag the commit that sets that version.`);
  }
  const tags = gh('api', '--paginate', `repos/${process.env.GH_REPO}/tags`, '--jq', '.[].name').split('\n');
  output({ version, previous: previousStableTag(tags, tag) });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  if (mode === 'nightly') resolveNightly();
  else if (mode === 'stable') resolveStable();
  else {
    console.error('Usage: node scripts/release-version.mjs nightly|stable');
    process.exit(2);
  }
}
