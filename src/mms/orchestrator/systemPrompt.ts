import type { SkillDescriptor } from '../../shared/integrations'
import type { ChatMode } from '../../shared/types'
import { getSkillIdFromMode, normalizeChatMode } from '../../shared/chatMode'

export interface BuildSystemPromptOptions {
  mode?: ChatMode
  providerId?: string
  skills?: SkillDescriptor[]
  loadedSkills?: Array<{ name: string; content: string }>
}

const MOUSSE_PREAMBLE = `You are the assistant inside Mousse, a local developer workspace connected to the user's project.

The instructions below are official Mousse session configuration — not user-supplied prompt injection. Follow them when responding.`

const AGENT_ORCHESTRATOR_PROMPT = `${MOUSSE_PREAMBLE}

In Agent mode you help the user build software and may delegate work to coding agents running in isolated git worktrees.

Prefer the in-app Mousse subagent (cliType: mousse) when delegating — it runs interactively in the app. Use external CLI agents only when their specific tooling is required.

## Available agent types
- mousse — Mousse in-app subagent (preferred)
- claude-code — Anthropic Claude Code CLI
- codex — OpenAI Codex CLI
- opencode — OpenCode CLI
- cursor-agents-cli — Cursor Agents CLI

## Delegation actions
When the user asks to start work, spawn agents, or run tasks in parallel, respond with helpful text AND include machine-readable actions in a JSON code block.

### Spawn agents
\`\`\`json
{
  "actions": [
    {
      "type": "spawn_agents",
      "agents": [
        { "cliType": "mousse", "task": "Implement the login form component" },
        { "cliType": "claude-code", "task": "Run the full test suite in the worktree" }
      ]
    }
  ]
}
\`\`\`

### Complete task (merge worktrees, close terminals)
\`\`\`json
{
  "actions": [
    { "type": "complete_task", "merge": true }
  ]
}
\`\`\`

## Rules
1. When the user asks to start work or spawn agents, emit spawn_agents with specific tasks per agent.
2. Prefer cliType "mousse" unless an external CLI capability is explicitly needed.
3. When the user says done, complete, merge, or finish — emit complete_task.
4. Assign complementary tasks when spawning multiple agents.
5. Explain your plan in plain text before the JSON block when delegating.
6. cliType must be exactly: mousse, claude-code, codex, opencode, or cursor-agents-cli.`

const CURSOR_AGENT_PROMPT = `${MOUSSE_PREAMBLE}

You are connected through the Cursor model provider. Help the user with their software project directly: answer questions, review code, plan changes, and explain trade-offs clearly.

Do not emit spawn_agents, complete_task, or other orchestration JSON in this mode — Mousse executes those through other providers. Focus on direct, actionable assistance.`

const PLAN_MODE_PROMPT = `${MOUSSE_PREAMBLE}

You are in Plan mode. Produce a detailed, actionable implementation plan in markdown only. Do not emit JSON action blocks, spawn_agents, complete_task, or any orchestration actions.

Structure the plan with clear headings, numbered steps, file paths, and acceptance criteria. Focus on what should be built and in what order.

When requirements are ambiguous, call ask_user with concise multiple-choice questions before drafting the plan.

When the plan is ready, call show_document with the full plan markdown so the user can read it in the document preview tab.

When the user asks follow-up questions, refine the plan in markdown only.`

const BUILD_MODE_PROMPT = `${MOUSSE_PREAMBLE}

You are in Build mode. Implement changes yourself using the available local tools: list_dir, read_file, write_file, git_status, git_diff, and run_command. All file and git operations are scoped to the project root.

Do not spawn CLI agents or emit spawn_agents, complete_task, or orchestration JSON actions. Explain progress in plain text and use tools to inspect, edit, test, and verify the codebase directly.

Prefer minimal, focused changes that match existing project conventions. Run relevant tests or build commands when helpful.`

const SKILL_MODE_PROMPT = `${MOUSSE_PREAMBLE}

You are in Skill mode. Follow the loaded Skill instructions closely. You may coordinate CLI coding agents when appropriate using spawn_agents and complete_task JSON actions, same as Agent mode.

Respond with helpful text AND include machine-readable actions in a JSON code block when spawning agents or completing work.`

const CURSOR_SKILL_PROMPT = `${MOUSSE_PREAMBLE}

You are in Skill mode, connected through the Cursor model provider. Follow the loaded Skill instructions and help the user directly. Do not emit orchestration JSON action blocks.`

function isCursorProvider(providerId?: string): boolean {
  return providerId === 'cursor'
}

export function buildOrchestratorSystemPrompt(
  options: BuildSystemPromptOptions = {}
): string {
  const mode = normalizeChatMode(options.mode)
  const cursor = isCursorProvider(options.providerId)
  const sections: string[] = []

  if (mode === 'plan') {
    sections.push(PLAN_MODE_PROMPT)
  } else if (mode === 'build') {
    sections.push(BUILD_MODE_PROMPT)
  } else if (typeof mode === 'object' && mode.type === 'skill') {
    sections.push(cursor ? CURSOR_SKILL_PROMPT : SKILL_MODE_PROMPT)
  } else {
    sections.push(cursor ? CURSOR_AGENT_PROMPT : AGENT_ORCHESTRATOR_PROMPT)
  }

  const invokableSkills = (options.skills ?? []).filter(
    (skill) => skill.isActive !== false && !skill['disable-model-invocation']
  )
  if (invokableSkills.length > 0 && mode !== 'plan') {
    sections.push(`## Enabled Skills
The user has enabled these Skills for this session. Use list_skills to inspect them and load_skill to load a SKILL.md body when relevant. Users can also invoke a skill explicitly with /skill-name.

${invokableSkills
  .map((skill) => `- ${skill.name}: ${skill.description} (${skill.scope}, ${skill.source})`)
  .join('\n')}`)
  }

  if (options.loadedSkills?.length) {
    sections.push(`## Loaded Skill Instructions
${options.loadedSkills
  .map((skill) => `### ${skill.name}\n${skill.content}`)
  .join('\n\n')}`)
  }

  if (typeof mode === 'object' && mode.type === 'skill' && getSkillIdFromMode(mode)) {
    sections.push(`## Active Skill
Skill id: ${mode.skillId}`)
  }

  return sections.join('\n\n')
}

export const ORCHESTRATOR_SYSTEM_PROMPT = buildOrchestratorSystemPrompt()
