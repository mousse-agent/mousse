import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GIT_ACCESS, gitAccessOf } from '../src/mms/protocol/gitAccess'
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

  it('declares userRequested only where a handler passes the user\'s request, or says why not', () => {
    const unexplained = [...new Set(PROTOCOL_METHODS)].filter((method) => GIT_ACCESS[method] === 'userRequested' && !MUTATIONS.test(blocks.get(method) ?? '') && !(method in USER_REQUESTED_ELSEWHERE))
    expect(unexplained).toEqual([])
  })
})
