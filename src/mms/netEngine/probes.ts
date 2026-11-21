import { connect } from 'node:net'
import { engineControl } from './limits'

/**
 * The deliberate defects of the routes checks' egress controls (1b §14), run where route setup happens (a join, a
 * Reach change, an SSH add): `plus-probe` asks Plus for something, `egress-probe` opens a connection to an address
 * outside the cell. Nothing runs without the control, and an installed app never reads one.
 */
export function routeSetupProbes(): void {
  if (engineControl('plus-probe')) {
    const origin = (process.env.MOUSSE_ID_ORIGIN || process.env.MOUSSE_PLUS_ORIGIN || '').trim()
    if (origin) void fetch(new URL('/v1/net/routes', origin)).catch(() => undefined)
  }
  if (engineControl('egress-probe')) {
    // TEST-NET-1: never a real host.
    const socket = connect({ host: '192.0.2.1', port: 443 })
    socket.on('error', () => undefined)
    socket.setTimeout(1_000, () => socket.destroy())
    socket.on('connect', () => socket.destroy())
  }
}
