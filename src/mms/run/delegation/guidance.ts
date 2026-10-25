/**
 * The one guidance text about subagents. The pi loop's system prompt (`DELEGATION_PROMPT`), the
 * Mousse MCP server's instructions and the first prompt of a subagent all read it from here, so the
 * surfaces cannot drift apart (pinned by `tests/run/delegationGuidance.test.ts`).
 *
 * Nested subagents work, but the guidance does not mention them yet: models are told only after
 * results wait for a subagent's own subagents and Stop reaches the whole tree (issue #142, D and E).
 */

/** Whether the guidance tells a subagent that it may start subagents of its own. */
export const ADVERTISE_NESTING = false

/** The model-facing delegation bullets, shared by pi and MCP. */
export function delegationGuidanceLines(): string[] {
  return [
    'Delegate only substantial work: a bounded task that runs on its own thread, in parallel, or on another provider or model. Give every subagent a short role-like title such as "API reviewer"; the title is how you address it later.',
    'Continue the same subagent (continue_subagent, by title) when the next step builds on what it already read or did: fixing its findings, re-checking its own change, answering its question, the next iteration of the same work. It keeps its context, so this is faster and cheaper than starting over.',
    'Start a new subagent (delegate_task) for independent work, a deliberately fresh or independent review, a different workspace, provider or model, or when the old subagent\'s context is wrong or too long. A title is unique among your subagents; delegate_task returns title_taken when one already exists, and then you continue it or choose another title.',
    'The user cannot create subagents. When the user names one ("ask the API reviewer to ..."), use continue_subagent with that title.',
    'Pick workspace "isolated" for work that edits, builds or tests; "shared" only for read-only roles (role "research" or "review").',
    'After delegating or continuing, end your turn. Mousse sends you a notice with the result, so do not poll; call task_status only when the notice says the result was cut off. Use integrate_delegation to merge a finished isolated task.',
    'When a subagent asks a question you can answer, use answer_subagent; otherwise ask the user. A subagent that needs input is reported as needing it.'
  ]
}

/** The `## Delegation` section of the pi loop's system prompt. */
export function piDelegationPrompt(): string {
  return [
    '## Delegation',
    'Use delegate_task to hand a bounded task to a subagent. It returns immediately with a delegationId; do not wait or poll. When the subagent finishes, Mousse sends you a notice with its result. task_cancel stops a subagent and everything it delegated. list_subagents lists your subagents and what they are doing.',
    ...delegationGuidanceLines().map((line) => `- ${line}`),
    '- Include the plan or spec body (or a readable path), the acceptance criteria and the focused validation to run. instanceId and model default to yours; set them only when the user explicitly requests an override, using known connected identifiers. Never copy example or guessed model identifiers.',
    '- Isolated results do not affect this task until you call integrate_delegation after the subagent finished; it runs as its own integration run after your turn and you are notified of the outcome. Never claim integration from completion alone.'
  ].join('\n')
}

/** The delegation bullets of the Mousse MCP server's instructions. */
export function mcpDelegationInstructions(): string[] {
  return [
    '- Delegation: use delegate_task for work that should run on another provider or model, or in parallel on its own thread, and continue_subagent to follow up on a subagent you already have.',
    ...delegationGuidanceLines().map((line) => `- ${line}`)
  ]
}

/** What a subagent is told, in addition to its task: where its result goes. `parentTitle` is absent when the parent has no title. */
export function subagentGuidanceLines(parentTitle?: string): string[] {
  return [
    `You are a subagent${parentTitle ? ` of "${parentTitle}"` : ''}. Your final message is your result: keep it self-contained and bounded.`,
    'ask_user questions reach your parent and the user.',
    ...(ADVERTISE_NESTING ? ['You may start your own subagents unless your instructions say not to.'] : [])
  ]
}

/** The first prompt of a subagent: its guidance, then the task. */
export function subagentPreamble(parentTitle?: string): string {
  return subagentGuidanceLines(parentTitle).join(' ')
}
