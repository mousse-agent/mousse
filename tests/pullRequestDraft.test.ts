import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MOUSSE_COMMIT_ENV } from '../src/mms/actions/git'
import { GitService } from '../src/mms/git/GitService'
import { OrchestratorService } from '../src/mms/orchestrator/OrchestratorService'
import {
  PULL_REQUEST_DRAFT_LIMITS,
  PULL_REQUEST_TITLE_MAX,
  buildPullRequestDraftPrompt,
  capText,
  conversationExcerpt,
  heuristicPullRequestDraft,
  isMousseCommit,
  parsePullRequestDraft,
  type PullRequestDraftInputs
} from '../src/mms/git/pullRequestDraft'
import { getDefaultSettings } from '../src/shared/settings'
import type { OneShotRequest } from '../src/mms/harness/gateway'

const inputs = (patch: Partial<PullRequestDraftInputs> = {}): PullRequestDraftInputs => ({
  branch: 'feature/login-retry',
  base: 'main',
  threadName: null,
  conversation: '',
  commits: [],
  stat: '',
  patch: '',
  template: null,
  ...patch
})

describe('pull request draft prompt', () => {
  it('names the branches and asks for a title line then a description', () => {
    const prompt = buildPullRequestDraftPrompt(inputs({ commits: [{ subject: 'Retry the login', body: '' }] }))
    expect(prompt).toContain('from branch "feature/login-retry" into "main"')
    expect(prompt).toContain(`at most ${PULL_REQUEST_TITLE_MAX} characters`)
    expect(prompt).toContain('Commits:\nRetry the login')
    expect(prompt).not.toContain('template')
  })

  it('does not name a thread\'s own branch, and leaves Mousse\'s checkpoint commits out', () => {
    const prompt = buildPullRequestDraftPrompt(inputs({
      branch: 'mousse/thread/0b5e2d4c-8f1a-4e57-9d3b-2c6a1f0e9b7d/main',
      commits: [
        { subject: 'mousse: checkpoint turn run:thread:0b5e2d4c:1 (a1)', body: '', authorEmail: 'mousse@local' },
        { subject: 'Retry the login', body: '', authorEmail: 'ada@example.com' }
      ]
    }))
    expect(prompt).toContain('Write the title and the description of a pull request into "main"')
    expect(prompt).not.toContain('mousse/thread')
    expect(prompt).not.toContain('checkpoint')
    expect(prompt).toContain('Commits:\nRetry the login')
  })

  it('carries the template and asks for it to be filled in', () => {
    const prompt = buildPullRequestDraftPrompt(inputs({ template: '## Summary\n\n## Testing\n- [ ] ran tests' }))
    expect(prompt).toContain('Pull request template:\n## Summary')
    expect(prompt).toContain('Fill in the pull request template')
  })

  it('caps each input at its limit and says so', () => {
    const prompt = buildPullRequestDraftPrompt(inputs({
      conversation: 'c'.repeat(PULL_REQUEST_DRAFT_LIMITS.conversation * 2),
      commits: [{ subject: 's'.repeat(PULL_REQUEST_DRAFT_LIMITS.commits * 2), body: '' }],
      stat: 't'.repeat(PULL_REQUEST_DRAFT_LIMITS.stat * 2),
      patch: 'p'.repeat(PULL_REQUEST_DRAFT_LIMITS.patch * 2),
      template: 'x'.repeat(PULL_REQUEST_DRAFT_LIMITS.template * 2)
    }))
    const total = Object.values(PULL_REQUEST_DRAFT_LIMITS).reduce((sum, limit) => sum + limit, 0)
    expect(prompt.length).toBeLessThan(total + 2_000)
    expect(prompt.match(/… \(cut\)/g)).toHaveLength(5)
    expect(capText('short', 10)).toBe('short')
  })

  it('leaves out an input that is empty', () => {
    const prompt = buildPullRequestDraftPrompt(inputs({ patch: 'diff --git a/a b/a' }))
    expect(prompt).toContain('Patch:\ndiff --git a/a b/a')
    expect(prompt).not.toContain('Commits:')
    expect(prompt).not.toContain('Conversation with the agent')
    expect(prompt).not.toContain('Changed files:')
  })
})

describe('conversation excerpt', () => {
  it('keeps the user\'s messages and the agent\'s finished replies, and leaves out the rest', () => {
    const text = conversationExcerpt([
      { role: 'user', content: 'Retry the login' },
      { role: 'assistant', content: 'Done, retries three times' },
      { role: 'assistant', content: 'still typing', streaming: true },
      { role: 'user', content: 'hidden', hidden: true },
      { role: 'system', content: 'notice' },
      { role: 'user', content: '   ' }
    ])
    expect(text).toBe('User: Retry the login\nAssistant: Done, retries three times')
  })

  it('keeps the newest messages when they do not fit, and the opening request', () => {
    const messages = [
      { role: 'user', content: 'FIRST request' },
      ...Array.from({ length: 30 }, (_, index) => ({ role: index % 2 ? 'user' : 'assistant', content: `message ${index} ${'x'.repeat(100)}` }))
    ]
    const text = conversationExcerpt(messages, 1_000)
    expect(text.length).toBeLessThanOrEqual(1_000 + 300)
    expect(text.startsWith('User: FIRST request\n…\n')).toBe(true)
    expect(text).toContain('message 29')
    expect(text).not.toContain('message 1 ')
  })

  it('cuts one long message', () => {
    expect(conversationExcerpt([{ role: 'user', content: 'y'.repeat(5_000) }], 12_000, 100)).toContain('… (cut)')
  })
})

describe('parsePullRequestDraft', () => {
  it('splits the first line from the description', () => {
    expect(parsePullRequestDraft('Retry the login request\n\n## Summary\n- retries\n')).toEqual({
      title: 'Retry the login request',
      body: '## Summary\n- retries'
    })
  })

  it('cleans a title the model decorated, and clamps it', () => {
    expect(parsePullRequestDraft('# "Retry the login."\n\nBody')?.title).toBe('Retry the login')
    expect(parsePullRequestDraft('Title: Retry the login\nBody')?.title).toBe('Retry the login')
    expect(parsePullRequestDraft('**Retry the login**\nBody')?.title).toBe('Retry the login')
    const long = parsePullRequestDraft(`${'word '.repeat(40)}\nBody`)
    expect(long?.title.length).toBeLessThanOrEqual(PULL_REQUEST_TITLE_MAX)
  })

  it('reads an answer wrapped in a code fence, skips leading blank lines, and allows no description', () => {
    expect(parsePullRequestDraft('```markdown\nA title\n\nBody text\n```')).toEqual({ title: 'A title', body: 'Body text' })
    expect(parsePullRequestDraft('\n\n  A title  ')).toEqual({ title: 'A title', body: '' })
  })

  it('is null without a title', () => {
    expect(parsePullRequestDraft('')).toBeNull()
    expect(parsePullRequestDraft('   \n  ')).toBeNull()
    expect(parsePullRequestDraft('""\nBody')).toBeNull()
  })
})

describe('heuristicPullRequestDraft', () => {
  const commits = [
    { subject: 'Add the retry test', body: '' },
    { subject: 'Retry the login', body: 'details' }
  ]

  it('titles with the conversation\'s name and lists the commits, oldest first, above the template', () => {
    const draft = heuristicPullRequestDraft(inputs({ threadName: 'Fix flaky login', commits, template: '## Testing\n- [ ] ran' }))
    expect(draft.title).toBe('Fix flaky login')
    expect(draft.body).toBe('- Retry the login\n- Add the retry test\n\n## Testing\n- [ ] ran')
  })

  it('titles with the first commit when the conversation has no name', () => {
    expect(heuristicPullRequestDraft(inputs({ commits })).title).toBe('Retry the login')
  })

  it('falls back to the branch name, and leaves the body empty with nothing to say', () => {
    expect(heuristicPullRequestDraft(inputs())).toEqual({ title: 'login retry', body: '' })
  })

  const threadBranch = 'mousse/thread/0b5e2d4c-8f1a-4e57-9d3b-2c6a1f0e9b7d/main'
  const mousse = 'mousse@local'
  const checkpoints = [
    { subject: 'mousse: checkpoint turn run:thread:0b5e2d4c:2 (a2)', body: '', authorEmail: mousse },
    { subject: "Merge commit '9f8e7d6c' into mousse/thread/0b5e2d4c-8f1a-4e57-9d3b-2c6a1f0e9b7d/main", body: '', authorEmail: mousse },
    { subject: 'mousse: undo turn run:thread:0b5e2d4c:1 (op-1)', body: '', authorEmail: mousse },
    { subject: 'mousse: checkpoint turn run:thread:0b5e2d4c:1 (a1)', body: '', authorEmail: mousse }
  ]
  const stat = ' src/format.js   | 12 ++++++++----\n src/tax.js      |  4 ++++\n 2 files changed, 12 insertions(+), 4 deletions(-)'

  it('describes a thread\'s branch by its changed files, without checkpoint subjects, ids or the branch name', () => {
    const draft = heuristicPullRequestDraft(inputs({ branch: threadBranch, threadName: 'Add sales tax', commits: checkpoints, stat }))
    expect(draft.title).toBe('Add sales tax')
    expect(draft.body).toBe('Changes 2 files (+12 \u22124):\n\n- `src/format.js`\n- `src/tax.js`')
    expect(`${draft.title}\n${draft.body}`).not.toMatch(/mousse|checkpoint|0b5e2d4c|run:thread/)
  })

  it('keeps the commits someone wrote and drops Mousse\'s own between them', () => {
    const draft = heuristicPullRequestDraft(inputs({ branch: threadBranch, commits: [checkpoints[0], ...commits, checkpoints[3]], stat }))
    expect(draft).toEqual({ title: 'Retry the login', body: '- Retry the login\n- Add the retry test' })
  })

  it('titles a thread\'s unnamed branch from its files, never from the branch name', () => {
    expect(heuristicPullRequestDraft(inputs({ branch: threadBranch, commits: checkpoints, stat })).title).toBe('Update 2 files')
    expect(heuristicPullRequestDraft(inputs({ branch: threadBranch, stat: ' README.md | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)' })).title).toBe('Update README.md')
    expect(heuristicPullRequestDraft(inputs({ branch: threadBranch })).title).toBe('Update')
  })

  it('knows Mousse\'s own commits by their author, never by their subject', () => {
    expect(isMousseCommit({ authorEmail: 'mousse@local' })).toBe(true)
    for (const authorEmail of ['ada@example.com', 'Mousse@Local', '', undefined]) expect(isMousseCommit({ authorEmail })).toBe(false)
    // A person's commit that happens to look like Mousse's stays in the description.
    const draft = heuristicPullRequestDraft(inputs({
      commits: [
        { subject: 'mousse: checkpoint turn t-1 (a1)', body: '', authorEmail: 'mousse@local' },
        { subject: 'mousse: rename the dessert module', body: '', authorEmail: 'ada@example.com' },
        { subject: 'MOUSSE: shout less', body: '' }
      ]
    }))
    expect(draft.body).toBe('- MOUSSE: shout less\n- mousse: rename the dessert module')
  })

  it('clamps a long title', () => {
    expect(heuristicPullRequestDraft(inputs({ threadName: 'n'.repeat(200) })).title).toHaveLength(PULL_REQUEST_TITLE_MAX)
  })
})

describe('OrchestratorService.draftPullRequest', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mousse-pr-draft-'))
    mkdirSync(join(root, '.github'))
    writeFileSync(join(root, '.github', 'pull_request_template.md'), '## Testing\n')
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const params = (patch: Record<string, unknown> = {}) => ({
    root,
    branch: 'feature/login-retry',
    base: 'main',
    remote: 'origin',
    originThreadId: 't1',
    projectId: 'p1',
    threadName: 'Fix flaky login',
    ...patch
  })

  function orchestrator(options: { titleModel?: boolean; draft?: () => Promise<string> } = {}) {
    const settings = {
      ...getDefaultSettings(),
      title: options.titleModel ? { llmProvider: 'openai', model: 'gpt-big' } : getDefaultSettings().title
    }
    const draft = options.draft ?? (async () => 'Retry the login\n\nIt retries.')
    const draftPullRequest = vi.fn(async (_request: OneShotRequest) => ({ text: await draft() }))
    const readBranchSummary = vi.fn(async () => ({
      commits: [{ subject: 'Retry the login', body: '' }],
      stat: ' a.ts | 2 +-',
      patch: 'diff --git a/a.ts b/a.ts'
    }))
    const orch = Object.assign(Object.create(OrchestratorService.prototype), {
      settingsStore: { get: () => settings },
      harness: { oneShot: draftPullRequest },
      gitService: { readBranchSummary },
      getMessages: () => [{ role: 'user', content: 'Please retry the login' }],
      threadScope: () => ({})
    }) as OrchestratorService
    return { orch, draftPullRequest, readBranchSummary }
  }

  it('without a title model drafts from the commits and the template, and calls no model', async () => {
    const { orch, draftPullRequest, readBranchSummary } = orchestrator()
    const draft = await orch.draftPullRequest(params())
    expect(draft).toEqual({ title: 'Fix flaky login', body: '- Retry the login\n\n## Testing', source: 'heuristic' })
    expect(draftPullRequest).not.toHaveBeenCalled()
    expect(readBranchSummary).toHaveBeenCalledWith(root, expect.objectContaining({ branch: 'feature/login-retry', base: 'main', remote: 'origin' }))
  })

  it('asks the title model, with the template, the commits and the conversation in the prompt', async () => {
    const { orch, draftPullRequest } = orchestrator({ titleModel: true })
    expect(await orch.draftPullRequest(params())).toEqual({ title: 'Retry the login', body: 'It retries.', source: 'model' })
    const request = draftPullRequest.mock.calls[0]![0]
    expect(request.prompt).toContain('## Testing')
    expect(request.prompt).toContain('Retry the login')
    expect(request.prompt).toContain('User: Please retry the login')
    expect(request.sessionKey).toBe('pull-request-draft:t1')
    expect(request).toMatchObject({ purpose: 'title', task: 'pull_request', selection: { llmProvider: 'openai', model: 'gpt-big' } })
  })

  it('resolves the title model in the project of the folder, even without an originating thread', async () => {
    const { orch, draftPullRequest } = orchestrator({ titleModel: true })
    await orch.draftPullRequest(params())
    await orch.draftPullRequest(params({ originThreadId: null }))
    expect(draftPullRequest.mock.calls.map(([request]) => request.scope)).toEqual([
      { kind: 'project', projectId: 'p1' },
      { kind: 'project', projectId: 'p1' }
    ])
    draftPullRequest.mockClear()
    await orch.draftPullRequest(params({ originThreadId: null, projectId: null }))
    expect(draftPullRequest.mock.calls[0]![0].scope).toEqual({ kind: 'device' })
  })

  it('falls back to the plain draft when the model fails or answers without a title', async () => {
    const failing = orchestrator({ titleModel: true, draft: async () => { throw new Error('provider down') } })
    expect(await failing.orch.draftPullRequest(params())).toMatchObject({ title: 'Fix flaky login', source: 'heuristic' })
    const empty = orchestrator({ titleModel: true, draft: async () => '   ' })
    expect(await empty.orch.draftPullRequest(params())).toMatchObject({ title: 'Fix flaky login', source: 'heuristic' })
  })

  it('does not ask a model when there is nothing to describe', async () => {
    const { orch, draftPullRequest, readBranchSummary } = orchestrator({ titleModel: true })
    readBranchSummary.mockResolvedValue({ commits: [], stat: '', patch: '' })
    ;(orch as unknown as { getMessages: () => unknown[] }).getMessages = () => []
    expect(await orch.draftPullRequest(params({ originThreadId: null }))).toMatchObject({ source: 'heuristic' })
    expect(draftPullRequest).not.toHaveBeenCalled()
  })

  it('still drafts when the branch cannot be read', async () => {
    const { orch, readBranchSummary } = orchestrator()
    readBranchSummary.mockRejectedValue(new Error('not a repository'))
    expect(await orch.draftPullRequest(params())).toMatchObject({ title: 'Fix flaky login', source: 'heuristic' })
  })
})

describe('GitService.readBranchSummary', () => {
  let root: string
  const git = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    execFileSync('git', args, { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.com', GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.com', ...env }, stdio: 'pipe' })

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mousse-pr-summary-'))
    git(['init', '-q', '-b', 'main'])
    writeFileSync(join(root, 'a.txt'), 'one\n')
    git(['add', '.'])
    git(['commit', '-q', '-m', 'Start'])
    git(['checkout', '-q', '-b', 'mousse/thread/t1/main'])
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('leaves out the commits Mousse made itself, whatever their subject', async () => {
    writeFileSync(join(root, 'a.txt'), 'two\n')
    git(['commit', '-q', '-am', 'Retry the login'])
    writeFileSync(join(root, 'b.txt'), 'new\n')
    git(['add', '.'])
    git(['commit', '-q', '-m', 'Bookkeeping'], MOUSSE_COMMIT_ENV)
    const summary = await new GitService().readBranchSummary(root, { branch: 'mousse/thread/t1/main', base: 'main', remote: null })
    expect(summary.commits).toEqual([{ subject: 'Retry the login', body: '', authorEmail: 'ada@example.com' }])
    expect(summary.stat).toContain('b.txt')
  })

  it('keeps a person\'s commit whatever its subject, and counts the limit after Mousse\'s own are left out', async () => {
    writeFileSync(join(root, 'a.txt'), 'two\n')
    git(['commit', '-q', '-am', 'mousse: rename the dessert module'])
    // Sixty checkpoints on top: a limit counted before the filter would leave nothing a person wrote.
    for (let index = 0; index < 60; index++) git(['commit', '-q', '--allow-empty', '-m', `mousse: checkpoint turn t-${index} (a${index})`], MOUSSE_COMMIT_ENV)
    const summary = await new GitService().readBranchSummary(root, { branch: 'mousse/thread/t1/main', base: 'main', remote: null })
    expect(summary.commits.map((commit) => commit.subject)).toEqual(['mousse: rename the dessert module'])
  })
})
