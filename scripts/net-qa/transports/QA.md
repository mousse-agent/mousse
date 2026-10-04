# P4 transport QA evidence

I ran the Cloudflare quick-tunnel link probe on macOS with Node 24.20.0 and
cloudflared 2026.3.0:

```sh
MOUSSE_NET_QA_OPT_IN=1 MOUSSE_QA_DNS_FALLBACK=1 /tmp/mousse-net-runtime-l9dp7l_5/node-v24.20.0-darwin-arm64/bin/node scripts/net-qa/transports/run.mjs cloudflared
```

The process exited 0. Its recorded result was:

```json
{"transport":"cloudflared","mode":"quick","systemDns":false,"injectedResolver":true,"outerHostAndSniPreserved":true,"mutualPinnedTls":true,"exporterMatches":true,"largeControlPartsBytes":918400,"wrongPinRejected":true}
```

System `getaddrinfo` failed for the newly issued hostname. I used the opt-in
QA-only resolver to measure A records against 1.1.1.1, with the original hostname
preserved for WebSocket Host, TLS SNI and certificate validation. This run does not
qualify system DNS. I did not modify account tunnels, existing configuration or
DNS records. The probe removed its child, origin listener, generated keys and
temporary directories.

I have not run the Tailscale real-binary probe: no Tailscale binary or authenticated
tailnet is available here. Its fake-binary supervisor checks do not qualify a real
tailnet route. This link probe alone does not qualify a Bridge workflow or relay.

## Isolated named tunnel

I also ran the same actual encrypted-link probe through a task-owned named tunnel
and a new random hostname under the authenticated `avarnic.com` zone on
2026-10-03. Existing credentials authorized tunnel creation and isolated DNS;
no additional login was needed. I verified removal of the new DNS record,
tunnel, and its private credentials after each attempt. I left existing account
tunnels, DNS records, and configuration unchanged.

The first named startup failed. Captured cloudflared logs showed that the generated
ingress service included a trailing `/`, which cloudflared rejects as an origin
path. I corrected the named service to use the URL origin and reproduced the
regression in the focused configuration test before verifying its fix.

The next attempt registered an edge connection, but its first WebSocket dial
returned HTTP 530. I captured the HTTP body as `error code: 1033`. The bounded
QA-only pre-payload readiness retry waited five seconds; the next connection
passed the complete probe. I did not replay any application request or effect.
The successful result was:

```json
{"transport":"cloudflared","mode":"named","systemDns":true,"injectedResolver":true,"outerHostAndSniPreserved":true,"mutualPinnedTls":true,"exporterMatches":true,"largeControlPartsBytes":918400,"wrongPinRejected":true}
```

This run used the opt-in resolver callback with system-measured DNS answers.
It establishes a named-tunnel encrypted link, not a complete Bridge, Spaces,
packaged-daemon, or release gate. Startup edge registration alone did not prove
that the newly created hostname could already reach the connector.

## Composed Bridge through a quick tunnel

I ran the real profile-composition gate on macOS with Node 24.20.0 and
cloudflared 2026.3.0 on 2026-10-03:

```sh
MOUSSE_NET_QA_OPT_IN=1 MOUSSE_QA_DNS_FALLBACK=1 \
MOUSSE_QA_EVIDENCE_OUT=/private/tmp/mousse-bridge-cloudflare-qa.json \
TMPDIR=/private/tmp node node_modules/vitest/vitest.mjs run \
  tests/net/bridge/composed-execution.test.ts -t 'real quick Cloudflare'
```

The evidence file must not already exist. The test is skipped without the explicit
opt-in. Both actual MMS profiles use production Bridge/Net composition. The target
disables its direct listener and advertises only its task-owned quick tunnel. The
caller enrolls through that route, creates a thread, receives a verified 2.64 MiB
display snapshot, observes a target-local rename, then sends, steers and aborts an
exact owned native run through the same authenticated transport. The provider SDK
response fixture is deterministic; external HTTP fetch throws. This does not
qualify paid billing or activate NativeBotRuntime/reader profiles.

The cleanup-qualified run passed in 14.87 seconds and recorded:

```json
{"gate":"composed-bridge-cloudflared-quick","dnsEvidence":[{"systemDns":true,"injectedResolver":true}],"prePayloadAttempts":2,"onlyCloudflareRoute":true,"sameUserAuthenticated":true,"mutualPinnedTls":true,"verifiedDisplayBytes":2640000,"actualNativeSteerAbort":true,"ownedTunnelChildrenStopped":true,"ownedTunnelDirectoriesRemoved":true,"paidProviderQualified":false}
```

I also observed system `getaddrinfo` failure on an earlier hostname and transient
1.1.1.1 A-record absence on another newly created hostname. The QA resolver measures
system answers first and uses 1.1.1.1 only when explicitly enabled. It waits for DNS
propagation before enrollment, then supplies measured addresses to the production
DirectTransport resolver cache. Actual WebSocket URL, Host, SNI, certificate
validation, inner mutual TLS pinning, delegation and same-user RPC authorization
remain in effect. The two pre-payload dial attempts in the recorded run are the
enrollment and normal-session connections; application mutations are never replayed.
Production DNS behavior and route phase deadlines are unchanged.

After profile shutdown I checked every task-owned tunnel PID returned `ESRCH` and
its private working directory returned `ENOENT`. The test removes its profiles and
temporary Git repository. It creates no account tunnel or DNS record and changes no
existing Cloudflare resource. This qualifies the composed profile workflow through
a quick tunnel; named-tunnel Bridge, relay/Tailscale application workflows, separate
CLI daemon processes through Cloudflare, and packaged application gates still need
their own evidence.
