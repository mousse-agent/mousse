# Claude's client name through CLIProxyAPI

Mousse starts Claude Code with the client name `mousse` (`CLAUDE_CODE_ENTRYPOINT`) on a direct
Claude subscription and on a route through CLIProxyAPI. Without a name, Claude Code reports the
Agent SDK's `sdk-ts`. Nothing needs to be set in Mousse for this.

## How Mousse recognises the route

When Claude Code's `ANTHROPIC_BASE_URL` is an address on this computer or the private network,
Mousse checks the address's root before a turn (again every few minutes at most). CLIProxyAPI
answers it without a key. Any other gateway keeps `sdk-ts`. A management key is not needed.
When one is available (the usage page's
saved key or `CLIPROXY_MANAGEMENT_KEY`), Mousse also lists the proxy's Claude sign-ins, and
proxies whose sign-ins are API keys, all or some, keep `sdk-ts`.

These keep `sdk-ts` on every route: Auto mode, an API key (`ANTHROPIC_API_KEY`, `apiKeyHelper`),
an entry that pays per token, Bedrock, Vertex and Foundry, and launch arguments with `--settings`.
A name the user sets in the entry's variables or in their Claude settings `env` always wins.

## What CLIProxyAPI does with the name

CLIProxyAPI decides from its configuration:

- A name in its `native-entrypoints` list is passed through unchanged:

  ```yaml
  upstream:
    claude:
      header-defaults:
        native-entrypoints:
          - mousse
  ```

  Older layouts call the section `claude-header-defaults`.
- Any other name, on a subscription sign-in, is served as Claude Code's own CLI ("cloaking"):
  the proxy rewrites the system prompt into the CLI's shape. This is what CLIProxyAPI does for
  every client it does not list, including other apps that set their own name.

Adding `mousse` to the list keeps Mousse's requests exactly as Claude Code sent them.

## Sessions

A process keeps the name it started with. A thread whose process started under `sdk-ts` changes
name when its next process starts, which can cost one prompt-cache miss for that thread.
A compaction keeps the name its session ran under.

## Evidence and limits

- `tests/live/claudeProxyEntrypoint.test.ts` (run with `MOUSSE_LIVE_CLAUDE=1`) starts the real
  Claude Code from Mousse's Claude service against a local stand-in for CLIProxyAPI, with no
  management key and nothing set in Mousse. Both turns of a thread send `mousse` in the
  `User-Agent` and `cc_entrypoint=mousse`, with the same system prompt and tools; an Auto thread
  sends `sdk-ts`. No Anthropic request is made.
- `node scripts/check-claude-proxy-entrypoint.mjs <absolute claude executable> [captures.json]`
  checks the same wire shape with the Agent SDK alone and can save synthetic captures.
- Captures from Claude Code 2.1.325 were run through CLIProxyAPI commit
  `6db7d4b839d86c5b24e17bbe73bcd4db18ef1b1a`'s own request detection and cloaking code. With
  `mousse` listed, both requests were recognised as native and passed through byte for byte.
  Without it, both were cloaked, with the same rewritten system prompt on both turns. This does
  not run the proxy's full HTTP server or a production configuration.

Public reports in [anthropics/claude-code#97074](https://github.com/anthropics/claude-code/issues/97074)
motivate using a product name instead of `sdk-ts`. They are not an official metering contract.
None of the checks above measure Anthropic's five-hour meter or promise quota savings.
