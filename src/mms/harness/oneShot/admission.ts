import type { OneShotTask } from '../driver'
import type { OneShotOp, OneShotRoute, OneShotRouteDecision, RouteFacts } from './route'

/**
 * Admission for single requests: the one step the picker listing, Automatic, a saved choice and the runner all use.
 * `admit(op, binding, view)` reads only what is cached (no check is started or awaited) and returns an immutable plan,
 * or why the request is not admitted. See docs/plans/one-shots-every-provider.md §2.
 */

/** A route's label: computed from its facts. A legacy route claims nothing, so it has its own. */
export type OneShotLabel = 'held' | 'best_effort' | 'legacy'

/** Held means no tool offered, one attempt, and no user config loaded; anything else is best-effort. */
export function routeLabel(route: Pick<OneShotRoute, 'facts'>): OneShotLabel {
  const facts = route.facts
  if (!facts) return 'legacy'
  return facts.tools === 'none_offered' && facts.attempts === 'one' && facts.isolation === 'verified' ? 'held' : 'best_effort'
}

/** The facts behind a best-effort label, in words for its tooltip. Empty for a held or legacy route. */
export function routeFactsText(facts: RouteFacts | undefined): string[] {
  if (!facts) return []
  const lines: string[] = []
  if (facts.tools === 'detected_on_report') lines.push('The agent has tools of its own: Mousse tells it not to use them and stops the request at the first one it reports.')
  if (facts.tools === 'refused_before_run') lines.push('Tools are offered, and Mousse refuses each call before it runs.')
  if (facts.attempts === 'unenforced') lines.push('A failed request may be sent again below Mousse.')
  if (facts.isolation === 'env_only') lines.push("Only the agent's environment is redirected: config it finds elsewhere may still load.")
  return lines
}

/** The operation a gateway request serves, from its task (`OneShotTask`); a bot's request names its own. */
export function opOfTask(task: OneShotTask | undefined): OneShotOp {
  switch (task) {
    case 'branch_name': return 'branch_name'
    case 'pull_request': return 'pr_draft'
    case 'commit_message': return 'commit_message'
    case 'chat_digest': return 'bot_digest'
    default: return 'thread_title'
  }
}

/**
 * The exact target of a request. `local_thread` is a thread that runs on a local server's model: only that model may
 * name it, and only while it is loaded; a stale or unloaded binding never turns into a cloud request.
 */
export type OneShotBinding =
  | { kind: 'model'; instanceId: string; model: string; effort?: string }
  | { kind: 'local_thread'; instanceId: string; model: string; resident: boolean }

/** What the runner checks just before sending: the request goes only to what was admitted. */
export interface OneShotIdentity {
  instanceId: string
  /** The runtime's build key (driver, revision, home): a config change makes a new one. */
  runtime: string
  /** The executable the last check saw, when the entry runs one. */
  executable?: string
  /** The signed-in account the last check saw, and the sign-in generation. */
  credential?: string
  /** When the facts the route relies on were last read. */
  facts?: string
}

export interface OneShotPlan {
  readonly op: OneShotOp
  readonly instanceId: string
  readonly model: string
  readonly effort?: string
  readonly route: Readonly<OneShotRoute>
  readonly label: OneShotLabel
  readonly identity: Readonly<OneShotIdentity>
}

export type NotAdmittedCode =
  | 'unknown_entry'
  | 'retired'
  | 'disabled'
  | 'stopped'
  | 'signed_out'
  | 'locked'
  | 'unchecked'
  | 'no_route'
  | 'refused'
  | 'model_hidden'
  | 'local_only'
  | 'local_unloaded'
  | 'not_local'

export interface NotAdmitted {
  readonly notAdmitted: NotAdmittedCode
  readonly reason: string
  readonly instanceId: string
}

export function isPlan(value: OneShotPlan | NotAdmitted): value is OneShotPlan {
  return !('notAdmitted' in value)
}

/** One entry as the cache knows it (`HarnessGateway.admissionView`). Every read is synchronous and asks nothing. */
export interface AdmissionEntry {
  instanceId: string
  label: string
  enabled: boolean
  retired: boolean
  /** Removed or turned off while requests ran. */
  stopped: boolean
  signedOut: boolean
  /** A bot-only entry. */
  locked: boolean
  /** A check has ended with a result: the facts a route relies on are known. */
  checked: boolean
  /** The driver's route for this model; undefined when the driver has none. */
  route(model: string): OneShotRouteDecision | undefined
  model(model: string): { hidden: boolean; local: boolean }
  identity(): OneShotIdentity
}

export interface AdmissionView {
  entry(instanceId: string): AdmissionEntry | undefined
}

const no = (instanceId: string, notAdmitted: NotAdmittedCode, reason: string): NotAdmitted => Object.freeze({ notAdmitted, reason, instanceId })

/**
 * Whether `op` may run on `binding`, from cached state only: an immutable plan, or why not. A legacy route keeps what
 * its driver did before (it is not held to a check here); a route that launches a program runs only once the entry's
 * check has read it, so a thread keeps its first line while its facts are unknown.
 */
export function admit(op: OneShotOp, binding: OneShotBinding, view: AdmissionView): OneShotPlan | NotAdmitted {
  const { instanceId, model } = binding
  const entry = view.entry(instanceId)
  if (!entry) return no(instanceId, 'unknown_entry', binding.kind === 'local_thread' ? 'The local model this thread ran on is gone; the thread keeps its first line.' : 'This provider is no longer set up.')
  if (entry.retired) return no(instanceId, 'retired', `${entry.label} is retired.`)
  if (!entry.enabled) return no(instanceId, 'disabled', `${entry.label} is turned off.`)
  if (entry.stopped) return no(instanceId, 'stopped', `${entry.label} was turned off.`)
  // A bot-only entry serves its bots' own requests (a bot's name and digest), never a thread's.
  if (entry.locked && op !== 'bot_name' && op !== 'bot_digest') return no(instanceId, 'locked', `${entry.label} runs bots only.`)
  if (entry.signedOut) return no(instanceId, 'signed_out', `${entry.label} is signed out.`)
  const decision = entry.route(model)
  if (!decision) return no(instanceId, 'no_route', `${entry.label} cannot run a single request.`)
  if ('refused' in decision) return no(instanceId, 'refused', decision.refused)
  const route = decision.route
  // A launched route's facts are about the program the check read; an in-process route's hold by construction.
  if (route.facts && route.facts.launch !== 'in_process' && !entry.checked) return no(instanceId, 'unchecked', `${entry.label} has not been checked yet.`)
  const known = entry.model(model)
  if (known.hidden) return no(instanceId, 'model_hidden', `${model} is hidden.`)
  const local = route.facts?.audience === 'own_threads' || known.local
  if (binding.kind === 'local_thread') {
    if (!local) return no(instanceId, 'not_local', "This thread's model is no longer a local one; the thread keeps its first line.")
    if (!binding.resident) return no(instanceId, 'local_unloaded', 'The local model is not loaded; the thread keeps its first line.')
  } else if (local) {
    return no(instanceId, 'local_only', 'A local model names only the threads that run on it.')
  }
  const effort = binding.kind === 'model' ? binding.effort : undefined
  return Object.freeze({
    op,
    instanceId,
    model,
    ...(effort ? { effort } : {}),
    route: Object.freeze({ id: route.id, ...(route.facts ? { facts: Object.freeze({ ...route.facts }) } : {}) }),
    label: routeLabel(route),
    identity: Object.freeze({ ...entry.identity() })
  })
}

/** Whether two identities name the same runtime, executable, sign-in and facts. */
export function sameIdentity(a: OneShotIdentity, b: OneShotIdentity): boolean {
  return a.instanceId === b.instanceId && a.runtime === b.runtime && a.executable === b.executable && a.credential === b.credential && a.facts === b.facts
}
