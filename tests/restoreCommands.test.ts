/**
 * Every command a notice shows to bring a kept or preserved file back is run here as a person would run it: typed into
 * the shell they use, in the folder the notice names. The file must come back with exactly the bytes it had, CRLF line
 * ends, UTF-16 and paths with spaces, quotes, `%`, `$` and a leading `-` included. On macOS and Linux that shell is sh
 * (and zsh and bash where present); on Windows it is cmd, Windows PowerShell 5.1 and PowerShell 7 where present.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { keepCopy, keptCopyNotice } from '../src/mms/actions/keptCopies'
import { legacyAbortRefAsync } from './support/legacyAbortRef'
import { restoreCommandTemplate, restoreFileCommand, restoreStagedCommand } from '../src/mms/actions/restoreCommands'
import { moveFilesAsync, preservedNotice, takeSnapshotAsync } from '../src/mms/actions/snapshots'
import { keptAsideNotice } from '../src/mms/lifecycle/WorktreeRetirementService'
import { pressed } from './support/userRequest'

const WINDOWS = process.platform === 'win32'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** A shell a person types the command into. Throws with what it printed when the command fails. */
interface Shell { name: string; run(command: string, cwd: string): void }

function present(program: string, args: string[]): boolean {
  return spawnSync(program, args, { stdio: 'ignore' }).status === 0
}

function checked(name: string, ran: ReturnType<typeof spawnSync>): void {
  if (ran.error || ran.status !== 0) throw new Error(`${name} failed (${ran.status}): ${ran.error?.message ?? ''}${String(ran.stderr ?? '')}${String(ran.stdout ?? '')}`)
}

function shells(): Shell[] {
  if (WINDOWS) {
    const comspec = process.env.ComSpec ?? 'cmd.exe'
    // The line exactly as typed at a cmd prompt: /s takes the outer quotes off and leaves the rest as it is.
    const cmd: Shell = { name: 'cmd', run: (command, cwd) => checked('cmd', spawnSync(comspec, ['/d', '/s', '/c', `"${command}"`], { cwd, windowsVerbatimArguments: true, encoding: 'utf8' })) }
    // The line exactly as typed at a PowerShell prompt; the exit code is the command's.
    const powershell = (program: string): Shell => ({
      name: program,
      run: (command, cwd) => checked(program, spawnSync(program, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`${command}\nexit $LASTEXITCODE`, 'utf16le').toString('base64')], { cwd, encoding: 'utf8' }))
    })
    return [cmd, powershell('powershell.exe'), ...(present('pwsh', ['-NoProfile', '-Command', 'exit 0']) ? [powershell('pwsh')] : [])]
  }
  const posix = (program: string): Shell => ({ name: program, run: (command, cwd) => checked(program, spawnSync(program, ['-c', command], { cwd, encoding: 'utf8' })) })
  return ['sh', 'zsh', 'bash'].filter((program) => program === 'sh' || present(program, ['-c', 'exit 0'])).map(posix)
}

/**
 * Paths a person's files really have. Windows names cannot hold `"`, and a backslash is a folder there; elsewhere they
 * can.
 */
const AWKWARD = WINDOWS
  ? ['kept/with space.txt', 'kept/-leading dash.txt', "kept/100%PATH% & (x) ^ $HOME 'it'.txt", 'kept/tick`.txt', 'kept/naïve.txt']
  : ['kept/with space.txt', 'kept/-leading dash.txt', "kept/100%PATH% & (x) ^ $HOME 'it'.txt", 'kept/tick`.txt', 'kept/naïve.txt', 'kept/"quoted" \\ back.txt']

/** Bytes that a shell's own redirection, a line-ending conversion or a filter would change. */
const CONTENTS: Record<string, Buffer> = {
  'kept/crlf file.txt': Buffer.from('one\r\ntwo\r\nno end'),
  // Attributes that convert on checkout: git restore would write CRLF and re-encode; the bytes kept are LF and UTF-8.
  'kept/filtered.crlf': Buffer.from('lf only\nsecond\n'),
  'kept/encoded.utf16': Buffer.from('plain utf-8 here\n'),
  // UTF-16 with a byte order mark and CRLF: Windows PowerShell 5.1's `>` would decode and re-encode it.
  'kept/utf16 file.txt': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('café\r\n☃\r\n', 'utf16le')]),
  'kept/binary.bin': Buffer.from([0, 255, 13, 10, 26, 128, 0x1b, 37, 0]),
  ...Object.fromEntries(AWKWARD.map((path, index) => [path, Buffer.from(`awkward ${index}\r\né\n`)]))
}

function repo(): string {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-restore-cmd-'))); roots.push(cwd)
  git(cwd, 'init', '-q', '-b', 'main')
  git(cwd, 'config', 'user.name', 'Restore command test'); git(cwd, 'config', 'user.email', 'restore@example.invalid')
  git(cwd, 'config', 'commit.gpgsign', 'false'); git(cwd, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(cwd, '.gitattributes'), '*.crlf text eol=crlf\n*.utf16 text working-tree-encoding=UTF-16LE-BOM eol=crlf\n')
  writeFileSync(join(cwd, 'base.txt'), 'base\n')
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base')
  return cwd
}

function owner(): string {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-restore-owner-'))); roots.push(folder)
  return folder
}

function writeAll(cwd: string, files: Record<string, Buffer>): void {
  for (const [path, bytes] of Object.entries(files)) { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), bytes) }
}

/**
 * Runs `commands[path]` in each shell, in `top`, after the file is removed, and compares what it wrote with `expected`.
 */
function expectRestored(top: string, commands: Record<string, string>, expected: Record<string, Buffer>): void {
  for (const shell of shells()) {
    for (const [path, command] of Object.entries(commands)) {
      rmSync(join(top, path), { force: true })
      shell.run(command, top)
      expect({ shell: shell.name, path, bytes: [...readFileSync(join(top, path))] }).toEqual({ shell: shell.name, path, bytes: [...expected[path]!] })
    }
  }
}

describe('the command shown', () => {
  it('replaces what stands at the path, through cmd on Windows and straight into it elsewhere, quoting what needs it', () => {
    const ref = 'refs/mousse/preserved/op-0123456789ab'
    expect(restoreFileCommand(ref, 'src/a.txt', { shell: 'posix' })).toBe(`rm -f ./src/a.txt && git cat-file blob ${ref}:src/a.txt > ./src/a.txt`)
    expect(restoreFileCommand(ref, 'src/a.txt', { shell: 'windows' })).toBe(`cmd --% /c git cat-file blob ${ref}:src/a.txt > src/a.txt.mousse-restore && move /y "src\\a.txt.mousse-restore" "src\\a.txt" >nul`)
    expect(restoreFileCommand(ref, "it's 100%.txt", { shell: 'posix' })).toBe(`rm -f ./'it'\\''s 100%.txt' && git cat-file blob '${ref}:it'\\''s 100%.txt' > ./'it'\\''s 100%.txt'`)
    expect(restoreFileCommand(ref, 'a b %PATH%.txt', { shell: 'windows' })).toBe(`cmd --% /c git cat-file blob "${ref}:a b "%"PATH"%".txt" > "a b "%"PATH"%".txt.mousse-restore" && move /y "a b "%"PATH"%".txt.mousse-restore" "a b "%"PATH"%".txt" >nul`)
    expect(restoreFileCommand(ref, 'a.txt', { shell: 'posix', normalized: true })).toBe(`rm -f ./a.txt && git cat-file --filters ${ref}:a.txt > ./a.txt`)
    expect(restoreFileCommand(ref, 'bin/run', { shell: 'posix', kind: 'executable' })).toBe(`rm -f ./bin/run && git cat-file blob ${ref}:bin/run > ./bin/run && chmod +x ./bin/run`)
    expect(restoreFileCommand(ref, 'link', { shell: 'posix', kind: 'link' })).toBe(`rm -f ./link && ln -s "$(git cat-file blob ${ref}:link)" ./link`)
    expect(restoreFileCommand(ref, 'link', { shell: 'windows', kind: 'link' })).toBe(`git cat-file blob ${ref}:link (link was a link; this prints where it pointed)`)
    expect(restoreCommandTemplate(ref, { shell: 'windows' })).toBe(`cmd --% /c git cat-file blob ${ref}:<path> > <path>.mousse-restore && move /y <path>.mousse-restore <path> >nul`)
    expect(restoreCommandTemplate(ref, { shell: 'posix' })).toBe(`rm -f ./<path> && git cat-file blob ${ref}:<path> > ./<path>`)
    expect(restoreStagedCommand(ref, 'windows')).toBe(`git restore "--source=${ref}^2" --staged -- <path>`)
    expect(restoreStagedCommand(ref, 'posix')).toBe(`git restore --source=${ref}^2 --staged -- <path>`)
  })
})

describe('each notice\'s commands give back the exact bytes in the shells of this system', { timeout: 120_000 }, () => {
  it('Discard\'s kept copy: one command per file, five shown, and no staged command for files with nothing staged', async () => {
    const top = repo()
    writeAll(top, CONTENTS)
    const kept = await keepCopy({ owner: owner(), top, operationType: 'git-discard', action: 'Discard', paths: Object.keys(CONTENTS) })
    const notice = keptCopyNotice(kept)
    const paths = Object.keys(CONTENTS).sort()
    const commands = Object.fromEntries(paths.map((path) => [path, restoreFileCommand(kept.ref, path)]))
    expect(notice).toContain(`run in ${top}: ${paths.slice(0, 5).map((path) => commands[path]).join('; ')}, and the same way for the other ${paths.length - 5}.`)
    // The rest are told to do the same; each command, filled in as the notice would, brings its file back.
    expectRestored(top, commands, CONTENTS)
  })

  it('files an Undo found in its way: each one named with its command', async () => {
    const top = repo()
    writeFileSync(join(top, '.gitignore'), 'kept/\n'); git(top, 'add', '.gitignore'); git(top, 'commit', '-qm', 'ignore kept')
    const from = await takeSnapshotAsync(top, { reason: 'test' })
    // The target holds every path as a tracked file; on disk each is an ignored file no snapshot has.
    const index = join(top, '.git', 'restore-target.index')
    const env = { ...process.env, GIT_INDEX_FILE: index }
    execFileSync('git', ['read-tree', from.tree], { cwd: top, env })
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: top, input: 'from the snapshot\n', encoding: 'utf8' }).trim()
    execFileSync('git', ['update-index', '--add', '--index-info'], { cwd: top, env, input: Object.keys(CONTENTS).map((path) => `100644 ${blob}\t${path}`).join('\n') + '\n' })
    const to = execFileSync('git', ['write-tree'], { cwd: top, env, encoding: 'utf8' }).trim()
    rmSync(index)
    writeAll(top, CONTENTS)
    const preserved = (await pressed('Undo', () => moveFilesAsync(top, from.sha, to)))!
    expect(preserved.top).toBe(top)
    expect(readFileSync(join(top, 'kept/crlf file.txt'), 'utf8')).toBe('from the snapshot\n')
    const notice = preservedNotice(preserved, 24 * 60 * 60 * 1000)
    const commands = Object.fromEntries(preserved.paths.map((path) => [path, restoreFileCommand(preserved.ref, path)]))
    expect(notice).toContain(`Bring one back before then by running this in ${top}: ${preserved.paths.slice(0, 5).map((path) => commands[path]).join('; ')}, and the same way for the other ${preserved.paths.length - 5}.`)
    expectRestored(top, commands, CONTENTS)
  })

  it('files a rebuild set aside: each one in backticks with its command', async () => {
    const top = repo()
    writeAll(top, CONTENTS)
    const kept = await keepCopy({ owner: owner(), top, operationType: 'worktree-cleanup', action: 'Cleanup', paths: Object.keys(CONTENTS) })
    const paths = Object.keys(CONTENTS)
    const notice = keptAsideNotice({ worktreePath: top, keptAside: [{ ref: kept.ref, paths }] }, 24 * 60 * 60 * 1000)!
    const commands = Object.fromEntries(paths.map((path) => [path, restoreFileCommand(kept.ref, path)]))
    expect(notice.text).toContain(`running this in ${top}: ${paths.slice(0, 5).map((path) => `\`${commands[path]}\``).join('; ')}, and the same way for the other ${paths.length - 5} (listed under ${kept.ref})`)
    expectRestored(top, commands, CONTENTS)
  })

  it('an older version\'s abort copy, which holds snapshots\' normal form: converted back as a checkout would', async () => {
    const top = repo()
    // Files whose conversion round-trips: CRLF under eol=crlf, UTF-16 with a byte order mark under its encoding, and
    // files without attributes, kept as they are.
    const files: Record<string, Buffer> = {
      'kept/crlf file.crlf': Buffer.from('one\r\ntwo\r\n'),
      'kept/encoded file.utf16': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('café\r\n', 'utf16le')]),
      'kept/plain crlf.txt': Buffer.from('as is\r\n'),
      ...Object.fromEntries(AWKWARD.map((path, index) => [path, Buffer.from(`awkward ${index}\n`)]))
    }
    writeAll(top, files)
    const { ref, top: kept } = await legacyAbortRefAsync(top, 'op')
    // Git names the folder its own way (forward slashes on Windows); it is the same folder.
    expect(resolve(kept)).toBe(resolve(top))
    expect(git(top, 'cat-file', 'blob', `${ref}:kept/crlf file.crlf`)).toBe('one\ntwo')
    const commands = Object.fromEntries(Object.keys(files).map((path) => [path, restoreFileCommand(ref, path, { normalized: true })]))
    expectRestored(top, commands, files)
  })
})
