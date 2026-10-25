import { mcpDelegationInstructions } from '../delegation/guidance'

/**
 * The one guidance text for agents that reach Mousse's tools over the Mousse MCP server
 * (docs/run-engine/SPEC.md §15.3). Delivered per adapter: appended to Claude's system prompt,
 * wrapped into Antigravity's first prompt, and returned as the server's `initialize` instructions.
 */
export function mousseOrchestrationInstructions(): string {
  return [
    'You are running inside Mousse, which exposes its orchestration tools through the "mousse" MCP server.',
    '',
    ...mcpDelegationInstructions(),
    '- clientRequestId: pass a fresh clientRequestId for every new action that changes state (delegate_task, continue_subagent, answer_subagent, integrate_delegation). Reuse the same value only when retrying the same call after an error or timeout; Mousse then returns the first result instead of acting twice.',
    '- A delegated task can never exceed your own mode ceiling: a planning turn may only start planning children and cannot integrate.',
    '- Use ask_user for clarifying questions and present_plan for a plan the user should approve; use thread_read to read your thread\'s run events (and those of your parent or children).',
    '- Never ask for passwords, API keys, tokens or other secrets in chat, and never repeat a secret you were given.'
  ].join('\n')
}
