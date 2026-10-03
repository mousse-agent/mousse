# Dispatch engine integration

`DispatchService` shares the profile's `NetDatabase` with the durable RPC ledger.
Register `bridge.dispatch` with `write`, mutation and input upload enabled. The
root handler passes the admission's trusted execution id to `run`; it must not
take an execution id from remote parameters. Root RPC authorization continues to
require the current same-user node delegation and capability.

The local owner first calls `portableRepository` and `bindRepository` with a
canonical repository root. Network requests carry its portable id, exact base
commit, definition selector, prompt and finite run limits. They cannot select a
local path, remote URL, host permission or provider credentials. Fetch and push
require both an explicit request and a local binding that enables that operation
and selects an existing remote name. No merge occurs.

The artifact port wraps `BridgeArtifacts.input(ref, context, 'bridge.dispatch')`
and `preparePublication(bytes, 'application/x-git-bundle', context,
'bridge.dispatch')`. The returned `commit` is synchronous. The engine registers
it together with its completed journal transition in `onTerminalCommit`; the
root dispatcher runs this callback inside the terminal execution transaction.
Returning a prepared ref alone does not publish a result. SQL rollback leaves
the journal in publishing and reconciliation marks it uncertain.

Input artifacts are bounded and checked against their blob digest, then Git
verifies them in a private quarantine repository. Exactly one head is permitted:
`refs/mousse/dispatch-input/<baseCommit>`. Incremental prerequisites may use the
already bound repository's objects. Strict object checks and root ancestry
precede importing that one ref. Git never imports configuration, hooks or other
refs from an input bundle.

`mmsDispatchRuntime` calls the existing `runAgentDefinition` lifecycle with its
resolved immutable definition, stable execution thread, exact isolated worktree,
local approval callback, reduced budget and cancellation signal. Prompt and
native transcript are durably recorded in that thread. Only the native
Mousse runtime and thread/off memory are currently supported. Provider context
does not inherit desktop thread history or selected files.

On success, the target commits worktree changes and retains
`refs/mousse/dispatch/<dispatchId>`, a full result bundle and a node-signed result.
Callers must run `verifyDispatchResult` with the expected target user/node,
original RPC, execution, repository, base and request digest before presenting or
applying it. Artifact retrieval still goes through the authorized gateway.

Call `recover()` at startup before admitting new dispatches. Preparation crashes
fail and clean up; running/publishing crashes become uncertain and retain model
effects for owner inspection. Completion cleanup runs only after the terminal
transaction and removes the validated owned worktree and private quarantine.
Cleanup failures persist bounded codes and can be retried with `recover`.
`query` returns the local recovery record; root should select its external owner
DTO instead of exporting local repository/worktree paths accidentally.

The owned engine tests use actual Git, databases, ThreadDataStore and
WorktreeManager, with a deterministic model port. They include actual child
SIGKILL recovery. They do not establish full MMS/RPC/model end-to-end
qualification; root transport/artifact/daemon composition supplies that evidence.
The native fixture additionally uses the actual MMS published definition,
resolver, orchestrator and provider/tool lifecycle, with only a deterministic
provider stream/auth seam. It proves the actual write tool's isolated worktree
effect, exact approval binding and local transcript, not a live external model.
Dispatch uses WorktreeManager's trusted safe-checkout option to disable hooks and
filesystem monitors and refuse configured external checkout filters. Ordinary
desktop worktree behavior remains unchanged.
