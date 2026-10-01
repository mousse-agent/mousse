import { randomUUID } from 'node:crypto'

export interface ReferenceIdentity {
  profileId: string
  sessionId: string
  generation: number
  tabId: string
  documentId: string
  observationId: string
}
export interface ObservedNode {
  backendNodeId: number
  frameRef: string
  cdpSessionId?: string
  fingerprint: string
  frameId?: string
}
interface StoredReference extends ObservedNode { ref: string; identity: ReferenceIdentity }

/** Backend node IDs are private; only observations may mint model-visible references. */
export class BrowserReferenceStore {
  private readonly observations = new Map<string, Map<string, StoredReference>>()
  constructor(private readonly owner: Pick<ReferenceIdentity, 'profileId' | 'sessionId' | 'generation'>, private readonly maxObservations = 8, private readonly maxElements = 1000) {
    if (!owner.profileId || !owner.sessionId || !Number.isSafeInteger(owner.generation) || owner.generation < 1 || !Number.isSafeInteger(maxObservations) || maxObservations < 1 || !Number.isSafeInteger(maxElements) || maxElements < 1) throw new Error('Invalid reference store bounds')
    this.owner = Object.freeze({ ...owner })
  }

  observe(identity: ReferenceIdentity, nodes: readonly ObservedNode[]): string[] {
    this.assertOwner(identity)
    if (!identity.tabId || !identity.documentId || !identity.observationId || this.observations.has(identity.observationId)) throw new Error('stale_observation')
    if (nodes.length > this.maxElements) throw new Error('Observation element limit exceeded')
    const values = new Map<string, StoredReference>()
    for (const node of nodes) {
      if (!Number.isSafeInteger(node.backendNodeId) || node.backendNodeId < 1 || !node.frameRef || !node.fingerprint) throw new Error('Invalid observed node')
      const ref = 'el_' + randomUUID()
      values.set(ref, Object.freeze({ ...node, ref, identity: Object.freeze({ ...identity }) }))
    }
    this.observations.set(identity.observationId, values)
    while (this.observations.size > this.maxObservations) this.observations.delete(this.observations.keys().next().value!)
    return [...values.keys()]
  }

  resolve(identity: ReferenceIdentity, ref: string): Readonly<StoredReference> {
    this.assertOwner(identity)
    const record = this.observations.get(identity.observationId)?.get(ref)
    if (!record || record.identity.tabId !== identity.tabId || record.identity.documentId !== identity.documentId) throw new Error('stale_ref')
    return record
  }

  invalidateTab(tabId: string): void {
    for (const [id, values] of this.observations) {
      if ([...values.values()].some((record) => record.identity.tabId === tabId)) this.observations.delete(id)
    }
  }

  invalidateDocument(documentId: string): void {
    for (const [id, values] of this.observations) {
      if ([...values.values()].some((record) => record.identity.documentId === documentId)) this.observations.delete(id)
    }
  }

  invalidateFrame(frameRef: string): void {
    for (const [id, values] of this.observations) {
      if ([...values.values()].some((record) => record.frameRef === frameRef)) this.observations.delete(id)
    }
  }

  hasObservation(observationId: string): boolean {
    return this.observations.has(observationId)
  }

  clear(): void { this.observations.clear() }

  private assertOwner(identity: ReferenceIdentity): void {
    if (identity.profileId !== this.owner.profileId || identity.sessionId !== this.owner.sessionId) throw new Error('profile_mismatch')
    if (identity.generation !== this.owner.generation) throw new Error('stale_generation')
  }
}
