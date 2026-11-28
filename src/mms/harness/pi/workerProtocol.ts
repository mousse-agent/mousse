/**
 * The NDJSON protocol between a Pi single request (`pi:worker`, `drivers/pi/workerOneShot.ts`) and its worker process
 * (`worker.ts`). The worker says `ready` once, takes one request line on stdin, streams events on stdout and ends with
 * one `end`. Neither side imports the other, and nothing here loads pi-ai or the AWS SDK.
 */

/** The request: the model as pi-ai defines it, the text, and the credential inputs the entry uses, never more. */
export interface PiWorkerRequest {
  /** pi-ai's model definition (`Model<'bedrock-converse-stream'>`), as plain data. */
  model: Record<string, unknown>
  system: string
  prompt: string
  /** A thinking level the model takes; absent for none. */
  reasoning?: string
  /** Prompt-cache affinity only: it saves no chat. */
  sessionId?: string
  /** A Bedrock bearer token (a stored key or `AWS_BEARER_TOKEN_BEDROCK`). */
  bearerToken?: string
  /** pi-ai's scoped variables for the request: static keys and the region, by name. */
  env?: Record<string, string>
}

export type PiWorkerMessage =
  | { event: 'ready' }
  | { event: 'activity' }
  | { event: 'text'; text: string }
  /** A tool call the model started: the request ends. */
  | { event: 'tool'; name: string }
  /** The request's end: the whole answer, or the provider's error as pi-ai reported it. */
  | { event: 'end'; text: string; error?: string; provider?: string }
