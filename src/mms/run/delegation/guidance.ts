/**
 * The one guidance text about subagents. The pi loop's system prompt (`DELEGATION_PROMPT`), the
 * Mousse MCP server's instructions and the first prompt of a subagent all read it from here, so the
 * surfaces cannot drift apart (pinned by `tests/run/delegationGuidance.test.ts`).
 *
 * Nested subagents are advertised: results wait for a subagent's own subagents (D) and Stop reaches
 * the whole tree and the questions of every level reach the parent (E), so a subagent is told it may
 * start subagents of its own (issue #142).
 */

/** The model-facing delegation bullets, shared by pi and MCP. */
export function delegationGuidanceLines(): string[] {
  return [
    'Delegate only substantial work: a bounded task that runs on its own thread, in parallel, or on another provider or model. Give every subagent a short role-like title such as "API reviewer"; the title is how you address it later.',
    'Continue the same subagent (continue_subagent, by title) when the next step builds on what it already read or did: fixing its findings, re-checking its own change, answering its question, the next iteration of the same work. It keeps its context, so this is faster and cheaper than starting over.',
    'Start a new subagent (delegate_task) for independent work, a deliberately fresh or independent review, a different workspace, provider or model, or when the old subagent\'s context is wrong or too long. A title is unique among your subagents; delegate_task returns title_taken when one already exists, and then you continue it or choose another title.',
    'The user cannot create subagents. When the user names one ("ask the API reviewer to ..."), use continue_subagent with that title.',
    'Pick workspace "isolated" for work that edits, builds or tests; "shared" only for read-only roles (role "research" or "review").',
    'After delegating or continuing, end your turn. Mousse sends you a notice with the result, so do not poll; call task_status only when the notice says the result was cut off. Use integrate_delegation to merge a finished isolated task.',
    'When a subagent asks a question you can answer, use answer_subagent; otherwise ask the user. A subagent that needs input is reported as needing it.',
    'To run a subagent on another of the user\'s computers (another operating system, a stronger machine, a job that should outlive this one), pass computer to delegate_task; list_computers shows which ones you may use. It runs there under that computer\'s agents, in its copy of this repository; its questions are answered there, and its result names the branch its work is on.'
  ]
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
    'You may start your own subagents unless your instructions say not to.'
  ]
}

/** The first prompt of a subagent: its guidance, then the task. */
export function subagentPreamble(parentTitle?: string): string {
  return subagentGuidanceLines(parentTitle).join(' ')
}

/**
 * The first prompt of a remote subagent (issue #469): it runs as an ordinary thread on another computer,
 * so it is told where its result goes and that a person there, not its parent, answers its questions.
 */
export function remoteSubagentPreamble(parentTitle?: string): string {
  return [
    `You are a subagent${parentTitle ? ` of "${parentTitle}"` : ''}, started by an agent on another of the user's computers. Your final message is your result: keep it self-contained and bounded.`,
    'Questions you ask are answered on this computer, by the user, not by the agent that started you.',
    'Commit your work to this thread\'s branch when you change code, so it can be fetched from here.'
  ].join(' ')
}
