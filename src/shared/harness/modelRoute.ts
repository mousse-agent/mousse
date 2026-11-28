/**
 * The model provider a Codex entry runs on, when the person chose one other than ChatGPT
 * (docs/plans/codex-own-provider.md). Stored on the entry's config as `modelRoute`; absent = ChatGPT.
 * It names the `[model_providers.<table>]` of the entry's own config.toml and the base URL the person
 * agreed to. It never holds the key.
 */
export interface CodexModelRoute {
  kind: 'custom'
  table: string
  baseUrl: string
}

/**
 * What the provider editor shows for an entry's model provider. The key appears only masked.
 * - `chatgpt`: runs on ChatGPT.
 * - `custom`: runs on the agreed provider; `problem` says why it can't run now.
 * `offer` is the provider config.toml selects now, when it isn't the one the entry runs on: ready to
 * agree to. `problem` on `chatgpt` says why the selected provider can't be offered.
 */
export type ModelRouteView =
  | { kind: 'chatgpt'; offer?: ModelRouteOffer; problem?: string }
  | { kind: 'custom'; table: string; name?: string; host: string; keyMasked?: string; problem?: string; offer?: ModelRouteOffer }

export interface ModelRouteOffer {
  table: string
  name: string
  baseUrl: string
  host: string
  keyMasked: string
}

/** `providers.instances.setModelRoute`: agree to the offer (its table and base URL), or `null` for ChatGPT. */
export interface SetModelRouteInput {
  instanceId: string
  route: { table: string; baseUrl: string } | null
}
