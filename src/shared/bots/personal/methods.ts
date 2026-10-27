/**
 * The personal-bot methods (PR 6 §4): profile-bound, apart from the Space-bot `bots.*` set and
 * not behind `net.v1`. Consults, walls and escalation (6c-2) add their own.
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
  'bots.activations.stop'
] as const
export type BotsPersonalMethod = (typeof BOTS_PERSONAL_METHODS)[number]
export const BOTS_PERSONAL_CAPABILITY = 'bots.personal.v1'
