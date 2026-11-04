import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

/** One `git worktree remove <path>` a test's code ran, and whether `<path>` was still there when it started. */
export interface WorktreeRemoveCall {
  path: string
  /** `<path>` existed (as a file, folder or link) right before Git would have run. */
  existed: boolean
  args: string[]
}

export interface GitRemoveGuard {
  /** The folder holding the `git` launcher, first on `PATH` while the guard is on. */
  readonly bin: string
  /** Every `git worktree remove` that ran, in order. */
  removes(): WorktreeRemoveCall[]
  /** Throws when any `git worktree remove <path>` ran while `<path>` existed. */
  assertNoRemoveOfExisting(): void
  /** Puts `PATH` back and deletes the launcher. */
  restore(): void
}

/**
 * Puts a `git` launcher first on `PATH` that records every `git worktree remove <path>`. Git only ever unregisters a
 * folder that is already gone (Mousse deletes worktree folders itself, against a proof), so a removal of a `<path>`
 * that still exists is refused here, with nothing run, and recorded: {@link GitRemoveGuard.assertNoRemoveOfExisting}
 * then fails the test. Every other Git command runs unchanged.
 *
 * `beforeRemove` is a shell snippet run right before each `worktree remove` is checked, the moment a writer could act
 * between Mousse's last look at the folder and Git's removal (for example, restoring a changed file).
 */
export function installGitRemoveGuard(options: { beforeRemove?: string } = {}): GitRemoveGuard {
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  if (!realGit) throw new Error('git is not on PATH')
  const bin = mkdtempSync(join(tmpdir(), 'git-remove-guard-'))
  const log = join(bin, 'removes.log')
  const script = `#!/bin/sh
previous=''
removing=''
target=''
for word in "$@"; do
  if [ -n "$removing" ]; then
    case "$word" in -*) ;; *) target="$word" ;; esac
  elif [ "$previous" = worktree ] && [ "$word" = remove ]; then
    removing=yes
  fi
  previous="$word"
done
if [ -n "$removing" ]; then
${options.beforeRemove ?? ':'}
  if [ -e "$target" ] || [ -L "$target" ]; then state=existed; else state=gone; fi
  printf '%s\\t%s\\t%s\\0' "$state" "$target" "$*" >> '${log}'
  if [ "$state" = existed ]; then
    echo "git-remove-guard: refused 'git worktree remove' of $target, which still exists" >&2
    exit 97
  fi
fi
exec '${realGit}' "$@"
`
  writeFileSync(join(bin, 'git'), script, { mode: 0o755 })
  const previousPath = process.env.PATH
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ''}`
  const removes = (): WorktreeRemoveCall[] => {
    if (!existsSync(log)) return []
    return readFileSync(log, 'utf8').split('\0').filter(Boolean).map((line) => {
      const [state, path, args] = line.split('\t')
      return { path: path ?? '', existed: state === 'existed', args: (args ?? '').split(' ') }
    })
  }
  return {
    bin,
    removes,
    assertNoRemoveOfExisting() {
      const existing = removes().filter((call) => call.existed)
      if (existing.length) throw new Error(`git worktree remove ran on a folder that still existed: ${existing.map((call) => call.path).join(', ')}`)
    },
    restore() {
      if (process.env.PATH?.startsWith(`${bin}${delimiter}`)) process.env.PATH = previousPath
      rmSync(bin, { recursive: true, force: true })
    }
  }
}
