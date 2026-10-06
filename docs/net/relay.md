# Operating a self-hosted relay

I run a relay independently of any Mousse profile daemon. It admits allow-listed
public user roots or node signing keys, pairs outbound WebSockets, and forwards
opaque inner-TLS bytes. It does not host Spaces, store chat content, or grant
Bridge/Space permissions. Nodes still authenticate and authorize each other
inside the pinned TLS channel.

## Local trial

Create `nodes.json` with the public node IDs and signing keys to admit:

```json
[
  { "node": "nod_<node ID>", "signKey": "<32-byte base64url public signing key>" }
]
```

Alternatively, `users.json` contains entries with `user` (`usr_...`) and `rootKey`
(the user's 32-byte base64url public root key). A user allow-list entry admits
nodes presenting a current root-signed delegation and roster; revoked evidence
is rejected. Both files may be supplied, and neither contains private keys.
Absent lists admit nobody except a joiner using an inviter-registered enrollment
rendezvous. Files must be JSON arrays no larger than 64 KiB. Changes require a
relay restart. Keep access to these policy files restricted to the operator.

```sh
mousse-cli relay serve --database ./relay.sqlite --allow-nodes ./nodes.json
```

The default bind is `127.0.0.1:8787`. `--port 0` chooses an available port. The
command prints the advertised address and client configuration instructions.
For each admitted node, save its address in `relay-settings.json`:

```json
{ "address": "ws://127.0.0.1:8787/mousse-relay" }
```

```sh
mousse-cli net transport configure relay --settings-file relay-settings.json
```

Use the selected profile's normal `net init`/`net protect` setup first. Relay
invitations require a protected profile. There is no automatic public bind;
`--host` is an explicit IP address. IPv6 loopback (`--host ::1`) is also supported.
A bind other than `127.0.0.1` or `::1` requires an explicit advertised address.
Public routes must use `wss://`.

## VPS behind TLS termination

Point a domain such as `relay.example.com` at the VPS. Run the relay as a dedicated
unprivileged account, give that account a private data directory, and persist its
SQLite database across restarts. Keep the backend bound to loopback and expose
only the TLS proxy's port through the firewall:

```sh
mousse-cli relay serve \
  --host 127.0.0.1 --port 8787 \
  --database /var/lib/mousse-relay/relay.sqlite \
  --public-address wss://relay.example.com/mousse-relay \
  --allow-users /etc/mousse-relay/users.json
```

For example, a Caddy reverse proxy can terminate TLS and forward WebSocket
upgrades to the loopback listener:

```caddyfile
relay.example.com {
    reverse_proxy /mousse-relay 127.0.0.1:8787
}
```

Configure the proxy's certificate issuance and HTTP/TLS ports for your environment.
The relay itself has no TLS certificate flags. A non-loopback backend bind requires
both an explicit `--host` and a `wss://` public address; restrict backend access
with a firewall if the proxy runs on a different machine. The advertised URL must
end in `/mousse-relay`, with no credentials, fragment, or node query. Clients use
this public address in their settings file. A supervisor such as systemd can
restart the foreground command; let it receive SIGTERM and finish closing before
escalating shutdown. Stop the process before moving its database.

## Quotas and durability

`relay serve --help` lists all quota flags. Defaults are 1 GiB of admitted bytes
per principal per UTC hour, 120 admissions per principal per hour, 32 concurrent
connections, eight connections per principal, and 256 KiB of queued bytes per
endpoint. Authentication bytes count toward usage. Nodes admitted through one
user root share that user's quota; explicitly listed nodes have separate quotas.
Enrollment tickets have their own principal and remain limited to their
registered target and bound signing key.

Byte limits are checked in memory on every frame. Connection admission remains
durable. Byte totals flush in a deferred transaction within one second of the
first unflushed charge, at a global 1 MiB threshold, on endpoint close, and on
SIGINT/SIGTERM. Forwarding waits before exceeding the global unflushed window;
a crash can under-count at most 1 MiB across all principals. Clean shutdown
preserves all accepted usage. Hour buckets and the persisted clock watermark
survive restart; backward clock movement fails closed. Only run one relay process
per database. SQLite work still runs on the event loop during bounded flushes,
rather than once per forwarded frame.

## What the relay sees

The relay and TLS terminator see source network addresses, authenticated node or
user principals, rendezvous metadata, who connects to whom, byte sizes, and timing.
Outer TLS protects that metadata in transit to the proxy, but does not conceal it
from the operator. The relay can refuse, delay, or drop traffic.

The forwarded payload is opaque inner-TLS ciphertext when nodes use the normal
Mousse Net link. Inner pinning protects message content and end-to-end identity
from the relay and proxy. Relay admission alone does not provide that protection:
a raw client sending plaintext would expose it to the relay. The relay is not an
anonymity service, a chat archive, or a substitute for node-side authorization.
