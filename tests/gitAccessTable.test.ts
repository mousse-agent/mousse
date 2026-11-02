import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { GIT_ACCESS, gitAccessOf, USER_REQUEST_LABELS } from '../src/mms/protocol/gitAccess'
import { PROTOCOL_METHODS } from '../src/mms/protocol/types'

/** Each `case '<method>':` block of the protocol handlers, with the labels that share it. */
function handlerBlocks(): Map<string, string> {
  const lines = readFileSync(join(__dirname, '..', 'src', 'mms', 'protocol', 'handlers.ts'), 'utf8').split('\n')
  const label = /^(\s*)case '([^']+)':/
  const blocks = new Map<string, string>()
  for (let index = 0; index < lines.length; index++) {
    const first = label.exec(lines[index]!)
    if (!first) continue
    const labels = [first[2]!]
    let next = index + 1
    while (next < lines.length && label.test(lines[next]!)) labels.push(label.exec(lines[next++]!)![2]!)
    const indent = first[1]!
    let end = next
    while (end < lines.length && !lines[end]!.startsWith(`${indent}case '`) && !lines[end]!.startsWith(`${indent}default:`) && !lines[end]!.startsWith(`${indent.slice(2)}}`)) end++
    const body = lines.slice(index, end).join('\n')
    for (const name of labels) if (!blocks.has(name)) blocks.set(name, body)
    index = next - 1
  }
  return blocks
}

// ---------------------------------------------------------------------------------------------------------
// Following calls through services

const ROOT = join(__dirname, '..', 'src', 'mms')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sources(path) : /\.ts$/.test(name) && !name.endsWith('.d.ts') ? [path] : []
  })
}

/** Git subcommands that change something; a call whose argument list starts with one is a Git write. */
const WRITE_SUBCOMMANDS = new Set([
  'add', 'am', 'apply', 'branch', 'checkout', 'checkout-index', 'cherry-pick', 'clean', 'clone', 'commit', 'config', 'fetch', 'init', 'merge',
  'mv', 'pull', 'push', 'read-tree', 'rebase', 'remote', 'reset', 'restore', 'revert', 'rm', 'sparse-checkout', 'stash', 'switch', 'symbolic-ref',
  'tag', 'update-index', 'update-ref', 'worktree'
])

/**
 * The read forms of subcommands that can also write, told apart by their literal arguments: `config --get`,
 * `tag --list`, `remote` alone or `remote get-url`, `symbolic-ref` with one name. Anything else counts as a write.
 */
function readForm(subcommand: string, rest: readonly string[]): boolean {
  const positional = rest.filter((word) => !word.startsWith('-'))
  if (subcommand === 'config') return rest.some((word) => /^--(get|get-all|get-regexp|get-urlmatch|list|show-origin|show-scope)$|^-l$/.test(word)) || positional.length <= 1
  if (subcommand === 'tag') return rest.some((word) => /^(-l|--list|--contains|--points-at|--merged|--no-merged)$/.test(word)) || positional.length === 0
  if (subcommand === 'remote') return positional.length === 0 || ['get-url', 'show'].includes(positional[0]!)
  if (subcommand === 'symbolic-ref') return !rest.some((word) => /^(-d|--delete)$/.test(word)) && positional.length <= 1
  return false
}
/** Functions that run the Git command in their argument list. */
const RUNNERS = new Set(['git', 'gitRaw', 'tryGit', 'actionGit', 'lifecycleGit', 'workspaceGit', 'runGit', 'runLive', 'withoutRepoPrograms', 'raw'])
/** GitService and code host methods that change the repository or GitHub. */
const SERVICE_WRITES = /^(GitService\.(stage|stageAll|unstage|unstageAll|discard|fetch|pull|abortInProgress|init|createBranch|renameBranch|deleteBranch|checkout|commit|push)|CodeHost\.(createPullRequest|mergePullRequest|closePullRequest|fetchPullRequestHead|releasePullRequestHead)|GitHubService\.(createRepository|cloneRepository))$/

/** The callee a call expression names: `Class.method` where the class can be told, else the bare name. */
function calleeOf(call: ts.CallExpression, className: string | undefined, locals: Map<string, string>): string | null {
  const target = call.expression
  if (ts.isIdentifier(target)) return target.text
  if (!ts.isPropertyAccessExpression(target)) return null
  const name = target.name.text
  const owner = target.expression
  if (owner.kind === ts.SyntaxKind.ThisKeyword) return className ? `${className}.${name}` : name
  if (ts.isNewExpression(owner) && ts.isIdentifier(owner.expression)) return `${owner.expression.text}.${name}`
  if (ts.isParenthesizedExpression(owner) && ts.isNewExpression(owner.expression) && ts.isIdentifier(owner.expression.expression)) return `${owner.expression.expression.text}.${name}`
  if (ts.isIdentifier(owner) && locals.has(owner.text)) return `${locals.get(owner.text)}.${name}`
  const text = owner.getText()
  if (/\bgitService$/.test(text)) return `GitService.${name}`
  if (/\bcodeHost$/.test(text)) return `CodeHost.${name}`
  if (/\bgithub$/.test(text)) return `GitHubService.${name}`
  return name
}

/** Whether a call runs a Git write itself: a runner whose argument list starts with a write subcommand. */
function writesGit(call: ts.CallExpression, callee: string | null): boolean {
  if (!callee || !RUNNERS.has(callee.split('.').pop()!)) return false
  return call.arguments.some((argument) => {
    if (!ts.isArrayLiteralExpression(argument)) return false
    const elements = argument.elements.filter((element) => !ts.isSpreadElement(element))
    const first = elements[0]
    // Only literal words count; a word computed at run time (a key, a ref) is treated as a positional argument.
    const rest = elements.slice(1).map((element) => (ts.isStringLiteralLike(element) ? element.text : '<value>'))
    // A literal subcommand, or either branch of `a ? 'merge' : 'revert'`.
    const names = !first ? [] : ts.isConditionalExpression(first) ? [first.whenTrue, first.whenFalse] : [first]
    return names.some((name) => ts.isStringLiteralLike(name) && WRITE_SUBCOMMANDS.has(name.text) && !readForm(name.text, rest))
  })
}

interface Graph { calls: Map<string, Set<string>>; writes: Set<string> }

/** Every named function and method in `src/mms`, what it calls, and which run a Git write themselves. */
function callGraph(): Graph {
  const calls = new Map<string, Set<string>>()
  const writes = new Set<string>()
  for (const path of sources(ROOT)) {
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
    const record = (key: string, body: ts.Node, className: string | undefined): void => {
      const out = calls.get(key) ?? new Set<string>()
      calls.set(key, out)
      const locals = new Map<string, string>()
      const visit = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isNewExpression(node.initializer) && ts.isIdentifier(node.initializer.expression)) locals.set(node.name.text, node.initializer.expression.text)
        if (ts.isCallExpression(node)) {
          const callee = calleeOf(node, className, locals)
          if (callee) out.add(callee)
          if (writesGit(node, callee)) writes.add(key)
        }
        ts.forEachChild(node, visit)
      }
      visit(body)
    }
    const visit = (node: ts.Node, className?: string): void => {
      if (ts.isClassDeclaration(node) && node.name) {
        for (const member of node.members) {
          if ((ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member) || ts.isGetAccessor(member)) && member.name && ts.isIdentifier(member.name)) record(`${node.name.text}.${member.name.text}`, member, node.name.text)
        }
        return
      }
      if (ts.isFunctionDeclaration(node) && node.name) record(node.name.text, node, className)
      if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) record(declaration.name.text, declaration.initializer, className)
      }
      ts.forEachChild(node, (child) => visit(child, className))
    }
    visit(source)
  }
  return { calls, writes }
}

/** Every function or method that reaches a Git write or a changing GitService call, through any number of calls. */
function mutating(graph: Graph): Set<string> {
  const reached = new Set<string>(graph.writes)
  for (const key of graph.calls.keys()) if (SERVICE_WRITES.test(key)) reached.add(key)
  let grew = true
  while (grew) {
    grew = false
    for (const [key, callees] of graph.calls) {
      if (reached.has(key)) continue
      if ([...callees].some((callee) => reached.has(callee) || SERVICE_WRITES.test(callee))) {
        reached.add(key)
        grew = true
      }
    }
  }
  return reached
}

/** What each handler block calls, as `Class.method` or a bare function name. */
function handlerCalls(): Map<string, Set<string>> {
  const path = join(ROOT, 'protocol', 'handlers.ts')
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const result = new Map<string, Set<string>>()
  const visit = (node: ts.Node): void => {
    if (ts.isCaseBlock(node)) {
      let labels: string[] = []
      for (const clause of node.clauses) {
        if (ts.isCaseClause(clause) && ts.isStringLiteralLike(clause.expression)) labels.push(clause.expression.text)
        if (!clause.statements.length) continue
        const out = new Set<string>()
        const locals = new Map<string, string>()
        const walk = (child: ts.Node): void => {
          if (ts.isVariableDeclaration(child) && ts.isIdentifier(child.name) && child.initializer && ts.isNewExpression(child.initializer) && ts.isIdentifier(child.initializer.expression)) locals.set(child.name.text, child.initializer.expression.text)
          if (ts.isCallExpression(child)) {
            const callee = calleeOf(child, undefined, locals)
            if (callee) out.add(callee)
          }
          ts.forEachChild(child, walk)
        }
        for (const statement of clause.statements) walk(statement)
        for (const label of labels) if (!result.has(label)) result.set(label, out)
        labels = []
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}

/**
 * Services and functions that change the user's own checkout or remote rather than Mousse's: their handler
 * must declare `userRequested` and carry the user's request.
 */
const USER_CHANGES = /^(PublishService\.(publish|recoverPending)|CodeRevertService\.\w+|ManagedConflictService\.abort|discardPendingChanges|PullRequestThreadService\.startThread|startThread)$/

const MUTATIONS = /gitService\.(stage|stageAll|unstage|unstageAll|discard|fetch|pull|abortInProgress|init|createBranch|renameBranch|deleteBranch|checkout|commit|push)\(|codeHost\.(createPullRequest|mergePullRequest|closePullRequest)\(|github\.(createRepository|cloneRepository)\(|gitUserAction\(/
const READS = /gitService\.(getStatus|getDiff|getLog|getBranches|getDiffStats|lastCommitMessage|readBranchSummary|describeCommitInput|isRepo)\(|codeHost\.\w+\(/

/** Declared `userRequested` without a GitService or code host change in their own block, and why. */
const USER_REQUESTED_ELSEWHERE: Record<string, string> = {
  'operations.abort': 'aborts a merge, rebase or publish the user started, through the operation service',
  'operations.recover': 'finishes or cancels a user operation after a restart, on the user\'s request',
  'publish.start': 'Publish writes the user\'s branch, through the publish service'
}

describe('GIT_ACCESS', () => {
  const blocks = handlerBlocks()

  it('declares every protocol method, and only those', () => {
    const methods = [...new Set(PROTOCOL_METHODS)]
    expect(Object.keys(GIT_ACCESS).sort()).toEqual([...methods].sort())
    for (const method of methods) expect(['none', 'read', 'owned', 'userRequested']).toContain(gitAccessOf(method))
    expect(gitAccessOf('not.a.method')).toBeUndefined()
  })

  it('declares userRequested for every method whose handler changes the user\'s repository or GitHub', () => {
    const wrong = [...new Set(PROTOCOL_METHODS)].filter((method) => MUTATIONS.test(blocks.get(method) ?? '') && GIT_ACCESS[method] !== 'userRequested')
    expect(wrong).toEqual([])
  })

  it('declares a Git read at least for every method whose handler reads Git', () => {
    const wrong = [...new Set(PROTOCOL_METHODS)].filter((method) => READS.test(blocks.get(method) ?? '') && GIT_ACCESS[method] === 'none')
    expect(wrong).toEqual([])
  })

  it('follows calls through other services: a handler that reaches a Git write declares owned or userRequested', () => {
    const graph = callGraph()
    const reached = mutating(graph)
    const handlers = handlerCalls()
    const wrong = [...new Set(PROTOCOL_METHODS)]
      .filter((method) => [...(handlers.get(method) ?? [])].some((callee) => reached.has(callee) || SERVICE_WRITES.test(callee)))
      .filter((method) => GIT_ACCESS[method] === 'none' || GIT_ACCESS[method] === 'read')
      .map((method) => `${method}: ${[...handlers.get(method)!].filter((callee) => reached.has(callee) || SERVICE_WRITES.test(callee)).join(', ')}`)
    expect(wrong).toEqual([])
    // The analysis itself finds the paths it must: Revert, Publish, Abort, Discard, Start from a pull request.
    for (const key of ['CodeRevertService.revertCode', 'PublishService.publish', 'ManagedConflictService.abort', 'PullRequestThreadService.startThread', 'discardPendingChanges']) expect(reached.has(key), key).toBe(true)
    // Undo and Redo only rewind the conversation on this branch; they are declared for the file restore that follows.
    expect(reached.has('ConversationActionService.apply')).toBe(false)
  })

  it('a handler that changes the user\'s checkout through a service declares userRequested and carries the request', () => {
    const handlers = handlerCalls()
    const blocks = handlerBlocks()
    const wrong = [...new Set(PROTOCOL_METHODS)]
      .filter((method) => [...(handlers.get(method) ?? [])].some((callee) => USER_CHANGES.test(callee)))
      .filter((method) => GIT_ACCESS[method] !== 'userRequested' || !(method in USER_REQUEST_LABELS || /gitUserAction\(/.test(blocks.get(method) ?? '')))
    expect(wrong).toEqual([])
  })

  it('declares userRequested only where a handler passes the user\'s request, or says why not', () => {
    const unexplained = [...new Set(PROTOCOL_METHODS)].filter((method) => GIT_ACCESS[method] === 'userRequested' && !MUTATIONS.test(blocks.get(method) ?? '') && !(method in USER_REQUEST_LABELS) && !(method in USER_REQUESTED_ELSEWHERE))
    expect(unexplained).toEqual([])
  })
})
