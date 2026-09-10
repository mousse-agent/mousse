# Managed integration app bridge

Root implements the profile-bound MCP/Skills lifecycle domain registration and a typed renderer client. This consumes Grok backend `6ce4a68`; the registration is not yet composed into MMS, so this commit alone does not deliver Add UX.

`registerIntegrationMethods(domains, servicesForProfile)` takes an admitted immutable profile ID and resolves `{ profileId, catalog, mcpManager, projects, settings }`. Register before the domain registry is sealed. Advertise `integrations.lifecycle.v1` only when these services exist. Public method names and all renderer parameter/result types live in `src/shared/integrationPlatform.ts`; `createIntegrationPlatformClient` maps the host requester to that interface.

The host must invoke the returned `disconnect(connectionId)` on connection close or profile rebinding, `disposeProfile(profileId)` before runtime deletion, and `dispose()` on daemon shutdown. These abort outstanding OAuth work; cancellation/revocation/disable/config replacement do not wait behind a login request. Root ownership of these new files does not change the profiles workgroup's ownership of MMS/protocol/IPC composition.

All operations check the admitted profile. Project scope resolves a profile-owned project ID, never a renderer-supplied path. DTOs reject extra fields and malformed values, including masked secret placeholders. MCP editors must omit unchanged `env`, `headers`, and `auth` objects; replacing one of these objects replaces that whole object, so the UI must explicitly collect complete replacement values. A masked read response must never become a write payload.

CRUD writes serialize per profile to preserve installation IDs and profile selection lists. Create/import/enable select stable IDs and enable the relevant integration category; existing main-agent and per-agent gates are preserved. Revision conflicts use the structured `revision_conflict` code. The transport must preserve that code through daemon/client/preload errors.

Uploads use ZIP bytes in base64, limited to 480 KiB of encoded text (360 KiB compressed). Single-file and folder uploads can be packaged by the renderer with `fflate`; paths must pass the existing package validation, and imported scripts are preserved without execution. Larger package transfer needs a separate streaming/blob bridge before it can be advertised. Exports are capped at 2 MiB raw bytes to fit the existing response frame. There is no raw `sourcePath` public import API.

Validation: 11 tests across `platformIntegrationDomains` and `platformIntegrationLifecycle`, covering real profile-local CRUD, concurrent creates, cross-profile project refusal, revision conflicts, ZIP import/export, secret placeholder refusal, OAuth profile/connection cancellation, and a real stdio MCP fixture. Node/web typecheck also passes. These are domain tests; full app/CLI wiring and external OAuth qualification remain required.
