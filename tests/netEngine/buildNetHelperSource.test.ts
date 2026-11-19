/**
 * `scripts/build-net-helper.mjs` checks out the pinned engine commit in `native/net-helper/source`. A checkout
 * someone works in (signed check results, edits) must survive: the build stops instead of moving it. Real git
 * repositories; the script runs from a copy in a scratch project so the real checkout is never involved. Proceeding
 * cases stop later at the cargo build of a source without a Cargo.toml, which is past the checkout.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const SCRIPT = resolve(__dirname, '..', '..', 'scripts', 'build-net-helper.mjs')
const root = mkdtempSync(join(tmpdir(), 'build-net-helper-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const git = (cwd: string, ...args: string[]): string => {
  const out = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' })
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`)
  return out.stdout.trim()
}

/** A scratch project whose source checkout is at a later commit than the pinned one. */
function project(name: string): { source: string; pinned: string; later: string } {
  const folder = join(root, name)
  const source = join(folder, 'native', 'net-helper', 'source')
  mkdirSync(join(folder, 'scripts'), { recursive: true })
  mkdirSync(source, { recursive: true })
  copyFileSync(SCRIPT, join(folder, 'scripts', 'build-net-helper.mjs'))
  git(source, 'init', '-q')
  writeFileSync(join(source, '.gitignore'), '/target\n')
  writeFileSync(join(source, 'kept.txt'), 'pinned\n')
  git(source, 'add', '.')
  git(source, 'commit', '-q', '-m', 'pinned')
  const pinned = git(source, 'rev-parse', 'HEAD')
  writeFileSync(join(source, 'kept.txt'), 'later\n')
  git(source, 'commit', '-q', '-am', 'later')
  const later = git(source, 'rev-parse', 'HEAD')
  git(source, 'remote', 'add', 'origin', 'https://example.invalid/own-remote.git')
  writeFileSync(join(folder, 'native', 'net-helper', 'ENGINE_COMMIT'), `${pinned}\n`)
  return { source, pinned, later }
}

function build(source: string): string {
  const out = spawnSync(process.execPath, [join(source, '..', '..', '..', 'scripts', 'build-net-helper.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, MOUSSE_NET_REPO: join(root, 'no-such-repo'), CARGO_TARGET_DIR: join(root, 'cargo') }
  })
  return `${out.stdout}${out.stderr}`
}

// Inputs: what the source checkout holds when a build starts.
const rows: Array<{
  state: string
  prepare: (source: string) => string
  stops: boolean
}> = [
  { state: 'an untracked file (a signed check result)', prepare: (s) => file(s, 'checks/results/r.json'), stops: true },
  {
    state: 'an edited tracked file',
    prepare: (s) => {
      writeFileSync(join(s, 'kept.txt'), 'edited\n')
      return join(s, 'kept.txt')
    },
    stops: true
  },
  {
    state: 'a staged new file',
    prepare: (s) => {
      const path = file(s, 'staged.txt')
      git(s, 'add', 'staged.txt')
      return path
    },
    stops: true
  },
  { state: 'only an ignored file (build output)', prepare: (s) => file(s, 'target/out.bin'), stops: false },
  { state: 'nothing extra', prepare: (s) => join(s, 'kept.txt'), stops: false }
]

function file(source: string, relative: string): string {
  const path = join(source, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, 'someone\'s work\n')
  return path
}

describe('the net helper build and its source checkout', () => {
  it.each(rows.map((row, index) => [row.state, index] as const))('with %s', (_state, index) => {
    const row = rows[index]
    const { source, pinned, later } = project(`case-${index}`)
    const path = row.prepare(source)
    const before = readFileSync(path, 'utf8')

    const output = build(source)

    expect(existsSync(path)).toBe(true)
    expect(git(source, 'remote', 'get-url', 'origin')).toBe('https://example.invalid/own-remote.git')
    if (row.stops) {
      expect(output).toMatch(/changed or untracked file/)
      expect(git(source, 'rev-parse', 'HEAD')).toBe(later)
      expect(readFileSync(path, 'utf8')).toBe(before)
    } else {
      expect(output).not.toMatch(/changed or untracked file/)
      expect(git(source, 'rev-parse', 'HEAD')).toBe(pinned)
    }
  })
})
