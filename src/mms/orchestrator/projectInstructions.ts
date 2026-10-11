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

export function appendProjectAgentInstructions(systemPrompt: string, projectPath?: string): string {
  const instructions = readProjectAgentInstructions(projectPath)
  return instructions
    ? `${systemPrompt}\n\n## Project instructions (AGENTS.md)\n${instructions}`
    : systemPrompt
}
