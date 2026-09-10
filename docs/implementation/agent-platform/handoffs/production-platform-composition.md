# Profile platform composition

The installation composition root now registers `agentDefinitions.*`, workflow definition methods, and integration lifecycle methods before the MMS protocol registry is sealed. Capability negotiation advertises these domains to clients that request them. Each admitted profile resolves its own `MmsProfilePlatform`, which owns agent and workflow registries, the skill/MCP lifecycle catalog, and a workflow slash-command resolver. All personal storage roots come from the trusted profile services; provider models and credentials remain installation-owned.

Agent editor CRUD does not launch MCP executables. Explicit validation, publication, and try-run resolution build a fresh grant lookup for the definition's actual runtime kind, intersected with current profile selections and main-versus-agent gates. Publication pins the hashes from that resolver snapshot. The shared model lookup reads the existing provider catalog without starting another refresh; catalog availability is distinct from credential acquisition at execution. Browser/native and structured-output capabilities are not inferred from a model name. Development-only GUI tools are excluded from agent-definition grants.

Profile disposal runs platform cleanup before MCP shutdown. Integration authorization attempts are cancelled on profile shutdown and installation shutdown. Installation teardown attempts both child-profile and default-profile cleanup even if one fails, then releases the shared provider service and owner lease.

## Evidence

`tests/platformProductionComposition.test.ts` uses the real MMS framed client/server and production composition root. Two profiles create/read separate agent, workflow, skill, and MCP records; a forged profile ID and foreign definition/integration access fail; restart reloads the durable personal records; both profiles share the same provider service. A second fixture validates against the real local model registry, publishes a definition, changes native versus Codex skill gates and tool selections, and verifies disposal rejects further definition resolution. Live model calls and network catalog refresh are disabled in this fixture; the configured MCP executable is deliberately disabled and is not launched.

Validation:

- Production composition: 2 tests passed.
- Existing profile runtime and agent-domain suites: 10 tests passed.
- Node and renderer typechecks passed.

## Still required

Wire the profile workgroup's generic connection-close/rebind notifications to integration authorization cancellation when its bridge commit lands. Mount the renderer workspaces through that bridge, including real structured-error propagation. Agent A03 execution is still absent: try-run returns a truthful blocked result until the host attaches the qualified native/CLI executor. Workflow runtime service/adapters, durable admission, slash-command ingress, browser sessions and tools, project workflow discovery, and application end-to-end qualification remain separate required work. This handoff does not close their release gates.
