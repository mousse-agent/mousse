import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

/**
 * Mousse's extension for Pi's agent: the only extension a Mousse-started Pi loads (`-e`). It is
 * bundled on its own into `out/pi-runtime/mousse-extension.mjs` and may import only Node built-ins
 * and the modules Pi provides to extensions (`@earendil-works/*`, `typebox`), which resolve to the
 * runtime's own copies.
 *
 * A stub until the RPC engine lands (provider registration, the tool gate and the app-tool bridge).
 */
export default function mousseExtension(_pi: ExtensionAPI): void {}
