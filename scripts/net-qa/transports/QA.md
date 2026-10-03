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
tailnet route. Named Cloudflare tunnels and the full Bridge workflow through the
relay remain unqualified by this link probe.
