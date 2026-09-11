# Linux qualification handoff

Date: 2026-09-11

Source under test: `4bedbf507bfbc2e1421a2b99eabbcfaa00347db8` with the preserved dependency overlay (`@earendil-works/pi-coding-agent` 0.85.1, `pi-cursor-sdk` 0.3.6, Electron 43.2.0, electron-builder 26.15.3, Vitest 4.1.11).

Host: AlmaLinux 9.5 under WSL2, Linux 5.15.167.4, x86_64, Node 22.19.0, npm 10.9.3. The task-owned source, runtime, release, and evidence roots are under `/home/aeon_laster/mousse-platform-qualification/linux-20260911`; no default `~/.mousse`, live account/provider/channel, OS startup, Docker daemon, or managed-browser download was used.

## Reviewed result

The production Node CLI path passed help/version, daemon start and authenticated framed protocol access, profile migration and profile creation, workflow list/run, stop/join, restart/re-authentication, and final shutdown. The legacy fixture uses the real array-based thread index, active-thread record, thread files, and a disabled one-time scheduled job with a valid `schedule.kind`. Migration committed once, retained the fake shared credential at installation scope, and did not duplicate the default profile on restart.

A passthrough workflow completed through the built CLI. A script workflow was durably admitted by the CLI, which exited 3 while external approval was pending; an authenticated fixture GUI client approved the exact pending record, after which the real script runner reached `succeeded` with `{script:true, linux:true, input:{count:3}}`. This is approval-path evidence, not a claim that the initial CLI process waited through GUI approval.

The system-Node daemon selected the `system-node` host after successfully loading Linux `node-pty`. A real PTY spawned `bash`, emitted `pty-ok`, and exited 0. Both recorded daemon generations stopped, and `/proc` scanning by the exact isolated `MOUSSE_HOME` found no remaining owned process.

The production electron-builder commands produced both desktop and CLI AppImages with exit 0. The unpacked Electron binary passed `--cli --help`, `--version`, and `browser status`; WSL emitted expected missing-DBus diagnostics on stderr. Browser status returned `setup-required`, Linux platform supported, zero sessions/launches, and did not install or download Chrome.

## Evidence

Node CLI/runtime report:

`/home/aeon_laster/mousse-platform-qualification/linux-20260911/evidence-root3/linux-qualification-evidence.json`

Package report:

`/home/aeon_laster/mousse-platform-qualification/linux-20260911/evidence-package/linux-qualification-evidence.json`

Artifacts:

- Desktop AppImage: `/home/aeon_laster/mousse-platform-qualification/linux-20260911/src/release/Mousse-0.1.1.AppImage`, 180,762,502 bytes, SHA-256 `e89811e00e037a09de5f8e3392918047693508e32da6dd7bf39a8f096a9c81d0`.
- CLI AppImage: `/home/aeon_laster/mousse-platform-qualification/linux-20260911/src/release/cli/mousse-cli-0.1.1-linux-x86_64.AppImage`, 177,067,379 bytes, SHA-256 `438cae656641c927b078ac66a6043fcacc476d95fb08979092ce97c0b99c4731`.
- Unpacked Electron ASAR: 209,182,040 bytes, SHA-256 `4e83421111f5d2ad9f0ed7c33d08f442f2f0e71b5c0f754d87272b8a17258053`.

The Linux scratch checkout completed `npm ci`, the full app build, and CLI build before qualification. This review did not repeat those disk-heavy commands. Local syntax verification passed for both qualification scripts and both fixture modules.

## Review fixes

The reusable runner now performs exact `MOUSSE_HOME` process discovery and bounded TERM/KILL cleanup in a `finally` block, including daemon-start and runner-error paths. It reports any residual PID as a blocker. It also records a machine-readable `outcome` and explicitly sets `package.electronNativePty.qualified=false`; packaged Electron help/version/browser status does not substitute for a packaged daemon/native-PTY run. Full command output stays available internally while evidence fields remain bounded.

## Open qualification

A certified Linux Chrome was unavailable and deliberately not downloaded, so managed-browser launch/action remains blocked by `missing-certified-browser`. The packaged Electron daemon/native PTY path was not exercised; only the production Node daemon/native PTY and packaged Electron CLI smoke paths were. AppImage execution through FUSE, desktop GUI interaction, distro-native installation/upgrade, signing, publishing, and non-WSL Linux hosts remain unqualified. G7 remains pending.
