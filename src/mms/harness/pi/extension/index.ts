import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

/**
 * Mousse's extension for Pi's agent: the only extension a Mousse-started Pi loads (`-e`). It is
 * bundled on its own into `out/pi-runtime/mousse-extension.mjs` and may import only Node built-ins
 * and the modules Pi provides to extensions (`@earendil-works/*`, `typebox`), which resolve to the
 * runtime's own copies.
 *
 * A stub until the RPC engine lands (provider registration, the tool gate and the app-tool bridge).
 */

/**
 * A command that does nothing: `get_commands` lists it with this file as its source, which is how
 * the runtime check and tests see that Pi loaded the extension (a failed load is only a startup
 * warning, and Pi answers without it).
 */
export const MOUSSE_EXTENSION_MARKER = 'mousse-extension'

export default function mousseExtension(pi: ExtensionAPI): void {
  pi.registerCommand(MOUSSE_EXTENSION_MARKER, {
    description: "Mousse's extension is loaded (does nothing)",
    handler: async () => {}
  })
}
