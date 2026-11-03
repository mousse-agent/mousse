/**
 * The commands a notice shows to bring a kept or preserved file back, run in the repository's top folder.
 *
 * Each writes Git's bytes straight into the file through the shell, so nothing between Git and the disk changes them:
 * - `git cat-file blob <ref>:<path> > <path>` for a ref that holds the bytes as they were on disk (a kept copy, or files
 *   a restore preserved). `git restore` would run them through line-ending conversion and filters a second time.
 * - `git cat-file --filters <ref>:<path> > <path>` for a ref that holds Git's normal form of the file (a snapshot), which
 *   Git converts back the way a checkout would.
 *
 * Windows PowerShell 5.1's `>` re-encodes a native command's output as UTF-16, so on Windows the redirection is cmd's:
 * `cmd --% /c git cat-file blob "<ref>:<path>" > "<path>"`. The same line works typed into cmd and into PowerShell:
 * PowerShell passes everything after `--%` to cmd as it is, and cmd reads only its `/c`. (`cmd /c "…"` cannot quote a
 * path with spaces so that both shells read it.) Elsewhere the command is for a POSIX shell, with paths in single quotes.
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

function command(ref: string, path: string, options: RestoreCommandOptions, placeholder: boolean): string {
  const shell = options.shell ?? restoreShell()
  const kind = options.normalized ? '--filters' : 'blob'
  if (shell === 'windows') {
    const word = placeholder ? (value: string) => value : windowsWord
    return `cmd --% /c git cat-file ${kind} ${word(`${ref}:${path}`)} > ${word(path)}`
  }
  const word = placeholder ? (value: string) => value : posixWord
  return `git cat-file ${kind} ${word(`${ref}:${path}`)} > ${word(path)}`
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
export function restoreCommands<T extends { ref: string; path: string }>(files: readonly T[], options: RestoreCommandOptions = {}): { commands: string[]; rest: T[] } {
  return {
    commands: files.slice(0, RESTORE_COMMANDS_SHOWN).map((file) => restoreFileCommand(file.ref, file.path, options)),
    rest: files.slice(RESTORE_COMMANDS_SHOWN)
  }
}

/** The commands for `files` joined for a line of text: `a; b, and the same way for the other 3`. */
export function restoreCommandsText(files: ReadonlyArray<{ ref: string; path: string }>, options: RestoreCommandOptions = {}): string {
  const { commands, rest } = restoreCommands(files, options)
  return commands.join('; ') + (rest.length ? `, and the same way for the other ${rest.length}` : '')
}
