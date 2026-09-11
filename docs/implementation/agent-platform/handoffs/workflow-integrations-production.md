# Production workflow MCP and Skill adapters

This root-owned slice connects `load-skill` and `mcp-tool` workflow nodes to each profile's existing integration services. It builds on reviewed core `031ca936` and does not close W02, W03, I04 or a release gate.

## Admission and ownership

`MmsProfilePlatform` creates one `MmsWorkflowIntegrations` for its owning profile. `MmsWorkflowCoordinator.prepareExecution` runs before the durable admission record or execution thread is created. It traverses the compiled graph and nested inline graphs, resolves enabled installations through the profile's native Mousse integration gates, and discovers only referenced MCP servers. Discovery can start the configured MCP server to obtain its tool catalog; admission never calls an MCP tool.

Host-created `WorkflowExecutionBindings` carry exact Skill Markdown bytes and hashes, installation identities, requested historical revisions, MCP configuration revisions and input/output schemas. Public run DTOs reject this field. The bindings are part of the engine admission digest and persisted run manifest. A repeated request ID reads its original admission rather than resolving current dependency heads. A Skill edit after admission therefore leaves the run's instructions unchanged, including after host restart. Disabling, archiving or deselecting the installation still revokes future dispatch.

Admitted Skill content is limited to 1 MiB per entry; MCP schemas to 256 KiB per entry; all bindings to 8 MiB; the complete admission record to 16 MiB. Persisted admission reads reject changed directory roots, symlinks, nonregular files, oversized files, malformed JSON and changed file identities. Opening and reading use an explicit byte bound. These admission limits do not claim that all preexisting integration discovery/Skill registry reads are themselves bounded before allocation.

## Dispatch

Adapters verify the active profile, project, thread, run, actor, source, turn, cancellation identity and policy digest against the host-owned running manifest. Skill loads return the admitted instructions and revision metadata only while that installation remains enabled. `load-skill` produces graph data; it does not automatically append the instructions to every later agent prompt or execute Skill resource files.

MCP calls require the exact admitted server/tool, `mcp.invoke`, external-effect permission and matching schemas. Inputs are validated before transport dispatch, and structured output is validated when the server declares an output schema. Results retain the existing integration provenance and content blocks, with a 4 MiB admitted result limit. The existing workflow engine owns durable approval decisions and effect intents; this adapter does not fabricate approvals.

`McpManager.callTool` accepts an internal optional execution pin. It fences the initial descriptor, authorization result and connected configuration, then checks execution ownership and fresh installation permissions after connection setup. Profile selection cannot be bypassed by the temporary explicit one-tool actor grant. The final guard also rejects a changed descriptor or aborted call before calling the transport. Ordinary MCP callers without a pin retain their existing API.

MCP errors after entering the adapter remain conservative external-effect failures under the engine's existing unknown-effect handling. Even a pre-dispatch schema/revocation rejection may therefore need reconciliation; it is not automatically retried. A future typed pre-dispatch failure contract can improve this without weakening uncertain-effect handling.

## Qualification

The test suite uses the actual framed MMS server/client and profile services with a real local stdio MCP server. Provider catalog initialization is stubbed solely to prevent network refresh; no model, account, channel or third-party service is called. Fixture call/event logs independently observe tool execution and cancellation.

Coverage includes pinned Skill content after edit and host reconstruction, explicit historical revisions, exactly one observed MCP call across repeated admission, profile-separated run history, installation disable/deselection/configuration changes, input-schema rejection before any call, public rejection of supplied bindings, forged/inactive execution contexts, permission revocation during asynchronous dispatch preparation, and cancellation delivered to an in-flight MCP request. Coordinator tests also reject malformed, wrong-shape and oversized durable admission files without creating another run/thread.

Final command evidence is recorded in the delivery ledger. Host reconstruction is a graceful stop/recreate test; this slice does not claim a process-kill qualification of an in-flight external MCP effect. Existing workflow engine crash tests remain separate evidence.

## Remaining integration

- Child workflow starts bypass the top-level preparation hook. They currently fail closed if they require integration bindings. Resolve and pin transitive child dependencies and propagate only the parent's admitted authority before enabling those paths.
- Agent/main-agent, built-in tool and browser adapters, editor Try Run, provider-native browser tools, schedules/channels, completion/forms and visible app/packaged acceptance remain separate work.
- This slice uses the existing native Mousse integration enable/selection gates for workflow actors. It does not introduce a separate per-workflow installation grant editor.
- Skill resource/package execution, MCP OAuth interoperability, schema dialect qualification beyond the current validator, output artifact ownership/projection, and exhaustive discovery-read bounds remain open where not already covered by their own reviewed services.
- Root profile disposal stops the adapters with the workflow coordinator. The full background-work deletion audit is still required before P04 can close.

Source: `MmsWorkflowIntegrations.ts`, coordinator/platform composition, `McpManager.ts`, the additive workflow execution binding contract and engine admission fields. Tests: `platformWorkflowIntegrations.test.ts`, `platformWorkflowCoordinator.test.ts`, and the opt-in call/event logs in the existing stdio fixture.
