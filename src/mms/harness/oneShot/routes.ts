import type { RouteFacts } from './route'

/** Every provider's route facts. See the providers table in docs/plans/one-shots-every-provider.md. */

/** Pi: one pi-ai request in Mousse's process, with no tool offered. */
export const PI_DIRECT_FACTS: RouteFacts = Object.freeze({ tools: 'none_offered', attempts: 'one', isolation: 'verified', launch: 'in_process', audience: 'any' })

/**
 * Pi on Bedrock (`pi:worker`): the same request in a worker process of its own, in its place, with `AWS_MAX_ATTEMPTS=1`
 * set before pi-ai makes its AWS client (one request on the wire on 429 and 503, counted at a stub) and only the
 * credentials the entry uses; none of the person's AWS files or Pi's setup loads, shown in
 * `tests/piWorkerOneShotEffects.test.ts`. Held.
 */
export const PI_WORKER_FACTS: RouteFacts = Object.freeze({ tools: 'none_offered', attempts: 'one', isolation: 'verified', launch: 'sealed_child', audience: 'any' })

/** A local server's model on Pi: the same request, for the threads that run on it only. */
export const PI_LOCAL_FACTS: RouteFacts = Object.freeze({ ...PI_DIRECT_FACTS, audience: 'own_threads' })

/**
 * Any ACP agent known only by its command (`acpOneShot`): its own tools can't be removed, so Mousse refuses what passes
 * through it and ends the request at the first one it reports; it may retry below Mousse; only its environment is
 * sealed. Best-effort.
 */
export const GENERIC_ACP_FACTS: RouteFacts = Object.freeze({ tools: 'detected_on_report', attempts: 'unenforced', isolation: 'env_only', launch: 'sealed_child', audience: 'any' })

/**
 * Antigravity on `acpOneShot` with its preset's launch (#1936: an empty `--gemini-dir`, settings of its own, and its own
 * environment, which keeps the account's sign-in). Its own tools still can't be removed: best-effort, as any ACP agent.
 */
export const ANTIGRAVITY_FACTS: RouteFacts = GENERIC_ACP_FACTS

const CLAUDE_FACTS: RouteFacts = Object.freeze({ tools: 'none_offered', attempts: 'one', isolation: 'verified', launch: 'sealed_child', audience: 'any' })
const CLAUDE_MANAGED_FACTS: RouteFacts = Object.freeze({ ...CLAUDE_FACTS, isolation: 'env_only' })

/**
 * Claude Code (`claude:cli`): no tool offered (`tools: []`), and one request on the wire (`CLAUDE_CODE_MAX_RETRIES=0`
 * and no non-streaming fallback, counted at a stub on 429 and 503). No user config loads (`settingSources: []`), but an
 * organisation's managed settings can enforce hooks no caller can turn off: with a managed settings file present only
 * the environment is held (`env_only`), and the route is best-effort.
 */
export function claudeFacts(managed: boolean): RouteFacts {
  return managed ? CLAUDE_MANAGED_FACTS : CLAUDE_FACTS
}

/**
 * Codex on OpenAI's own provider with its ChatGPT sign-in (`codex:direct`): one direct request with no tools to the
 * ChatGPT backend, in Mousse's process, with Codex's own token. No retry and no WebSocket (counted at a stub); nothing
 * of Codex's setup is in it (shown by an effects test). Held.
 */
export const CODEX_DIRECT_FACTS: RouteFacts = Object.freeze({ tools: 'none_offered', attempts: 'one', isolation: 'verified', launch: 'in_process', audience: 'any' })

/**
 * Codex on any other provider (a managed entry's, `codex:app_server`): a turn on the entry's app-server with every
 * feature, web search and MCP server off. Codex still declares tools no setting removes (`apply_patch` on some models,
 * `request_user_input`; F8, Codex 0.172), and retries as its provider config says. Best-effort.
 */
export const CODEX_APP_SERVER_FACTS: RouteFacts = Object.freeze({ tools: 'detected_on_report', attempts: 'unenforced', isolation: 'env_only', launch: 'sealed_child', audience: 'any' })

/**
 * OpenCode (`opencode:sealed`): a server of its own in the request's place, its config folders in the place and the
 * folders above it skipped (`OPENCODE_DISABLE_PROJECT_CONFIG`), a session that denies every tool, and one `generate` on
 * it, which runs no session runner and so never retries (counted at a stub on 429 and 503; effects shown in
 * `tests/opencodeOneShotEffects.test.ts`). Held.
 */
export const OPENCODE_SEALED_FACTS: RouteFacts = Object.freeze({ tools: 'none_offered', attempts: 'one', isolation: 'verified', launch: 'sealed_child', audience: 'any' })

/**
 * OpenCode's own paid models (`opencode/*`): its Console provider loads the organisation's config from the Console with
 * the key (its providers, remote MCP servers and policies), so only the environment is held. Best-effort.
 */
export const OPENCODE_CONSOLE_FACTS: RouteFacts = Object.freeze({ ...OPENCODE_SEALED_FACTS, isolation: 'env_only' })

/**
 * OpenCode's own free models refuse a request with no tool, so they are offered `read`. `generate` runs no tool, so a
 * call is never run; the model is still offered one. Best-effort.
 */
export const OPENCODE_FREE_FACTS: RouteFacts = Object.freeze({ ...OPENCODE_SEALED_FACTS, tools: 'refused_before_run' })

/**
 * Cursor (`cursor:sdk`): a host process of its own for the request, in its place, separate from the host that runs
 * turns. One agent with no built-in tool (`tools: []`, sent as an empty `x-cursor-agent-allowed-tools`), no settings
 * layer (`settingSources: []`: no rules, skills, hooks or MCP servers of the user's or a project's) and the SDK's
 * retries off (`enableAgentRetries: false`): one request on the wire on 429 and 503, counted at a stub, and no user
 * config loaded, shown in `tests/cursorOneShotEffects.test.ts`. Held.
 */
export const CURSOR_SDK_FACTS: RouteFacts = Object.freeze({ tools: 'none_offered', attempts: 'one', isolation: 'verified', launch: 'sealed_host', audience: 'any' })

/**
 * Grok with an xAI API key (`grok:direct`): one request with no tools to xAI's API, in Mousse's process, with the key
 * Grok would use. No retry (one request on the wire on 429 and 503, counted at a stub, `tests/grokDirectOneShot.test.ts`);
 * Mousse builds the request, so nothing of Grok's setup is in it (its config, instructions or MCP servers; shown against
 * Grok's own run in the same home, `tests/grokDirectOneShotEffects.test.ts`). Held.
 */
export const GROK_DIRECT_FACTS: RouteFacts = Object.freeze({ tools: 'none_offered', attempts: 'one', isolation: 'verified', launch: 'in_process', audience: 'any' })

/**
 * Grok with its account sign-in (`acp:grok`): `acpOneShot` with the preset's inputs (`grok/oneShot.ts`): a Grok home of
 * the request's own whose config denies every tool and sends nothing again, the entry's own `auth.json` read in place,
 * and every source Grok reads from other agents' setups off. Grok's own tools are still offered and its retries are
 * not counted here: best-effort, as any ACP agent.
 */
export const GROK_ACP_FACTS: RouteFacts = GENERIC_ACP_FACTS
