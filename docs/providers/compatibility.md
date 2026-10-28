# Agent versions

`src/mms/harness/compatibility.ts` holds one table, `COMPATIBILITY`, with a row per driver (`claude`,
`codex`, `antigravity`, `grok`, `cursor`, `pi`) and per ACP preset (`acp:generic`, `acp:grok`).
Drivers and presets read their range from it; none declares its own.

Each row has:

- `tested`: the versions Mousse was tested with. A version below it is "too old"; a newer one is
  reported on the provider's card and never blocked. The generic ACP preset has none: it runs any
  agent.
- `knownBroken`: versions that do not work with Mousse, each with a `range` (`2.1.5`, or
  `2.1.5 - 2.1.9`, both ends included), a `reason` the card shows, and `fixedIn` when a later
  version works again.
- `evidence`: what the range rests on, each a version with a replay fixture's path or the PR that
  records a run on the real agent.
- `bundled`: a runtime Mousse ships as an npm dependency (Pi, Cursor). Its row records the version
  for upgrades; the check never judges it.

## Known problems

A version in a `knownBroken` range runs nothing: every turn, retry, delegated child, workflow step
and single request is refused before the agent starts, with the reason and "Update it, or allow
this version in Settings → Providers." Checks, Check again, sign-in and model lists still run, so
the card can show the problem and the update.

On the card, **Run anyway with &lt;version&gt;** allows that version for that program only. Mousse checks
the agent again itself and records the version, the executable's path, size and modification time,
and the install receipt for an agent Mousse installed. Each turn compares them with the executable
there now; an update, a reinstall or another executable needs the choice again. The CLI cannot
allow a version: it prints the refusal.

## When an agent releases a new version

1. Re-record the agent's replay fixtures (`scripts/record-acp-fixture.mjs` writes `agentVersion`
   in the header), or check the hand-authored ones against the new version and move their `basis`.
2. Run the replay and conformance tests for the agent, and a smoke run on the real agent.
3. Raise `tested.max` and add an evidence row for the new version.
4. For a version that does not work, add a `knownBroken` row with its reason, and `fixedIn` once a
   fixed version is out.

`tests/harness/compatibilityTable.test.ts` checks that every driver and preset has a row, that each
tested range has evidence inside it, that every fixture's `agentVersion` or `basis` is inside its
agent's range, and that every `knownBroken` range parses.

## Checking the agents on this computer

```
node scripts/check-agent-versions.mjs [--search <dir>]... [--installation-home <dir>]
```

It lists each agent found on PATH, and with `--installation-home` each agent Mousse installed (read
from its install receipts), with its version, tested range and any known problem. It runs only each
agent's version flag: it never starts a turn, checks a sign-in or opens a session.
