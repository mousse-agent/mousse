# Final Windows directory-package verification

Date: 2026-09-11

Reviewed source freeze: `778aa3925d5be7a496b5c236b499acd5b8e7b1af`

## Result

The current Windows x64 directory candidate is:

`C:\Users\bubbl\Documents\Projects\RYSPA\mousse\orchestration\windows-candidate-20260911\win-unpacked`

Its installed `resources/app.asar` is 209,391,401 bytes with SHA-256 `ABD6769ECF92657F0F54F655F61B6C77A990FD41870366E9F1C68ADE6D8A99EE`. The bounded packaged Windows qualification passed all 17 cases with no failed or unsupported cases.

## Source build and archive construction

Root ran `npm run typecheck` and `npm run build` in the original checkout at the reviewed source freeze. Both completed successfully. The build includes main, preload, renderer, browser-worker, and CLI output. The logs are:

- `C:\Users\bubbl\Documents\Projects\RYSPA\mousse-platform-worktrees\orchestration\completion-original-typecheck.log`
- `C:\Users\bubbl\Documents\Projects\RYSPA\mousse-platform-worktrees\orchestration\completion-original-build.log`

To avoid another Electron Builder dependency traversal, I created a new staging archive at `orchestration/windows-candidate-20260911/completion-778aa39/app.asar` with the installed official `@electron/asar` `createPackageFromStreams` API. Existing packed entries were read individually from the prior archive, existing unpacked entries were read from its physical unpacked tree, and the 332 files under the newly built `out` directory overlaid those streams. Source maps were excluded. The prior archive was not extracted and no obsolete archive or package was deleted.

Before installation, the staged archive passed these checks:

- Its non-`out` entry set and per-entry metadata exactly matched the prior archive.
- All 332 rebuilt `out` files were byte-identical to the staged archive payload.
- Required main, CLI, preload, renderer, and browser-worker entries were present.
- It contained 43,921 entries and 40,691 files, with no source maps.
- Its physical unpacked set exactly matched all 211 archive entries marked unpacked.
- All 211 staged unpacked files were byte-identical to the installed unpacked files. The browser worker therefore did not require replacement, and the installed native/unpacked tree was left untouched.

Only the validated `app.asar` was copied over the installed archive. Its installed hash and length were checked again after the copy.

## Packaged lifecycle evidence

I ran the actual packaged CLI and daemon with a new task-owned `MOUSSE_HOME` and Electron user-data root:

```powershell
node scripts/qualification/windows/run.mjs `
  --package C:\Users\bubbl\Documents\Projects\RYSPA\mousse\orchestration\windows-candidate-20260911\win-unpacked `
  --work-root C:\Users\bubbl\Documents\Projects\RYSPA\mousse-platform-worktrees\integration\windows-lifecycle-qualification\completion-778aa39
```

The run used the source `LocalMmsClient` and recorded 17 passed, 0 failed, and 0 unsupported cases. It verified package identity, help and version output, stopped status, service start, authenticated local access, clean-profile isolation, config and workflow listing, browser setup-required behavior without auto-install, native PTY spawn/write/exit, joined service stop, restart without duplicate profiles, legacy migration and idempotent rerun, owned-process cleanup, and unchanged default user state. No owned PID remained after cleanup.

After the run, I moved its task-owned directory beside the staged archive so the review worktree could remain clean without deleting evidence. The machine-readable report is at `orchestration/windows-candidate-20260911/completion-778aa39/qualification/evidence/report.json` in the original checkout. It records source SHA `778aa3925d5be7a496b5c236b499acd5b8e7b1af`, the exact reviewed archive identity, start `2026-09-11T11:46:57.258Z`, and finish `2026-09-11T11:47:49.484Z`.

The qualification helper regression also passed:

```text
npx vitest run tests/platformWindowsPackageQualification.test.ts
1 file, 5 tests passed
```

## Limits

This qualifies the Windows x64 unpacked directory candidate. It does not qualify an NSIS installer, code signing, publishing, installed upgrade behavior, OS startup registration, Linux, or macOS. The final ASAR was reconstructed with the official streams API from the existing Electron Builder directory package and the current built output. Qualification did not use live accounts, models, browser downloads, or credentials.
