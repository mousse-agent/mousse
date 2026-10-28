import { type Duplex, duplexPair } from 'node:stream'

/**
 * Two streams joined end to end, where destroying one destroys the other.
 *
 * `duplexPair` does not do this: destroying one end leaves the other open, so a tunnel that ended would leave the
 * SSH connection on the other end of its pair running, with its programs. The endpoint's side of a tunnel is such
 * a pair, so the two ends are tied together here.
 */
export function linkedPair(): [Duplex, Duplex] {
  const [near, far] = duplexPair()
  near.once('close', () => far.destroy())
  far.once('close', () => near.destroy())
  // An error on one end has no listener until its owner takes it over; it must not be an unhandled event.
  near.on('error', () => {})
  far.on('error', () => {})
  return [near, far]
}
