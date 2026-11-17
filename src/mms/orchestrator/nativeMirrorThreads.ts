import type { NativeHelperRuntime, NativeHelperState, Thread, ThreadLineage, ThreadNativeHelper } from '../../shared/types'
import type { StreamingLlmToolEvent } from '../harness/turnEvents'
import { attributeCall, callMetaIds, nativeHelperRuntime, nativeMirrorThreadId, NativeHelperRouter, type CallAttribution, type HelperRoute } from '../run/nativeHelpers'

/**
 * The mirror threads of native helpers (docs/plans/tool-api.md §2.7), made at provider ingestion: as a hosting run's tool
 * events arrive, each helper the runtime starts gets a watch-only thread under the hosting thread (or under the helper
 * that started it), with relation `native`, its lineage, the provider instance, the runtime session and an id that ends
 * in the runtime's agent id. The helper's own calls are written to its thread's log as they happen; the hosting thread's
 * log is unchanged. The thread's state follows the helper: a run that ends without the helper's end leaves it `unknown`.
 */

/** What the mirrors need of the orchestrator and the thread store. */
export interface NativeMirrorHost {
  thread(threadId: string): Thread | undefined
  /** Makes the mirror thread; refused when the id is taken. */
  createMirror(input: { id: string; name: string; host: Thread; lineage: ThreadLineage; owner: string; native: ThreadNativeHelper }): void
  updateNative(threadId: string, native: ThreadNativeHelper): void
  rename(threadId: string, name: string): void
  /** Writes a tool event to the mirror thread's own log, as the hosting thread's log takes its own. */
  writeTool(threadId: string, event: StreamingLlmToolEvent): void
  /** A line in the mirror thread's log (how the helper started or ended). */
  writeNote(threadId: string, text: string): void
  /** Closes the calls still open in the mirror's log: the helper's end was never reported. */
  closeOpenCalls(threadId: string): void
}

/** One hosting run as its mirrors follow it. */
export interface HostRun {
  hostThreadId: string
  runId: string
  instanceId: string
  sessionEpoch: string
}

const END_NOTES: Record<Exclude<NativeHelperState, 'running'>, string> = {
  done: 'The helper finished.',
  failed: 'The helper failed.',
  stopped: 'The helper was stopped.',
  unknown: 'The run that hosted this helper ended without the runtime saying how the helper ended.'
}

const RUNTIME_NAMES: Record<NativeHelperRuntime, string> = { codex: 'Codex', claude: 'Claude Code' }

export class NativeMirrorThreads {
  private readonly routers = new Map<string, NativeHelperRouter>()
  /** The mirror thread of each helper, by hosting thread and agent id. */
  private readonly mirrors = new Map<string, string>()

  constructor(private readonly host: NativeMirrorHost) {}

  /**
   * A run of `hostThreadId` starts on a runtime with native helpers: its tool events are followed from here. Undefined
   * for a driver whose helpers Mousse does not mirror.
   */
  beginRun(run: HostRun & { driver: string }): MirroredRun | undefined {
    const runtime = nativeHelperRuntime(run.driver)
    if (!runtime) return undefined
    let router = this.routers.get(run.hostThreadId)
    if (!router || router.runtime !== runtime) {
      router = new NativeHelperRouter(runtime)
      this.routers.set(run.hostThreadId, router)
    }
    router.beginRun()
    return new MirroredRun(this, router, { hostThreadId: run.hostThreadId, runId: run.runId, instanceId: run.instanceId, sessionEpoch: run.sessionEpoch })
  }

  /** Who made a Mousse tool call that arrived under `hostThreadId`'s credential, from what its runtime put in `_meta`. */
  async attribute(hostThreadId: string, meta: unknown): Promise<CallAttribution> {
    const attribution = await attributeCall(this.routers.get(hostThreadId), callMetaIds(meta))
    if (attribution.kind !== 'helper') return attribution
    const mirrorThreadId = this.mirrors.get(key(hostThreadId, attribution.agentId))
    return mirrorThreadId ? { ...attribution, mirrorThreadId } : attribution
  }

  /** Forgets a hosting thread (deleted). */
  forget(hostThreadId: string): void {
    this.routers.delete(hostThreadId)
    for (const entry of [...this.mirrors.keys()]) if (entry.startsWith(`${hostThreadId}\n`)) this.mirrors.delete(entry)
  }

  /** @internal The mirror of a helper, made or reopened at its start. */
  open(run: HostRun, runtime: NativeHelperRuntime, route: Extract<HelperRoute, { kind: 'start' }> & { resumed?: boolean }): string | undefined {
    const host = this.host.thread(run.hostThreadId)
    if (!host) return undefined
    const id = nativeMirrorThreadId({ hostThreadId: run.hostThreadId, instanceId: run.instanceId, sessionEpoch: run.sessionEpoch, agentId: route.agentId })
    if (!id) return undefined
    this.mirrors.set(key(run.hostThreadId, route.agentId), id)
    const existing = this.host.thread(id)
    if (existing?.native) {
      this.host.updateNative(id, { ...existing.native, hostRunId: run.runId, state: 'running' })
      this.host.writeNote(id, 'More work for the helper.')
      return id
    }
    if (existing) return undefined
    const parentMirror = route.parentAgentId ? this.mirrors.get(key(run.hostThreadId, route.parentAgentId)) : undefined
    const parent = parentMirror ? this.host.thread(parentMirror) ?? host : host
    const lineage: ThreadLineage = { parentThreadId: parent.id, rootThreadId: host.lineage?.rootThreadId ?? host.id, relationship: 'native' }
    // A helper's first event in this run may be more work for one an earlier run started: its log starts here.
    const partial = route.resumed === true
    const native: ThreadNativeHelper = {
      runtime,
      instanceId: run.instanceId,
      sessionEpoch: run.sessionEpoch,
      agentId: route.agentId,
      hostRunId: run.runId,
      state: 'running',
      ...(partial ? { partial: true } : {})
    }
    try {
      this.host.createMirror({ id, name: mirrorName(route), host, lineage, owner: parent.id, native })
    } catch (error) {
      console.warn('a native helper could not be mirrored', { hostThreadId: run.hostThreadId, agentId: route.agentId, error: error instanceof Error ? error.message : String(error) })
      return undefined
    }
    const started = `${RUNTIME_NAMES[runtime]} started this helper in "${host.name}".${route.description ? `\n\n${route.description}` : ''}`
    this.host.writeNote(id, partial ? `${started}\n\nIts earlier work was not followed; this log starts here.` : started)
    return id
  }

  /** @internal The helper's row said what it is after it started: a mirror still named by its placeholder takes the name. */
  describe(mirrorThreadId: string, route: Extract<HelperRoute, { kind: 'describe' }>): void {
    const thread = this.host.thread(mirrorThreadId)
    if (!thread?.native || !route.description) return
    if (thread.name === mirrorName({}) || (route.agentType && thread.name === mirrorName({ agentType: route.agentType }))) {
      this.host.rename(mirrorThreadId, mirrorName(route))
      this.host.writeNote(mirrorThreadId, route.description)
    }
  }

  /** @internal */
  mirrorOf(hostThreadId: string, agentId: string): string | undefined {
    return this.mirrors.get(key(hostThreadId, agentId))
  }

  /** @internal The helper ended, or its run ended without saying. */
  end(mirrorThreadId: string, state: Exclude<NativeHelperState, 'running'>, details: { summary?: string; sendTo?: string } = {}): void {
    const thread = this.host.thread(mirrorThreadId)
    if (!thread?.native || thread.native.state !== 'running') return
    this.host.closeOpenCalls(mirrorThreadId)
    this.host.updateNative(mirrorThreadId, { ...thread.native, state, ...(details.sendTo ? { sendTo: details.sendTo } : {}) })
    this.host.writeNote(mirrorThreadId, details.summary ? `${END_NOTES[state]}\n\n${details.summary}` : END_NOTES[state])
  }

  /** @internal */
  write(mirrorThreadId: string, event: StreamingLlmToolEvent): void {
    this.host.writeTool(mirrorThreadId, event)
  }
}

/** One hosting run's tool events as its mirrors take them. */
export class MirroredRun {
  constructor(private readonly mirrors: NativeMirrorThreads, private readonly router: NativeHelperRouter, readonly run: HostRun) {}

  /** A tool event of the hosting run (after the hosting thread's own log took it). Never throws. */
  tool(event: StreamingLlmToolEvent): void {
    try {
      const route = this.router.route(event)
      if (route.kind === 'host') return
      if (route.kind === 'start') {
        const known = this.mirrors.mirrorOf(this.run.hostThreadId, route.agentId)
        // Codex's later episode of a helper this process never saw start: the helper is older than its log here.
        const resumed = !known && this.router.runtime === 'codex' && (event.activity as { summary?: string } | undefined)?.summary === 'More work'
        this.mirrors.open(this.run, this.router.runtime, { ...route, ...(resumed ? { resumed: true } : {}) })
        return
      }
      const mirror = this.mirrors.mirrorOf(this.run.hostThreadId, route.agentId)
      if (!mirror) return
      if (route.kind === 'describe') this.mirrors.describe(mirror, route)
      else if (route.kind === 'end') this.mirrors.end(mirror, route.state, { ...(route.summary ? { summary: route.summary } : {}), ...(route.sendTo ? { sendTo: route.sendTo } : {}) })
      else this.mirrors.write(mirror, route.event)
    } catch (error) {
      console.warn('a native helper event could not be mirrored', { hostThreadId: this.run.hostThreadId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** The hosting run ended: a helper still open ended without the runtime saying how, so its mirror reads `unknown`. */
  end(): void {
    for (const agentId of this.router.endRun()) {
      const mirror = this.mirrors.mirrorOf(this.run.hostThreadId, agentId)
      if (mirror) this.mirrors.end(mirror, 'unknown')
    }
  }
}

/** A mirror's name: what the runtime said the helper does, else its kind. */
function mirrorName(route: { description?: string; agentType?: string }): string {
  const label = route.description ?? route.agentType ?? 'Helper'
  return label.length > 80 ? `${label.slice(0, 79)}…` : label
}

function key(hostThreadId: string, agentId: string): string {
  return `${hostThreadId}\n${agentId}`
}
