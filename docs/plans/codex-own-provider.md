# Codex on the user's own model provider

Status: decided (design level 2), not built. Tracking issue: #2146.

## Problem

A person whose Codex CLI runs on a custom model provider in `~/.codex/config.toml` can't use that Codex from Mousse. The setup is `model_provider = "<id>"` plus `[model_providers.<id>]` with `base_url`, `wire_api = "responses"` and an inline `experimental_bearer_token`.

- **Not signed in.** Mousse shows the entry as "Not signed in", because only a ChatGPT account counts (`classifyAccount`, `CodexProviderService.ts`).
- **The provider is ignored.** Every Mousse turn is pinned to the built-in `openai` provider (`CODEX_MODEL_PROVIDER`). Commit 9b01fa671 added that pin on purpose: a user's or a workspace's config.toml can select a provider that bills an API key, even under a ChatGPT sign-in.
- **Nowhere to set it.** There is no place in Mousse to choose or change the provider. Claude's settings section edits only Claude's file (`vendorSettingsTarget` is hard-wired to `driver === 'claude'`).

**The root cause.** Mousse keeps no record per entry of which provider the person chose. So the rule "a workspace never picks the provider" is kept by refusing every provider that isn't ChatGPT.

## Flows

1. **Existing setup.** Mousse reads the entry's config.toml and offers what it found: the provider name, the base URL's host, and the key, shown as `•••• last4`. The person agrees once with "Use it". After that, turns, titles and other one-shot requests run on that provider, and the entry shows "API key · host".
2. **Set up in Mousse** (slice 2). Under Codex settings, the person chooses Model provider → Custom, then enters a Base URL and an API key. Optional rows follow: default model, reasoning effort, approval policy and sandbox. When the file is shared with the terminal's Codex, Mousse asks once per file, as Claude's section does.
3. **Managed entry** (slice 3). The same section edits the private home's file, and the provider choice is available there too.
4. **Switching back.** Choosing ChatGPT sign-in clears the choice. The file isn't touched, and the ChatGPT sign-in is needed again.
5. **Failures.**
   - A rejected key: "<host> refused the API key."
   - An unreachable host: the key stays in use, and the turn shows Codex's own error. Mousse's check may not reach a host that Codex does (a proxy that Node's fetch ignores).
   - A file Mousse can't parse is shown read-only with its error and is never written.
   - A file that changed underneath: "File changed, reload".
   - A base URL in the file that differs from the one agreed to: the entry stops until the person agrees again.
6. **Removing.** Removing the key or the provider in Mousse also clears the choice. When the key disappears from the file, the entry reads "The API key is gone from config.toml". It never silently falls back to billing the ChatGPT plan.

## Rules

1. A Mousse turn runs on a provider other than ChatGPT only when the person chose that provider for that entry in Mousse. A provider that a workspace or project config selects is never used.
2. The API key never leaves the daemon in plain text: not in a snapshot, an IPC result, a log, an error, argv, an environment variable, or thread history. The renderer only ever sees `•••• last4`.
3. A config write keeps the file's layout, is atomic, keeps the file mode (new files are 0600), keeps a one-time backup, refuses on a stale revision, and is never attempted on a file Mousse can't parse.
4. A file shared with the terminal's Codex is changed only after the person agreed once for that file.
5. An entry on a custom provider is ready without ChatGPT. An entry on ChatGPT behaves exactly as it does today.
6. Billing stays visible: an entry that bills an API key says "API key · host" wherever it said "ChatGPT sign-in".
7. Private homes stay isolated from the user's home, both ways.
8. Bots keep their holds whatever the provider.

## Decision

Proposal A, "a per-entry route, with the key served by the token helper", with one graft from B.

### State and owners

| State | Lives in | Owner |
|---|---|---|
| The choice | `InstanceConfig.modelRoute?: { kind: 'custom'; table: string; baseUrl: string }`, absent = ChatGPT. Set only by the local-only RPC `providers.instances.setModelRoute`. It holds no key. | gateway + `decodeCodexConfig` |
| The key | The entry's own config.toml, `[model_providers.<table>].experimental_bearer_token`. The daemon reads it into memory at launch. | the file (the person's) |
| How a launch runs | `vendors/codex/providerRoute.ts`, `resolveCodexRoute(choice, fileReading)`. It returns ChatGPT, or the seams the managed entry already fills (`modelProvider`, `prepareLaunch`, `account`, `models`), plus `usage` and `useLimitReset`: no plan limits are shown and no reset credit is offered while a route is set. The service reads these seams at each launch, not once when it is built. That matters because the built-in service is built once per profile (`MmsProfileServices.ts`), and the own-home service survives config changes (`drivers/codex.ts`). Changing the route stops every app-server of the entry and revokes its leases, as the managed runtime's `stopProcesses` does. | providerRoute |
| The broker and token helper | Taken out of `createManagedCodexRuntime` into a shared module, so the built-in and own-home runtimes use the same helper. Its refusal messages are neutral about the provider: a rejected key reads "<host> refused the API key.", never "Sign in again". | the shared broker module |
| Sign-in state | The `account` seam: `signed_in`, labelled "API key · host", with subject `hmac(baseUrl, key)`. Codex's `account/read` isn't consulted. The driver-wide `methodLabel` and `oneShotRoute` (`drivers/codex.ts`) become values per entry. | providerRoute + the service's probe |
| Settings view and writes (slice 2) | `harness/settingsFileIo.ts`, extracted from `claudeSettingsFile.ts`, plus `vendors/codex/codexConfigFile.ts` (smol-toml, and a narrow span patcher checked by re-parsing). Behind `HarnessDriver.settingsFile`. | the driver's hook; the gateway keeps consent |

### Why rule 1 holds by structure

`resolveCodexRoute` is the only source of a provider id other than ChatGPT, and it needs `modelRoute`.

- **The table is Mousse's own.** It is defined with `-c model_providers.<id>={name, base_url, wire_api="responses", requires_openai_auth=false, auth={command: <token helper>}, http_headers={}, query_params={}}`. That is the same form as `managedCodexConfigArgs`, and `-c` sits above every config layer, so a key Mousse sets can't be changed by a file.
- **The id is not a secret, and nothing relies on it being one.** It is visible in the app-server's argv to the chat's own shell commands, so a prompt-injected chat could write a project `.codex/config.toml` that names it. Two defences:
  - Every field that could change the key, the headers or the address is set by `-c`.
  - Before each thread starts, the service reads Codex's config layers for that working folder (`config/read` with `includeLayers`). It refuses to start when a project layer defines `model_provider`, or any key under `model_providers.<id>`.
- **Slice 1 tests this directly.** A wire test writes exactly that malicious project config, using the real id, and asserts that the fake server sees the helper's key and none of the injected fields, and that the thread is refused.
- **The existing guards stay.** The per-thread `modelProvider` and `config.model_provider`, and `pinnedProvider`, now take the id as a value.

### Why rule 2 holds

- **The token helper serves the key.** It uses the existing broker lease (`managedRuntime.ts`), so the key never appears in argv or the environment (`recordHarnessSpawn` records both).
- **The key is redacted.** It is added to the service's `secrets`, so `redact` strips it.
- **The view can't carry it.** The view type has `masked` and no value field for secrets.

### Noticing a changed file

The token helper's lease reads the entry's config.toml again on every request; Codex calls the helper for each request.
- If `base_url` differs from the one the person agreed to, the lease refuses with "The base URL in config.toml changed. Agree again in Settings → Providers."
- If the key is gone, it refuses with "The API key is gone from config.toml."
- The entry's probe reports the same reasons. This replaces the built-in entry's credential-fingerprint check (`assertTerminalCredentials`), which doesn't run once an `account` seam is set.

### Reading the table the way Codex does

Slice 1 parses the table with smol-toml and checks it against Codex's own reading of the user layer (`config/read`).
- If the two disagree, Mousse doesn't offer "Use it", and shows why.
- A table with fields Mousse doesn't copy (`http_headers`, `query_params`, `env_key`) is refused with a message, instead of running without them.

### Graft from B

A key check before any turn: one `GET <base_url>/models` with the key, with a short timeout and no retries. It lets a bad key show as an error during the probe instead of on the first chat. A 401 or 403 gives "<host> refused the API key." A network failure says nothing about the key, so the key stays in use, as with Claude's API key. A passed check is kept for 10 minutes and a failed one for 30 seconds.

### Rejected

- **B's way of delivering the key.** B keeps the person's own table id and lets Codex read `experimental_bearer_token` from the file, pinning only `base_url` with dotted `-c`. B marks as unverified whether a project layer can override that table's token or `env_key`. A narrows that question: Mousse sets every field that matters with `-c`, and refuses to start a thread whose project layer names the provider at all.
- **B's new `AuthState 'error'`.** The probe's existing error path carries the failure message. Adding a state changes every consumer of `AuthState`. Revisit if the error needs its own tone in the status line.

### Marks

These are my own marks; there was no separate judge, because the shapes agreed. Each criterion is marked met / partly met / not met.

| Criterion | A | B |
|---|---|---|
| Every piece of state has one owner | met | met |
| Rules are kept by structure | met | partly met: rule 1 depends on Codex's unverified handling of project layers |
| The next two features fit | met | met |
| Each part can be replaced or deleted on its own | met | met |
| No compatibility layer | met | met |
| A workspace can never choose the provider, base URL or key, by a structural mechanism testable without Codex | met: `-c` on every field, the project-layer refusal and the existing guards (the refusal is tested on the pinned binary, not without Codex) | partly met |
| The key exists only in config.toml | met: daemon memory and the broker socket only | met |
| An existing setup works with no edit, after one agreement | met | met |

### Facts

| Fact | Status |
|---|---|
| `-c model_providers.x={… auth={command}}` plus the provider pin works through the app-server with `wire_api="responses"` | Checked: the managed entry runs this way, and `codexManagedWire.test.ts` ("a turn carries the helper's bearer") proves it against a local fake server on the pinned binary |
| The token helper's output is sent as the bearer to a base URL that isn't ChatGPT's | Checked by the same test: its fake server is a local address |
| A project layer can't change a key that `-c` set on the same table | Checked on 0.162.1 (`codexRouteWire.test.ts`): Codex loads a trusted project's config.toml but drops its `model_provider` and `model_providers`, so a project adds nothing to the route. The user's own config.toml can add to the table, and every thread start or resume (chats, titles, compaction) is refused when it does |
| `config/read` with `includeLayers` reports the project layer for a thread's working folder | Checked on 0.162.1: it lists the project, user, system and `-c` (`sessionFlags`) layers with their keys |
| `model/list` returns the custom provider's models | Checked on 0.162.1: it asks `<base_url>/models` and falls back to Codex's bundled list when the answer isn't in Codex's own format. A route change clears the stored list, so the next check lists again |
| `smol-toml` reads what Codex's toml crate accepts | Not checked. A mismatch leaves the file read-only, never with a bad write |

### What would make it worth revisiting

- Codex adds a supported way to pass a provider's credentials over the app-server protocol.
- People need more than one custom provider per entry.
- People need `http_headers` or `query_params` from their own tables. Slice 1 copies only `name`, `base_url` and `wire_api`, and it refuses, with a message, a table that needs more.

## Slices

1. **Run on the existing provider (flow 1, plus flows 4, 5 and 6 when the file changes).**
   - Code:
     - `providerRoute.ts`, with a read-only config reader (smol-toml, checked against `config/read`).
     - `modelRoute` with its RPC and decoder. The RPC refuses a managed entry until slice 3.
     - The seams, read at each launch, in the built-in and own-home Codex runtimes, including `usage` and `useLimitReset`.
     - A route change stops the entry's app-servers.
     - The shared broker module, with neutral messages.
     - A lease that re-reads the file.
     - A per-entry `methodLabel`, `oneShotRoute`, `readAuth` and `credential: 'api_key'`.
     - The project-layer refusal before each thread starts, and the key check.
     - A row in the provider editor: "Runs on <name> at <host>, key •••• 1a2b, billed to that key. Use it".
   - Check: a wire test on the pinned binary. A turn reaches the fake server with the key as bearer. A project `.codex/config.toml` that selects another provider, or that adds fields under the real id, never reaches the server, and the thread is refused. Choosing the route and switching back take effect without restarting Mousse.
   - With no `modelRoute` set, every entry behaves as it does today.
2. **Codex settings editor (flows 2 and 6 in Mousse).** `settingsFileIo.ts` extracted (Claude's section keeps working), `HarnessDriver.settingsFile`, the TOML patcher, and the rows from the approved mockup. Check: the file round-trip tests, and the renderer test of the section.
3. **Managed entry (flow 3).** `managedRuntime` builds its seams from `resolveCodexRoute` when a route is set. Check: a managed wire test with a custom route.

## The next two features

- **(a) A key Mousse holds, for env_key providers.** `resolveCodexRoute` gains `keySource: 'config_file' | 'mousse_secret'`, and the lease returns the stored secret. No environment variable is needed.
- **(b) The same section for OpenCode and Grok.** Each driver supplies `settingsFile` with its own table of known keys and its own parser. The gateway, consent, RPCs, `VendorSettings.tsx` and `settingsFileIo` are vendor-neutral after slice 2.
