import { createHash } from 'node:crypto'

/**
 * The commands a notice shows to bring a kept or preserved file back, run in the repository's top folder.
 *
 * Each writes Git's bytes straight into the file through the shell, so nothing between Git and the disk changes them:
 * - `git cat-file blob <ref>:<path>` for a ref that holds the bytes as they were on disk (a kept copy, or files a restore
 *   preserved). `git restore` would run them through line-ending conversion and filters a second time.
 * - `git cat-file --filters <ref>:<path>` for a ref that holds Git's normal form of the file (a snapshot), which Git
 *   converts back as a checkout would.
 *
 * POSIX shells: one subshell, so nothing of it stays in the person's shell, that stops at the first step that fails.
 * 1. No folder above the path is a link (`[ ! -L ./a ]` for each): a command never writes outside the folders it names.
 *    Folders above it that are gone (one the abort removed with the file) are then made again (`mkdir -p`).
 * 2. A folder at the path, not a link to one, stops the command before it writes anything
 *    (`{ [ -L ./p ] || [ ! -d ./p ]; }`).
 * 3. The bytes go to `<path>.mousse-<8 hex>` first, a name fixed by the ref and path. `set -C` makes `exec 3>` create
 *    it or refuse a name already taken, so a refused run touches no one else's file; Git then writes through that
 *    descriptor. A copy that is gone, or a folder that cannot be written, stops the command with nothing at the path
 *    changed. Once the temporary file is this run's, any step that fails removes it, so running the command again works.
 * 4. `rm -f` then removes what stands at the path, a link itself and never what it points to, and `mv` puts the bytes
 *    there. A kept link comes back as a link with its exact target (`ln -s --`, the target read with a sentinel so
 *    trailing newlines survive, and `rm -f` refusing a folder), an executable file with `chmod +x`.
 *
 * Windows: `cmd --% /c git cat-file blob <ref>:<path> > <path>`, one command typed the same into cmd and into
 * PowerShell: PowerShell passes everything after `--%` to cmd as it is, and cmd reads only its `/c`. Windows PowerShell
 * 5.1's own `>` would re-encode the bytes as UTF-16, and it refuses `&&` even after `--%`, so no step can be chained to
 * it. That line writes through a file link standing at the path or a link above it (Windows makes links only with
 * Developer Mode or as an administrator, and Git for Windows checks links out as plain files unless told to), and a copy
 * that is gone leaves the file empty. A kept link is not made again there: its command prints where it pointed.
 * Paths are quoted for each shell: single quotes for POSIX shells; double quotes, with `%` left outside them, for cmd.
 */

export type RestoreShell = 'posix' | 'windows'

/** The shell a person on this computer runs the command in. */
export function restoreShell(platform: NodeJS.Platform = process.platform): RestoreShell {
  return platform === 'win32' ? 'windows' : 'posix'
}

export interface RestoreCommandOptions {
  /** The ref holds Git's normal form, which is converted back as a checkout would (`--filters`). */
  normalized?: boolean
  shell?: RestoreShell
  /** What the kept entry is: a file (the default), an executable file, or a link. */
  kind?: RestoreKind
}

export type RestoreKind = 'file' | 'executable' | 'link'

/** The kind a tree entry's mode stands for. */
export function restoreKindOf(mode: string | undefined): RestoreKind {
  return mode === '120000' ? 'link' : mode === '100755' ? 'executable' : 'file'
}

/** How many files a notice gives a command for; the rest are told to use the same command. */
export const RESTORE_COMMANDS_SHOWN = 5

/** A word of a POSIX shell command, in single quotes only when it needs them. */
function posixWord(value: string): string {
  return /^[\w./@:+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * A word as cmd and the C runtime read it, in double quotes only when it needs them. Windows paths cannot hold `"`.
 * A `%` is left outside the quotes so that cmd and PowerShell never read `%name%` as a variable: what follows it
 * starts with a quote, which no variable's name does.
 */
function windowsWord(value: string): string {
  return /^[\w./:@+-]+$/.test(value) ? value : `"${value.replaceAll('%', '"%"')}"`
}

/** The folders above `path`, outermost first: `a`, `a/b` for `a/b/c`. */
function parentsOf(path: string): string[] {
  const parents: string[] = []
  for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) parents.push(path.slice(0, slash))
  return parents
}

function command(ref: string, path: string, options: RestoreCommandOptions, placeholder: boolean): string {
  const shell = options.shell ?? restoreShell()
  const kind = options.normalized ? '--filters' : 'blob'
  if (shell === 'windows') {
    const word = placeholder ? (value: string) => value : windowsWord
    const source = `git cat-file ${kind} ${word(`${ref}:${path}`)}`
    if (options.kind === 'link') return `${source} (${path} was a link; this prints where it pointed)`
    return `cmd --% /c ${source} > ${word(path)}`
  }
  const word = placeholder ? (value: string) => value : posixWord
  const at = (rel: string): string => `./${word(rel)}`
  const source = `git cat-file ${kind} ${word(`${ref}:${path}`)}`
  const parents = placeholder ? [] : parentsOf(path)
  // No folder above is a link; then the ones that are gone (a folder the abort removed) are made again.
  const noLinkAbove = parents.map((parent) => `[ ! -L ${at(parent)} ]`)
  const makeParents = parents.length ? [`mkdir -p ${at(parents.at(-1)!)}`] : []
  if (options.kind === 'link') {
    return `(${[...noLinkAbove, ...makeParents, `t="$(${source} && printf x)"`, `rm -f ${at(path)}`, `ln -s -- "\${t%x}" ${at(path)}`].join(' && ')})`
  }
  const temporary = at(`${path}.mousse-${placeholder ? 'restore' : createHash('sha256').update(`${ref}:${path}`).digest('hex').slice(0, 8)}`)
  // Once this run has made the temporary file, a step that fails removes it again, so a stopped run leaves nothing.
  const steps = [`${source} >&3`, ...(options.kind === 'executable' ? [`chmod +x ${temporary}`] : []), `rm -f ${at(path)}`, `mv ${temporary} ${at(path)}`]
  return `(${[
    ...noLinkAbove,
    `{ [ -L ${at(path)} ] || [ ! -d ${at(path)} ]; }`,
    ...makeParents,
    'set -C',
    `exec 3> ${temporary}`,
    `{ ${steps.join(' && ')} || { rm -f ${temporary}; false; }; }`
  ].join(' && ')})`
}

/** The command that brings back one file kept under `ref`, run in the repository's top folder. */
export function restoreFileCommand(ref: string, path: string, options: RestoreCommandOptions = {}): string {
  return command(ref, path, options, false)
}

/** The command with `<path>` for the person to fill in. */
export function restoreCommandTemplate(ref: string, options: RestoreCommandOptions = {}): string {
  return command(ref, '<path>', options, true)
}

/** The command that puts a file's staged version kept as the second parent of `ref` back in the index. */
export function restoreStagedCommand(ref: string, shell: RestoreShell = restoreShell()): string {
  // cmd reads `^` outside quotes as an escape; PowerShell and cmd both keep it inside double quotes.
  return shell === 'windows' ? `git restore "--source=${ref}^2" --staged -- <path>` : `git restore --source=${ref}^2 --staged -- <path>`
}

/**
 * One command for each of the first {@link RESTORE_COMMANDS_SHOWN} files, and how many are left for the same command.
 */
export function restoreCommands<T extends { ref: string; path: string; kind?: RestoreKind; normalized?: boolean }>(files: readonly T[], options: RestoreCommandOptions = {}): { commands: string[]; rest: T[] } {
  return {
    commands: files.slice(0, RESTORE_COMMANDS_SHOWN).map((file) => restoreFileCommand(file.ref, file.path, { ...options, ...(file.kind ? { kind: file.kind } : {}), ...(file.normalized !== undefined ? { normalized: file.normalized } : {}) })),
    rest: files.slice(RESTORE_COMMANDS_SHOWN)
  }
}

/** The commands for `files` joined for a line of text: `a; b, and the same way for the other 3`. */
export function restoreCommandsText(files: ReadonlyArray<{ ref: string; path: string; kind?: RestoreKind; normalized?: boolean }>, options: RestoreCommandOptions = {}): string {
  const { commands, rest } = restoreCommands(files, options)
  return commands.join('; ') + (rest.length ? `, and the same way for the other ${rest.length}` : '')
}
