# Automatic LAN connections

Enabled, unlocked Net profiles listen for paired devices on an IPv4 TCP port on every interface and discover each other using UDP multicast `239.255.77.77:47777` (TTL 1). This works without the hosted relay, including after both computers restart. The configured `direct` listener remains separate: disabling it withdraws its published routes, while automatic LAN connections remain available. Disabling Net stops both.

## A port that stays the same

The listener's port is chosen once and kept in the profile's Net database (`net_lan_port`), so it is the same after a restart. If the kept port is taken when Net starts, a new one is chosen and kept instead; peers learn it from the next beacon or the next session. The listener is reachable on a stable port on every interface, including networks you do not trust. That exposes no more than an ephemeral port did: a connection must still pass the pinned TLS certificate and signed hello, and the existing preauthentication connection, byte and deadline limits apply. A stable port is easier to find with a port scan; a scanner learns only that something speaks TLS there.

## Beacons

Every five seconds each profile sends a fixed-size advertisement for up to 64 peers in its current signed roster that a session would be admitted with: a device of the user's list connected here, or the keeper and its members (the connection record in `src/mms/net/store/connections.ts`). Beacons from any other device are ignored. Discovery reads that list again on every tick, so connecting or disconnecting a device, or revoking it, takes effect within five seconds. Each advertisement is AES-256-GCM encrypted with a directional key derived with HKDF-SHA256 from the devices' X25519 agreement keys and the sender's node id. The packet contains only a timestamp, listening port and random padding. It exposes no account, device id, device name or route in plaintext. Nearby observers can still observe traffic timing and source addresses.

Authenticated hints expire after 30 seconds, require clocks within 30 seconds, and use the UDP source address rather than a supplied hostname. Up to eight interface addresses per peer are retained so VPN and virtual interfaces do not replace a usable WiFi address. Memberships refresh when interfaces change; a failed UDP socket is retried on the next tick. Discovery processing is bounded to 128 candidate packets per five seconds and 64 peer keys. This bounds work but does not prevent local denial of service.

## The last address

Each computer also keeps, per device, the last address a session with it opened over (`net_lan_last_address`), so the two can reconnect after both restart even where beacons do not arrive:

- When this computer dialled, it is the route it dialled, if that was a LAN hint or a direct route. A relay is never kept.
- When this computer accepted the session on its LAN listener, it only sees the peer's source port. Each side therefore tells the other its listener port on the session (`lan.port`, unsigned, same user only), and the accepting side keeps the peer's source address with that port.

The last address is tried after the live LAN hints and before signed routes: a hint is fresher, and on the same network the last address is likelier to answer than a published route. A dead one delays the next local route only by the dial stagger (250 ms). Records of devices that leave the list are dropped.

`lan.port` is a session capability (`lan.port.v1`). A build from before it does not offer the capability and is never sent the message, so it keeps working; such a peer just cannot be dialled back by a computer that only accepted from it.

## Before the relay

Routes with a priority below 0 (LAN hints and the last address) get a 1.5 s head start before any route above 0 (Tailscale, the relay, tunnels) is dialled. A LAN dial with its pinned TLS finishes well within that, so two devices on one network do not open a relay connection at all. When every local route has failed, the remote routes start at once. Configured direct routes (priority 0) keep the ordinary 250 ms stagger.

## Phones

A phone learns the listener's addresses from `net.direct.endpoints` (see `protocol.md`): one `ws://<address>:<port>/mousse-net` per private IPv4 address of the computer, at most eight, only for another device of the same account. The listener binds IPv4 only, so unique local IPv6 addresses are not offered. A phone that remembers them can open its next session on the LAN with no relay. Its session on the listener passes the same pinned TLS, signed hello, delegation, revocation and connected-here checks as a session through the relay.

## Trust

Hints, the told port and the last address are local and unsigned, and are never added to signed or cloud-published routes. They do not authenticate a session: the existing pinned TLS certificate, signed hello, current delegation, revocation and connected-here checks still apply to every dial. Revoked peers are removed from discovery on its next tick. A lapsed delegation can still yield a hint so the existing authenticated hello can recover a renewed roster; session authentication enforces the current roster independently.

## Limits

Both computers need a build with LAN discovery. IPv6-only networks, WiFi client isolation and host firewalls that reject the listener cannot use this path. With multicast blocked, the last address carries the pair only while neither computer's address changes: after an address change the pair stays offline on the LAN until a new link is made or another route (Tailscale, relay or a configured listener) connects them. Existing relay and manually configured routes remain fallbacks. Initial pairing still needs an existing enrollment route. Automatic Tailscale discovery and a path indicator in Devices are separate work tracked in #379.
