import { levelNotifies, type RunLevel } from '../../../shared/automationInbox'
import type { TellMe } from '../../../shared/types'
import type { BotChatMessage } from '../../../shared/bots/personal/chat'
export type Tell = 'now' | 'soon' | 'later'
interface Context { tellMe?: TellMe; level?: RunLevel; message: BotChatMessage; ownerTurn: boolean; reminderOwner?: boolean | null; reminder: boolean; quiet: boolean; scheduleLine?: { say: string; ownerAsked?: boolean } }
/** Ordered rules: new row kinds belong here, not in the release loop. No text matching. */
const classes: Array<[ (c: Context) => boolean, Tell | null ]> = [
  [({ message: m }) => m.author !== 'bot' || !!m.systemLine || !!m.ask && m.ask.status !== 'open' || !!m.question && m.question.status !== 'open' || !!m.action && m.action.status !== 'open', null],
  [({ message: m }) => m.id.endsWith('_offline') || m.id.includes('_sched_dropped_'), 'later'],
  [c => c.reminder && c.reminderOwner !== false, 'now'],
  [c => c.scheduleLine?.say !== undefined && c.scheduleLine.ownerAsked === true, 'now'],
  [c => c.ownerTurn && !c.message.question?.nudge && (c.message.kind === 'text' || !!c.message.ask || !!c.message.question), 'now'],
  [c => c.message.kind === 'error' || !!c.message.error, 'soon'],
  [c => !!c.message.action, 'soon'],
  [c => !!c.tellMe && !levelNotifies(c.tellMe, { failed: false, level: c.message.ask || c.message.question ? 'needs_you' : c.level }), 'later'],
  [c => c.quiet && c.message.kind === 'run_report', 'later'],
  [() => true, 'soon']
]
export function tellingClass(context: Context): Tell | null {
  return classes.find(([matches]) => matches(context))![1]
}
