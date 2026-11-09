import type { AutomationRun } from '../../../shared/automations'
import { agoText, ownedWhenText } from './automationTime'

/**
 * Automations as data, for Edit details and its dialogs: what a run says, the mark of a run missed while offline, and
 * when a Pause… ends. Pure, so the page and its tests share them.
 */

/** The mark on a run that stands for repeats missed while its computer was off, with its tooltip. */
export function missedText(run: AutomationRun): { text: string; title: string } | undefined {
  if (!run.missed) return undefined
  const count = run.missed.count
  return {
    text: 'Missed while offline',
    title: count > 1 ? `${count >= 1000 ? '1000+' : count} runs fell while the computer was off. They ran once, late.` : 'It fell while the computer was off. It ran once, late.'
  }
}

/** What one run says on a row: "failed · npm install exited 1", "waiting · usage limit until 14:00". */
export function runText(run: AutomationRun, now: Date, owner: { name: string; timeZone: string }, viewerZone: string): string {
  const when = (iso: string) => ownedWhenText(iso, now, owner, viewerZone)
  switch (run.state) {
    case 'queued':
      return 'starting'
    case 'running':
      return run.detail ? `running · ${run.detail.toLowerCase()}` : 'running'
    case 'waiting':
      if (run.reason === 'usage_limit') return run.until ? `waiting · usage limit until ${when(run.until)}` : 'waiting · usage limit'
      if (run.reason === 'offline') return 'offline'
      if (run.reason === 'behind') return 'waiting · behind another run'
      return run.detail ? `waiting · ${run.detail.toLowerCase()}` : 'waiting'
    case 'failed':
      return run.detail ? `failed · ${firstLine(run.detail)}` : 'failed'
    case 'incomplete':
      return run.detail ? `incomplete · ${lowerFirst(firstLine(run.detail))}` : 'incomplete'
    case 'nothing_new':
      return `nothing new · ${agoText(run.at, now)}`
    case 'done':
      return `done · ${agoText(run.at, now)}`
  }
}

/** The first letter lowered, so a key's name ("Add key GITHUB_TOKEN") keeps its case. */
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1)

const firstLine = (text: string) => {
  const line = text.trim().split(/\r?\n/)[0] ?? ''
  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

export type PauseChoice = 'resume' | 'tomorrow' | 'monday' | 'date'

/** When a Pause… choice ends: never (Until I resume), the start of tomorrow, the start of next Monday, or the chosen day. */
export function pauseUntil(choice: PauseChoice, now: Date = new Date(), date?: string): string | undefined {
  if (choice === 'resume') return undefined
  if (choice === 'tomorrow') return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString()
  if (choice === 'monday') {
    const ahead = ((8 - now.getDay()) % 7) || 7
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead).toISOString()
  }
  const match = date ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null
  if (!match) return undefined
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).toISOString()
}
