/**
 * The check of a repository's programs runs Git synchronously before each of Mousse's Git commands. When
 * it times out (a volume macOS is still asking about, a hung drive), the folder is refused at once for a
 * while instead of holding the whole daemon for the full timeout on every call. It still refuses: Git is
 * never run there without the check.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { clearRepoProgramCache, repoProgramProbes, repoProgramSettings, setRepoProgramProbeTimeout } from '../src/mms/git/repoPrograms'

let root: string
const previousPath = process.env.PATH
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mousse-repo-programs-hang-'))
  // A `git` that never answers, like Git reading a volume whose permission prompt is pending.
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'git'), '#!/bin/sh\nsleep 5\n')
  chmodSync(join(bin, 'git'), 0o755)
  process.env.PATH = `${bin}${delimiter}${previousPath}`
  setRepoProgramProbeTimeout(200)
  clearRepoProgramCache()
})
afterEach(() => {
  process.env.PATH = previousPath
  setRepoProgramProbeTimeout(30_000)
  clearRepoProgramCache()
  rmSync(root, { recursive: true, force: true })
})

it.skipIf(process.platform === 'win32')('a timed-out check refuses the folder at once until it expires, and is checked again after', () => {
  const folder = join(root, 'worktree')
  mkdirSync(folder)
  const probes = repoProgramProbes()
  const started = Date.now()
  expect(() => repoProgramSettings(folder)).toThrow(/did not answer/)
  expect(Date.now() - started).toBeGreaterThanOrEqual(150)
  expect(repoProgramProbes()).toBe(probes + 1)

  // The next calls are refused without running Git again.
  const again = Date.now()
  for (let i = 0; i < 3; i++) expect(() => repoProgramSettings(folder)).toThrow(/did not answer/)
  expect(Date.now() - again).toBeLessThan(150)
  expect(repoProgramProbes()).toBe(probes + 1)

  // Forgetting it (as trusting the repository again does) checks the folder again.
  clearRepoProgramCache()
  expect(() => repoProgramSettings(folder)).toThrow(/did not answer/)
  expect(repoProgramProbes()).toBe(probes + 2)
})
