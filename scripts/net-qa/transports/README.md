# Real transport probes

Use Node 24.20 or newer. Each run creates and cleans up its own loopback origin,
test keys, profile directory, child process and build output. The Cloudflare probe
uses a quick tunnel and never edits an existing tunnel, configuration or DNS.

```sh
MOUSSE_NET_QA_OPT_IN=1 node scripts/net-qa/transports/run.mjs cloudflared
MOUSSE_NET_QA_OPT_IN=1 node scripts/net-qa/transports/run.mjs tailscale
```

Tailscale must already be installed and authenticated to a tailnet. The probe does
not authenticate, change tailnet ACLs or enable Funnel. Cloudflared must already be
installed. Override a binary with `MOUSSE_QA_CLOUDFLARED` or `MOUSSE_QA_TAILSCALE`.

If system DNS fails for a newly issued quick-tunnel hostname,
`MOUSSE_QA_DNS_FALLBACK=1` permits an explicitly recorded QA-only lookup against
1.1.1.1. The measured addresses change lookup only; the outer WebSocket keeps its
original Host and TLS SNI and certificate validation. Production DNS behavior does
not change. A fallback run does not qualify system DNS.

The JSON result records pinned mutual TLS over the actual route, equal TLS
exporters, a 918400-byte control payload and rejection of a different peer pin.
These link checks do not establish the full Bridge workflow acceptance gate.
Record the actual command, runtime, binary version and result in release QA.

Relay enrollment rendezvous tickets authorize transport quarantine only. I persist
the first joining node and signing key. An unbound ticket expires at its signed
invite deadline; the exact bound node/key may reconnect at most 64 times until the
issuer lease that was current at registration expires. Renewal does not extend
that retained deadline. The core authority still verifies exporter-bound proof,
exact request claims and its durable consumed receipt; the relay never grants node
enrollment or domain authorization.
