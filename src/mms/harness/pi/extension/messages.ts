/**
 * The fixed texts Mousse's extension raises on Pi's request path (PR 2 §4 "Messages Pi must not
 * retry"). Pi retries a failed request when its error text matches pi-ai's retryable pattern
 * (`isRetryableAssistantError`: "timeout", "terminated", "503", "rate limit"…), so every text here
 * is a fixed identifier with no digit and no such word: a refused request ends the turn at once.
 * Numbers and upstream details travel in Mousse's own records, never in these texts.
 *
 * Shared by the extension (bundled on its own) and the engine; it imports nothing.
 */

/** An Anthropic subscription credential, or an Anthropic host outside the API-key rule. */
export const ANTHROPIC_OAUTH_REFUSED = 'mousse_anthropic_oauth_refused'
/** Mousse could not hand over a credential (any `/pi/credential` failure, transport included). */
export const CREDENTIAL_UNAVAILABLE = 'mousse_credential_unavailable'

/** A turn, tool-call, token or cost limit of the run refused the request (the limit is in Mousse's counter record). */
export const BUDGET_EXHAUSTED = 'mousse_budget_exhausted'
/** Mousse refused the request for another reason: no turn is live on the process, or it is stopping. */
export const REQUEST_REFUSED = 'mousse_request_refused'
/** `/pi/request` could not be reached or answered badly (never the transport's own text). */
export const GATE_UNAVAILABLE = 'mousse_gate_unavailable'

/**
 * The final payload of a reserved request carried no output cap, or one above its reservation
 * (thrown from `onPayload`, so nothing is sent). Sizing makes this a backstop: it means the wire-cap
 * mirror drifted from pi-ai, or a hook raised the cap.
 */
export const SPEND_CAP_MISMATCH = 'mousse_spend_cap_mismatch'

/** Every text Mousse raises on the request path; a unit test checks pi-ai does not retry any. */
export const REQUEST_PATH_ERRORS: readonly string[] = Object.freeze([ANTHROPIC_OAUTH_REFUSED, CREDENTIAL_UNAVAILABLE, BUDGET_EXHAUSTED, REQUEST_REFUSED, GATE_UNAVAILABLE, SPEND_CAP_MISMATCH])

/** Pi's sign-in flows are Mousse's: a provider's `login` rejects with this. */
export const LOGIN_REFUSED = "mousse_login_refused: sign in from Mousse's Providers page"

/** Tool-call refusals from the gate (`tool_call` blocks with these reasons). */
export const GATE_REFUSALS = Object.freeze({
  /** The gate could not be reached or answered badly: default deny. */
  unreachable: 'mousse_gate_unreachable',
  /** The call is not one the turn allows (not in its active set, or an old attempt). */
  denied: 'mousse_tool_denied',
  /** A delegation of the attempt is authorized: parent mutations wait for the next step. */
  writerYielded: 'mousse_writer_yielded',
  /** The run's tool-call limit (or an earlier limit) is reached: the call never runs. */
  budget: BUDGET_EXHAUSTED
})
