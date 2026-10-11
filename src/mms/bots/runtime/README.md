# Native bot runtime

`NativeBotRuntime` uses the existing `LlmClient` tool loop through its host-owned
`runtimeContext` port. It does not use the ordinary thread's prompt, Skills, MCP,
project instructions, browser, tools, provider session or transcript. Root composes
admission, materialization, output publication, compartment storage and terminal
accounting; a transcript never authorizes another execution.

The constructor requires a fixed definition, actual profile/installation identity,
the compartment and durable execution-binding ports, a current-authorization gate,
and a durable qualification port. `effectiveBotPolicyDigest` is the value admission
must bind. Every context load, model request, progress callback, approval and reader
operation rechecks the immutable binding and the current gate. Private output routing
remains the root service's responsibility.

## Qualification

No paid provider or external CLI is qualified by these tests. There is no default
billing qualification. Root must retain one reviewed record for each offered
adapter/version/provider/model/profile and keep `qualification.active(profile)`
false until that record is proved. The billing record pins the model digest,
installed Pi SDK version, Node version and platform, output/request limits and a
conservative maximum charge covering all input/output/cache/overhead/failure
classes. Catalogue prices or a nonempty evidence string do not independently
prove this bound; the durable qualification authority supplies that decision.

Every model attempt, including native retries, reserves its complete maximum before
actual provider dispatch. Terminal usage reconciles integer micro-USD. Missing
usage retains the maximum. Unexpected above-bound cost/usage or failure to stop
suspends qualification and retains evidence; it never settles unknown usage as zero.
Each execution has independent call, tool, elapsed and input-size bounds. Unknown
billing, model/version changes and unqualified profiles fail closed.

`chat` has zero tools. `reader` has only the explicitly granted `safe_read`,
`safe_list` and `safe_search` inventory. Invented names, namespaces and native aliases
cannot reach Pi/shell/MCP/browser/delegation. Reader approvals bind canonical exact
arguments, the immutable policy and execution/audience; an approval never widens
the inventory or filesystem boundary. Denial/expiry/stop prevents further actions.

Reader requires a hash-verified native module loaded by `loadNativeReader` plus an
actual packaged qualification record for this platform. There is no JavaScript
path-check fallback. The backend uses pinned `openat` directory/file handles with
`O_NOFOLLOW` for every component and rejects hardlinked regular files. Read/list/
search sizes and traversal are bounded. The installation tree and explicitly
provided additional secret/cache roots cannot overlap the project root. Blocking
filesystem operations still rely on the underlying OS/filesystem; packaged runtime
qualification must use the deployment's actual filesystem. Windows is unsupported.

`operator` and autonomous CLI/worker engines are unavailable. Their ordinary tool,
approval, subprocess cancellation and billing paths need separate qualification.

## Evidence in this checkpoint

Focused tests exercise the actual native MMS loop and ProviderAuthService model
registry with deterministic model-response fixtures, actual SQLite execution and
budget ledgers, and the compiled native filesystem backend. The fixtures establish
runtime boundaries; they do not validate paid vendor billing.

They cover zero-tool advertisement and invented-tool rejection, compartment
separation, binding/config changes, each native retry's reservation, a one-unit
budget shortfall, unknown/above-bound cost retention, exact provider cancellation,
and revocation after reservation before dispatch. Native tests on macOS cover
symlink/hardlink/traversal/profile aliases, root replacement, real ancestor/file
swap barriers, closure, exact argument preservation during an approval wait,
single-use action hashes, expiry and cancellation before a late grant.

Production activation still needs reviewed provider maximum-charge evidence,
actual packaged reader build/load, and root daemon/admission/output composition.
Linux and packaged Electron qualification have not run in this checkpoint.
