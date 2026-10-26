/**
 * How one agent departs from plain ACP. Presets carry their own quirks; an agent Mousse knows
 * nothing about gets none.
 */
export interface AcpQuirks {
  /** Offer client fs (`fs/read_text_file`, `fs/write_text_file`) inside the workspace, with write approval. */
  clientFs?: boolean
  /** Reopen a saved session with `session/resume` (else `session/load` when advertised). */
  preferResume?: boolean
}
