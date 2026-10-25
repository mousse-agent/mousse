# Hosted wrapper source pin

I copied these six files from the local `@mousse-plus/net-relay` package after its hosted-client/security/lifecycle tests passed. This local candidate has no runtime dependency on a sibling checkout or an unpublished package. The explicit cross-repository test uses `MOUSSE_PLUS_ROOT` only for qualification against the real gateway.

| File | SHA-256 of copied source |
| --- | --- |
| client.ts | 5def8e28a02eb53f1bae299da813fcacb63f32e50e5c7232250eb0629dd3feef |
| protocol.ts | 87c962ece3bfc7458bda284818592c7d591b78b8f090644206816ae99afa14da |
| codec.ts | 2b204b9691e01898debe9b963460d31d2ffde34c9825962e7414fe39626b705b |
| crypto.ts | b1701643e4e2275130222726b2f473b379f6174d853321e88f4fd0bfb5ed345b |
| types.ts | 4b7abb95c8f4cc53f612b127d4273f50183183f0ef5a03e4ed034c1d7c5fcea4 |
| errors.ts | e00dc2cf06ceb1ec68f257d27ede775816aaea2fb288a587bc5db26dc67e2b36 |

The wrapper domain is `mousse-plus/net-relay-auth/v1`, and the independently configured audience is the exact WSS origin plus `/v1/net/relay`. I keep the inner Net pinned TLS and signatures unchanged. The provider uses the separate `plus-relay` transport discriminant; self-hosted `relay` keeps `/mousse-relay` and its original wire.

The package's codec is adapted from this repository's Net codec, and its upstream license is retained in `UPSTREAM_LICENSE`.
