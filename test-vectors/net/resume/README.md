# Resume and staging vectors

The cases freeze ordered inputs and explicit durable-cursor checkpoints. Ranges expand to inclusive original positions. `subscribed.head` and `through` are captured simultaneously and MUST match; later live positions may exceed that captured head. All source records carry exact signed bytes in actual P1 conformance; this policy catalogue names positions/semantic roles and is not cryptographic evidence.

The full meta-snapshot case preserves epoch-1 genesis plus its signed freeze (positions 1–2), and an owner-signed epoch-2 descriptor activation whose auth names prior safe head `(1,2)`. The codec's signed catalogue supplies byte/signature examples; P1 must materialize real identity/descriptor evidence for these sequences, check the entire chain, inject transactions/faults, and compare the unchanged oracle. Snapshot data never triggers a bot or normal onRecord callback. Staging is invisible until complete validation plus atomic generation/cursor activation.

P0 loader tests check catalogue bounds and position/range integrity. They do not simulate a store or establish that the P1 resume protocol works.
