# Windows packaged lifecycle qualification

Date: 2026-09-11

Reviewed harness base: `4bedbf507bfbc2e1421a2b99eabbcfaa00347db8`

Read-only package: `C:\Users\bubbl\Documents\Projects\RYSPA\mousse\orchestration\windows-candidate-20260911\win-unpacked`

Package identity: `resources/app.asar` is 209,336,240 bytes with SHA-256 `EFB718E613ABC85767FE961FAD9D1E0ECCF07144280FE1335EFF5D48B18F48AB`, matching `reviews/final-windows-package.md`.

## Review result

The reusable runner exercises the real packaged `mousse-cli.exe` and daemon with a source-built production `LocalMmsClient`. Every invocation receives an isolated `MOUSSE_HOME`, `APPDATA`, `LOCALAPPDATA`, and Electron user-data directory. Provider environment variables are removed. The runner does not install startup integration, download a browser, invoke a model, or use a live account/channel.

The earlier migration failure was a qualification-fixture defect, not a packaged migration defect. The planted scheduled job omitted the required `schedule.kind` and other persisted job fields, so packaged startup failed while reading the job. The fixture now plants a disabled one-time 2099 job with the real persisted schedule and timestamps. Its thread index, active-thread record, and thread-data files also use production layouts.

I strengthened the runner to record final owned-process liveness and metadata fingerprints of the default Mousse home/AppData locations before and after qualification. A green result now requires no residual owned daemon PID and no observed change to those default-user paths.

## Evidence

Command:

```powershell
node scripts/qualification/windows/run.mjs --package "C:\Users\bubbl\Documents\Projects\RYSPA\mousse\orchestration\windows-candidate-20260911\win-unpacked" --work-root "C:\Users\bubbl\Documents\Projects\RYSPA\mousse-platform-worktrees\runtime\windows-lifecycle-qualification\run-6"
```

Machine report: `C:\Users\bubbl\Documents\Projects\RYSPA\mousse-platform-worktrees\runtime\windows-lifecycle-qualification\run-6\evidence\report.json`

Result: 17 passed, 0 failed, 0 unsupported. The package passed:

- help, version, and stopped-service status;
- real daemon start, authenticated framed client connection, stop/join, restart, and final PID cleanup;
- clean profile creation and cross-profile list isolation;
- configuration and workflow definition list RPCs;
- missing managed-browser status without installation or download;
- real packaged `node-pty` spawn, input, observed echo, exit, and kill state;
- legacy personal config, thread, transcript, and shared credential migration;
- migration restart without duplicate profiles or credential copies;
- unchanged default-user Mousse home/AppData metadata.

Targeted helper regression:

```text
npx vitest run tests/platformWindowsPackageQualification.test.ts
5 tests passed
```

All four recorded daemon PIDs were absent after the run. Migration kept the provider/model choice in the profile-owned `mousse.conf`, retained the shared fake credential only at installation scope, committed one default profile, and preserved the legacy transcript across restart.

## Limits

This qualifies the reviewed Windows x64 unpacked directory package. It does not qualify an NSIS install/upgrade, signing, publishing, GUI interaction, an installed managed browser, live providers/channels, Linux, or macOS. The source client is bundled from the harness checkout for authenticated protocol exercise; the daemon and PTY implementation under test are the packaged binaries. This evidence does not close the full release gate by itself.
