import { mcpDelegationInstructions } from '../delegation/guidance'

/**
 * The one guidance text for agents that reach Mousse's tools over the Mousse MCP server
 * (docs/run-engine/SPEC.md §15.3). It is part of the session instructions a turn's bridge carries
 * (`appTools/assemble.ts`), delivered where each runtime applies session text, and the server's
 * `initialize` instructions.
 */
export function mousseOrchestrationInstructions(): string {
  return [
    'You are running inside Mousse, which exposes its orchestration tools through the "mousse" MCP server.',
    '',
    ...mcpDelegationInstructions(),
    '- clientRequestId: pass a fresh clientRequestId for every new action that changes state (delegate_task, continue_subagent, answer_subagent, integrate_delegation). Reuse the same value only when retrying the same call after an error or timeout; Mousse then returns the first result instead of acting twice.',
    '- A delegated task can never exceed your own mode ceiling: a planning turn may only start planning children and cannot integrate.',
    '- Use ask_user for clarifying questions and present_plan for a plan the user should approve; use thread_read to read your thread\'s run events (and those of your parent or children).',
    '- thread_list and thread_search find other threads and thread_read reads them, but only when the user has given agents that access in Mousse\'s settings (they are hidden otherwise); the access level decides how much you see, and a refusal names the level it needs.',
    ...appToolGuidance(),
    '- Never ask for passwords, API keys, tokens or other secrets in chat, and never repeat a secret you were given.'
  ].join('\n')
}

/** Guidance for Mousse's app tools: the browser, applets and skills (PR 2 §2 "Orchestrator"). */
export function appToolGuidance(): string[] {
  return [
    '- Browser: when the browser_* tools are usable in a turn, Mousse binds them to the browser the user chose; open or observe a page before acting on it, and act on the refs an observation returns.',
    '- Applets: publish an offline HTML/CSS/JS applet with publish_applet rather than a mousse-applet fence when the tool is usable.',
    '- Skills: list_skills shows the Skills the user enabled and load_skill loads one; a skill the user invoked explicitly (/name) is already in the turn\'s instructions.',
    '- What a turn may use depends on its mode, the browser binding and Settings; a Mousse tool that is not usable now returns why instead of running.'
  ]
}
