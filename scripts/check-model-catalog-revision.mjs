#!/usr/bin/env node
// Checks that the model catalog's `revision` rises whenever the file changes
// (docs/providers/model-catalog.md, "Changing the file").
//
//   node scripts/check-model-catalog-revision.mjs --base <git-rev>
//     CI on a pull request: src/mms/models/models.json in the checkout against the same file at
//     <git-rev> (HEAD^1, the base branch side of the PR's merge commit).
//   node scripts/check-model-catalog-revision.mjs --published <published.json> <candidate.json>
//     The publish workflow: the file about to be uploaded against the one already published.
//
// Byte-identical files pass, whatever their revision. Otherwise the new revision must be higher.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const CATALOG_PATH = 'src/mms/models/models.json'

function revisionOf(text) {
  try {
    const revision = JSON.parse(text)?.revision
    return Number.isInteger(revision) ? revision : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether `after` may replace `before`. `before` is null when there is no earlier copy (a new file,
 * or nothing published yet). Returns `{ ok, message }`.
 */
export function checkCatalogRevision(before, after) {
  if (before === null) return { ok: true, message: 'There is no earlier copy to compare with.' }
  if (before === after) return { ok: true, message: 'The catalog is unchanged.' }
  const old = revisionOf(before)
  const next = revisionOf(after)
  if (next === undefined) return { ok: false, message: 'The new catalog has no whole-number revision.' }
  if (old === undefined) return { ok: false, message: 'The earlier catalog has no whole-number revision to compare with.' }
  if (next > old) return { ok: true, message: `The revision rises from ${old} to ${next}.` }
  return {
    ok: false,
    message: `The catalog changed but its revision is ${next}, not above ${old}. Set "revision" to ${old + 1}.`
  }
}

/** The catalog at a git revision, or null when the file does not exist there. */
function catalogAt(rev, cwd) {
  try {
    execFileSync('git', ['cat-file', '-e', `${rev}:${CATALOG_PATH}`], { cwd, stdio: 'ignore' })
  } catch {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { cwd, stdio: 'ignore' })
    return null
  }
  return execFileSync('git', ['show', `${rev}:${CATALOG_PATH}`], { cwd, encoding: 'utf8' })
}

function main() {
  const args = process.argv.slice(2)
  let result
  if (args[0] === '--base' && args.length === 2) {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    let before
    try {
      before = catalogAt(args[1], root)
    } catch {
      throw new Error(`${args[1]} is not a commit in this checkout. Fetch enough history to include it.`)
    }
    // A Windows checkout may have CRLF where git stores LF; line endings are not a change here.
    const lf = (text) => text?.replace(/\r\n/g, '\n') ?? null
    result = checkCatalogRevision(lf(before), lf(readFileSync(join(root, CATALOG_PATH), 'utf8')))
  } else if (args[0] === '--published' && args.length === 3) {
    result = checkCatalogRevision(readFileSync(args[1], 'utf8'), readFileSync(args[2], 'utf8'))
  } else {
    throw new Error('Usage: check-model-catalog-revision.mjs --base <git-rev> | --published <published.json> <candidate.json>')
  }
  if (!result.ok) throw new Error(result.message)
  console.log(result.message)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
