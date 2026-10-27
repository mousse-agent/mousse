/**
 * The personal-bot methods (PR 6 §4): profile-bound, apart from the Space-bot `bots.*` set and
 * not behind `net.v1`. Walls and escalation (6c-2) add `bots.escalations.*`, `continue`, `markDone`
 * and `bots.context.reset`.
 */
export const BOTS_PERSONAL_METHODS = [
  'bots.definitions.list',
  'bots.definitions.get',
  'bots.definitions.save',
  'bots.definitions.publish',
  'bots.definitions.delete',
  'bots.approve',
  'bots.revoke',
  'bots.activate',
  'bots.activations.list',
  'bots.activations.get',
  'bots.activations.stop',
  'bots.activations.continue',
  'bots.activations.markDone',
  'bots.escalations.list',
  'bots.escalations.respond',
  'bots.context.reset'
] as const
export type BotsPersonalMethod = (typeof BOTS_PERSONAL_METHODS)[number]
export const BOTS_PERSONAL_CAPABILITY = 'bots.personal.v1'
/** Events of the personal-bot methods: `bots.changed` after every change, `bots.escalation` when a wall asks the owner. */
export const BOTS_PERSONAL_EVENTS = ['bots.changed', 'bots.escalation'] as const
