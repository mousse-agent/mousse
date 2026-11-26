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

## Start-up time

Measured on Windows 11 x64 on 20 November 2026: `agy acp` 1.5.13 answered `initialize` in about
0.2 s and opened a session on an existing sign-in in about 3.5 s. The 1.1.1 server took 30 to 39 s
to answer `initialize`, because it unpacks about 1.2 GB on every start.
