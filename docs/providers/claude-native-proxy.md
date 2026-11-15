# Claude's client name

Mousse starts every Claude Code process with the client name `mousse` (`CLAUDE_CODE_ENTRYPOINT`):
on every route (direct, through a proxy or gateway, Bedrock, Vertex, Foundry), with every kind of
sign-in, and in every permission mode. Without a name, Claude Code reports the Agent SDK's
`sdk-ts`. Nothing needs to be set in Mousse for this.

A name you set yourself wins: put `CLAUDE_CODE_ENTRYPOINT` in the Claude entry's variables, or in
the `env` of your own or the managed Claude settings. A project's settings cannot set it.

## Why not `sdk-ts`

Public reports ([anthropics/claude-code#97074](https://github.com/anthropics/claude-code/issues/97074),
[pingdotgg/t3code#24649](https://github.com/pingdotgg/t3code/issues/24649)) say Anthropic's 5-hour
meter charges `sdk-ts` traffic about 1.6–1.8 times more per token than the interactive CLI; the
weekly limit is reported unaffected. One subscription's proxy history showed about 2.4 times more
5-hour use per token under `sdk-ts` than under another app's own name passed through unchanged.
That is one account and not an official metering rule; nothing in Mousse's tests measures the meter.

## Known limits

- **API credits.** Accounts on Anthropic API credits (for example the credits included with a
  subscription) have been reported to refuse any name Claude Code does not know, with "Credit
  balance is too low" ([pingdotgg/t3code#29393](https://github.com/pingdotgg/t3code/issues/29393)).
  If that happens, set `CLAUDE_CODE_ENTRYPOINT=sdk-ts` in that entry's variables.
- **CLIProxyAPI.** It passes a name in its `native-entrypoints` list through unchanged:

  ```yaml
  upstream:
    claude:
      header-defaults:
        native-entrypoints:
          - mousse
  ```

  Older layouts call the section `claude-header-defaults`. A name it does not list is served, on a
  subscription sign-in, as Claude Code's own CLI ("cloaking"), which rewrites the system prompt.
  Older versions cloak as an older Claude Code release, and newer models can then be refused
  ("does not support this model"). Add `mousse` to the list, or set `sdk-ts` as above.
- **Auto.** Claude Code 2.1.325 asks Anthropic's server for Auto's safety check (the `safeguards`
  field) under `mousse` exactly as under `sdk-ts`, and sends no classifier request of its own,
  in a local check with a synthetic server. It falls back to a billed local classifier when a
  response comes back without the server's verdict, for example through a proxy that drops it,
  whatever the name. One report against Claude Code 2.1.322
  ([pingdotgg/t3code#34562](https://github.com/pingdotgg/t3code/issues/34562)) saw the local
  classifier under an unknown name; it did not reproduce on 2.1.325.

## Sessions

A process keeps the name it started with. A thread whose process started under another name takes
Mousse's when its next process starts, which can cost that thread one prompt-cache miss. A
compaction keeps the name its session ran under.

## Checks

- `tests/live/claudeProxyEntrypoint.test.ts` (run with `MOUSSE_LIVE_CLAUDE=1`) starts the real
  Claude Code from Mousse's Claude service through a local stand-in for CLIProxyAPI, with nothing
  set in Mousse. Every turn, Auto included, sends `mousse` in the `User-Agent` and
  `cc_entrypoint=mousse`; two turns of a thread send the same system prompt and tools; the Auto
  turn carries the server safety-check request. No Anthropic request is made.
- `node scripts/check-claude-proxy-entrypoint.mjs <absolute claude executable> [captures.json]`
  checks the same wire shape with the Agent SDK alone and can save synthetic captures.
- Captures from Claude Code 2.1.325 were run through CLIProxyAPI commit
  `6db7d4b839d86c5b24e17bbe73bcd4db18ef1b1a`'s own request detection and cloaking code. With
  `mousse` listed, both requests were recognised as native and passed through byte for byte;
  without it, both were cloaked. This did not run the proxy's full HTTP server.
