/**
 * Local models (Settings → Providers → Add provider → Local models): model servers already running on a computer,
 * connected on the Pi driver as `pi:local-<slug>`. Mousse finds them only when asked, reads their models and what
 * each can do, and hands Pi a finished catalogue. Phase 1 starts nothing: no app, server or model load.
 */

/** The servers Mousse recognises. Anything else that speaks OpenAI chat completions is `openai`. */
export type LocalRuntimeKind = 'llamacpp' | 'ollama' | 'lmstudio' | 'unsloth' | 'vllm' | 'jan' | 'localai' | 'koboldcpp' | 'mlx' | 'openai'

export const LOCAL_RUNTIME_LABELS: Readonly<Record<LocalRuntimeKind, string>> = {
  llamacpp: 'llama.cpp',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  unsloth: 'Unsloth Studio',
  vllm: 'vLLM',
  jan: 'Jan',
  localai: 'LocalAI',
  koboldcpp: 'KoboldCpp',
  mlx: 'MLX',
  openai: 'Local server'
}

/**
 * The window a model with no reported window is planned at (chat and titles). Agent turns need a real number first
 * (`Window unknown · Set`): Ollama's OpenAI endpoint silently cuts a longer prompt.
 */
export const LOCAL_PLANNING_WINDOW = 4096

/**
 * Tool calling, best evidence first: `passed` a round-trip check on this model; `failed` it; `reported` the server
 * says yes; `none` the server says no; `unknown` nothing said.
 */
export type LocalToolSupport = 'passed' | 'failed' | 'reported' | 'none' | 'unknown'

/** What Mousse knows of one model a local server lists, beside its pi-ai definition. */
export interface LocalModelFacts {
  /** The window the server runs the model at, when it said; absent: unknown (planned at {@link LOCAL_PLANNING_WINDOW}). */
  loadedWindow?: number
  /** The window the person set (`Window unknown · Set`); wins over the server's. */
  windowOverride?: number
  tools: LocalToolSupport
  images: boolean
  /** The server runs this model elsewhere (an Ollama cloud model): never treated as local. */
  cloud?: true
  /** In memory on the server now, when the server says. Absent: unknown. */
  loaded?: boolean
}

/** One model as the picker and the Providers page see it. */
export interface LocalModelView extends LocalModelFacts {
  id: string
  label: string
}

/** `tools` that let a person-driven thread run with tools. */
export function localToolsAttended(tools: LocalToolSupport): boolean {
  return tools === 'passed' || tools === 'reported'
}

/** `tools` that let a bot or a delegated child run with tools: only a passed check. */
export function localToolsUnattended(tools: LocalToolSupport): boolean {
  return tools === 'passed'
}

/** A model that runs tool-free turns only (`Chat only`). */
export function localChatOnly(facts: Pick<LocalModelFacts, 'tools'>): boolean {
  return facts.tools === 'none' || facts.tools === 'failed'
}

/** The window turns plan with: the person's, else the server's, else unknown. */
export function localEffectiveWindow(facts: Pick<LocalModelFacts, 'loadedWindow' | 'windowOverride'>): number | undefined {
  return facts.windowOverride ?? facts.loadedWindow
}

/** One server found by detection (`providers.local.detect`). */
export interface LocalServerRow {
  kind: LocalRuntimeKind
  label: string
  /** The OpenAI base (`http://127.0.0.1:11434/v1`); absent when nothing answers. */
  baseUrl?: string
  /**
   * `running`: answers, `count` models; `needs_key`: answers 401 (Unsloth Studio always); `not_running`: installed on
   * this computer, nothing answers; `connected`: already added (its provider id in `providerId`).
   */
  state: 'running' | 'needs_key' | 'not_running' | 'connected'
  count?: number
  providerId?: string
}

/** `providers.local.connect`. */
export interface LocalConnectInput {
  /** A host, `host:port`, or a full base URL (`http://box:8000/v1`, a reverse-proxy prefix kept). */
  address: string
  /** The server's own key, entered after a 401. Stored in the credential store, sent only to this address. */
  apiKey?: string
  /** The person agreed to plain http to another machine on the network (asked once per connection). */
  allowCleartext?: boolean
}

/** Why a connect did not finish, for the one line and one action the dialog shows. */
export type LocalConnectProblem =
  /** 401/403: show the key field. */
  | 'needs_key'
  /** Plain http to a host that is not this computer: ask once. */
  | 'cleartext_consent'
  /** Nothing answers there. */
  | 'unreachable'
  /** It answers, but not as a model server (404 on the model list, not JSON). */
  | 'not_a_model_server'
  /** The address is not one Mousse can use (credentials in it, not http or https). */
  | 'invalid_address'

export type LocalConnectResult =
  | { ok: true; providerId: string; label: string; kind: LocalRuntimeKind; count: number }
  | { ok: false; problem: LocalConnectProblem; message: string; kind?: LocalRuntimeKind }

/** `providers.local.setModel`: the person's window for a model (`Window unknown · Set`); null clears it. */
export interface LocalSetModelInput {
  providerId: string
  modelId: string
  window: number | null
}

/** `providers.local.checkTools`: the round-trip check on an already-loaded model. */
export interface LocalCheckToolsInput {
  providerId: string
  modelId: string
}

export type LocalCheckToolsResult =
  | { ok: true; tools: LocalToolSupport }
  /** `cold`: the model is not in memory, and the check never loads one. */
  | { ok: false; problem: 'cold' | 'unreachable' | 'unknown_model'; message: string }

/** The smallest window an agent turn (tools on) may plan with. Below it, Mousse's prompt and tools do not fit. */
export const LOCAL_AGENT_MIN_WINDOW = 16_384
