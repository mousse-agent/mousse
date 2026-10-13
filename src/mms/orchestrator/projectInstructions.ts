import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Read the active workspace on each turn so instructions never leak between projects. */
export function readProjectAgentInstructions(projectPath?: string): string | undefined {
  if (!projectPath?.trim()) return undefined
  try {
    const content = readFileSync(join(projectPath, 'AGENTS.md'), 'utf8')
    return content.trim() ? content : undefined
  } catch {
    // Project instructions are optional; missing or unreadable files cannot block a turn.
    return undefined
  }
}

/** The labeled AGENTS.md block for a system prompt, or undefined when the project has none. */
export function projectAgentInstructionsSection(projectPath?: string): string | undefined {
  const instructions = readProjectAgentInstructions(projectPath)
  return instructions ? `## Project instructions (AGENTS.md)\n${instructions}` : undefined
}

export function appendProjectAgentInstructions(systemPrompt: string, projectPath?: string): string {
  const section = projectAgentInstructionsSection(projectPath)
  return section ? `${systemPrompt}\n\n${section}` : systemPrompt
}
