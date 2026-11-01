import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Source scans for the central Git check: Git and `gh` start only from files that run the check, and the
 * commands that can delete what nothing else keeps never appear in Mousse's code.
 */

const ROOT = join(__dirname, '..')

/** Every file that starts `git` itself, and how it reaches the central check. */
const APPROVED_GIT_SPAWNERS: Record<string, string> = {
  'src/mms/actions/ReceiptRefReleaseService.ts': 'withoutRepoPrograms',
  'src/mms/actions/git.ts': 'withoutRepoPrograms',
  'src/mms/bridge/dispatch/git.ts': 'assertGitAllowed',
  'src/mms/files/WorkspaceGrep.ts': 'withoutRepoPrograms',
  'src/mms/files/WorkspaceIndex.ts': 'withoutRepoPrograms',
  'src/mms/files/gitControl.ts': 'assertGitAllowed',
  'src/mms/git/GitService.ts': 'withoutRepoPrograms',
  'src/mms/git/PullRequestThreadService.ts': 'withoutRepoPrograms',
  'src/mms/git/RepositoryIdentity.ts': 'withoutRepoPrograms',
  'src/mms/git/gitProcess.ts': 'callers pass withoutRepoPrograms',
  'src/mms/git/readOnlyGit.ts': 'withoutRepoPrograms',
  'src/mms/git/repoPrograms.ts': 'assertGitAllowed',
  'src/mms/git/reviewDiff.ts': 'withoutRepoPrograms',
  'src/mms/git/scopedRead.ts': 'assertGitAllowed',
  'src/mms/git/workingTreeStatus.ts': 'withoutRepoPrograms',
  'src/mms/lifecycle/WorktreeRetirementService.ts': 'withoutRepoPrograms',
  'src/mms/workspace/ThreadWorkspaceManager.ts': 'assertGitAllowed',
  'src/mms/workspace/WorkflowWorkspace.ts': 'withoutRepoPrograms',
  'src/mms/workspace/WorkspaceGcService.ts': 'withoutRepoPrograms',
  'src/mms/worktree/WorktreeManager.ts': 'policedSimpleGit'
}

/** The one place a `gh` process starts; everything else passes `'gh'` to an `ExecutableRunner`. */
const GH_SPAWNER = 'src/mms/git/ghRunner.ts'

const SPAWNERS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork', 'spawnGit', 'execFileAsync', 'nodeSpawn'])
/** Calls that take `'gh'` without starting it themselves: the runner checks it. */
const RUNNERS = new Set(['runExecutable', 'base', 'run', 'runner'])

function sources(dir: string): string[] {
  const found: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) found.push(...sources(path))
    else if (/\.(ts|tsx|mts)$/.test(name) && !name.endsWith('.d.ts')) found.push(path)
  }
  return found
}

interface Finding { file: string; line: number; text: string }

function scan(): { git: Map<string, Finding[]>; gh: Finding[]; banned: Finding[] } {
  const git = new Map<string, Finding[]>()
  const gh: Finding[] = []
  const banned: Finding[] = []
  for (const path of sources(join(ROOT, 'src'))) {
    const file = relative(ROOT, path).split('\\').join('/')
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
    const at = (node: ts.Node): Finding => ({ file, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: node.getText().slice(0, 120) })
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ''
        const first = node.arguments[0]
        const program = first && ts.isStringLiteralLike(first) ? first.text : null
        if ((SPAWNERS.has(callee) && program !== null && /^git(\.exe)?$/i.test(program)) || callee === 'simpleGit') git.set(file, [...(git.get(file) ?? []), at(node)])
        if (program !== null && /^gh(\.exe)?$/i.test(program) && !RUNNERS.has(callee)) gh.push(at(node))
      }
      if (ts.isArrayLiteralExpression(node)) {
        const words = node.elements.map((element) => (ts.isStringLiteralLike(element) ? element.text : null))
        words.forEach((word, index) => {
          const next = words[index + 1]
          if ((word === 'worktree' && next === 'prune') || (word === 'reflog' && (next === 'expire' || next === 'delete')) || word === 'gc' || word === 'prune') banned.push(at(node))
        })
      }
      if (ts.isStringLiteralLike(node) && /^git\s+(gc|prune|worktree\s+prune|reflog\s+expire)\b/.test(node.text)) banned.push(at(node))
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return { git, gh, banned }
}

describe('Git command sources', () => {
  const found = scan()

  it('starts git only from approved files', () => {
    const unapproved = [...found.git.entries()].filter(([file]) => !(file in APPROVED_GIT_SPAWNERS)).flatMap(([, findings]) => findings)
    expect(unapproved).toEqual([])
  })

  it('runs the central check in every approved file', () => {
    for (const [file, route] of Object.entries(APPROVED_GIT_SPAWNERS)) {
      const text = readFileSync(join(ROOT, file), 'utf8')
      if (route === 'callers pass withoutRepoPrograms') continue
      expect(text, file).toContain(route)
    }
    // The approved list has no stale entries.
    expect(Object.keys(APPROVED_GIT_SPAWNERS).filter((file) => !found.git.has(file))).toEqual([])
  })

  it('starts gh only from the checked runner', () => {
    expect(found.gh).toEqual([])
    const runner = readFileSync(join(ROOT, GH_SPAWNER), 'utf8')
    expect(runner).toContain("assertGitAllowed({ executable: 'gh'")
  })

  it('never runs gc, prune, worktree prune or reflog expire', () => {
    expect(found.banned).toEqual([])
  })

  it('imports the Git process runner only where its callers guard the arguments', () => {
    const importers = sources(join(ROOT, 'src'))
      .filter((path) => /import\s*\{[^}]*\brunGit\b[^}]*\}\s*from\s*'[^']*gitProcess'/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(ROOT, path).split('\\').join('/'))
      .filter((file) => !file.endsWith('gitProcess.ts'))
    expect(importers).toEqual(['src/mms/git/GitService.ts'])
  })
})
