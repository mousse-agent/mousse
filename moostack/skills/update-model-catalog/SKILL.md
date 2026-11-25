---
name: update-model-catalog
description: Use when adding, retiring or re-tiering models in Mousse's bundled model catalog (src/mms/models/models.json), or changing which providers Automatic thread naming tries first (namingProviders). Checks the models live on signed-in providers, edits the catalog, tiers, test and docs together, and cites what the live check found in the PR.
---

# Update the model catalog

`src/mms/models/models.json` names Mousse's models, dates them, tiers them and says which ids each route accepts. Bots pick their hidden model by its tiers, and Automatic thread naming ranks connected models by `namingProviders`, then tier. A wrong tier or id quietly sends naming or bots to a slower or unrunnable model, so every change starts from what the providers list now, not from memory or a changelog.

The format and the reading rules are in [`docs/providers/model-catalog.md`](../../../docs/providers/model-catalog.md). Read its "Format 1", "Routes", "Automatic thread naming" and "Changing the file" sections before editing.

## 1. Check the models live

On a machine signed in to each provider the change touches, with the app running from this checkout:

- **Claude Code** (`claude` route): refresh the entry's models in Settings → Providers. The model picker shows what `supportedModels()` lists and what the older-model check found. For each model added or retired, write down whether it runs, is refused, is remapped to another model, or is unknown (the "Older Claude models" section says how the check decides).
- **Codex** (`codex` route): refresh the entry's models. They come from the app server's `model/list`. Note each id, the reasoning levels it offers and its default level.
- **Antigravity** (`antigravity` route): refresh the entry's models and note each id as listed.
- **Pi providers**: a Pi model matches the catalog by its own `id`, so check the id each Pi provider lists for the model.

Send one short message on each new model to confirm it answers. An id that is not listed live, or that fails to run, does not go in the catalog with that route.

## 2. Edit the catalog

In `src/mms/models/models.json`, for each model:

- `id`: the maker's own id. Never rename or reuse one.
- `name`, `short`: `short` is `name` without the brand for Claude models; OpenAI and Google models keep the full id as both.
- `maker`, `family`, `released` (`YYYY-MM-DD`, the real release date).
- `tier`: `small` for the fast models Automatic naming should reach first (Haiku, `gpt-*-luna`, `gemini-*-flash` releases that are small), `standard`, or `frontier`.
- `older: true` for a model a newer one of its family replaces.
- `efforts` only when the route reports none.
- `routes`: only the routes the live check confirmed, with each route's exact id. Add `minMousse` when the route needs code this change adds.

Then:

- `namingProviders`: change it only to change which provider Automatic naming tries first. It must stay non-empty and end with `*`.
- Raise `revision` by one for the whole change.

## 3. Keep tiers, test and docs in step

- `src/shared/bots/personal/modelTiers.ts`: add an id pattern for a new family, so a model the catalog does not list yet still gets a tier. Put a specific pattern before a broader one in the same list.
- `tests/modelCatalogBundled.test.ts`: add the new family's tier to the family map, and a brand to `BRANDS` for a new maker.
- `docs/providers/model-catalog.md`: update the route list, the tier examples and the `namingProviders` order when they change.

## 4. Verify

```bash
node scripts/verify.mjs tests/modelCatalogBundled.test.ts tests/bots/botModelChoice.test.ts tests/titleModelIndex.test.ts
```

Add any other test the change touches, following "Verify" in [`work`](../work/SKILL.md).

## 5. Say what the live check found

The PR lists, for each model added, retired or re-tiered: the provider and account kind it was checked on (subscription or API key), whether it ran, was refused, remapped or unknown, and the id each route listed. A model with no live check is not added.
