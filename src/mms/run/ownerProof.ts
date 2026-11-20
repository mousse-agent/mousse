/**
 * Proof that the owner of this Mousse wrote a message themselves, recorded on its run when the send
 * arrives. Only the `orchestrator.send` protocol handler makes one, from the connection the request
 * came in on (never from anything the caller says): a Mousse window on this computer (`gui`), or a
 * window on another of the owner's own computers through a routed call (`bridge`, whose RPC layer
 * admits only devices of the owner's own Mousse ID). A Resume now press records one on the pause it
 * resumes (`RunPause.resumeOwner`), and the continue turn takes it from there.
 *
 * What it proves: the connection passed the daemon's owner-token check and introduced itself as a window. The token
 * is the local trust boundary, so any program running as the owner that can read it is trusted as their window, as
 * for every other window command. It does not prove that a person pressed anything.
 *
 * Read by the gate for providers that may only run turns the owner drives (`harness/ownerOnly.ts`).
 */
export interface OwnerProof {
  via: 'gui' | 'bridge'
  /** The owner's other computer, for `bridge`. */
  node?: string
}

/** A stored proof, or undefined for anything that is not exactly one. */
export function decodeOwnerProof(value: unknown): OwnerProof | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const { via, node } = value as Record<string, unknown>
  if (via === 'gui') return { via }
  if (via === 'bridge' && typeof node === 'string' && node.length > 0 && node.length <= 256) return { via, node }
  return undefined
}
