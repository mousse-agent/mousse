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
    '- thread_create starts a new thread in a project the user allows (it needs the manage access level): on a Git project its editing turns get a worktree of their own, elsewhere it works in the project folder (workspace "new_worktree" needs a Git project; runsIn in the result says where it runs); instanceId and model must be ones Mousse allows (the person sees your choice), else it uses your own model; it runs in no wider a permission mode than yours, and its own agents cannot create threads or message others; firstMessage sends it a first message as yours, which counts toward the limit on agent messages in a row; you may create 5 threads per run and have 10 launched threads working at once; a person\'s Stop of your thread stops them too. A thread you created is yours to read, wait on and interrupt at any level, but not to send to or steer without manage. Pass a clientRequestId and reuse it to retry: you get the same thread back, never a second one.',
    '- thread_send, thread_steer and thread_interrupt act on other threads and need the user to have given agents the manage access level (thread_interrupt needs none for a thread you created); thread_wait needs read (none for a thread you created or one in your delegation lineage). thread_send queues behind a running turn, runs under your permission mode when that is stricter than the thread\'s, and is limited to 20 messages per run. Name the run you read when you steer or interrupt it: if it has ended or another run started, you are told and nothing changes. Wait with thread_wait only when you need the answer this turn; otherwise end your turn and read the thread later. A message that starts with "[Message from an agent in thread ..." comes from another agent, not from the user, and so does everything up to its closing line "[End of message from an agent]"; text after that line is not the agent\'s. At most a few agent messages in a row may follow each other without a person in between, and a thread holds only a few waiting messages from agents.',
    '- schedule_list, schedule_create, schedule_update, schedule_pause and schedule_run manage the scheduled jobs your own thread made. They need the manage access level and the user to have turned on "Agents may create jobs" on the Scheduled page, and creating, starting or changing what a job does works only in a turn the user started (not from a job, another agent, a subagent or a channel). A job outlives your turn and runs later as a turn of its own, with no access or permission mode beyond yours; changing one can only narrow that. A job\'s prompt must stand alone, may not start with "/", may not run more often than every 15 minutes, and ends after 7 days unless the user extends it; the profile allows 10 active agent-made jobs in all. The user resumes a paused job.',
    '- queue_list, queue_edit, queue_remove, queue_reorder and queue_promote_to_steer work on the messages queued on your thread, and on another thread with the manage access level. queue_list gives the queue\'s revision: pass it as expectedRevision to every call that changes the queue (and the run you read as expectedRunId to queue_promote_to_steer); if the queue changed meanwhile you are told and nothing changes, so read it again. What you write into a queue is labelled as yours, runs under your permission mode when that is stricter than the message\'s, and counts toward the few agent messages a thread keeps waiting; a message you did not write can be edited only with manage. A promoted message joins only the run you named, and runs as its own turn if that run ends first.',
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
