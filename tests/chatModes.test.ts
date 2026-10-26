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
import { findInlineSkillToken, removeInlineSkillToken } from '../src/shared/channelCommands'
import { parseActions, stripActionBlocks, filterActionsForChatMode } from '../src/mms/orchestrator/actions'
import { buildOrchestratorSystemPrompt } from '../src/mms/orchestrator/systemPrompt'
import { BuildModeTools } from '../src/mms/orchestrator/BuildModeTools'
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

describe('BuildModeTools', () => {
  it('runs commands in the project root and blocks dangerous commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mousse-build-'))
    const tools = new BuildModeTools(new FileService(), new GitService())

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

describe('PiCodingTools', () => {
  it('exposes the full Pi SDK tool set and executes read/edit/grep/find/ls', async () => {
    const { PiCodingTools } = await import('../src/mms/orchestrator/PiCodingTools')
    const root = await mkdtemp(join(tmpdir(), 'mousse-pi-tools-'))
    const tools = new PiCodingTools()

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
