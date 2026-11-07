/**
 * The bot runner entry (Bot Phase 1 §5.9 item 7): the locked entry Mousse adds at the first bot
 * creation when the owner has a Claude subscription and no locked entry. It signs in once, in its
 * own home; the owner's `~/.claude` sign-in is never copied into it.
 */
export const CLAUDE_BOT_RUNNER_SLUG = 'bots'
export const CLAUDE_BOT_RUNNER_ID = `claude:${CLAUDE_BOT_RUNNER_SLUG}`
export const CLAUDE_BOT_RUNNER_NAME = 'Claude for bots'
