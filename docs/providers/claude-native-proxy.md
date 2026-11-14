# Claude's client name through CLIProxyAPI

Mousse normally identifies direct subscription turns as `mousse`. Proxy routes keep Claude
Code's Agent SDK default (`sdk-ts`): CLIProxyAPI cloaks unknown launcher names, changing the
system prompt and potentially breaking prompt-cache continuity. PR #1137 deliberately kept
that guard. Recognizing another launcher's name does not recognize Mousse's name.

An operator can opt in one configured CLIProxyAPI route after enabling native passthrough.
This is an explicit assertion about the proxy configuration, not automatic capability detection.
Mousse does not read or write the proxy's configuration. Its management API exposes configuration,
but an account listing alone cannot establish that an allowlisted request will pass through every
other proxy rule unchanged.

## Configuration

1. On CLIProxyAPI v8.0.63, add `mousse` to the existing list in the proxy's configuration,
   preserving other entries. The nested v8 configuration is:

   ```yaml
   upstream:
     claude:
       header-defaults:
         native-entrypoints:
           - mousse
   ```

   Older layouts call the section `claude-header-defaults`. Use the layout supported by your
   proxy version. Check that requests with both `User-Agent` containing `mousse` and
   `cc_entrypoint=mousse` are recognized as native and keep their system prefix unchanged.
   Allowlisting alone does not override incompatible credential, model or payload rules.

2. In the Mousse Claude provider entry's environment variables, add:

   ```text
   MOUSSE_CLAUDE_NATIVE_PROXY_URL=http://127.0.0.1:8317
   ```

   Use the **exact full `ANTHROPIC_BASE_URL`**, including any path and trailing slash. A different
   route does not inherit this opt-in. The variable can also be set in the user's or managed
   Claude settings `env`; project settings cannot opt in. Do not set `CLAUDE_CODE_ENTRYPOINT`
   for this feature: that existing manual override bypasses Mousse's automatic safeguards.

3. Mousse must be able to confirm a subscription-only seat listing through the existing
   CLIProxyAPI management-key support (for example `CLIPROXY_MANAGEMENT_KEY` in the provider's
   environment). Keep the management credential private. Only loopback/private-network
   CLIProxyAPI routes supported by that listing qualify; their address alone proves nothing.
   Missing, failed, stale, empty, mixed, unknown or API-key-only listings keep `sdk-ts`.
   Listings are reused for up to 30 minutes; a changed proxy seat pool is not detected instantly.

API-key variables, API-key helpers, per-token entries, cloud routes and launch arguments containing
`--settings` keep the default. Auto mode keeps the default too. Named processes retain the existing
Auto and plan-mode restrictions. An explicit user `CLAUDE_CODE_ENTRYPOINT` continues to win.

## Sessions and cache transitions

Enable passthrough **before** enabling the Mousse opt-in. Prefer a new thread after enabling it:
the name is part of the prompt and changing it can cause a one-time cache miss. A compaction
keeps its saved session's name while the route still qualifies; it does not relabel an older
`sdk-ts` session just because opt-in became available. A newly launched regular turn adopts the
current configuration; a process retained for background work keeps its existing identity until
it can restart. No threads are restarted or caches cleared by changing this setting alone.

To opt out, remove `MOUSSE_CLAUDE_NATIVE_PROXY_URL` or set the existing explicit entrypoint
override to `sdk-ts`. Let active named sessions finish before removing the proxy allowlist.
Changing either side during a warm session can cause another cache miss.

## Evidence and limits

`node scripts/check-claude-proxy-entrypoint.mjs <absolute-claude-executable>` checks two real
Claude Code turns against a local capture server with synthetic replies and isolated settings.
It checks the wire name and stable system/tools/previous-message content across session resume;
Claude's moving `cache_control` breakpoint is excluded from the previous-message comparison.
It makes no Anthropic model requests. This checks wire compatibility, not actual cache hits.

On Windows, Claude Code 2.1.325 with Agent SDK 0.3.291 sent
`claude-cli/2.1.325 (external, mousse, agent-sdk/0.3.291)` and `cc_entrypoint=mousse`.
The two captures were also checked with CLIProxyAPI commit
`6db7d4b839d86c5b24e17bbe73bcd4db18ef1b1a`'s actual request detector and cloaking pipeline:
without the allowlist the launcher is unconfirmed and selected for cloaking; with `mousse`
allowlisted both requests are confirmed and their payloads pass that pipeline byte-for-byte.
This does not exercise the complete proxy HTTP executor or a production configuration.

Public reports in [anthropics/claude-code#97074](https://github.com/anthropics/claude-code/issues/97074)
motivate using a product name instead of `sdk-ts`. They are not an official metering contract.
Neither the unit tests nor local captures measure Anthropic's five-hour meter or promise quota
savings. No production proxy setting or live account is changed by this feature.
