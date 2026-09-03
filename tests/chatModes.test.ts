import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
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
import { parseActions, stripActionBlocks, filterActionsForChatMode } from '../src/mms/orchestrator/LlmClient'
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
    const actions = [
      { type: 'spawn_agents', agents: [] },
      { type: 'complete_task' },
      { type: 'message', content: 'ok' }
    ] as const
    const directMessage = [{ type: 'message', content: 'ok' }]

    expect(filterActionsForMode([...actions], 'build')).toEqual(directMessage)
    expect(filterActionsForMode([...actions], 'plan')).toEqual(directMessage)
    expect(filterActionsForMode([...actions], { type: 'skill', skillId: 'x' })).toEqual(directMessage)
    expect(filterActionsForChatMode([...actions], 'agent')).toHaveLength(3)
  })
})

describe('skill model settings', () => {
  it('deep merges default skill model map', () => {
    const defaults = getDefaultSettings()
    expect(defaults.integrations.skills.model).toEqual({})
  })

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

    expect(agentPrompt).toContain('"type": "spawn_agents"')
    expect(agentPrompt).toContain('present_plan')
    expect(agentPrompt).toContain('You decide whether to plan')
    expect(cursorAgentPrompt).not.toContain('"type": "spawn_agents"')
    expect(cursorAgentPrompt).toContain('official Mousse session configuration')
    expect(planPrompt).toContain('ask_user')
    expect(planPrompt).toContain('Do NOT call show_document')
    expect(planPrompt).toContain('markdown only')
    expect(buildPrompt).toContain('read')
    expect(buildPrompt).toContain('edit')
    expect(buildPrompt).toContain('grep')
    expect(buildPrompt).toContain('Do not spawn CLI agents')
    expect(buildPrompt).not.toContain('"type": "spawn_agents"')
    const skillPrompt = buildOrchestratorSystemPrompt({
      mode: { type: 'skill', skillId: 'reviewer' }
    })
    expect(skillPrompt).toContain('Do not spawn CLI agents')
    expect(skillPrompt).not.toContain('"type": "spawn_agents"')
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

  it('uses the base prompt when project MOUSSE.md is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mousse-project-prompt-'))

    try {
      const prompt = buildOrchestratorSystemPrompt({ mode: 'agent', projectPath: root })

      expect(prompt.startsWith('You are the assistant inside Mousse')).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps instructions isolated between projects', async () => {
    const first = await mkdtemp(join(tmpdir(), 'mousse-project-prompt-'))
    const second = await mkdtemp(join(tmpdir(), 'mousse-project-prompt-'))
    const firstInstructions = 'FIRST PROJECT ONLY'
    const secondInstructions = 'SECOND PROJECT ONLY'

    try {
      await Promise.all([mkdir(join(first, '.mousse')), mkdir(join(second, '.mousse'))])
      await writeFile(join(first, '.mousse', 'MOUSSE.md'), firstInstructions, 'utf-8')
      await writeFile(join(second, '.mousse', 'MOUSSE.md'), secondInstructions, 'utf-8')

      const firstPrompt = buildOrchestratorSystemPrompt({ mode: 'agent', projectPath: first })
      const secondPrompt = buildOrchestratorSystemPrompt({ mode: 'agent', projectPath: second })

      expect(firstPrompt.startsWith(firstInstructions)).toBe(true)
      expect(firstPrompt).not.toContain(secondInstructions)
      expect(secondPrompt.startsWith(secondInstructions)).toBe(true)
      expect(secondPrompt).not.toContain(firstInstructions)
    } finally {
      await rm(first, { recursive: true, force: true })
      await rm(second, { recursive: true, force: true })
    }
  })

  it('executes only dedicated orchestration blocks and strips them', () => {
    const response = `Here is the plan.

\`\`\`mousse-actions
{ "actions": [ { "type": "spawn_agents", "agents": [] } ] }
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
      'Spawning workers.',
      '',
      '```mousse-actions',
      JSON.stringify({
        actions: [
          {
            type: 'spawn_agents',
            agents: [
              { cliType: 'mousse', task: nestedTask },
              { cliType: 'mousse', task: 'Second worker without fences.' }
            ]
          }
        ]
      }),
      '```',
      '',
      'Waiting for settle.'
    ].join('\n')

    const actions = parseActions(response)
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      type: 'spawn_agents',
      agents: [
        { cliType: 'mousse', task: nestedTask },
        { cliType: 'mousse', task: 'Second worker without fences.' }
      ]
    })
    expect(stripActionBlocks(response).replace(/\n{2,}/g, '\n\n')).toBe(
      'Spawning workers.\n\nWaiting for settle.'
    )
  })

  it('extracts skill id from skill chat mode', () => {
    expect(getSkillIdFromMode({ type: 'skill', skillId: 'canvas' })).toBe('canvas')
    expect(getSkillIdFromMode('agent')).toBeUndefined()
  })
})

describe('subagent composer slash handling', () => {
  it('treats /skills as literal text in the subagent composer', () => {
    // Regression: typing `/skills ...` in an agent chat switched the global
    // chat mode (via applySkill) and swallowed the message instead of sending
    // the prompt to the agent.
    const composer = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/ChatComposer.tsx'),
      'utf8'
    )
    expect(composer).toMatch(/disableSkillsPicker\?: boolean/)
    // Disabled by default for subagent composers (hideModePicker).
    expect(composer).toMatch(/disableSkillsPicker \?\? hideModePicker/)
    // No skills picker, no /skills suggestion, Enter sends literally.
    expect(composer).toMatch(/skillsPickerDisabled \? null : parseSkillsPickerQuery\(input\)/)
    expect(composer).toMatch(/command\.name !== 'skills'/)

    const agentChat = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/MousseAgentChat.tsx'),
      'utf8'
    )
    expect(agentChat).toMatch(/disableSkillsPicker/)
  })
})

describe('skill chip', () => {
  it('embeds a picked skill as an inline @token without touching the global mode', () => {
    // Selecting a skill turns `/skills X` into an inline `@skill` token that
    // lives in the typed text (painted as a pill by the input backdrop); the
    // skill mode applies to the submitted prompt only (send-time override),
    // never by flipping the global chat mode on selection.
    const composer = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/ChatComposer.tsx'),
      'utf8'
    )
    // Token is embedded in the text (picker command replaced / caret insert),
    // painted inline by the backdrop — no detached chip state.
    expect(composer).toMatch(/findInlineSkillToken\(input, enabledSkills\)/)
    expect(composer).toMatch(/composer-input-backdrop/)
    expect(composer).toMatch(/composer-token-chip/)
    expect(composer).toMatch(/@\$\{name\}/)
    expect(composer).not.toMatch(/pendingSkillId/)
    // Selection never switches the mode here.
    const applySkill = composer.slice(composer.indexOf('const applySkill'))
    expect(applySkill.slice(0, applySkill.indexOf('\n  }'))).not.toMatch(/onChatModeChange/)
    // Submit forwards the token as a one-shot override.
    expect(composer).toMatch(/onSend: \(skillMode\?: SkillChatMode\) => void/)
    // A lone token is not a prompt: sendability is judged on text minus token.
    expect(composer).toMatch(/removeInlineSkillToken\(input/)

    const shared = readFileSync(
      resolve(process.cwd(), 'src/shared/channelCommands.ts'),
      'utf8'
    )
    expect(shared).toMatch(/findInlineSkillToken/)
    expect(shared).toMatch(/removeInlineSkillToken/)

    const orchestrator = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/OrchestratorChat.tsx'),
      'utf8'
    )
    expect(orchestrator).toMatch(/handleSend = async \(skillMode\?: SkillChatMode\)/)
    expect(orchestrator).toMatch(/sendMessage\(text, skillMode \?\? chatMode, images\)/)
    // The daemon never sees the `@skill` marker: it is stripped from content,
    // the skill travels as the mode override.
    expect(orchestrator).toMatch(/removeInlineSkillToken\(raw, enabledSkills\)/)
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
