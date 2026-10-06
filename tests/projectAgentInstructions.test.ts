import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from '@earendil-works/pi-ai'
import { buildOrchestratorSystemPrompt } from '../src/mms/orchestrator/systemPrompt'
import { appendProjectAgentInstructions } from '../src/mms/orchestrator/projectInstructions'
import { AgentExecutionService } from '../src/mms/agentDefinitions/AgentExecutionService'
import { createNativeAgentRuntime } from '../src/mms/agentDefinitions/nativeRuntime'
import { createCliProcessRuntime } from '../src/mms/agentDefinitions/cliRuntime'
import { userMessage } from '../src/mms/orchestrator/nativeContext'
import {
  nativeClient, providerResponse, resolvedDefinition
} from './fixtures/agent-platform/agent-runtime-policy/helpers'

const roots: string[] = []
function project(instructions?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'mousse-project-agents-'))
  roots.push(root)
  if (instructions !== undefined) writeFileSync(join(root, 'AGENTS.md'), instructions)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('project AGENTS.md system instructions', () => {
  it.each([
    { mode: 'agent' as const },
    { mode: 'plan' as const },
    { mode: 'build' as const },
    { mode: { type: 'skill' as const, skillId: 'reviewer' } },
    { mode: 'agent' as const, providerId: 'cursor' },
    { mode: 'build' as const, subagent: true },
    { mode: 'plan' as const, subagentDiscovery: true },
    { mode: 'agent' as const, namedDelegation: true }
  ])('appends project instructions for $mode with $providerId/$subagent/$subagentDiscovery/$namedDelegation', (options) => {
    const contents = '# Project rules\r\nUse the fixture conventions.\r\n'
    const root = project(contents)
    const prompt = buildOrchestratorSystemPrompt({ ...options, projectPath: root })
    expect(prompt).toContain('You are the assistant inside Mousse')
    expect(prompt.endsWith(`## Project instructions (AGENTS.md)\n${contents}`)).toBe(true)
  })

  it('preserves MOUSSE.md instructions while appending AGENTS.md', () => {
    const root = project('AGENTS RULES')
    mkdirSync(join(root, '.mousse'))
    writeFileSync(join(root, '.mousse', 'MOUSSE.md'), 'MOUSSE RULES')
    const prompt = buildOrchestratorSystemPrompt({ projectPath: root })
    expect(prompt.startsWith('MOUSSE RULES\n\n')).toBe(true)
    expect(prompt.endsWith('AGENTS RULES')).toBe(true)
  })

  it('rereads updates and isolates project, worktree and projectless turns', () => {
    const root = project('PROJECT A')
    const worktree = project('WORKTREE B')
    expect(appendProjectAgentInstructions('base', root)).toContain('PROJECT A')
    writeFileSync(join(root, 'AGENTS.md'), 'UPDATED A')
    expect(appendProjectAgentInstructions('base', root)).toContain('UPDATED A')
    expect(appendProjectAgentInstructions('base', worktree)).not.toContain('UPDATED A')
    expect(appendProjectAgentInstructions('base', worktree)).toContain('WORKTREE B')
    expect(appendProjectAgentInstructions('base')).toBe('base')
  })

  it('tolerates missing, blank and unreadable instruction files', () => {
    const missing = project()
    const blank = project(' \n\t')
    const unreadable = project()
    mkdirSync(join(unreadable, 'AGENTS.md'))
    for (const root of [missing, blank, unreadable]) {
      expect(appendProjectAgentInstructions('base', root)).toBe('base')
    }
  })

  it('sends instructions to the actual ordinary LLM system channel and tracks them in context usage', async () => {
    const root = project('ORDINARY PROJECT INSTRUCTIONS')
    const captured: Context[] = []
    const llm = nativeClient([providerResponse([{ type: 'text', text: 'done' }], 'stop')], captured)
    const result = await llm.chat([userMessage('inspect')], undefined, { projectPath: root })
    expect(captured[0]?.systemPrompt).toContain('ORDINARY PROJECT INSTRUCTIONS')
    expect(result.contextInputs.systemPromptText).toContain('ORDINARY PROJECT INSTRUCTIONS')
    expect(captured[0]?.messages).toEqual([expect.objectContaining({ role: 'user', content: 'inspect' })])
  })

  it('sends instructions through the trusted agent-definition system prompt without duplicating them', async () => {
    const root = project('NAMED AGENT PROJECT INSTRUCTIONS')
    const captured: Context[] = []
    const llm = nativeClient([providerResponse([{ type: 'text', text: 'done' }], 'stop')], captured)
    const result = await new AgentExecutionService({ native: createNativeAgentRuntime(llm) }).run({
      profileId: 'profile-1', resolved: resolvedDefinition(), threadId: 'agent-thread',
      projectPath: root, input: 'inspect'
    })
    expect(result.status).toBe('completed')
    expect(captured[0]?.systemPrompt).toContain('You are a reviewer.')
    expect(captured[0]?.systemPrompt?.split('NAMED AGENT PROJECT INSTRUCTIONS')).toHaveLength(2)
    expect(captured[0]?.messages).toEqual([expect.objectContaining({ role: 'user', content: 'inspect' })])
  })

  it('passes the instruction file to the CLI adapter system channel rather than user input', async () => {
    const root = project('CLI PROJECT INSTRUCTIONS')
    const cli = createCliProcessRuntime({
      resolveInvocation: (input) => ({
        command: process.execPath,
        args: ['-e', "let s=''; process.stdin.on('data',c=>s+=c); process.stdin.on('end',()=>process.stdout.write(JSON.stringify({system:process.env.PROJECT_SYSTEM,input:s})))"],
        cwd: input.projectPath, env: { PROJECT_SYSTEM: input.systemPrompt }
      })
    })
    const result = await new AgentExecutionService({ cli: { codex: cli } }).run({
      profileId: 'profile-1', resolved: resolvedDefinition({ runtimeKind: 'codex' }),
      threadId: 'cli-thread', projectPath: root, input: 'inspect'
    })
    expect(result.status).toBe('completed')
    expect(JSON.parse(result.text)).toEqual({
      system: expect.stringContaining('CLI PROJECT INSTRUCTIONS'), input: 'inspect'
    })
  })

  it('uses the validated workspace root when the host omits projectPath', async () => {
    const root = project('WORKSPACE ROOT INSTRUCTIONS')
    let actualPrompt = ''
    const service = new AgentExecutionService({ native: { run: async (input) => {
      actualPrompt = input.systemPrompt
      return { text: 'done' }
    } } })
    const result = await service.run({
      profileId: 'profile-1', resolved: resolvedDefinition(), threadId: 'host-thread', input: 'inspect',
      host: { workspaceRoots: [root] }
    })
    expect(result.status).toBe('completed')
    expect(actualPrompt).toContain('WORKSPACE ROOT INSTRUCTIONS')
  })

  it('honors the agent definition setting that excludes project instructions', async () => {
    const root = project('EXCLUDED PROJECT INSTRUCTIONS')
    const resolved = resolvedDefinition()
    resolved.settings.context.includeProjectInstructions = false
    let actualPrompt = ''
    await new AgentExecutionService({ native: { run: async (input) => {
      actualPrompt = input.systemPrompt
      return { text: 'done' }
    } } }).run({
      profileId: 'profile-1', resolved, threadId: 'excluded-thread', projectPath: root, input: 'inspect'
    })
    expect(actualPrompt).not.toContain('EXCLUDED PROJECT INSTRUCTIONS')
  })
})
