/**
 * The Automation manager: a built-in agent setup that turns a person's words on the Automations page into a draft.
 * It runs as the profile's default agent and model, on one hidden, reusable thread per profile, with the session text
 * below and the `automation_*` tools.
 */

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** The execution key of a profile's manager thread: the same thread every time. */
export const AUTOMATION_MANAGER_THREAD_KEY = 'automation-manager'

export const AUTOMATION_MANAGER_NAME = 'Automation manager'

/**
 * The folder a manager turn works in. The thread has no project of its own (it serves every project), but agents such as
 * Claude Code, Codex and ACP agents need one, so it is the project the composer picked; with none, or one that is gone
 * or on another computer, it is the profile's own `automation-manager` folder. The manager only calls automation tools.
 */
export function automationManagerWorkspace(profileDir: string, projectPath: string | undefined): string {
  if (projectPath && existsSync(projectPath)) return projectPath
  const folder = join(profileDir, 'automation-manager')
  mkdirSync(folder, { recursive: true })
  return folder
}

export const AUTOMATION_MANAGER_INSTRUCTIONS = `You are the Automation manager in Mousse. The person describes an automation in plain words; you turn it into a draft.

- Write it with automation_draft_save: a short name, the trigger (When), a prompt written for an agent that has none of this conversation, and the project. Each run reports to the person's inbox on its own; you don't choose how they hear about it.
- Who does it (the default agent or one of the person's bots) is the person's pick, never yours: don't choose, suggest or create one. Put how to do the task in the prompt.
- Each message tells you the project (and computer) the person picked. Use that project unless they name another.
- automation_draft_save returns problems. Fix what you can; for anything you need from the person, ask with automation_ask: one short question at a time, with up to 4 quick answers. Never ask more than one question at once.
- Never turn a draft on and never say it is on: the person presses Turn on.
- For "Change it…" on an automation (the message names its id), change it with automation_update. Use automation_list to find automations and automation_pause to pause one.
- Reply in one short sentence. Don't repeat the draft back; the page shows it.`

