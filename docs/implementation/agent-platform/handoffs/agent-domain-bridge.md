# Agent definition domain methods and client

Root continuation after `42fa35e`. `registerAgentDefinitionMethods(domains, servicesForProfile)` registers eleven methods from `shared/agentPlatform.ts`, before server seal. Each requires trusted profile binding and `agentDefinitions.v1`; the daemon chooses the registry from that binding and checks its ownership again. It never accepts profile filesystem paths.

CRUD, publish, import/export and validation call the actual registry. Input validation rejects unknown top-level keys, invalid runtime/IDs/revision hashes and coerced booleans. Publication validates live model/integration availability first. `AgentResolver.resolveDraft` validates an exact draft without changing published state. Agent errors become structured domain errors so revision conflict handling survives the bridge. `createAgentDefinitionsClient` adapts the renderer UI port to a host-bound requester, with no local persistence or fallback.

Try-run requires exact draft hash or a published revision. It calls the provided execution adapter when attached; otherwise it reports blocked. Real native/CLI execution and run history remain A03, not implemented by this registration layer. The host must construct fresh/live dependency lookups and attach production runners.

Validation: typecheck passed; 27 tests across agent definitions and new domain bridge passed. Tests exercise actual filesystem registry through the renderer client adapter: save/revision conflicts, validate-before-publish, no implicit publication, model availability rejection, A/B profile isolation, capabilities/admission, export/import, and visual-only semantic identity.

Pending host integration: call the registration function before server start; admit the capability only for supported clients; retain daemon error code/details in LocalMmsClient and Electron IPC instead of flattening to an Error message; connect `AgentDefinitionsWorkspace` to the trusted window profile. The profile production workgroup owns central bridge files and will be reconciled before activation. Product copy in TryRunPanel now describes the user's task rather than implementation details.
