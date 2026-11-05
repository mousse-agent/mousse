/**
 * A restore from snapshots without exact bytes (taken before snapshots recorded them; `snapshotExactBytes.test.ts`
 * covers those that do) writes files in Git's form. Bytes on disk that Git counts as
 * unchanged but would not write back (CRLF under `core.autocrlf=input`, LF under `true`, an `eol`, `crlf` or encoding
 * attribute) are held by no snapshot. For those files Mousse proves each one held or kept right before it removes it,
 * and Git only creates: a save that lands at any point is kept or left as it is, never written over. A repository
 * that converts nothing compares nothing and keeps nothing extra.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { build } from 'esbuild'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConversationBranchService } from '../src/mms/actions/ConversationBranchService'
import { exactBytesNotice, moveFilesAsync, recordExactTrees, takeSnapshotAsync } from '../src/mms/actions/snapshots'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { UndoService } from '../src/mms/actions/UndoService'
import { ThreadJournal } from '../src/mms/data/ThreadJournal'
import { trustRepositoryPrograms } from '../src/mms/git/repoPrograms'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { actionOptions, CRASH_CHILD_REQUIRE, git, gitFoundationFixture } from './fixtures/gitFoundation'
import { pressed } from './support/userRequest'

let f: ReturnType<typeof gitFoundationFixture>
let cwd: string
let previousPath: string | undefined
beforeEach(() => {
  f = gitFoundationFixture()
  cwd = f.repo
  previousPath = process.env.PATH
  recordExactTrees(false)
})
afterEach(() => {
  recordExactTrees(true)
  process.env.PATH = previousPath
  f.dispose()
})

const bytes = (path: string): Buffer => readFileSync(join(cwd, path))
const keptRefs = (): string[] => git(cwd, 'for-each-ref', '--format=%(refname)', 'refs/mousse/preserved/').split('\n').filter(Boolean)
const keeps = () => new ThreadJournal(f.thread).list().filter((entry) => entry.operationType === 'restore-keep')
const refIn = (notice: string | undefined): string => /git cat-file blob '?(refs\/mousse\/preserved\/[^:\s']+):/.exec(notice ?? '')![1]!

/** Brings `path` back from the kept copy with the notice's command, into a scratch file, and returns the bytes it wrote. */
function restoreKept(ref: string, path: string): Buffer {
  const out = join(f.root, 'restored')
  execFileSync('sh', ['-c', `git cat-file blob '${ref}:${path}' > '${out}'`], { cwd })
  return readFileSync(out)
}

/** Whether some kept copy gives back exactly `value` for `path`. */
function keptSomewhere(value: Buffer, path = 'value.txt'): boolean {
  return keptRefs().some((ref) => { try { return restoreKept(ref, path).equals(value) } catch { return false } })
}

/** A turn that writes `value` to `path`, then Undo of it. */
async function undoTurnThatWrote(value: string | Buffer, path = 'value.txt', after?: () => void, inTurn = false) {
  const { action } = await new ThreadActionService(f.thread).runCheckpointedAction(actionOptions(cwd), () => { writeFileSync(join(cwd, path), value); if (inTurn) after?.() })
  if (!inTurn) after?.()
  const undone = await pressed('Undo', () => new UndoService(f.thread).undoLatest('main', cwd))
  return { action, undone }
}

/** A `git` first on PATH that runs `script` (sh) on each Git command whose words match `pattern`, then the real Git. */
function gitLauncher(pattern: string, script: string, log?: string): void {
  const bin = join(f.root, 'bin')
  mkdirSync(bin, { recursive: true })
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  writeFileSync(join(bin, 'git'), `#!/bin/sh\n${log ? `printf '%s\\n' "$*" >> '${log}'\n` : ''}case " $* " in\n  ${pattern}) ${script} ;;\nesac\nexec '${real}' "$@"\n`)
  chmodSync(join(bin, 'git'), 0o755)
  process.env.PATH = `${bin}:${previousPath}`
}

/** Git's form of `text` written at `path` (its blob run through the checkout conversion). */
function gitsForm(text: string, path = 'value.txt'): Buffer {
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd, input: text, encoding: 'utf8' }).trim()
  return execFileSync('git', ['cat-file', '--filters', `--path=${path}`, blob], { cwd })
}

/** Commits `.gitattributes` holding `line`, then value.txt as `value()` gives it under those attributes. */
function commitAttributes(line: string, value?: () => Buffer): void {
  writeFileSync(join(cwd, '.gitattributes'), `${line}\n`)
  git(cwd, 'add', '.gitattributes'); git(cwd, 'commit', '-qm', 'attributes')
  if (value) { writeFileSync(join(cwd, 'value.txt'), value()); git(cwd, 'add', 'value.txt'); git(cwd, 'commit', '-qm', 'value', '--allow-empty') }
}

describe('a restore keeps bytes on disk that Git would not write back', { timeout: 60_000 }, () => {
  it('Undo under autocrlf=input keeps the CRLF file it writes over, and the copy brings back its exact bytes (N5)', async () => {
    git(cwd, 'config', 'core.autocrlf', 'input')
    const agent = 'agent replacement\r\n'
    const { undone } = await undoTurnThatWrote(agent)
    expect(bytes('value.txt').toString()).toBe('base\n')
    expect(undone.notice).toMatch(new RegExp(`^Kept value\\.txt exactly as it was on disk for 30 days; Git writes it with other line endings or encoding\\. Bring it back by running this in ${cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: \\(.*git cat-file blob refs/mousse/preserved/\\S+:value\\.txt .*\\)\\.$`))
    // The notice's own command, run where it says, writes the kept bytes back.
    execFileSync('sh', ['-c', /running this in .*?: (\(.*\))\.$/.exec(undone.notice!)![1]!], { cwd })
    expect(bytes('value.txt').equals(Buffer.from(agent))).toBe(true)
    expect(keeps().map((entry) => entry.state)).toEqual(['prepared', 'completed'])
    expect(restoreKept(refIn(undone.notice), 'value.txt').equals(Buffer.from(agent))).toBe(true)
  })

  it('Undo under autocrlf=true keeps the LF file it writes over as CRLF (N5)', async () => {
    git(cwd, 'config', 'core.autocrlf', 'true')
    const agent = 'agent replacement\n'
    const { undone } = await undoTurnThatWrote(agent)
    expect(bytes('value.txt').toString()).toBe('base\r\n')
    expect(restoreKept(refIn(undone.notice), 'value.txt').equals(Buffer.from(agent))).toBe(true)
  })

  it('an eol attribute alone, with no autocrlf, is a conversion too', async () => {
    commitAttributes('value.txt text eol=crlf')
    const agent = 'agent replacement\n'
    const { undone } = await undoTurnThatWrote(agent)
    expect(bytes('value.txt').toString()).toBe('base\r\n')
    expect(restoreKept(refIn(undone.notice), 'value.txt').equals(Buffer.from(agent))).toBe(true)
  })

  it('the legacy crlf attribute, which Git still reads as text, is a conversion too', async () => {
    commitAttributes('value.txt crlf')
    const agent = 'agent replacement\r\n'
    const { undone } = await undoTurnThatWrote(agent)
    expect(bytes('value.txt').toString()).toBe('base\n')
    expect(restoreKept(refIn(undone.notice), 'value.txt').equals(Buffer.from(agent))).toBe(true)
  })

  it('a path starting with a space is compared under its own attributes, not those of the path without it', async () => {
    git(cwd, 'config', 'core.autocrlf', 'input')
    writeFileSync(join(cwd, ' x'), 'base\n'); commitAttributes('x eol=crlf')
    // A path that sorts first, so ' x' is not the first line of any listing (whose leading space a trim would lose).
    writeFileSync(join(cwd, '\tfirst'), 'first\n')
    git(cwd, 'add', ' x', '\tfirst'); git(cwd, 'commit', '-qm', 'leading space')
    const agent = 'agent replacement\r\n'
    const { undone } = await undoTurnThatWrote(agent, ' x')
    expect(bytes(' x').toString()).toBe('base\n')
    expect(undone.notice).toMatch(/^Kept {2}x exactly as it was on disk/)
    expect(restoreKept(refIn(undone.notice), ' x').equals(Buffer.from(agent))).toBe(true)
  })

  it('a conversation switch keeps the CRLF edit it brings along, exactly as typed (N5B)', async () => {
    git(cwd, 'config', 'core.autocrlf', 'input')
    const middle = 'context a\ncontext b\ncontext c\ncontext d\ncontext e\n'
    writeFileSync(join(cwd, 'value.txt'), `start\n${middle}line2\n`); git(cwd, 'add', 'value.txt'); git(cwd, 'commit', '-qm', 'two lines')
    await new ThreadWorkspaceManager(f.thread).ensureProjectFolder('task', 'main', cwd)
    const actions = new ThreadActionService(f.thread)
    const branches = new ConversationBranchService(f.thread)
    const { action } = await actions.runCheckpointedAction(actionOptions(cwd, 'first'), () => writeFileSync(join(cwd, 'value.txt'), `fork\n${middle}line2\n`))
    await actions.runCheckpointedAction(actionOptions(cwd, 'second'), () => writeFileSync(join(cwd, 'value.txt'), `main\n${middle}line2\n`))
    const fork = await branches.fork(cwd, 'main', action.id, 'Older')
    const typed = `main\n${middle}personal WIP\n`.replaceAll('\n', '\r\n')
    writeFileSync(join(cwd, 'value.txt'), typed)
    const switched = await pressed('Switch conversation branch', () => branches.activate(cwd, fork.id))
    expect(bytes('value.txt').toString()).toBe(`fork\n${middle}personal WIP\n`)
    expect(switched.notice).toContain('Kept value.txt exactly as it was on disk')
    expect(restoreKept(refIn(switched.notice), 'value.txt').equals(Buffer.from(typed))).toBe(true)
  })

  it('a repository that converts nothing compares nothing and keeps no copy', async () => {
    const log = join(f.root, 'git.log')
    gitLauncher('*" cat-file "*', ':', log)
    const { undone } = await undoTurnThatWrote('agent replacement\r\n')
    expect(bytes('value.txt').toString()).toBe('base\n')
    expect(undone.notice).toBeUndefined()
    expect(keeps()).toEqual([])
    expect(keptRefs()).toEqual([])
    const commands = readFileSync(log, 'utf8')
    expect(commands).toContain('read-tree -m -u')
    expect(commands).not.toContain('--filters')
  })

  it('core.eol alone converts nothing, so it compares nothing either', async () => {
    git(cwd, 'config', 'core.eol', 'crlf')
    const log = join(f.root, 'git.log')
    gitLauncher('*" cat-file "*', ':', log)
    const { undone } = await undoTurnThatWrote('agent replacement\n')
    expect(bytes('value.txt').toString()).toBe('base\n')
    expect(undone.notice).toBeUndefined()
    expect(keptRefs()).toEqual([])
    expect(readFileSync(log, 'utf8')).not.toContain('--filters')
  })

  const late = [
    {
      name: 'a same-second, same-size save that only moves a CR',
      setup: () => git(cwd, 'config', 'core.autocrlf', 'input'),
      first: () => Buffer.from('agent\r\nreplacement\n'),
      late: () => Buffer.from('agent\nreplacement\r\n'),
      restored: () => Buffer.from('base\n')
    },
    {
      name: 'a same-second, same-size save that flips UTF-16 byte order',
      setup: () => commitAttributes('value.txt text working-tree-encoding=UTF-16', () => gitsForm('base\n')),
      first: () => gitsForm('agent replacement\n'),
      late: () => Buffer.from(gitsForm('agent replacement\n')).swap16(),
      restored: () => gitsForm('base\n')
    }
  ]
  it.each(late)('$name after the check is kept, not written over', async (probe) => {
    // Git's own check misses this save: same size, its time put back, change time not trusted, in the racy second.
    git(cwd, 'config', 'core.checkStat', 'minimal')
    git(cwd, 'config', 'core.trustctime', 'false')
    probe.setup()
    const first = probe.first()
    const later = probe.late()
    expect(later.length).toBe(first.length)
    const script = join(f.root, 'late.py')
    writeFileSync(script, `import os\np=${JSON.stringify(join(cwd, 'value.txt'))}\ns=os.stat(p)\nopen(p,'wb').write(bytes.fromhex(${JSON.stringify(later.toString('hex'))}))\nos.utime(p,ns=(s.st_atime_ns,s.st_mtime_ns))\n`)
    const { undone } = await undoTurnThatWrote(first, 'value.txt', () => {
      const future = new Date(Date.now() + 3_600_000)
      utimesSync(join(cwd, 'value.txt'), future, future)
      gitLauncher('*" read-tree -m -u "*', `python3 '${script}'`)
    })
    expect(bytes('value.txt').equals(probe.restored())).toBe(true)
    expect(undone.notice).toContain('Kept value.txt exactly')
    expect(keptSomewhere(later)).toBe(true)
  })

  it('a save made while Git writes the other files is not written over', async () => {
    const trigger = join(f.root, 'trigger'), script = join(f.root, 'smudge.sh')
    const raw = Buffer.from('unique late raw\r\n')
    writeFileSync(join(cwd, '.gitattributes'), 'a.txt filter=review\n')
    writeFileSync(script, `#!/bin/sh\nif [ -e '${trigger}' ]; then printf 'unique late raw\\r\\n' > '${join(cwd, 'value.txt')}'; fi\ncat\n`); chmodSync(script, 0o755)
    git(cwd, 'config', 'filter.review.clean', 'cat'); git(cwd, 'config', 'filter.review.smudge', script); trustRepositoryPrograms(cwd)
    writeFileSync(join(cwd, 'a.txt'), 'a target\n'); writeFileSync(join(cwd, 'value.txt'), 'target\n')
    const to = (await takeSnapshotAsync(cwd, { reason: 'target' })).tree
    writeFileSync(join(cwd, 'a.txt'), 'a source\n'); writeFileSync(join(cwd, 'value.txt'), 'base\n')
    const from = (await takeSnapshotAsync(cwd, { reason: 'source' })).tree
    gitLauncher('*" read-tree -m -u "*', `: > '${trigger}'`)
    await pressed('Undo', () => moveFilesAsync(cwd, from, to, undefined, { owner: f.thread, action: 'Undo' }))
    expect(bytes('a.txt').toString()).toBe('a target\n')
    expect(bytes('value.txt').equals(raw) || keptSomewhere(raw)).toBe(true)
  })

  it('a converted file whose bytes hold the random record marker is kept, never taken as held', async () => {
    const script = join(f.root, 'smudge.py')
    writeFileSync(script, `import sys,os\nb=sys.stdin.buffer.read().lower()\nsys.stdout.buffer.write(b)\nmarker=os.environ.get('PROBE_MARKER')\nif marker: sys.stdout.buffer.write(b'\\n'+marker.encode()+b' '+b'0'*40+b'\\n\\x00binary tail')\nelse: sys.stdout.buffer.write(b'\\x00different smudge suffix')\n`)
    writeFileSync(join(cwd, '.gitattributes'), 'value.txt filter=review\n')
    git(cwd, 'config', 'filter.review.clean', 'tr a-z A-Z'); git(cwd, 'config', 'filter.review.smudge', `python3 '${script}'`); trustRepositoryPrograms(cwd)
    const raw = Buffer.from('original raw\n')
    writeFileSync(join(cwd, 'value.txt'), 'target\n')
    const to = (await takeSnapshotAsync(cwd, { reason: 'target' })).tree
    writeFileSync(join(cwd, 'value.txt'), raw)
    const from = (await takeSnapshotAsync(cwd, { reason: 'source' })).tree
    // The converted output is made to carry this run's own marker, as if by chance.
    gitLauncher('*" cat-file "*', `for word in "$@"; do case "$word" in --batch=mousse-*) PROBE_MARKER="\${word#--batch=}"; PROBE_MARKER="\${PROBE_MARKER%% *}"; export PROBE_MARKER;; esac; done`)
    const moved = await pressed('Undo', () => moveFilesAsync(cwd, from, to, undefined, { owner: f.thread, action: 'Undo' }))
    expect(moved.exact?.files.map((file) => file.path)).toEqual(['value.txt'])
    expect(restoreKept(moved.exact!.files[0]!.ref, 'value.txt').equals(raw)).toBe(true)
  })

  it('a file rewritten after its copy is kept is read and kept again before Git writes', async () => {
    git(cwd, 'config', 'core.autocrlf', 'input')
    const first = 'agent\r\nreplacement\n'
    const later = 'agent\nreplacement\r\n'
    const marker = join(f.root, 'late-write-done')
    // A save landing right after the first copy is recorded, before the restore's own write.
    gitLauncher(`*" update-ref "*refs/mousse/preserved/*`, `[ -e '${marker}' ] || { printf 'agent\\nreplacement\\r\\n' > '${join(cwd, 'value.txt')}'; : > '${marker}'; }`)
    const { undone } = await undoTurnThatWrote(first)
    expect(existsSync(marker)).toBe(true)
    expect(bytes('value.txt').toString()).toBe('base\n')
    expect(keeps().filter((entry) => entry.state === 'completed')).toHaveLength(2)
    expect(keptSomewhere(Buffer.from(first))).toBe(true)
    expect(keptSomewhere(Buffer.from(later))).toBe(true)
    expect(undone.notice).toContain('Kept value.txt exactly')
  })

  it('a file that keeps changing while it is written is left as it is and named, with every version kept', async () => {
    git(cwd, 'config', 'core.autocrlf', 'input')
    const a = 'agent\r\nreplacement\n', b = 'agent\nreplacement\r\n'
    const counter = join(f.root, 'rounds')
    // Every copy recorded is followed by another save with other line endings.
    gitLauncher(`*" update-ref "*refs/mousse/preserved/*`, `printf x >> '${counter}'; if [ $(wc -c < '${counter}') -eq 2 ]; then printf 'agent\\r\\nreplacement\\n' > '${join(cwd, 'value.txt')}'; else printf 'agent\\nreplacement\\r\\n' > '${join(cwd, 'value.txt')}'; fi`)
    const { undone } = await undoTurnThatWrote(a)
    expect(readFileSync(counter, 'utf8')).toBe('xxx')
    expect(bytes('value.txt').toString()).toBe(b)
    expect(undone.notice).toContain('Left as it is: value.txt (changed while the restore was writing it).')
    expect(keptSomewhere(Buffer.from(a))).toBe(true)
    expect(keptSomewhere(Buffer.from(b))).toBe(true)
  })

  it('the notice stays short however many files it keeps', () => {
    const ref = 'refs/mousse/preserved/0f0e0d0c-1b2a-4c3d-8e9f-a0b1c2d3e4f5-0123456789ab'
    const files = Array.from({ length: 40 }, (_, index) => ({ path: `src/module-${index}.ts`, ref }))
    const notice = exactBytesNotice({ files, top: '/work/app', windowMs: 30 * 24 * 3_600_000 }, 'posix')
    expect(notice).toMatch(/^Kept src\/module-0\.ts, src\/module-1\.ts, src\/module-2\.ts and 37 more exactly as they were on disk for 30 days; Git writes them with other line endings or encoding\. Bring one back by running this in \/work\/app: \(.*git cat-file blob refs\/mousse\/preserved\/\S+:src\/module-0\.ts .*\), and the same way for the others\.$/)
    // Three names and one command, however many files: 400 files read as long as 4.
    const few = exactBytesNotice({ files: files.slice(0, 4), top: '/work/app', windowMs: 30 * 24 * 3_600_000 }, 'posix')
    const many = exactBytesNotice({ files: Array.from({ length: 400 }, (_, index) => ({ path: `src/module-${index}.ts`, ref })), top: '/work/app', windowMs: 30 * 24 * 3_600_000 }, 'posix')
    expect(many.length - few.length).toBeLessThanOrEqual(2)
  })
})

describe('removing converted files and writing them again leaves the folder as Git would', { timeout: 60_000 }, () => {
  it('a folder whose every file is restored keeps its identity, so a program working in it still is', async () => {
    git(cwd, 'config', 'core.autocrlf', 'input')
    mkdirSync(join(cwd, 'docs')); writeFileSync(join(cwd, 'docs', 'a.md'), 'a\n')
    git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', 'docs')
    const folder = statSync(join(cwd, 'docs')).ino
    await undoTurnThatWrote('agent\r\n', 'docs/a.md')
    expect(bytes('docs/a.md').toString()).toBe('a\n')
    expect(statSync(join(cwd, 'docs')).ino).toBe(folder)
  })

  it('a case-only rename between the two trees writes the new spelling on a disk that folds case', async () => {
    git(cwd, 'config', 'core.autocrlf', 'input')
    // Git sets this when it finds the disk folds case, as macOS and Windows disks do by default.
    // Unset on a disk that keeps case, where `git config` would exit 1 without the default.
    if (git(cwd, 'config', '--bool', '--default', 'false', 'core.ignorecase') !== 'true') return
    writeFileSync(join(cwd, 'Readme.md'), 'hello\n')
    git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', 'readme')
    const to = git(cwd, 'rev-parse', 'HEAD^{tree}')
    git(cwd, 'mv', 'Readme.md', 'README.md'); git(cwd, 'commit', '-qm', 'rename')
    const from = (await takeSnapshotAsync(cwd, { reason: 'before' })).tree
    const moved = await pressed('Undo', () => moveFilesAsync(cwd, from, to, undefined, { owner: f.thread, action: 'Undo' }))
    expect(readdirSync(cwd).filter((name) => name.toLowerCase() === 'readme.md')).toEqual(['Readme.md'])
    expect(bytes('Readme.md').toString()).toBe('hello\n')
    expect(moved.leftAsIs).toBeUndefined()
  })

  it('a folder that goes back to being a file is written, and the ignored file inside it is kept first', async () => {
    git(cwd, 'config', 'core.autocrlf', 'input')
    writeFileSync(join(cwd, '.gitignore'), '*.log\n')
    writeFileSync(join(cwd, 'd'), 'was a file\n')
    git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', 'd file')
    const { undone } = await undoTurnThatWrote('', 'unused.txt', () => {
      unlinkSync(join(cwd, 'unused.txt'))
      unlinkSync(join(cwd, 'd')); mkdirSync(join(cwd, 'd'))
      writeFileSync(join(cwd, 'd', 'x.txt'), 'agent\r\n')
      writeFileSync(join(cwd, 'd', 'out.log'), 'build output\n')
    }, true)
    expect(lstatSync(join(cwd, 'd')).isFile()).toBe(true)
    expect(bytes('d').toString()).toBe('was a file\n')
    expect(undone.notice ?? '').not.toContain('Left as it is')
    expect(keptSomewhere(Buffer.from('build output\n'), 'd/out.log')).toBe(true)
    expect(keptSomewhere(Buffer.from('agent\r\n'), 'd/x.txt')).toBe(true)
  })

  it('a stop between removing a converted file and Git writing it is a partial restore for a person, never cancelled', async () => {
    git(cwd, 'config', 'core.autocrlf', 'input')
    const actions = new ThreadActionService(f.thread)
    await actions.runCheckpointedAction(actionOptions(cwd), () => writeFileSync(join(cwd, 'value.txt'), 'agent\r\n'))
    const entry = join(f.root, 'crash.ts'), bundle = join(f.root, 'crash.mjs'), project = process.cwd()
    // The child takes its snapshots as this file's do: without exact trees.
    writeFileSync(entry, `import { UndoService } from '${project}/src/mms/actions/UndoService'; import { recordExactTrees } from '${project}/src/mms/actions/snapshots'; import { pressed } from '${project}/tests/support/userRequest'; recordExactTrees(false); await pressed('Undo', () => new UndoService(${JSON.stringify(f.thread)}).undoLatest('main', ${JSON.stringify(cwd)}));`)
    await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', banner: { js: CRASH_CHILD_REQUIRE } })
    // The process stops as Git is about to write the new versions, after Mousse removed the old ones.
    gitLauncher('*" checkout-index "*', 'kill -KILL "$PPID"; exit 86')
    const child = spawnSync(process.execPath, [bundle], { env: { ...process.env, MOUSSE_HOME: f.home }, encoding: 'utf8', timeout: 30_000 })
    process.env.PATH = previousPath
    expect(child.signal, child.stderr).toBe('SIGKILL')
    expect(existsSync(join(cwd, 'value.txt'))).toBe(false)
    expect(keptSomewhere(Buffer.from('agent\r\n'))).toBe(true)
    await expect(new UndoService(f.thread).recoverPending(cwd, () => undefined)).rejects.toThrow(/neither the state before nor the state after/)
    expect([...new ThreadJournal(f.thread).latestByOperation().values()].find((record) => record.operationType === 'undo')?.state).toBe('prepared')
  })

  it('a path Git does not write, because a link appeared above it just before, is named', async () => {
    git(cwd, 'config', 'core.autocrlf', 'input')
    mkdirSync(join(cwd, 'folder'))
    const external = join(f.root, 'external'); mkdirSync(external); writeFileSync(join(external, 'child'), 'personal outside bytes\n')
    writeFileSync(join(cwd, 'folder', 'child'), 'target\n')
    const to = (await takeSnapshotAsync(cwd, { reason: 'target' })).tree
    writeFileSync(join(cwd, 'folder', 'child'), 'source\r\n')
    const from = (await takeSnapshotAsync(cwd, { reason: 'source' })).tree
    const folder = join(cwd, 'folder')
    // Whether the emptied folder is still there or not, a link stands in its place when Git starts to write.
    gitLauncher('*" checkout-index "*', `[ -L '${folder}' ] || { rmdir '${folder}' 2>/dev/null; ln -s '${external}' '${folder}'; }`)
    const moved = await pressed('Undo', () => moveFilesAsync(cwd, from, to, undefined, { owner: f.thread, action: 'Undo' }))
    process.env.PATH = previousPath
    expect(readFileSync(join(external, 'child'), 'utf8')).toBe('personal outside bytes\n')
    expect(lstatSync(folder).isSymbolicLink()).toBe(true)
    expect(moved.leftAsIs?.map((entry) => entry.path)).toEqual(['folder/child'])
    expect(keptSomewhere(Buffer.from('source\r\n'), 'folder/child')).toBe(true)
  })
})
