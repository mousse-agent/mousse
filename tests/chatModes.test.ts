import { describe, expect, it } from 'vitest'
import {
  allowsOrchestrationActions,
  filterActionsForMode,
  getChatModeLabel,
  getSkillIdFromMode,
  normalizeChatMode
} from '../src/shared/chatMode'
import {
  getDefaultSettings,
  resolveModelForMode,
  resolveSkillModelSettings
} from '../src/shared/settings'
import {
  applyMentionPick,
  findInlineSkillToken,
  findMentionQueryAtCaret,
  isImeComposing,
  isMentionResultCurrent,
  joinMentionPath,
  mentionItemReference,
  mergeMentionSuggestions,
  moveSelection,
  pickerKeyAction,
  removeInlineSkillToken
} from '../src/shared/channelCommands'
import { fileWorkspaceScope } from '../src/renderer/stores/filesStore'
import { formatChatReferences, parseChatReference } from '../src/shared/chatReferences'
import { parseActions, stripActionBlocks, filterActionsForChatMode } from '../src/mms/orchestrator/actions'
import { buildOrchestratorSystemPrompt } from '../src/mms/orchestrator/systemPrompt'
import { ProjectGitTools } from '../src/mms/workflows/tools/ProjectGitTools'
import { FileService } from '../src/mms/files/FileService'
import { GitService } from '../src/mms/git/GitService'
import { mkdir, mkdtemp, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

describe('chat mode helpers', () => {
  it('normalizes missing mode to agent', () => {
    expect(normalizeChatMode()).toBe('agent')
    expect(normalizeChatMode('plan')).toBe('plan')
    expect(normalizeChatMode({ type: 'skill', skillId: 'reviewer' })).toEqual({
      type: 'skill',
      skillId: 'reviewer'
    })
  })

  it('labels built-in and skill modes', () => {
    expect(getChatModeLabel('build')).toBe('Build')
    expect(getChatModeLabel({ type: 'skill', skillId: 'x' }, 'Reviewer')).toBe('Reviewer')
  })

  it('allows orchestration only in agent mode', () => {
    expect(allowsOrchestrationActions('agent')).toBe(true)
    expect(allowsOrchestrationActions('build')).toBe(false)
    expect(allowsOrchestrationActions('plan')).toBe(false)
    expect(allowsOrchestrationActions({ type: 'skill', skillId: 'x' })).toBe(false)
  })

  it('filters orchestration actions from every mode except agent', () => {
    // spawn_agents is retired (SPEC §14.5); complete_task is the remaining orchestration action.
    const actions = [
      { type: 'complete_task' },
      { type: 'message', content: 'ok' }
    ] as const
    const directMessage = [{ type: 'message', content: 'ok' }]

    expect(filterActionsForMode([...actions], 'build')).toEqual(directMessage)
    expect(filterActionsForMode([...actions], 'plan')).toEqual(directMessage)
    expect(filterActionsForMode([...actions], { type: 'skill', skillId: 'x' })).toEqual(directMessage)
    expect(filterActionsForChatMode([...actions], 'agent')).toHaveLength(2)
  })
})

describe('skill model settings', () => {
  it('resolves per-skill model when provider is connected', () => {
    const settings = getDefaultSettings()
    settings.integrations.skills.model.reviewer = {
      llmProvider: 'openai',
      model: 'gpt-4.1'
    }
    settings.provider = { llmProvider: 'anthropic', model: 'claude-sonnet-4' }

    expect(resolveSkillModelSettings(settings, 'reviewer')).toEqual({
      llmProvider: 'openai',
      model: 'gpt-4.1'
    })
    expect(resolveModelForMode(settings, { type: 'skill', skillId: 'reviewer' }, ['openai'])).toEqual({
      llmProvider: 'openai',
      model: 'gpt-4.1'
    })
  })

  it('falls back to global orchestrator model when skill provider is disconnected', () => {
    const settings = getDefaultSettings()
    settings.integrations.skills.model.reviewer = {
      llmProvider: 'openai',
      model: 'gpt-4.1'
    }
    settings.provider = { llmProvider: 'anthropic', model: 'claude-sonnet-4' }

    expect(resolveModelForMode(settings, { type: 'skill', skillId: 'reviewer' }, ['anthropic'])).toEqual({
      llmProvider: 'anthropic',
      model: 'claude-sonnet-4'
    })
  })
})

describe('mode-aware prompts and plan output', () => {
  it('builds distinct system prompts per mode', () => {
    const agentPrompt = buildOrchestratorSystemPrompt({ mode: 'agent' })
    const cursorAgentPrompt = buildOrchestratorSystemPrompt({ mode: 'agent', providerId: 'cursor' })
    const planPrompt = buildOrchestratorSystemPrompt({ mode: 'plan' })
    const buildPrompt = buildOrchestratorSystemPrompt({ mode: 'build' })

    // Delegation is the delegate_task tool family, appended when the turn has the tools.
    expect(agentPrompt).not.toContain('spawn_agents')
    expect(agentPrompt).toContain('"type": "complete_task"')
    expect(agentPrompt).toContain('present_plan')
    expect(agentPrompt).toContain('You decide whether to plan')
    expect(cursorAgentPrompt).not.toContain('"type": "complete_task"')
    expect(cursorAgentPrompt).toContain('official Mousse session configuration')
    expect(planPrompt).toContain('ask_user')
    expect(planPrompt).toContain('Do NOT call show_document')
    expect(planPrompt).toContain('markdown only')
    expect(buildPrompt).toContain('read')
    expect(buildPrompt).toContain('edit')
    expect(buildPrompt).toContain('grep')
    expect(buildPrompt).toContain('Do not emit complete_task')
    expect(buildPrompt).not.toContain('"type": "complete_task"')
    const skillPrompt = buildOrchestratorSystemPrompt({
      mode: { type: 'skill', skillId: 'reviewer' }
    })
    expect(skillPrompt).toContain('Do not emit complete_task')
    expect(skillPrompt).not.toContain('"type": "complete_task"')
  })

  it('prepends project MOUSSE.md instructions when present', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mousse-project-prompt-'))
    const instructions = '# Project instructions\nAlways use project conventions.'

    try {
      await mkdir(join(root, '.mousse'))
      await writeFile(join(root, '.mousse', 'MOUSSE.md'), instructions, 'utf-8')
      const prompt = buildOrchestratorSystemPrompt({ mode: 'agent', projectPath: root })

      expect(prompt.startsWith(instructions)).toBe(true)
      expect(prompt).toContain('You are the assistant inside Mousse')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('executes only dedicated orchestration blocks and strips them', () => {
    const response = `Here is the plan.

\`\`\`mousse-actions
{ "actions": [ { "type": "complete_task", "agentIds": ["agent-1"] } ] }
\`\`\``

    expect(parseActions(response)).toHaveLength(1)
    expect(stripActionBlocks(response)).toBe('Here is the plan.')
  })

  it('trims edge whitespace so raw stream snapshots dedupe against display text', () => {
    // OrchestratorService folds a completed stream into the final message by
    // comparing stripped-to-stripped; a raw trailing newline must not append
    // a visually identical twin message.
    expect(stripActionBlocks('Here is the plan.\n')).toBe('Here is the plan.')
    expect(stripActionBlocks('\n  Here is the plan.  \n')).toBe('Here is the plan.')
  })

  it('never executes ordinary or inline JSON examples', () => {
    const fenced = `Example only:\n\`\`\`json\n{ "actions": [{ "type": "spawn_agents", "agents": [] }] }\n\`\`\``
    const inline = `Example: { "actions": [{ "type": "complete_task", "agentIds": ["a"], "merge": true }] }`

    expect(parseActions(fenced)).toEqual([])
    expect(parseActions(inline)).toEqual([])
    expect(stripActionBlocks(fenced)).toBe(fenced)
    expect(stripActionBlocks(inline)).toBe(inline)
  })

  it('requires explicit targets for completion actions', () => {
    const unsafe = `\`\`\`mousse-actions\n{ "actions": [{ "type": "complete_task", "merge": true }] }\n\`\`\``
    const targeted = `\`\`\`mousse-actions\n{ "actions": [{ "type": "complete_task", "agentIds": ["agent-1"], "merge": true }] }\n\`\`\``

    expect(parseActions(unsafe)).toEqual([])
    expect(parseActions(targeted)).toEqual([
      { type: 'complete_task', agentIds: ['agent-1'], merge: true }
    ])
  })

  it('parses mousse-actions when task strings contain nested markdown fences', () => {
    const nestedTask =
      'Honor this contract:\n```ts\nexport type IssueStatus = \'open\'\n```\nThen implement domain.'
    const response = [
      'Recording the contract.',
      '',
      '```mousse-actions',
      JSON.stringify({
        actions: [
          { type: 'message', content: nestedTask },
          { type: 'message', content: 'Second note without fences.' }
        ]
      }),
      '```',
      '',
      'Waiting for settle.'
    ].join('\n')

    const actions = parseActions(response)
    expect(actions).toEqual([
      { type: 'message', content: nestedTask },
      { type: 'message', content: 'Second note without fences.' }
    ])
    expect(stripActionBlocks(response).replace(/\n{2,}/g, '\n\n')).toBe(
      'Recording the contract.\n\nWaiting for settle.'
    )
  })

  it('extracts skill id from skill chat mode', () => {
    expect(getSkillIdFromMode({ type: 'skill', skillId: 'canvas' })).toBe('canvas')
    expect(getSkillIdFromMode('agent')).toBeUndefined()
  })
})

describe('inline skill token', () => {
  const skills = [
    { id: 'review', name: 'review' },
    { id: 'reviewer', name: 'Reviewer' }
  ]

  it('finds a token on boundaries, preferring the longest skill name', () => {
    expect(findInlineSkillToken('please @reviewer check this', skills)).toEqual({
      index: 7,
      length: 9,
      skillId: 'reviewer'
    })
    expect(findInlineSkillToken('@review, then ship', skills)).toMatchObject({ index: 0, skillId: 'review' })
    expect(findInlineSkillToken('mail me@review now', skills)).toBeNull()
    expect(findInlineSkillToken('@unknown skill', skills)).toBeNull()
  })

  it('strips the token before the text is sent, so the daemon never sees the marker', () => {
    expect(removeInlineSkillToken('please @reviewer check this', skills)).toBe('please  check this')
    expect(removeInlineSkillToken('no token here', skills)).toBe('no token here')
    // A lone token leaves no prompt text.
    expect(removeInlineSkillToken('@review', skills).trim()).toBe('')
  })
})

describe('composer mentions', () => {
  const review = { id: 'review', name: 'review', description: 'Review a change' }
  const skills = [
    { id: 'plan', name: 'plan', description: 'Plan work, then review it' },
    review,
    { id: 'reviewer', name: 'reviewer', description: 'Second opinion' }
  ]
  const file = (path: string, kind: 'file' | 'directory' = 'file', positions: number[] = []) => ({ path, kind, positions })

  describe('findMentionQueryAtCaret', () => {
    it('opens at the start of the text, after a space and after an opening bracket or quote', () => {
      expect(findMentionQueryAtCaret('@src', 4)).toEqual({ index: 0, query: 'src' })
      expect(findMentionQueryAtCaret('look at @src/ma', 15)).toEqual({ index: 8, query: 'src/ma' })
      expect(findMentionQueryAtCaret('(@src', 5)).toEqual({ index: 1, query: 'src' })
      expect(findMentionQueryAtCaret('see "@src', 9)).toEqual({ index: 5, query: 'src' })
      expect(findMentionQueryAtCaret('line one\n@src', 13)).toEqual({ index: 9, query: 'src' })
      expect(findMentionQueryAtCaret('@', 1)).toEqual({ index: 0, query: '' })
    })

    it('stays closed inside words, emails and code', () => {
      expect(findMentionQueryAtCaret('me@review', 9)).toBeNull()
      expect(findMentionQueryAtCaret('a@b.com', 7)).toBeNull()
      expect(findMentionQueryAtCaret('@scope/pkg(', 11)).toBeNull()
      expect(findMentionQueryAtCaret('@Injectable(', 12)).toBeNull()
      expect(findMentionQueryAtCaret('`@src', 5)).toBeNull()
      expect(findMentionQueryAtCaret('x@@src', 6)).toBeNull()
      expect(findMentionQueryAtCaret('no mention here', 15)).toBeNull()
    })

    it('stays closed inside an unclosed code fence and opens again after it closes', () => {
      expect(findMentionQueryAtCaret('```ts\n@src', 10)).toBeNull()
      expect(findMentionQueryAtCaret('```ts\ncode\n```\n@src', 19)).toEqual({ index: 15, query: 'src' })
    })

    it('ends at whitespace and reads only the part before the caret', () => {
      expect(findMentionQueryAtCaret('@src x', 6)).toBeNull()
      expect(findMentionQueryAtCaret('@src/ma', 4)).toEqual({ index: 0, query: 'src' })
      expect(findMentionQueryAtCaret('@src/main.ts tail', 7)).toEqual({ index: 0, query: 'src/ma' })
    })

    it('ignores a caret that is not a position (a selected range reports -1)', () => {
      expect(findMentionQueryAtCaret('@src', -1)).toBeNull()
      expect(findMentionQueryAtCaret('@src', 99)).toEqual({ index: 0, query: 'src' })
    })

    it('keeps listing files while the caret is at the end of a complete skill name', () => {
      expect(findMentionQueryAtCaret('@review', 7)).toEqual({ index: 0, query: 'review' })
      expect(findInlineSkillToken('@review', skills)).toMatchObject({ skillId: 'review' })
      expect(findMentionQueryAtCaret('@review ', 8)).toBeNull()
    })
  })

  describe('ranking and filtering', () => {
    it('lists skills first, then files in the order the daemon ranked them', () => {
      const items = mergeMentionSuggestions(skills, [file('src/a.ts'), file('docs', 'directory'), file('b.md')], { query: '' })
      expect(items.map((item) => (item.kind === 'skill' ? `skill:${item.skill.id}` : item.path))).toEqual([
        'skill:plan',
        'skill:review',
        'skill:reviewer',
        'src/a.ts',
        'docs',
        'b.md'
      ])
    })

    it('filters skills by the query and puts an exact name first of all', () => {
      const items = mergeMentionSuggestions(skills, [file('review.md')], { query: 'review' })
      expect(items.map((item) => (item.kind === 'skill' ? `skill:${item.skill.id}` : item.path))).toEqual([
        'skill:review',
        'skill:reviewer',
        'skill:plan',
        'review.md'
      ])
      // Matches on a name come before matches on a description only.
      expect(items[2]).toMatchObject({ kind: 'skill', skill: { id: 'plan' } })
      expect(mergeMentionSuggestions(skills, [], { query: 'zzz' })).toEqual([])
    })

    it('caps skills at five and the whole list at the limit, and keeps file order', () => {
      const many = Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, name: `s${i}`, description: '' }))
      const files = Array.from({ length: 30 }, (_, i) => file(`f${i}.ts`))
      const capped = mergeMentionSuggestions(many, files, { query: '' })
      expect(capped.filter((item) => item.kind === 'skill')).toHaveLength(5)
      expect(capped).toHaveLength(20)
      expect(capped.slice(5).map((item) => (item.kind === 'skill' ? '' : item.path))).toEqual(files.slice(0, 15).map((f) => f.path))
      expect(mergeMentionSuggestions(many, files, { query: '', maxSkills: 2, limit: 4 })).toHaveLength(4)
    })

    it('lists a skill and a file with the same name side by side, skill first', () => {
      const items = mergeMentionSuggestions([review], [file('review.md')], { query: 'review' })
      expect(items).toHaveLength(2)
      expect(items[0]).toMatchObject({ kind: 'skill' })
      expect(items[1]).toMatchObject({ kind: 'file', path: 'review.md' })
    })

    it('carries match positions through for highlighting', () => {
      const [item] = mergeMentionSuggestions([], [file('src/main.ts', 'file', [4, 5])])
      expect(item).toEqual({ kind: 'file', path: 'src/main.ts', positions: [4, 5] })
    })
  })

  describe('inserting a pick', () => {
    it('inserts the same skill token typing it would leave', () => {
      const edit = applyMentionPick('please @revi', { index: 7, end: 12 }, '@review ')
      expect(edit).toEqual({ value: 'please @review ', caret: 15 })
      expect(findInlineSkillToken(edit.value, skills)).toEqual(findInlineSkillToken('please @review ', skills))
      expect(findInlineSkillToken(edit.value, skills)).toMatchObject({ index: 7, skillId: 'review' })
      // The picker is closed once the token is complete and followed by a space.
      expect(findMentionQueryAtCaret(edit.value, edit.caret)).toBeNull()
    })

    it('removes the typed query for a file or folder and collapses the doubled space', () => {
      expect(applyMentionPick('look at @src now', { index: 8, end: 12 }, '')).toEqual({ value: 'look at now', caret: 8 })
      expect(applyMentionPick('@src and more', { index: 0, end: 4 }, '')).toEqual({ value: 'and more', caret: 0 })
      expect(applyMentionPick('fix @src', { index: 4, end: 8 }, '')).toEqual({ value: 'fix ', caret: 4 })
      expect(applyMentionPick('a\n@src b', { index: 2, end: 6 }, '')).toEqual({ value: 'a\nb', caret: 2 })
    })

    it('does not swallow text that is not a space and replaces only up to the caret', () => {
      expect(applyMentionPick('see(@src)', { index: 4, end: 8 }, '')).toEqual({ value: 'see()', caret: 4 })
      expect(applyMentionPick('go @sr tail', { index: 3, end: 6 }, '@review ')).toEqual({ value: 'go @review tail', caret: 11 })
    })

    it('builds a file reference under the daemon root, not the project', () => {
      const reference = mentionItemReference(
        { kind: 'file', path: 'src/My App/index (1).ts', positions: [] },
        'C:\\repo\\.mousse-worktrees\\t1\\',
        { threadId: 't1', projectId: 'p1' },
        'file:1'
      )
      expect(reference).toEqual({
        id: 'file:1',
        kind: 'file',
        title: 'index (1).ts',
        path: 'C:\\repo\\.mousse-worktrees\\t1/src/My App/index (1).ts',
        threadId: 't1',
        projectId: 'p1'
      })
      expect(parseChatReference(reference)).toMatchObject({ kind: 'file', path: reference.path })
    })

    it('builds a folder reference for a directory result and formats its path for the agent', () => {
      const reference = mentionItemReference(
        { kind: 'directory', path: 'src/shared/', positions: [] },
        '/repo',
        { projectId: 'p1' },
        'directory:1'
      )
      expect(reference).toMatchObject({ kind: 'folder', title: 'shared', path: '/repo/src/shared', projectId: 'p1' })
      expect(reference.threadId).toBeUndefined()
      const block = formatChatReferences([reference])
      expect(block).toContain('- folder: "shared"')
      expect(block).toContain('Path: /repo/src/shared')
      expect(joinMentionPath('/repo/', '/a.ts')).toBe('/repo/a.ts')
    })
  })

  describe('result ownership', () => {
    const scope = fileWorkspaceScope('profile', 'thread-a', 'project-1')

    it('accepts a result only for the same scope and the same query', () => {
      expect(isMentionResultCurrent({ scopeKey: scope, query: 'src' }, { scopeKey: scope, query: 'src' })).toBe(true)
      expect(isMentionResultCurrent({ scopeKey: scope, query: 'sr' }, { scopeKey: scope, query: 'src' })).toBe(false)
    })

    it('rejects a result from another thread, or from another project in the blank composer', () => {
      const other = fileWorkspaceScope('profile', 'thread-b', 'project-1')
      expect(isMentionResultCurrent({ scopeKey: scope, query: 'src' }, { scopeKey: other, query: 'src' })).toBe(false)
      const blankA = fileWorkspaceScope('profile', null, 'project-1')
      const blankB = fileWorkspaceScope('profile', null, 'project-2')
      expect(isMentionResultCurrent({ scopeKey: blankA, query: 'src' }, { scopeKey: blankB, query: 'src' })).toBe(false)
    })

    it('drops a late response once the query or scope moved on', async () => {
      // The composer keeps one "current" value and checks it when a response arrives.
      let current = { scopeKey: scope, query: 'sr' }
      let resolveFirst!: (value: string[]) => void
      const first = new Promise<string[]>((resolve) => { resolveFirst = resolve })
      const requested = { ...current }
      const kept: string[][] = []
      const arrival = first.then((rows) => {
        if (isMentionResultCurrent(requested, current)) kept.push(rows)
      })
      current = { scopeKey: scope, query: 'src' }
      resolveFirst(['stale.ts'])
      await arrival
      expect(kept).toEqual([])
    })
  })

  describe('keyboard selection', () => {
    it('moves with the arrows, wrapping at both ends', () => {
      expect(moveSelection(0, 'ArrowDown', 3)).toBe(1)
      expect(moveSelection(2, 'ArrowDown', 3)).toBe(0)
      expect(moveSelection(0, 'ArrowUp', 3)).toBe(2)
      expect(moveSelection(2, 'ArrowUp', 3)).toBe(1)
    })

    it('moves by eight with the page keys, jumps with Home and End, and clamps', () => {
      expect(moveSelection(0, 'PageDown', 20)).toBe(8)
      expect(moveSelection(15, 'PageDown', 20)).toBe(19)
      expect(moveSelection(10, 'PageUp', 20)).toBe(2)
      expect(moveSelection(3, 'PageUp', 20)).toBe(0)
      expect(moveSelection(7, 'Home', 20)).toBe(0)
      expect(moveSelection(7, 'End', 20)).toBe(19)
      expect(moveSelection(5, 'ArrowDown', 0)).toBe(0)
      expect(moveSelection(9, 'x', 4)).toBe(3)
    })

    it('maps keys to picker actions: move, pick with Enter and Tab, dismiss with Escape', () => {
      const options = { count: 4 }
      expect(pickerKeyAction({ key: 'ArrowDown' }, options)).toEqual({ type: 'move', key: 'ArrowDown' })
      expect(pickerKeyAction({ key: 'PageUp' }, options)).toEqual({ type: 'move', key: 'PageUp' })
      expect(pickerKeyAction({ key: 'Home' }, options)).toEqual({ type: 'move', key: 'Home' })
      expect(pickerKeyAction({ key: 'End' }, options)).toEqual({ type: 'move', key: 'End' })
      expect(pickerKeyAction({ key: 'Enter' }, options)).toEqual({ type: 'pick' })
      expect(pickerKeyAction({ key: 'Tab' }, options)).toEqual({ type: 'pick' })
      expect(pickerKeyAction({ key: 'Escape' }, options)).toEqual({ type: 'dismiss' })
    })

    it('leaves Shift+Enter, Shift+Tab, modified navigation and ordinary keys to the text box', () => {
      const options = { count: 4 }
      expect(pickerKeyAction({ key: 'Enter', shiftKey: true }, options)).toBeNull()
      expect(pickerKeyAction({ key: 'Tab', shiftKey: true }, options)).toBeNull()
      expect(pickerKeyAction({ key: 'Home', ctrlKey: true }, options)).toBeNull()
      expect(pickerKeyAction({ key: 'ArrowDown', shiftKey: true }, options)).toBeNull()
      expect(pickerKeyAction({ key: 'a' }, options)).toBeNull()
      expect(pickerKeyAction({ key: 'Backspace' }, options)).toBeNull()
    })

    it('with no rows lets Enter send the text, while Escape still dismisses', () => {
      expect(pickerKeyAction({ key: 'Enter' }, { count: 0 })).toBeNull()
      expect(pickerKeyAction({ key: 'ArrowDown' }, { count: 0 })).toBeNull()
      expect(pickerKeyAction({ key: 'Tab' }, { count: 0 })).toBeNull()
      expect(pickerKeyAction({ key: 'Escape' }, { count: 0 })).toEqual({ type: 'dismiss' })
    })

    it('with no rows the skills list keeps swallowing Enter and the arrows', () => {
      const options = { count: 0, swallowWhenEmpty: true }
      expect(pickerKeyAction({ key: 'Enter' }, options)).toEqual({ type: 'swallow' })
      expect(pickerKeyAction({ key: 'ArrowUp' }, options)).toEqual({ type: 'swallow' })
      expect(pickerKeyAction({ key: 'Tab' }, options)).toBeNull()
    })
  })

  describe('input method composition', () => {
    it('does nothing for any key while composing, so committing text never picks', () => {
      for (const key of ['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'Home', 'PageDown']) {
        expect(pickerKeyAction({ key, isComposing: true }, { count: 4 })).toBeNull()
      }
    })

    it('treats keyCode 229 as composing, which is how Safari reports the committing Enter', () => {
      expect(isImeComposing({ isComposing: false, keyCode: 229 })).toBe(true)
      expect(isImeComposing({ isComposing: true, keyCode: 13 })).toBe(true)
      expect(isImeComposing({ isComposing: false, keyCode: 13 })).toBe(false)
      expect(isImeComposing({})).toBe(false)
      expect(pickerKeyAction({ key: 'Enter', isComposing: false, keyCode: 229 }, { count: 4 })).toBeNull()
    })

    it('picks again once composition ends', () => {
      expect(pickerKeyAction({ key: 'Enter', isComposing: false, keyCode: 13 }, { count: 4 })).toEqual({ type: 'pick' })
    })

    it('still finds the query in text an input method has already committed', () => {
      expect(findMentionQueryAtCaret('看看 @文档', 6)).toEqual({ index: 3, query: '文档' })
    })
  })
})

describe('ProjectGitTools', () => {
  it('runs commands in the project root and blocks dangerous commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mousse-build-'))
    const tools = new ProjectGitTools(new FileService(), new GitService())

    try {
      await writeFile(join(root, 'marker.txt'), 'hello', 'utf-8')

      const readResult = await tools.execute('read_file', { path: 'marker.txt' }, root)
      expect(readResult.isError).toBe(false)
      expect(readResult.text).toBe('hello')

      const blocked = await tools.runCommand(root, 'rm', ['-rf', '/'])
      expect(blocked.isError).toBe(true)
      expect(blocked.text).toContain('Blocked command')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('ProjectFileTools', () => {
  it('exposes the full Pi SDK tool set and executes read/edit/grep/find/ls', async () => {
    const { ProjectFileTools } = await import('../src/mms/workflows/tools/ProjectFileTools')
    const root = await mkdtemp(join(tmpdir(), 'mousse-pi-tools-'))
    const tools = new ProjectFileTools()

    try {
      await writeFile(join(root, 'marker.txt'), 'hello world\nsecond line\n', 'utf-8')

      const defs = await tools.getToolDefinitions(root, 'all')
      expect(defs.map((t) => t.name).sort()).toEqual(
        ['bash', 'edit', 'find', 'grep', 'ls', 'read', 'write'].sort()
      )

      const readResult = await tools.execute('read', { path: 'marker.txt' }, root)
      expect(readResult.isError).toBe(false)
      expect(readResult.text).toContain('hello world')

      const abort = new AbortController()
      abort.abort()
      const abortedRead = await tools.execute(
        'read',
        { path: 'marker.txt' },
        root,
        'cancelled-call',
        abort.signal
      )
      expect(abortedRead.isError).toBe(true)
      expect(abortedRead.text).toMatch(/abort/i)

      const editResult = await tools.execute(
        'edit',
        { path: 'marker.txt', edits: [{ oldText: 'hello', newText: 'hi' }] },
        root
      )
      expect(editResult.isError).toBe(false)

      const grepResult = await tools.execute('grep', { pattern: 'hi world', path: '.' }, root)
      expect(grepResult.isError).toBe(false)
      expect(grepResult.text).toContain('marker.txt')

      const findResult = await tools.execute('find', { pattern: 'marker.txt' }, root)
      expect(findResult.isError).toBe(false)
      expect(findResult.text).toContain('marker.txt')

      const lsResult = await tools.execute('ls', { path: '.' }, root)
      expect(lsResult.isError).toBe(false)
      expect(lsResult.text).toContain('marker.txt')

      // Legacy aliases still work
      const legacy = await tools.execute('read_file', { path: 'marker.txt' }, root)
      expect(legacy.isError).toBe(false)
      expect(legacy.text).toContain('hi world')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
