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
    { mode: 'build' as const, subagent: true },
    { mode: 'plan' as const, subagentDiscovery: true }
  ])('appends project instructions for $mode with subagent=$subagent subagentDiscovery=$subagentDiscovery', (options) => {
    const contents = '# Project rules\r\nUse the fixture conventions.\r\n'
    const root = project(contents)
    const prompt = buildOrchestratorSystemPrompt({ ...options, projectPath: root })
    expect(prompt.startsWith('You are the assistant inside Mousse')).toBe(true)
    expect(prompt.endsWith(`## Project instructions (AGENTS.md)\n${contents}`)).toBe(true)
  })

  it('preserves MOUSSE.md instructions while appending AGENTS.md', () => {
    const root = project('AGENTS RULES')
    mkdirSync(join(root, '.mousse'))
    writeFileSync(join(root, '.mousse', 'MOUSSE.md'), 'MOUSSE RULES')
    const prompt = buildOrchestratorSystemPrompt({ projectPath: root })
    expect(prompt.startsWith('MOUSSE RULES\n\n')).toBe(true)
    expect(prompt.endsWith('AGENTS RULES')).toBe(true)

    // Another project's MOUSSE.md never leaks into this prompt, and vice versa.
    const other = project('OTHER AGENTS')
    mkdirSync(join(other, '.mousse'))
    writeFileSync(join(other, '.mousse', 'MOUSSE.md'), 'OTHER MOUSSE')
    const otherPrompt = buildOrchestratorSystemPrompt({ projectPath: other })
    expect(otherPrompt.startsWith('OTHER MOUSSE\n\n')).toBe(true)
    expect(prompt).not.toContain('OTHER MOUSSE')
    expect(otherPrompt).not.toContain('MOUSSE RULES')
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
