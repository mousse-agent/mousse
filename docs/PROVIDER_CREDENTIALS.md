# Provider credential storage and recovery

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

Credential-store tests cover unavailable vaults, malformed data, encryption and disk-write failures, stale stores, asynchronous updates and mutable callback values. Windows runtime tests use synthetic secrets with independent CJS/ESM Electron processes: encryption, rejected Node access with unchanged bytes, and successful Electron reopen. Launcher tests cover default/custom homes, explicit overrides, inherited launch flags, development isolation and nonzero error exits. Real provider test fixtures use temporary stores rather than the developer's global installation.
