# P0 independent contract review

Date: 2026-10-02. Scope: the recovered P0 contracts and supporting implementations on `codex/issue-44-mousse-net`. I commissioned the two independent reviews requested in the recovered thread: GPT-6-Astra and GPT-6.1-Sol, each with extra-high reasoning effort. Neither reviewer edited files or wrote to GitHub.

## Final verdicts

**Astra:** “Ready for P0 contract freeze from my review. I found no remaining P0 blocker in the final snapshot.” Astra inspected the bounded historical snapshot seams, different-user join proof/receipt, mandatory outbound pin and P256 extraction, scoped artifacts and durable aliases, history/live author verification, accounting callbacks, cumulative rewraps, and placement activation boundaries. Astra inspected the corrected resume vector after its final contract review. Its earlier independent run exercised admission and TLS checks; it did not repeat the integration owner's already passing final checks.

**Sol 6.1:** “Ready for technical P0 contract freeze.” Sol found no remaining concrete P0 blocker and independently reran five selected tests across protocol, certificate and admission fixtures; 28 unrelated tests were skipped. Sol verified closure of the original codec, RSA-certificate, malformed edit-reference and indistinguishable multi-bot fixture failures, plus the final relayed-author and genesis/activation clarifications. Sol did not run the full suite or verify external owner agreement.

The final reviewed protocol SHA-256 is `21dea52747e4cfe0afd43c07fa84a2052cd309e9a769da3a164fb616abddcee6`; contracts SHA-256 is `8155c13a58829066dc2ed46e46abdd4e28991c31cf7a5fc27dd331e939f30824`. Sol's final state-machine SHA-256 is `ea5c23eb2695fa10e87c1cae9ef61016ca77f21b5e05f1e7846af8c272d4dee9`. Astra reviewed the preceding state-machine snapshot `de5e7b3e6f2f5a9b62fd095ceb5dd83d7a4b8c8ea21b8466044222d19cf617c7`; the subsequent wording corrections clarify the same relayed-author and epoch-activation contracts and were checked by Sol.

## Corrections incorporated

I incorporated review findings in the shared contracts and executable boundaries: bounded mixed-epoch snapshot staging, separate live/history identity evidence, authenticated invite use, actor/session distinctions, strict P256 peer keys, outbound pinning before I/O, immutable artifact scope, stable RPC identity, qualified clock evidence, atomic admission/terminal/recovery callbacks, per-call spend enforcement seams, complete cumulative key rewraps and distinct visibility/key epochs. I corrected fixture evidence rather than treating loader success as service conformance.

## Review limits

Both reviewers accepted the explicit v1 residual: an owner-host node has that owner's delegated privileges and can exercise direct-owner operations. This does not establish independent human intent. Both accepted explicit deferral of the local `mj1_`/`sj1_` CLI containers to P2/P5.

These verdicts close technical P0 contract findings. They do not establish shipping readiness, §4.10 agreement, actual persistence/session/authorization behavior, crash safety, packaged daemon operation, runtime containment or budget enforcement. P1 and subsequent phases must verify those obligations against real implementations. Every bot adapter remains unqualified.
