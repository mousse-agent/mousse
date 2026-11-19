# Antigravity runtime

Mousse runs Google Antigravity through one of two programs:

- **The 1.1.1 ACP server** (`agy_acp_server` with its `localharness_external` helper). This is the
  default everywhere. Mousse installs it from a pinned, SHA-256-checked archive
  (`src/mms/harness/acp/presets/antigravity/installation.ts`), and a manual path to the user's own
  copy still works. It keeps the Google sign-in in a file inside the profile's folder
  (`AGY_ACP_FORCE_FILE_STORAGE=1`, `GEMINI_HOME=<profile>/providers/antigravity/gemini-home`).
- **The native Antigravity CLI** (`agy acp`, Google's current release, unmodified). It runs only on
  a platform listed as qualified in `NATIVE_QUALIFIED_PLATFORMS` (`nativeRelease.ts`). No platform
  is qualified yet.

## Native CLI install and update

- Mousse installs only the release reviewed in `NATIVE_RELEASES`: 1.5.12 for Windows, macOS and
  Linux (glibc and musl), x64 and arm64. Each entry has the exact URL, size and SHA-512 of a
  separate download made on 19 November 2026, which matched Google's feed.
- Google's feed (`<feed>/manifests/<target>.json`) is read when installing, and at most every six
  hours when the provider is listed. It only reports: a newer release that is not reviewed yet (not
  installed), a lower version than the reviewed one, or the same version with another URL or digest.
  In the last two cases the reviewed release counts as withdrawn and is not installed. An
  unreadable feed does not block an install. The feed never chooses what is installed.
- An install refuses a withdrawn version, an older version than the one installed, and any URL
  other than Google's exact bucket path for that version and system. The download is staged in the
  install folder, limited to the reviewed size, and checked against its SHA-512. The macOS and Linux
  archive must hold exactly one plain file, `antigravity`, of the reviewed size.
- The staged executable is then started as `agy acp` on a temporary profile. It must answer
  `initialize` as `Antigravity ACP Server` with exactly the reviewed version. Only then does
  `active.json` switch to it, in one atomic write. That write keeps the previous release as the last
  good one, which stays on disk and is used again if the new one is damaged or withdrawn. Other
  releases are removed. A release whose executable is still running stays until a later install.
- Turns already running finish on their process. Idle processes close, and a busy thread switches
  on its next turn.
- Saved sessions are tagged with the runtime they were opened on. A session from the other runtime
  is not resumed: the thread hands its history over to a new session, and its history in Mousse is
  unchanged. The agent's own folder (`gemini-home/antigravity-acp`) is the same for both runtimes,
  so nothing in it is moved or deleted.
- The two runtimes keep the Google sign-in in different places, and Mousse never copies a token
  from one into the other. After a switch the provider shows as signed out and asks for a new sign-in.

## Qualifying a platform

A platform qualifies only when both of these are shown on a released build of that system:

1. A sign-in made through Mousse stays in the profile's own folder or its own credential entry.
   Another Mousse profile, and the user's own `agy`, neither see it nor change it.
2. Settings and app data (`config/`, `antigravity-acp/`) stay under `--gemini-dir`.

Until then the platform stays on the 1.1.1 server. To qualify one, add the evidence below and set its
entry in `NATIVE_QUALIFIED_PLATFORMS` to `true` in the same change.

### Evidence so far (1.5.12)

| System | Credentials | Settings and app data | Qualified |
|---|---|---|---|
| Windows 11 x64 | **Not isolated.** With a private `--gemini-dir`, `--app-data-dir antigravity-acp`, and `USERPROFILE`, `APPDATA`, `LOCALAPPDATA` and `TEMP` pointed at empty folders, an unauthenticated start loaded an existing Antigravity sign-in from the system keyring (`keyringAuth: loaded token`, then `authenticated via keyring`). It used it as the signed-in account. The keyring entry is per user, not per `--gemini-dir`. | Isolated: every file went under `--gemini-dir` (`config/`, `antigravity-acp/`), and nothing was written to the redirected home folders. | No |
| macOS | Not tested. The binary links the macOS Keychain (`go-keyring`) and has a file fallback. Expect the same per-user entry as Windows. | Not tested. | No |
| Linux x64 (WSL, Ubuntu-based, no D-Bus session bus) | **Not shown.** With no credentials present, an unauthenticated start answered `session/new` with `Authentication required`. The log said `Using file-based token storage because no D-Bus session bus detected`, but the token file's path shows only after a sign-in, which was not done. Plugin secrets go to `$XDG_CONFIG_HOME/antigravity/plugin-secrets.json`, which is **outside** `--gemini-dir`. With a D-Bus session the binary uses Secret Service, which is per user. | Settings and app data went under `--gemini-dir`, and nothing was written to the redirected `HOME` or `TMPDIR`. | No |

Both Windows and Linux answered `initialize` as `Antigravity ACP Server` 1.5.12.

### Next qualification steps

1. Linux without D-Bus: sign in once with a test Google account (not a personal one) on a
   throwaway profile, with `HOME` and `XDG_CONFIG_HOME` pointed into the profile. Then record
   where the token file lands. If it is inside the profile, start a second profile and the user's
   own `agy` and check that neither is signed in. Launching would then also need
   `XDG_CONFIG_HOME` set per profile and `DBUS_SESSION_BUS_ADDRESS` removed.
2. Windows and macOS: no documented flag keeps the token out of the per-user keyring. Ask Google
   for a per-profile keyring name or a file-storage flag, or keep these platforms on the 1.1.1
   server.

The 1.5.12 binary contains no `AGY_ACP_FORCE_FILE_STORAGE` setting, so the 1.1.1 server's way of
keeping the sign-in in a file does not carry over.
