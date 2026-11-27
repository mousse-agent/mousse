# Antigravity runtime

Mousse runs Google Antigravity as Google's `agy` CLI, served as `agy acp`. Google's earlier 1.1.1
ACP server (`agy_acp_server` beside its `localharness_external` helper) runs only from a manual path,
or from an install an earlier Mousse made, until `agy` is installed.

## Which executable runs

In this order:

1. **A manual path** in Settings → Providers → Antigravity. `agy` (or `antigravity`) runs as
   `agy acp`; `agy_acp_server` runs as the 1.1.1 server and must sit beside its helper.
2. **The user's own `agy`**, found on PATH or where Google's installer puts it
   (`%LOCALAPPDATA%\agy\bin` on Windows, `~/.local/bin` elsewhere). A copy whose `--version` is
   older than 1.5.0 is passed over. It updates itself, so Mousse only shows its version and offers
   no Update for it.
3. **Mousse's own `agy`**, installed into the installation (shared by every profile).
4. An earlier 1.1.1 install, until Mousse's `agy` replaces it (Update, or on its own once idle).

## Mousse's own install

- Mousse installs the version Google's update feed names for this computer
  (`<feed>/manifests/<target>.json`, `NATIVE_FEED_BASE` in `nativeRelease.ts`): version 1.5.0 or
  newer, from Google's exact storage path for that version and system, and only when the download
  matches the feed's SHA-512. A download is capped at 768 MB (an executable in an archive at 1 GB).
  The macOS and Linux archive must hold exactly one plain file, `antigravity`.
- The staged executable is started as `agy acp` on a temporary profile. It must answer `initialize`
  as `Antigravity ACP Server` with exactly the feed's version. Only then does `active.json` switch
  to it, in one atomic write that keeps the previous release as the last good one. Other releases
  are removed. A release whose executable is still running stays until a later install.
- The feed is read when installing, and at most every six hours while Mousse's own install is what
  runs. When it names a newer release, the card offers Update, and the update installs on its own
  once no turn is running. When it names an older release than the installed one, the installed one
  counts as withdrawn: the last good one runs, and the feed's release installs on the next update.
  `WITHDRAWN_NATIVE_VERSIONS` lists releases Mousse itself never runs.
- Turns already running finish on their process. Idle processes close, and a busy thread switches
  on its next turn. One install runs per installation; every profile sees its progress and can
  cancel it.

## Sign-in

`agy` keeps its Google sign-in per user on this computer (the system keyring on Windows and macOS,
and on Linux with a D-Bus session; otherwise a file under its folders). Mousse's Antigravity uses
that same sign-in, whichever `agy` runs: the user's own `agy`, Mousse's install and every Mousse
profile share it. Mousse never reads the credentials itself.

- Mousse's settings and app data stay private: `agy acp` runs with `--gemini-dir
  <profile>/providers/antigravity/gemini-home` and `--app-data-dir antigravity-acp`.
- Whether `agy` is already signed in is asked of `agy` itself: it opens a session without signing in.
  This runs on Sign in, and on an explicit check (Add, Check again, after an install), never at
  start-up. When it succeeds, the card shows Signed in with no Google flow. Otherwise Google's
  sign-in runs as before, now on `agy`.
- Sign out signs `agy` out on this computer, which ends the sign-in for the user's own `agy` and every
  Mousse profile too. The button's tooltip says so.
- The 1.1.1 server keeps its own sign-in in a file in the profile (`AGY_ACP_FORCE_FILE_STORAGE=1`).
  After a switch between the two runtimes, the card reads the sign-in again.

## More than one account

The first Antigravity entry is the one above, on this computer's `agy` sign-in. Each entry added after it
("Antigravity 2", "Antigravity 3", ...) is another Google account with a home of its own:

- Its settings, models and saved sessions are in `<profile>/harness/<id>/`, and `agy`'s folders, its Google
  sign-in included, in `<profile>/harness/<id>/home` (`gemini-home`, `bot-gemini-home`). Every `agy` it starts
  (turns, sign-in, the model list, the Usage page's `/usage`) gets `--gemini-dir` there and
  `AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1`, set over the entry's own variables.
- That variable makes `agy` keep the sign-in in a file under `--gemini-dir` instead of the system keyring.
  Checked on agy 1.5.17 on Windows without signing in: with it, `agy acp` logged "Using file-based token storage
  because AGY_CLI_FORCE_FILE_TOKEN_STORAGE is set" and a new home answered `Authentication required` while the
  keyring held a sign-in; without it, the same new home signed in from the keyring
  (`tests/live/antigravityAgy.test.ts`, `MOUSSE_LIVE_AGY=1`). A sign-in on an added entry was not run.
- A home that never signed in but opens a session anyway is read as an `agy` that ignores the variable: the
  entry refuses that sign-in and says to update `agy`, so it never runs on another entry's account.
- Sign out deletes `gemini-home` and `bot-gemini-home` in the entry's home (the sign-in file with them) and does
  not run `agy`'s own sign-out, which may also clear the keyring, the first entry's sign-in. Removing the entry
  deletes its home. The links to the user's `~/.gemini` skills in it are removed, never followed. Neither touches
  the first entry, another entry or this computer's `agy`.
- Not separate: what `agy` keeps outside `--gemini-dir`, such as plugin secrets (`plugin-secrets.json` in the
  user's config folder) and its user-wide keyring timeout marker. Mousse does not set these per entry.

## Limits on the Usage page

The Usage page shows each quota pool's five-hour and weekly windows (Gemini; Claude and GPT; Gemini 4
Argon), with what is left and when each resets. Mousse reads them by running the same `agy` as its
turns, with the same folders, as `agy --gemini_dir … --app_data_dir antigravity-acp -p /usage
--output-format json`, without a shell (a shell such as Git Bash rewrites `/usage` into a path).
`agy` answers from its own command, with no model turn, in about 9 s; `agy` itself asks Google.

- Only when the Usage page asks, within its deadline; reads that arrive together share one run.
  Never at start-up, and never in the background: the window ids are per pool, so the background
  limit reads, which keep only a provider's single five-hour and weekly trend, never pick it up.
- An `agy` older than 1.1.11 is never asked: it takes `/usage` as a prompt and runs a turn.
- A reply that reports a turn (`num_turns` other than 0) stops all reading for that `agy` version,
  kept across restarts, and the page shows the error.
- The 1.1.1 server reports no limits.

## Threads across a switch

Saved sessions are tagged with the runtime they were opened on. A session from the other runtime is
not resumed: the thread hands its history over to a new session, and its history in Mousse is
unchanged. The agent's own folder (`gemini-home/antigravity-acp`) is the same for both runtimes, so
nothing in it is moved or deleted.

## Stopping

Closing an agent ends its whole process tree (the agent and its helpers), not only the process
Mousse started.

## Thread titles and other single requests

Thread titles, branch names, pull request drafts, commit messages and a bot's name and digest are
single requests. They run on `acp:antigravity`: the same single-request path as any ACP agent
(`acpOneShot`), in a place of its own (`src/mms/harness/oneShot/places.ts`), with Antigravity's own
launch. The route is labelled best-effort: `agy` may run a native action before Mousse sees it and
stops the request.

- **Place:** the request's record is written under `<profile>/one-shot-ledger/` before its folder
  `<profile>/one-shot/<id>/` exists, and the process tree is recorded before `agy` starts (a
  Windows job, or a POSIX process group with its watcher).
- **Launch:** the place's empty `work` folder is both the process's working folder and the
  session's workspace, and its `tmp` folder is the temporary folder.
  The process gets only system, locale and proxy variables, none of the user's arguments, variables
  or skill links, and `--include-default-customizations=false` where `agy acp --help` lists it.
  Its settings go in a folder of their own (`--cli_dir_name one-shot-<place id>`, beside the sign-in in
  `gemini-home/antigravity-acp`): `default` agent mode, `strict` tool permission, no access outside
  the workspace, and a rule denying every action `agy` names. An `agy` without `--cli_dir_name` is
  refused.
- **Hooks and MCP servers:** `agy` reads them from `<gemini-dir>/config` (`hooks.json`,
  `mcp_config.json`), and neither `--cli_dir_name` nor `--include-default-customizations=false`
  keeps them out (checked on agy 1.5.18 with hooks and an MCP server that each write a marker). So
  the request's `--gemini-dir` is the place's empty `home`, and `--app-data-dir` points back to
  `gemini-home/antigravity-acp` by a relative
  path: `agy` refuses an absolute one and reads a relative one from the gemini dir. The sign-in and
  sessions stay where they are. The keyring sign-in of the first entry was checked on a real request;
  an added entry's file-based sign-in was not, so an "authentication required" answer there fails
  the request without signing the entry out.
- **During:** permission requests are cancelled and questions declined; file, terminal and unknown
  requests are refused. Each of these, and any tool call `agy` reports, ends the request as
  `one_shot_tool_refused`, and Automatic naming moves on to its next model. The request ends at its
  deadline, or once the answer passes 128,000 characters.
- **Quota:** a quota notice sent as the answer ("Individual quota reached. … Resets in 2h28m19s.") is
  never a title: the request fails as that model's usage limit, until the reset it names. This is
  read at the ACP boundary, so any ACP agent that answers with the same notice is handled the same way.
- **While it ends:** the process tree is ended while the refusals still listen, and its output is
  read until it closes, so a tool it reports while it ends still fails the request.
- **After:** the request waits up to 8 s for the process to end; one still running fails it. The
  tree must be proven gone (its job empty, or its group gone) before anything is touched. Then
  anything but empty folders left in `work` fails the request, and the place is removed with its
  typed leftovers: the settings folder, and the session's saved conversation, notes and annotations
  once the saved conversation names this place. Ownership is read again from the files at removal,
  and the conversation that proves it goes last. Whatever can't be removed (a locked file, a tree
  not proven gone) stays with the place's record for the places sweep, which runs a minute after the
  daemon is ready and every 30 minutes after. The same sweep removes the folders older versions left
  in the entry's own folders (`one-shot/<id>`, `one-shot-homes/<id>`, `one-shot-<id>`) once they
  are 30 minutes old and no recorded process of theirs runs.

The 1.1.1 server keeps its ordinary launch for single requests, in a place; that launch is not checked.

## Start-up time

Measured on Windows 11 x64 on 20 November 2026: `agy acp` 1.5.13 answered `initialize` in about
0.2 s and opened a session on an existing sign-in in about 3.5 s. The 1.1.1 server took 30 to 39 s
to answer `initialize`, because it unpacks about 1.2 GB on every start.
