# Hosted wrapper source pin

I copied these six files from the local `@mousse-plus/net-relay` package after its hosted-client/security/lifecycle tests passed. This local candidate has no runtime dependency on a sibling checkout or an unpublished package. The explicit cross-repository test uses `MOUSSE_PLUS_ROOT` only for qualification against the real gateway.

| File | SHA-256 of copied source |
| --- | --- |
| client.ts | 000bd00084a84242a8715e4fbff7f726a08e40ac1d7d7aa9ac004db0ec62b3e9 |
| protocol.ts | 897a2d007d6819a05d11f3964836d6c8290d74dc6df6785b9a60ef56493a79b7 |
| codec.ts | 2b204b9691e01898debe9b963460d31d2ffde34c9825962e7414fe39626b705b |
| crypto.ts | b1701643e4e2275130222726b2f473b379f6174d853321e88f4fd0bfb5ed345b |
| types.ts | ca2a896aca11b4166d7c1e493bec6c53cb9413668ef6159a18506f89b9a3c175 |
| errors.ts | e00dc2cf06ceb1ec68f257d27ede775816aaea2fb288a587bc5db26dc67e2b36 |

The wrapper domain is `mousse-plus/net-relay-auth/v1`, and the independently configured audience is the exact WSS origin plus `/v1/net/relay`. I keep the inner Net pinned TLS and signatures unchanged. The provider uses the separate `plus-relay` transport discriminant; self-hosted `relay` keeps `/mousse-relay` and its original wire.

The package's codec is adapted from this repository's Net codec, and its upstream license is retained in `UPSTREAM_LICENSE`.
