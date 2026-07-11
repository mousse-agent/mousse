# Mousse MMS launch on startup

Mousse Main Service (MMS) can start automatically when you log in (or at boot on servers)
using platform-native mechanisms. The `mousse-cli service install` command delegates to
`src/mms/startup/`; this document describes what it does and how to install, verify,
or remove autostart manually.

## Overview

| Platform | Mechanism | Config location |
|----------|-----------|-----------------|
| Windows | Task Scheduler (`ONLOGON`), registry fallback | Task `MousseMMS` or `HKCU\...\Run\MousseMMS` |
| Linux (Debian/Ubuntu, Fedora/RHEL, etc.) | systemd user unit | `~/.config/systemd/user/mousse-mms.service` |
| macOS | launchd LaunchAgent | `~/Library/LaunchAgents/com.ryspa.mousse.mms.plist` |

All platforms run the same command:

```text
<path-to-mousse-cli> service run
```

`MOUSSE_HOME` is set to your Mousse data directory (typically `~/.mousse`) so the
service finds configuration and state.

### CLI commands

```bash
mousse-cli service install    # detect platform and install autostart
mousse-cli service uninstall  # remove autostart
mousse-cli service status     # show whether autostart is configured (via startup API)
```

`service install` requires the path to the `mousse-cli` binary and your home directory;
the CLI passes these automatically.

---

## Windows

### Primary: Task Scheduler

On install, Mousse creates a logon task named **MousseMMS** that runs:

```text
"<cliPath>" service run
```

Manual install (replace the path):

```powershell
schtasks /Create /F /SC ONLOGON /TN "MousseMMS" /TR "\"C:\path\to\mousse-cli.exe\" service run"
```

Manual uninstall:

```powershell
schtasks /Delete /F /TN "MousseMMS"
```

### Fallback: registry Run key

If Task Scheduler creation fails (for example, insufficient rights), install falls back to:

```text
HKCU\Software\Microsoft\Windows\CurrentVersion\Run
```

Value name: **MousseMMS**

Manual registry install:

```powershell
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v MousseMMS /t REG_SZ /d "\"C:\path\to\mousse-cli.exe\" service run" /f
```

Manual registry uninstall:

```powershell
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v MousseMMS /f
```

### Verify on Windows

1. Open **Task Scheduler** → Task Scheduler Library → look for **MousseMMS**.
2. Or check the registry Run key in `regedit` under the path above.
3. Run `mousse-cli service status` for a summary.

### Troubleshooting (Windows)

- **Task exists but service does not start**: open the task’s **History** tab in Task
  Scheduler; confirm the CLI path is correct and that `mousse-cli service run` works when
  run manually in a terminal.
- **Only registry entry**: you may be on the registry fallback; ensure the quoted path in
  the Run value is valid.
- **Permission errors**: try installing from an elevated PowerShell, or use the registry
  fallback manually.

---

## Linux (systemd user units)

Debian/Ubuntu, Fedora, RHEL, and most modern Linux desktops use **systemd**. Mousse writes
a **user** unit (no root required):

**File:** `~/.config/systemd/user/mousse-mms.service`

```ini
[Unit]
Description=Mousse Main Service
After=network.target

[Service]
ExecStart=/path/to/mousse-cli service run
Restart=on-failure
Environment=MOUSSE_HOME=/home/you/.mousse

[Install]
WantedBy=default.target
```

Install then runs:

```bash
systemctl --user daemon-reload
systemctl --user enable --now mousse-mms
```

### Manual install

```bash
mkdir -p ~/.config/systemd/user
# edit ~/.config/systemd/user/mousse-mms.service (contents as above)
systemctl --user daemon-reload
systemctl --user enable --now mousse-mms
```

### Manual uninstall

```bash
systemctl --user disable --now mousse-mms
rm ~/.config/systemd/user/mousse-mms.service
systemctl --user daemon-reload
```

### Headless servers and VPS (linger)

User systemd services normally stop when you log out. For MMS to run at boot **without**
an interactive login (common on VPS/servers), enable **lingering** for your user:

```bash
loginctl enable-linger $USER
```

On Fedora/RHEL you may need `sudo`; on Debian/Ubuntu the same command usually works for
your own user. After enabling linger, re-enable the unit:

```bash
systemctl --user enable --now mousse-mms
```

### Verify on Linux

```bash
systemctl --user is-enabled mousse-mms
systemctl --user is-active mousse-mms
systemctl --user status mousse-mms
```

### Troubleshooting (Linux)

- **`systemctl: command not found`**: this host may not use systemd; autostart via this
  module is not supported.
- **Unit enabled but inactive after reboot**: enable linger (see above) or ensure you log
  in graphically if you expect a desktop session.
- **Logs**:

  ```bash
  journalctl --user -u mousse-mms -f
  journalctl --user -u mousse-mms --since today
  ```

- **Wrong CLI path**: edit the unit file, then `systemctl --user daemon-reload` and
  `systemctl --user restart mousse-mms`.

---

## macOS

Mousse installs a **LaunchAgent** (per-user, at login):

**File:** `~/Library/LaunchAgents/com.ryspa.mousse.mms.plist`

The plist runs `mousse-cli` with arguments `service` and `run`, sets `RunAtLoad`, keeps
the process alive on non-successful exit, and sets `MOUSSE_HOME`.

Install uses:

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.ryspa.mousse.mms.plist
```

On older macOS, fallback:

```bash
launchctl load -w ~/Library/LaunchAgents/com.ryspa.mousse.mms.plist
```

### Manual uninstall

```bash
launchctl bootout gui/$UID ~/Library/LaunchAgents/com.ryspa.mousse.mms.plist
rm ~/Library/LaunchAgents/com.ryspa.mousse.mms.plist
```

### Verify on macOS

```bash
launchctl print gui/$UID/com.ryspa.mousse.mms
ls ~/Library/LaunchAgents/com.ryspa.mousse.mms.plist
```

### Troubleshooting (macOS)

- **Agent not loading**: open **Console.app**, filter for `com.ryspa.mousse.mms` or
  `mousse`; fix paths in the plist if the CLI moved.
- **Permission or path issues**: ensure the CLI path in the plist is absolute and
  executable (`chmod +x` if needed).
- **After macOS upgrade**: try `launchctl bootout` then `bootstrap` again, or use
  `launchctl load -w` on older systems.

---

## API reference

The startup module exports:

```ts
export type StartupPlatform = 'windows' | 'linux-systemd' | 'macos'
export function detectPlatform(): StartupPlatform
export async function installStartup(opts: { cliPath: string; homeDir: string }): Promise<void>
export async function uninstallStartup(): Promise<void>
export async function startupStatus(): Promise<{ installed: boolean; detail: string }>
```

Errors include a **manual command** string when a system tool fails, so you can retry the
same step by hand.
