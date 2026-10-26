/**
 * How one agent departs from plain ACP. Presets carry their own quirks; an agent Mousse knows
 * nothing about gets none.
 */
export interface AcpQuirks {
  /** Offer client fs (`fs/read_text_file`, `fs/write_text_file`) inside the workspace, with write approval. */
  clientFs?: boolean
  /** Reopen a saved session with `session/resume` whatever the agent advertises (else load, then resume). */
  preferResume?: boolean
  /** Send the Mousse MCP server over the stdio bridge even when the agent advertises HTTP. */
  mcp?: 'auto' | 'stdio'
  /** Refuse an `initialize` answer of another protocol version (else it is read by its shape). */
  strictProtocol?: boolean
  /**
   * The model is always set through this select config option, and only a listed model runs
   * (else the model control the session offers, and the agent's default when it offers none).
   */
  modelConfigId?: string
  /** Its npm package needs its install scripts (Mousse installs npm agents with `--ignore-scripts`). */
  allowInstallScripts?: boolean
  /**
   * xAI's extensions (Grok), under both the `_x.ai/` and `x.ai/` prefixes: `ask_user_question`
   * goes to the thread's questions; `exit_plan_mode` is answered `abandoned` so it never blocks a
   * turn; a prompt is tagged `_meta.promptId` and ends at its `session/prompt_complete` or its
   * reply, whichever comes first; and a stopped prompt's process is ended (the agent may still
   * report its task running), so the next turn reopens the session on a new one.
   */
  xaiExtensions?: boolean
}

export const NO_QUIRKS: Readonly<AcpQuirks> = Object.freeze({})

/** Quirks of agents Mousse may meet as a generic command, by agent id. */
const KNOWN_QUIRKS: Readonly<Record<string, AcpQuirks>> = {
  // They drop injected HTTP MCP servers (found by T3 Code).
  'codex-acp': { mcp: 'stdio' },
  'pi-acp': { mcp: 'stdio' }
}

/** The quirks of `agentId`; unknown agents get none. */
export function quirksFor(agentId: string | undefined): AcpQuirks {
  return (agentId && Object.prototype.hasOwnProperty.call(KNOWN_QUIRKS, agentId) ? KNOWN_QUIRKS[agentId] : undefined) ?? NO_QUIRKS
}
