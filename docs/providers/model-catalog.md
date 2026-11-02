# Model catalog

`src/mms/models/models.json` is Mousse's own list of models: their names, release dates and the id
each route accepts. It says what might exist. Whether an account can run a model is decided live,
per account (see "Older Claude models" below). The daemon reads the file (`src/mms/models/modelCatalog.ts`)
and clients get names through the provider snapshots. There is one catalog per installation,
shared by every profile.

The reader is `src/shared/modelCatalog.ts`. `tests/modelCatalogBundled.test.ts` checks the bundled
file; every other test uses made-up models, so adding a real model never touches a test.

## Format 1

```json
{
  "format": 1,
  "revision": 1,
  "models": [
    { "id": "claude-opus-5-5", "name": "Claude Opus 5.5", "short": "Opus 5.5",
      "maker": "anthropic", "family": "opus", "released": "2026-09-22",
      "routes": { "claude": { "id": "claude-opus-5-5" }, "anthropic": { "id": "claude-opus-5-5" } } },
    { "id": "claude-opus-4-6", "name": "Claude Opus 4.6", "short": "Opus 4.6",
      "maker": "anthropic", "family": "opus", "released": "2026-02-05", "older": true,
      "efforts": ["low", "medium", "high", "max"],
      "routes": { "claude": { "id": "claude-opus-4-6" }, "anthropic": { "id": "claude-opus-4-6" } } }
  ]
}
```

### Top level (all required)

| Field | Rule |
|---|---|
| `format` | Whole number. This reader knows `1`. |
| `revision` | Whole number that rises with every change. When downloads arrive, the highest valid copy wins. |
| `models` | Array. Order carries no meaning: lists are ordered by `released`. |

### Each model

| Field | Required? | Rule |
|---|---|---|
| `id` | Required | The maker's own model id. Never renamed or reused. Saved selections and favorites store it. |
| `name` | Required | Full name, for example "Claude Opus 5.5". |
| `maker` | Required | Picks the logo and the brand section (`anthropic`). |
| `released` | Required | `YYYY-MM-DD`, a real date. Sets list order (newest first). |
| `routes` | Required, at least one | See below. |
| `short` | Optional | The name beside a maker logo: `name` without the brand ("Opus 5.5"). Defaults to `name`. |
| `family` | Optional | For example `opus`. Two models can share a release date, so a family tells them apart. |
| `older` | Optional | `true` folds the model behind "Show more" on API routes. Agent routes ignore it: there, "older" means the agent does not list the model itself. |
| `efforts` | Optional | Reasoning levels, with the same values as `LlmModelOption.efforts`. Used only when the route reports none for the model; in practice, older Claude Code models. |

### Routes

A route key is an existing driver or provider id: `claude` (the Claude Code driver), `anthropic`
(the Anthropic API provider), `openai`, `codex`. The value is an object:

| Field | Required? | Rule |
|---|---|---|
| `id` | Required | The exact id that route accepts. Ids are unique within a route. |
| `minMousse` | Optional | The first Mousse version that handles this route for this model. Inclusive, written as dotted digits (`0.3.0`). |

The `id` of a route can differ from the model's: Claude Code takes Haiku 4.5 only by its dated id,
`claude-haiku-4-5-20251001`.

### Version limits (`minMousse`)

- A route below its `minMousse` is not listed, not checked and not selectable. The model stays
  available through its other routes.
- It is compared with `compareVersions` (`src/mms/harness/driver.ts`) against `mousseVersion()`
  (`src/mms/appVersion.ts`). A missing version (`0.0.0`: a checkout or a test) counts as newest. A
  value that does not parse drops the route.
- It goes on routes only: the requirement belongs to the adapter, not the model.
- There is no upper bound.
- The code change that adds the handling sets `minMousse` in the same commit. It is never above the
  version in `package.json` (checked by the bundled-file test).
- A later field that older readers must not ignore ships only on routes gated by `minMousse`. That
  avoids most format changes.

## Reading rules

Every Mousse build reads the file the same way:

- Unknown fields, unknown route keys and unknown effort levels are ignored.
- An invalid model is dropped and the rest kept. So is a model whose `id`, or whose id on a route,
  repeats one already read.
- The whole file is rejected only when it does not parse or its `format` is unknown.

## Changing the file

Within format 1:

- Add optional fields only. Never rename, remove or change the meaning of a field.
- Never reuse an `id`.
- Deleting a model is allowed: older builds stop offering it.
- Raise `revision` with every change.
- A change that adds or retires a Claude model says in its PR what the check found for each
  candidate on a signed-in machine (runs, refused, remapped, unknown).

A breaking change becomes `format: 2` in a new file (`models-2.json`); the format-1 file stays
published until no supported build reads it.

The bundled-file test checks: the schema, unique ids and unique ids per route, valid dates, known
route keys, `short` equal to `name` without the brand, and every `minMousse` at or below
`package.json`'s version.

## Older Claude models

Claude Code lists only its current models (`supportedModels()`), but often still runs older ones.
After a model refresh has saved that live list, Mousse checks the catalog's other models on the
`claude` route (`ClaudeSubscriptionProviderService.refreshModels`):

1. **Candidates:** catalog models with a `claude` route that the live list lacks, after version
   limits. A live model counts by its alias and by the model it resolves to, without a `[…]`
   variant suffix (`claude-fable-5-1[1m]`).
2. **Check:** on the idle discovery query, newest first, with its own 20 s budget and no prompt
   sent: `setModel(id)`, then `get_settings`, which reports the model actually applied.
   - **Runs:** the applied model is the route id. The model is offered, with the effort Claude Code
     reports as its default.
   - **Refused** (`setModel` answers `400 unknown provider for model … · model not changed`) or
     **remapped** (another model is applied): not offered.
   - **Unknown** (a timeout, an abort, any other error, or no applied model reported): not offered,
     and checked again on the next refresh.
3. **Cache:** results are saved with the provider's settings, next to `models`. Their key hashes the
   Claude Code program file (path, size, modification time), the account (`claudeAccountSubject`)
   and the candidate route ids. A changed key checks every candidate again; otherwise only unknown
   ones are checked. Partial results are saved.
4. **Listing:** models that run follow the live ones, newest first, named by `short` and with the
   catalog's `efforts` that Claude Code accepts. They carry `older: true`, and the model picker folds
   them behind "Show more" at the end of the provider's list. Starred older models stay visible, the
   section opens when the selected model is older, and nothing folds while searching.

The check runs after the live list is saved and the refresh returns without waiting for it, so it
never delays or changes the live list.

## Planned

Not built yet:

- **Downloads:** the file published as a GitHub release asset (`models-1.json`), fetched at most
  every 6 hours with a timeout and a size cap, and used only when its `revision` is higher than the
  copy in use. The bundled copy is trusted as part of the install.
- **Signing:** a detached Ed25519 signature over the downloaded bytes, checked before use.
- **API routes:** names and order for model API lists (`anthropic`, `openai`), and later a per-route
  block with what each adapter needs (context and output limits, input types, reasoning, price).
- **Moving a thread off a model that is no longer offered,** to the newest model of the same
  `family`, then the provider's newest model.
