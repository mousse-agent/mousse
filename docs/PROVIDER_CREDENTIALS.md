# Provider sign-ins, keys and recovery

Where each provider's sign-in and keys live, what Mousse does with them, and how to recover the shared credentials file. For how each agent is set up see [agent setup](providers/agent-setup.md); for which setups were tested see [the setup matrix](providers/setup-matrix.md).

## Where sign-ins and keys live

- **The agent's own home.** Claude Code, Codex and Grok entries on your own setup use the sign-in in your own folder (`~/.claude`, `~/.codex`, `~/.grok`), exactly as in a terminal. Mousse reads whether they are signed in and never changes that folder.
- **A home of its own (private home).** A second account of Claude Code, Codex or Grok gets its own folder, `<profile>/harness/<id>/home`, and every process of the entry runs there. Your own sign-in, keys and cloud routes in Mousse's environment are not passed to it. Removing the entry leaves the folder, and the sign-in in it, on disk; sign out first, or delete the folder afterwards.
- **Keys Mousse keeps for one entry.** An API key saved on a Claude Code, Grok or Cursor entry is kept in that entry's own `<profile>/harness/<id>/secrets.json`, encrypted with the operating system's vault in the app. Removing the entry deletes it.
- **Model API keys (the Mousse agent).** Keys and sign-ins of model APIs (`pi:<provider>`) are kept in the installation's `auth.json`, so every profile on this device shares them. Removing an API provider deletes its saved key on this device. If another profile saves the key again, this profile still does not list it, use it for speech or show its usage until you add it again here.
- **ChatGPT in Mousse.** A Codex entry set up by Mousse signs in with ChatGPT inside Mousse. Its tokens are kept in `<profile>/harness/<id>/chatgpt.db`, sealed with the operating system's vault in the app, and are sent only to OpenAI's token and revocation addresses and to that entry's Codex.

## Signing in and out

- Mousse never runs `claude auth login` for your own Claude Code entry: sign in in a terminal. An entry with a home of its own signs in through Claude's own flow, in a terminal Mousse starts in that home.
- **Sign out** on an entry Mousse set up (a home of its own, a key Mousse keeps, ChatGPT in Mousse) signs that entry out for real: Mousse runs the agent's own sign-out in its home, or deletes and revokes what it keeps.
- **Sign out** on an entry on your own setup is a sign-out in Mousse only (the card says "Not signed in"): Mousse stops using the entry and keeps it signed out across restarts, and your terminal sign-in is unchanged. Sign in on the card to use it again.

## What the provider card says

The card's words, from `describeStatus` in `src/shared/harness/status.ts`:

| Card says | Meaning | Next step |
|---|---|---|
| "Checking status" | The first check since Mousse started has not finished. | None |
| "Check incomplete" | The check did not finish and there is no earlier result. | "Check again" |
| "Disabled" | The entry is turned off on this device or in this project. | "Turn on" |
| "Installing" | Mousse is installing the agent. | "Cancel" |
| "Override not found" | The executable set in Settings cannot run; Mousse does not fall back to PATH. | "Change path" |
| "Not found" | The agent's command is not on PATH. | "Install", or "Check again" |
| "Install is broken" | Files of an agent Mousse installed changed since the install. | "Reinstall" |
| "Known problem with <version>" | This version is known not to work with Mousse; nothing runs on it. | "Update", or run this version anyway |
| "Unavailable" | The agent could not start. | "Check again" |
| "Not signed in" | Signed out, in the agent or in Mousse. | "Sign in" |
| "Sign-in expired" | The sign-in must be renewed. | "Sign in again" |
| "Version too old" | Older than the versions Mousse was tested with. | "Update" |
| "Refreshing sign-in" | The sign-in is being renewed. | None |
| "Not verified" | Mousse could not check whether the agent runs. | "Check again" |
| "Installed · Sign-in unverified" | It runs, and Mousse cannot tell whether it is signed in. | "Sign in", or "Check again" |
| "Signed in" | Ready, with the account or sign-in method after it. | None |

## Shared credentials file

Provider identities and secrets belong to the installation `auth.json`, shared across personal profiles. A connection disappearing from every profile can therefore indicate a storage/runtime error rather than a profile switch.

## Runtime and persistence contract

- Loading a missing store does not create a file. Loading unreadable JSON, an invalid credential structure or ciphertext that cannot be decrypted throws an actionable error without changing the source.
- Electron requires encryption even for the first save. Losing vault availability never downgrades an existing encrypted store to plaintext. Fresh standalone Node stores may remain plaintext; Node cannot decrypt Electron safeStorage ciphertext.
- The GUI and headless Electron CLI select the same vault context before app readiness. The default installation retains the installed `appData/mousse` context; custom homes use their own `electron-user-data`, with explicit overrides honored consistently.
- Development GUI/daemon and `dev:mms` use isolated data and Electron. They refuse the default global home. Use `npm start` for the normal installation.
- Provider changes serialize within the store and take a file lock. A source-byte comparison rejects stale instances. Memory changes only after atomic replacement succeeds; reads/callback inputs are copies. Noncooperating external file edits are not a supported concurrent writer.
- Successful Electron CLI completion quits gracefully so Chromium flushes Local State. A forced crash or error exit before Chromium persists a newly created vault key can still lose that key; this change does not claim unconditional OS-vault crash durability. Preserve the OS account and Electron user-data directory along with encrypted credentials.

## Recovering a previously quarantined store

Older versions renamed the active file to `auth.json.corrupt-<timestamp>` when any decryption attempt failed, including a valid encrypted file opened by Node. Another startup could then create an empty replacement. The suffix does not prove the contents are corrupt.

Stop the owning daemon after checking that no work is active. Preserve the current file and candidate backups. Verify a candidate using the original OS account and vault context, without printing secret values; confirm the expected provider identities. Restore only that verified encrypted file using an atomic replacement, retain both backups, and restart with the corrected Electron host. Verify the configured provider IDs through the daemon. Do not blindly restore the newest timestamp, merge opaque ciphertext, copy secrets into profile directories, or automatically roll back live credentials.

## Regression evidence

Credential-store tests cover unavailable vaults, malformed data, encryption and disk-write failures, stale stores, asynchronous updates and mutable callback values. Windows runtime tests use synthetic secrets with independent CJS/ESM Electron processes: encryption, rejected Node access with unchanged bytes, and successful Electron reopen. Launcher tests cover default/custom homes, explicit overrides, inherited launch flags, development isolation and nonzero error exits. Vitest installs a disposable Mousse home before each test file's imports, replacing inherited application-home settings; explicit fixture homes remain supported. Provider test fixtures also use explicit temporary stores. The suite leaves the OS user's home unchanged.
