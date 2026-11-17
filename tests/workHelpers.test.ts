import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  OPEN_PR_LIMIT, assertComplete, branchNameMatches, cacheStamp, classifyArgs, findBranchHits, findOverlaps, formatReport, isOwnPr
} from '../scripts/related-work.mjs'
import { closeComment, closingIssues, decideClose, referenceRepo } from '../scripts/close-completed-issues.mjs'
import { formatNotes } from '../scripts/task-notes.mjs'
import { mergeTested, summarizeTsc, summarizeVitestJson } from '../scripts/verify.mjs'
import {
  checkPrBody, formatSpan, getPath, mergeNotes, normalizePath, parseArgv, parseClosingRefs, parseDuration,
  parsePartialRefs, pathSetsOverlap, pathsOverlap, setPath, trimText, workingTreeFingerprint
} from '../scripts/work-lib.mjs'

describe('path overlap', () => {
  it('matches exact files and directories, on path segments only', () => {
    const changed = ['src/mms/net/NetService.ts', 'src/mms/netx/other.ts', 'docs/a.md', 'src\\main\\index.ts']
    expect(pathsOverlap(['src/mms/net'], changed)).toEqual(['src/mms/net/NetService.ts'])
    expect(pathsOverlap(['src/mms/net/'], changed)).toEqual(['src/mms/net/NetService.ts'])
    expect(pathsOverlap(['src/mms/net/**', 'docs/a.md'], changed)).toEqual(['src/mms/net/NetService.ts', 'docs/a.md'])
    expect(pathsOverlap(['./src/main'], changed)).toEqual(['src/main/index.ts'])
    expect(pathsOverlap([], changed)).toEqual([])
  })

  it('treats the repository root as matching every file, never as nothing', () => {
    const changed = ['src/a.ts', 'docs/b.md']
    for (const root of ['.', './', '/', '*', '**', '']) {
      expect(normalizePath(root)).toBe('')
      expect(pathsOverlap([root], changed)).toEqual(changed)
    }
    expect(pathsOverlap(['.', 'nope/'], changed)).toEqual(changed)
    expect(pathSetsOverlap(['.'], ['src/a.ts'])).toEqual(['src/a.ts'])
    expect(classifyArgs(['.', 'term'])).toEqual({ terms: ['term'], paths: ['.'] })
  })

  it('finds the shared path between two planned sets in either direction', () => {
    expect(pathSetsOverlap(['src/mms/'], ['src/mms/net/a.ts', 'docs/x.md'])).toEqual(['src/mms/net/a.ts'])
    expect(pathSetsOverlap(['src/mms/net/a.ts'], ['src/mms'])).toEqual(['src/mms/net/a.ts'])
    expect(pathSetsOverlap(['src/a'], ['src/ab'])).toEqual([])
    expect(normalizePath('.\\src\\x\\*')).toBe('src/x/')
  })

  it('separates terms from planned paths and flags a truncated file list as a hit', () => {
    expect(classifyArgs(['work skill', 'scripts/verify.mjs', 'README.md', 'chat'])).toEqual({
      terms: ['work skill', 'chat'], paths: ['scripts/verify.mjs', 'README.md']
    })
    const prs = [{ number: 1, changedFiles: 2 }, { number: 2, changedFiles: 5000 }, { number: 3, changedFiles: 1 }]
    const files = new Map([[1, ['a/x.ts', 'b/y.ts']], [2, ['c/z.ts']], [3, ['q.ts']]])
    const hits = findOverlaps(prs, files, ['a/'])
    expect(hits.map((hit: { pr: { number: number } }) => hit.pr.number)).toEqual([1, 2])
    expect(hits[1].truncated).toBe(true)
    // The root plan hits every PR that has files, so it can never end as CLEAR.
    expect(findOverlaps(prs, files, ['.']).map((hit: { pr: { number: number } }) => hit.pr.number)).toEqual([1, 2, 3])
  })

  it('refuses an open PR list that reached its limit, and keys the file cache on head and base', () => {
    expect(() => assertComplete(OPEN_PR_LIMIT, OPEN_PR_LIMIT, 'the open PR list')).toThrow(/incomplete/)
    expect(() => assertComplete(OPEN_PR_LIMIT - 1, OPEN_PR_LIMIT, 'the open PR list')).not.toThrow()
    const pr = { headRefOid: 'h1', baseRefName: 'master', baseRefOid: 'b1' }
    expect(cacheStamp(pr)).not.toBe(cacheStamp({ ...pr, baseRefOid: 'b2' }))
    expect(cacheStamp(pr)).not.toBe(cacheStamp({ ...pr, baseRefName: 'stack' }))
    expect(cacheStamp(pr)).not.toBe(cacheStamp({ ...pr, headRefOid: 'h2' }))
  })

  it('skips only the own PR of the current task, not a fork branch of the same name', () => {
    const own = { headRefName: 'task', isCrossRepository: false, headRepositoryOwner: { login: 'Mousse-Agent' } }
    expect(isOwnPr(own, 'task', 'mousse-agent')).toBe(true)
    expect(isOwnPr({ ...own, isCrossRepository: true, headRepositoryOwner: { login: 'someone' } }, 'task', 'mousse-agent')).toBe(false)
    expect(isOwnPr({ ...own, headRepositoryOwner: { login: 'someone' } }, 'task', 'mousse-agent')).toBe(false)
    expect(isOwnPr(own, 'other', 'mousse-agent')).toBe(false)
    expect(isOwnPr(own, null, 'mousse-agent')).toBe(false)
  })

  it('finds recent branches without a PR by name or by changed paths, and counts ones it could not compare', () => {
    expect(branchNameMatches('work-skill-tokens', ['work skill'])).toBe(true)
    expect(branchNameMatches('work-tokens', ['work skill'])).toBe(false)
    expect(branchNameMatches('anything', ['ab'])).toBe(false)
    const branches = ['by-name-work-skill', 'touches-files', 'merged', 'unrelated', 'broken'].map((name) => ({ name, date: 'd' }))
    const files: Record<string, string[]> = { 'by-name-work-skill': ['x'], 'touches-files': ['scripts/verify.mjs'], unrelated: ['docs/a.md'] }
    const out = findBranchHits(branches, {
      terms: ['work skill'], planned: ['scripts/'],
      aheadOf: (name: string) => (name === 'merged' ? 0 : 1),
      filesOf: (name: string) => { if (name === 'broken') throw new Error('no base'); return files[name] ?? [] }
    })
    expect(out.hits.map((hit: { name: string }) => hit.name)).toEqual(['by-name-work-skill', 'touches-files'])
    expect(out.hits[1].files).toEqual(['scripts/verify.mjs'])
    expect(out.failed).toBe(1)
  })

  it('prints CLEAR only when paths were checked and nothing matched', () => {
    const base = { repo: 'o/r', baseSha: 'abcdef123', openCount: 3, terms: ['x'], overlaps: [], termHits: [] }
    expect(formatReport({ ...base, planned: ['a/'] })).toContain('CLEAR')
    const unchecked = formatReport({ ...base, planned: [] })
    expect(unchecked).not.toContain('CLEAR')
    expect(unchecked).toContain('NOT CHECKED')
    const partial = formatReport({ ...base, planned: ['a/'], incomplete: ['3 branches could not be compared'] })
    expect(partial).toContain('INCOMPLETE: 3 branches')
    expect(partial).not.toContain('CLEAR')
    const branch = formatReport({ ...base, planned: ['a/'], branchHits: [{ name: 'x', date: '2026-01-01T00:00:00Z', byName: true, files: [] }] })
    expect(branch).toContain('origin/x')
    expect(branch).not.toContain('CLEAR')
  })
})

describe('closing keywords', () => {
  it('reads real closing references and ignores comments, code and other repos', () => {
    const body = [
      '<!-- End with Closes #123 -->',
      'Closes #10, fixes #11 and Resolves: o/r#12',
      'Also closed https://github.com/o/r/issues/13',
      '`Closes #14` and ```\nFixes #15\n```',
      'Fixes other/repo#16 and Refs #17',
      'It closes #18 and discloses #19'
    ].join('\n')
    expect(parseClosingRefs(body, { repo: 'o/r' })).toEqual([10, 11, 12, 13, 18])
    expect(parsePartialRefs(body, { repo: 'o/r' })).toEqual([17])
  })

  it('enforces the PR body rule', () => {
    expect(checkPrBody('Closes #5')).toMatchObject({ ok: true, kind: 'closes', numbers: [5] })
    expect(checkPrBody('Refs #5')).toMatchObject({ ok: true, kind: 'refs' })
    expect(checkPrBody('No issue')).toMatchObject({ ok: true, kind: 'none' })
    expect(checkPrBody('<!-- Closes #123 or Refs #123 -->\n## Notes')).toMatchObject({ ok: false })
    expect(checkPrBody('')).toMatchObject({ ok: false })
    expect(checkPrBody(undefined)).toMatchObject({ ok: false })
  })

  it('collects closing issues from the body and GitHub references of this repository only', () => {
    // The shape gh returns: repository { name, owner { login } } and the issue url, no nameWithOwner.
    const ref = (owner: string, name: string, number: number) => ({
      id: 'I_x', number, repository: { id: 'R_x', name, owner: { id: 'U_x', login: owner } }, url: `https://github.com/${owner}/${name}/issues/${number}`
    })
    const pr = {
      number: 9, body: 'Closes #3',
      closingIssuesReferences: [ref('O', 'R', 4), ref('other', 'r', 5), ref('o', 'other', 6), { number: 7 }, { number: 8, url: 'https://github.com/o/r/issues/8' }, ref('o', 'r', 9)]
    }
    expect(closingIssues(pr, 'o/r')).toEqual([3, 4, 8])
    expect(referenceRepo(ref('o', 'r', 1))).toBe('o/r')
    expect(referenceRepo({ number: 1 })).toBeNull()
    expect(closeComment(pr)).toBe('Completed in #9.')
  })

  it('closes only an open issue that existed at merge time and was not reopened since', () => {
    const pr = { number: 9, mergedAt: '2026-11-10T10:00:00Z' }
    const open = { state: 'open', created_at: '2026-11-01T00:00:00Z' }
    expect(decideClose({ pr, issue: open })).toMatchObject({ close: true })
    expect(decideClose({ pr, issue: { ...open, state: 'closed' } })).toMatchObject({ close: false })
    expect(decideClose({ pr, issue: { ...open, pull_request: {} } })).toMatchObject({ close: false })
    expect(decideClose({ pr, issue: { ...open, created_at: '2026-11-11T00:00:00Z' } })).toMatchObject({ close: false })
    expect(decideClose({ pr, issue: open, reopenedAt: '2026-11-12T00:00:00Z' })).toMatchObject({ close: false })
    expect(decideClose({ pr, issue: open, reopenedAt: '2026-11-09T00:00:00Z' })).toMatchObject({ close: true })
  })
})

describe('output digesting', () => {
  it('summarises a vitest report with trimmed failures and a count of the rest', () => {
    const esc = String.fromCharCode(27)
    const report = {
      success: false, numTotalTests: 7, numFailedTests: 4,
      testResults: [
        {
          name: 'C:\\repo\\tests\\a.test.ts', status: 'failed', assertionResults: [
            { status: 'passed', fullName: 'ok' },
            ...[1, 2, 3].map((n) => ({ status: 'failed', fullName: `suite case ${n}`, failureMessages: [`${esc}[31mExpected ${n}${esc}[0m\n${'line\n'.repeat(20)}`] }))
          ]
        },
        { name: '/repo/tests/b.test.ts', status: 'failed', message: 'Cannot find module x', assertionResults: [] }
      ]
    }
    const out = summarizeVitestJson(report, { maxFailures: 2 })
    expect(out.ok).toBe(false)
    expect(out.summary).toBe('2 file(s), 7 test(s), 4 failed')
    expect(out.failures[0]).toContain('tests/a.test.ts > suite case 1')
    expect(out.failures[0]).toContain('Expected 1')
    expect(out.failures[0]).not.toContain(esc)
    expect(out.failures[0]).toContain('more line(s)')
    expect(out.failures.at(-1)).toContain('2 more failure(s)')
    expect(summarizeVitestJson({ success: true, numTotalTests: 3, testResults: [{ name: 'x', status: 'passed', assertionResults: [] }] }))
      .toMatchObject({ ok: true, summary: '1 file(s), 3 test(s)', failures: [] })
  })

  it('counts a file that failed to load even with no failed assertions', () => {
    const out = summarizeVitestJson({ success: false, numFailedTests: 0, testResults: [{ name: '/r/tests/c.test.ts', status: 'failed', message: 'boom', assertionResults: [] }] })
    expect(out.ok).toBe(false)
    expect(out.failures[0]).toContain('boom')
  })

  it('summarises tsc output and trims long lists', () => {
    const output = ['a.ts(1,1): error TS2322: bad', 'noise', 'b.ts(2,2): error TS2304: worse', 'c.ts(3,3): error TS1005: x'].join('\n')
    const out = summarizeTsc(output, { maxFailures: 2 })
    expect(out).toMatchObject({ ok: false, summary: '3 error(s)' })
    expect(out.failures).toHaveLength(3)
    expect(out.failures[2]).toContain('1 more error(s)')
    expect(summarizeTsc('', { ok: true })).toMatchObject({ ok: true, summary: 'no errors' })
    expect(summarizeTsc('', { ok: false }).ok).toBe(false)
  })

  it('trims text by lines and width', () => {
    expect(trimText('a\n\nb\nc\nd', { maxLines: 2 })).toBe('a\nb\n… 2 more line(s)')
    expect(trimText('x'.repeat(50), { maxLineChars: 10 })).toBe(`${'x'.repeat(9)}…`)
  })

  it('keeps earlier results only for the same working-tree fingerprint', () => {
    const at = 't'
    const run = { sha: 'a', tree: 't1', dirty: false, at }
    const first = mergeTested(undefined, run, { command: 'tests', ok: true })
    const second = mergeTested(first, run, { command: 'tsc', ok: true })
    expect(second.results.map((r: { command: string }) => r.command)).toEqual(['tests', 'tsc'])
    const rerun = mergeTested(second, run, { command: 'tests', ok: false })
    expect(rerun.results).toEqual([{ command: 'tsc', ok: true }, { command: 'tests', ok: false }])
    // Same commit, edited files: the earlier pass must not survive.
    expect(mergeTested(second, { ...run, tree: 't2', dirty: true }, { command: 'tests', ok: true }).results).toHaveLength(1)
    // A record from before fingerprints existed carries nothing over.
    expect(mergeTested({ sha: 'a', dirty: false, results: [{ command: 'tsc', ok: true }] }, run, { command: 'tests', ok: true }).results).toHaveLength(1)
  })

  it('fingerprints the exact working-tree contents, and survives a commit of the same contents', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fingerprint-test-'))
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
      git('init', '-q')
      git('config', 'user.name', 'T'); git('config', 'user.email', 't@example.invalid'); git('config', 'commit.gpgsign', 'false')
      writeFileSync(join(dir, 'a.txt'), 'one\n')
      git('add', 'a.txt'); git('commit', '-qm', 'init')
      const clean = workingTreeFingerprint(dir)
      expect(clean.dirty).toBe(false)
      writeFileSync(join(dir, 'a.txt'), 'two\n')
      const edited = workingTreeFingerprint(dir)
      expect(edited.dirty).toBe(true)
      expect(edited.tree).not.toBe(clean.tree)
      writeFileSync(join(dir, 'new.txt'), 'x')
      const withNew = workingTreeFingerprint(dir)
      expect(withNew.tree).not.toBe(edited.tree)
      expect(git('status', '--porcelain')).toContain('?? new.txt') // the real index is untouched
      git('add', '-A'); git('commit', '-qm', 'second')
      const committed = workingTreeFingerprint(dir)
      expect(committed).toMatchObject({ tree: withNew.tree, dirty: false })
      unlinkSync(join(dir, 'new.txt'))
      expect(workingTreeFingerprint(dir).tree).not.toBe(committed.tree)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('task notes and arguments', () => {
  it('sets dotted keys on a copy, refuses unsafe keys, and merges with null removal', () => {
    const original = { tier: 3 }
    const next = setPath(original, 'related.review', 'done')
    expect(next).toEqual({ tier: 3, related: { review: 'done' } })
    expect(original).toEqual({ tier: 3 })
    expect(getPath(next, 'related.review')).toBe('done')
    expect(getPath(next, 'related.missing.deeper')).toBeUndefined()
    expect(() => setPath({}, '__proto__.x', 1)).toThrow()
    const merged = mergeNotes({ tier: 3, claim: { task: 't' } }, { claim: null, pr: 12 }, new Date('2026-01-01T00:00:00Z'))
    expect(merged).toEqual({ tier: 3, pr: 12, updatedAt: '2026-01-01T00:00:00.000Z' })
  })

  it('calls a tested record current only when the working-tree fingerprint matches', () => {
    const notes = { tier: 4, tested: { sha: 'abcdef1234', tree: 'tree1', dirty: false, results: [{ ok: true, name: 'tests', summary: '1 file(s), 2 test(s)', command: 'npx vitest run tests/a.test.ts' }] } }
    const same = formatNotes(notes, { tree: 'tree1' })
    expect(same).toContain('current')
    expect(same).toContain('$ npx vitest run tests/a.test.ts')
    const edited = formatNotes(notes, { tree: 'tree2' })
    expect(edited).toContain('NOT VERIFIED')
    expect(edited).not.toContain('current')
    const old = formatNotes({ tested: { sha: 'abcdef1234', dirty: false, results: [] } }, { tree: 'tree1' })
    expect(old).toContain('NOT VERIFIED')
    expect(formatNotes(notes)).toContain('unchecked')
    expect(formatNotes({})).toBe('no task notes yet')
  })

  it('parses durations and options', () => {
    expect(parseDuration('2h')).toBe(7_200_000)
    expect(parseDuration('90')).toBe(5_400_000)
    expect(parseDuration('1d')).toBe(86_400_000)
    expect(parseDuration('soon')).toBeNull()
    expect(parseDuration('0m')).toBeNull()
    expect(formatSpan(5_400_000)).toBe('1h30m')
    const args = parseArgv(['claim', '--task=t', '--path', 'a', '--path', 'b', '--dry-run', '--bogus', '--ttl'], {
      bool: ['dry-run'], value: ['task', 'ttl'], multi: ['path']
    })
    expect(args.positional).toEqual(['claim'])
    expect(args.value.task).toBe('t')
    expect(args.multi.path).toEqual(['a', 'b'])
    expect(args.bool['dry-run']).toBe(true)
    expect(args.errors).toEqual(['unknown option --bogus', '--ttl needs a value'])
  })
})
