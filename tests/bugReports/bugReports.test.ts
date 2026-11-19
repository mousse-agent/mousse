// Bug reports: what a draft leaves out, how one bug is found again, filing and revoking, and which reports a release fixes.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BugReportService } from '../../src/mms/bugReports/BugReportService'
import { bugSignature, buildBugReportDraft, cleanReportText, closesIssue, finalDraft, reportsFixedBy, type FiledBugReportView } from '../../src/shared/bugReports'

describe('a bug report draft', () => {
  it('takes out secrets, the home folder, the account name, emails and addresses', () => {
    const text = cleanReportText(
      'Failed at C:\\Users\\ana\\proj\\a.ts for ana@example.com from 10.0.0.4 with Bearer abcdefghijkl123 and ghp_abcdefghijklmnop1234',
      { home: 'C:\\Users\\ana', username: 'ana' }
    )
    expect(text).not.toMatch(/ana|example\.com|10\.0\.0\.4|abcdefghijkl123|ghp_/)
    expect(text).toContain('~')
  })

  it('carries no diagnostics unless they are added, and keeps its signature last', () => {
    const draft = buildBugReportDraft({ kind: 'button', title: 'Save failed', message: 'disk full Reference: 1ecec6b5-aaaa' })
    expect(draft.body).not.toContain('Diagnostics')
    expect(draft.body).toContain('Reference: `1ecec6b5-aaaa`')
    const sent = finalDraft(draft, { title: ' Save failed ', body: draft.body }, { app: 'Mousse 1.2.3', os: 'Windows', logs: ['level=error boom'] })
    expect(sent.title).toBe('Save failed')
    expect(sent.body).toContain('- App: Mousse 1.2.3')
    expect(sent.body.trimEnd().endsWith(`<!-- ${draft.signature} -->`)).toBe(true)
    expect(sent.body.split(draft.signature)).toHaveLength(2)
  })

  it('gives one bug the same signature whatever its numbers, ids and paths', () => {
    const a = bugSignature({ kind: 'button', title: 'x', message: 'Thread 12 failed in /home/ana/p after 300 ms' })
    const b = bugSignature({ kind: 'button', title: 'x', message: 'Thread 98 failed in /home/bo/q after 7 ms' })
    expect(a).toBe(b)
    expect(a).toMatch(/^mousse-sig-[0-9a-f]{12}$/)
  })
})

describe('the reports a release fixes', () => {
  const report = (patch: Partial<FiledBugReportView>): FiledBugReportView => ({
    number: 10, url: 'u', title: 't', signature: 's', filedAt: '2026-11-01T00:00:00Z', anonymous: true, state: 'closed', stateReason: 'completed', ...patch
  })
  it('are the fixed, unrevoked reports a pull request in the update closes', () => {
    const reports = [
      report({ number: 10, closedBy: [40] }),
      report({ number: 11, closedBy: [41, 52] }),
      report({ number: 12, closedBy: [40], stateReason: 'not_planned' }),
      report({ number: 13, closedBy: [40], revokedAt: '2026-11-02T00:00:00Z' }),
      report({ number: 14, closedBy: [40], state: 'open' }),
      report({ number: 15, closedBy: [99] }),
      // Closed, but by nothing the update brings: never matched on its own number.
      report({ number: 40 })
    ]
    expect(reportsFixedBy(reports, [40, 52]).map((entry) => entry.number)).toEqual([10, 11])
    expect(reportsFixedBy(reports, [])).toEqual([])
  })

  it.each([
    ['Closes #10', true],
    ['fixes: #10.', true],
    ['Resolved mousse-agent/mousse#10', true],
    ['Fix https://github.com/mousse-agent/mousse/issues/10', true],
    ['Refs #10', false],
    ['Closes #100', false],
    ['Closes other/repo#10', false],
    ['discloses #10', false],
    ['See #10; closes #11', false]
  ])('%s closes #10: %s', (body, closes) => {
    expect(closesIssue(body, 10)).toBe(closes)
  })
})

describe('the bug report service', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

  /** A GitHub that holds issues in memory. */
  function github(existing: Array<{ number: number; state: string; body: string }> = [], timelines: Record<number, unknown[]> = {}) {
    const issues = [...existing]
    const calls: string[] = []
    const fetch = (async (url: string, init?: RequestInit) => {
      const path = String(url).replace('https://api.github.com', '')
      const method = init?.method ?? 'GET'
      calls.push(`${method} ${path.split('?')[0]}`)
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
      if (path.startsWith('/search/issues')) {
        const q = decodeURIComponent(path)
        return json({ items: issues.filter((issue) => q.includes(issue.body)).map((issue) => ({ number: issue.number, html_url: `https://gh/${issue.number}`, state: issue.state })) })
      }
      if (method === 'POST' && path === '/repos/mousse-agent/mousse/issues') {
        const body = JSON.parse(String(init?.body)) as { body: string }
        const number = 100 + issues.length
        issues.push({ number, state: 'open', body: body.body.match(/mousse-sig-[0-9a-f]+/)![0] })
        return json({ number, html_url: `https://gh/${number}` }, 201)
      }
      const timeline = /\/issues\/(\d+)\/timeline/.exec(path)
      if (timeline) return json(timelines[Number(timeline[1])] ?? [])
      const issue = /\/issues\/(\d+)$/.exec(path)
      if (issue && method === 'PATCH') { issues.find((entry) => entry.number === Number(issue[1]))!.state = 'closed'; return json({}) }
      if (issue) { const found = issues.find((entry) => entry.number === Number(issue[1])); return found ? json({ state: found.state }) : json({}, 404) }
      return json({})
    }) as typeof globalThis.fetch
    return { fetch, calls, issues }
  }

  const service = (fetch: typeof globalThis.fetch, settings = { enabled: true, anonymous: true }) => {
    const home = mkdtempSync(join(tmpdir(), 'bug-reports-'))
    dirs.push(home)
    return new BugReportService({ installationHome: home, profileHome: home, settings: () => settings, fetch, env: { MOUSSE_BUG_GITHUB_TOKEN: 'test-token' } })
  }

  it('files a report, then +1s the open issue instead of filing the same bug twice, and lists what it filed', async () => {
    const gh = github()
    const first = service(gh.fetch)
    const draft = first.draft({ kind: 'button', title: 'Save failed', message: 'disk full' })
    expect(await first.file(draft)).toMatchObject({ status: 'filed', number: 100 })
    // Another computer (no memory of the first) files the same bug.
    const second = service(gh.fetch)
    expect(await second.file(draft)).toMatchObject({ status: 'existing', number: 100 })
    expect(gh.calls).toContain('POST /repos/mousse-agent/mousse/issues/100/reactions')
    expect(gh.issues).toHaveLength(1)
    expect((await first.list()).map((report) => [report.number, report.state])).toEqual([[100, 'open']])
  })

  it('revokes a report it filed by closing the issue, and keeps it listed as revoked', async () => {
    const gh = github()
    const reports = service(gh.fetch)
    await reports.file(reports.draft({ kind: 'button', title: 'Save failed', message: 'disk full' }))
    const revoked = await reports.revoke(100)
    expect(revoked.revokedAt).toBeTruthy()
    expect(gh.calls).toContain('PATCH /repos/mousse-agent/mousse/issues/100')
    expect(gh.issues[0]!.state).toBe('closed')
  })

  it('lists as closing a fixed issue only the merged pull requests of this repository that close it', async () => {
    const reference = (number: number, body: string, merged: boolean, repository = 'mousse-agent/mousse', pr = true) => ({
      event: 'cross-referenced',
      source: { issue: { number, body, repository: { full_name: repository }, ...(pr ? { pull_request: { merged_at: merged ? '2026-11-18T10:00:00Z' : null } } : {}) } }
    })
    const gh = github([], {
      100: [
        reference(40, 'Fixes the save.\n\nCloses #100', true),
        reference(41, 'Refs #100', true),
        reference(42, 'Closes #100', false),
        reference(43, 'Closes mousse-agent/mousse#100', true, 'someone/fork-tools'),
        reference(44, 'Closes #100', true, 'mousse-agent/mousse', false),
        { event: 'closed' }
      ]
    })
    const reports = service(gh.fetch)
    await reports.file(reports.draft({ kind: 'button', title: 'Save failed', message: 'disk full' }))
    expect((await reports.list())[0]!.closedBy).toBeUndefined()
    gh.issues[0]!.state = 'closed'
    expect((await reports.list())[0]).toMatchObject({ state: 'closed', closedBy: [40] })
  })

  it('opens a prefilled page instead when it has no way to file', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bug-reports-'))
    dirs.push(home)
    const reports = new BugReportService({ installationHome: home, profileHome: home, settings: () => ({ enabled: true, anonymous: true }), fetch: github().fetch, env: {} })
    const outcome = await reports.file(reports.draft({ kind: 'button', title: 'Save failed', message: 'disk full' }))
    expect(outcome).toMatchObject({ status: 'browser' })
    expect(outcome.status === 'browser' && outcome.url).toContain('/issues/new?title=Save%20failed')
  })

  it('holds an agent’s draft until the person answers, and refuses one while reports are off', async () => {
    const gh = github()
    const settings = { enabled: true, anonymous: true }
    const reports = service(gh.fetch, settings)
    const proposal = reports.propose({ kind: 'agent', title: 'Pane blank', message: 'The changes pane went blank' }, { kind: 'thread', id: 't1' })
    const [pending] = reports.pendingReports()
    expect(gh.calls).toEqual([])
    await reports.answer(pending!.id, { file: false })
    expect(await proposal.settled).toBeNull()
    expect(gh.calls).toEqual([])
    settings.enabled = false
    expect(() => reports.propose({ kind: 'agent', title: 'x', message: 'y' }, { kind: 'thread', id: 't1' })).toThrow(/off/)
  })
})
