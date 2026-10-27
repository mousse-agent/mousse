# Devices reachable over SSH

Some machines accept `ssh` and nothing else. The `ssh` transport add-on lets such a machine join a device set anyway: it listens on a loopback port that only sshd can reach, and other devices connect to it with `ssh -W`. The usual WebSocket and pinned TLS run on top, so SSH adds a route, not a trust relationship.

## What Mousse will and will not run

Mousse only ever opens SSH to endpoints approved in the app for that device.

A device's signed routes prove which device advertised a route. They do not prove that you may log in to it. So a route like `ssh://me@box.example.com/127.0.0.1:47821` is ignored until this computer has an approval for that device in `<profile>/net/ssh/approvals.json`:

```json
{ "<node id>": { "endpoint": "me@box.example.com", "fingerprint": "SHA256:…", "approvedAt": 1790942400000 } }
```

When Mousse dials, it spawns `ssh` with the endpoint from that file, not the one in the route. The route supplies only the loopback port number. A second computer can approve its own alias or jump host for the same device.

## The command

```
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile="<profile>/net/ssh_known_hosts" "<home>/.ssh/known_hosts" \
    -o UpdateHostKeys=no -o CheckHostIP=no -o VerifyHostKeyDNS=no \
    -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no \
    -o ForwardAgent=no -o ForwardX11=no -o PermitLocalCommand=no -o ClearAllForwardings=yes \
    -o ControlMaster=no -o ControlPersist=no -o ControlPath=none \
    -o LogLevel=ERROR -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
    -T [-l <user>] [-p <port>] -W 127.0.0.1:<daemon port> -- <host>
```

- **Host keys are never accepted on the fly.** `ssh` runs with `StrictHostKeyChecking=yes`, so the host key must already be known. It is looked up in Mousse's own `ssh_known_hosts` file and in your `~/.ssh/known_hosts` (a host you already ssh to from a terminal needs nothing more). OpenSSH also reads its system-wide file (`/etc/ssh/ssh_known_hosts`, or `%PROGRAMDATA%\ssh\ssh_known_hosts` on Windows) and a `KnownHostsCommand` from your `~/.ssh/config`, and a key found there is accepted too. DNS host key records (`VerifyHostKeyDNS`) are turned off. Otherwise the dial fails with `Host key verification failed` and the device row says so.
- **Mousse's `ssh_known_hosts` is never written by a dial.** `CheckHostIP=no` stops OpenSSH from adding address lines to it.
- **Keys and agent only.** `BatchMode=yes` means ssh never prompts, so a password or a keyboard-interactive login cannot work for a background daemon. Mousse never asks for or stores a password and removes `SSH_ASKPASS*` from the environment it gives `ssh`. Add your key to the host (`ssh-copy-id -p <port> <user>@<host>`). The daemon needs access to your agent or a key file in `~/.ssh`: a daemon started from systemd or a LaunchAgent may not inherit `SSH_AUTH_SOCK`.
- **Your `~/.ssh/config` still applies** to the endpoint you approved, including `Match exec`, which runs while Mousse reads the resolved configuration with `ssh -G` before each dial. `ClearAllForwardings=yes` drops `LocalForward`/`RemoteForward` for these dials.
- **`ProxyJump` and `ProxyCommand` are refused.** The options above reach only the final `ssh`; a jump host is started as a separate `ssh` that keeps your own settings, so it could ask a question on a terminal or write your known_hosts. Until every hop can be held to the same rules, a configuration that resolves to a `ProxyJump` or `ProxyCommand` fails with a message saying so and `ssh` is not run. Approve an endpoint that reaches the host without a jump host.
- **The profile path must be plain.** A path containing `%`, `${`, a quote or a backslash (on macOS and Linux) is refused, because OpenSSH versions disagree on how to read it inside an option.
- **One `ssh` process per connection.** It exits when the connection closes, and Mousse kills it on teardown.
- **A spawn floor protects the host's login limits.** After a dial, Mousse waits at least 10 seconds before spawning `ssh` for the same endpoint again, and 60 seconds after `Permission denied` or a host key failure.

## Setting up the host by hand

On the machine reachable over SSH, with the daemon enrolled in your device set:

```bash
echo '{"endpoint":"me@box.example.com","port":47821}' > ssh.json && chmod 600 ssh.json
mousse-cli net transport configure ssh --settings-file ssh.json
```

`endpoint` is `[user@]host[:sshPort]` as the other computers type it. `port` is a fixed, free loopback port. It must be fixed because a route that changed after a restart could not reach a computer that only learns routes through that same connection.

The host's sshd must allow TCP forwarding to loopback (`AllowTcpForwarding yes`, which is the default). If the daemon is not running, the dial reports "the daemon on `<endpoint>` is not listening on port `<port>`". The usual cause is a reboot with no linger: `loginctl enable-linger <user>` keeps a systemd user service running while nobody is logged in.

To use the route from another computer, approve it under Devices ("SSH route offered"), which checks the host key first and writes the approval for you.

## Troubleshooting

| Detail on the device row | Meaning |
| --- | --- |
| `Host key verification failed` | The host key is not in either known_hosts file, or it changed. Confirm the fingerprint, then trust it. |
| `Permission denied` | No key or agent identity was accepted. Check `ssh-add -l` from the daemon's environment. |
| `does not allow TCP forwarding (AllowTcpForwarding)` | sshd on the host forbids `-W`. |
| `not listening on port` | Forwarding works but the daemon is down or on a different port. |
| `Waiting before trying SSH … again` | The per-endpoint spawn floor; the route manager retries on its own backoff. |
| `uses ProxyJump` / `uses ProxyCommand` | The resolved ssh configuration needs a proxy hop, which is not supported yet. |

A host that needs a browser or interactive step to log in (for example Tailscale SSH "check") cannot be used: `ssh` runs without prompts and its messages are not shown. Use an endpoint that accepts a key or an agent identity.

## Adding a machine from the app

**Settings → Devices → Add device → Remote machine over SSH** sets up a machine you can already `ssh` into. Type a host or a name from your `~/.ssh/config`. The app shows what it will do, runs it, and offers an undo.

You need: a key or agent identity that gets you in without a password, `curl` or `wget`, `sha256sum` or `shasum`, systemd user services, about 500 MB free, the shared libraries the Mousse app links against (GTK, NSS, audio: a bare server image has none, and the check names the missing ones and the `apt-get install` line, with the `t64` package names on Ubuntu 24.04 and Debian 13), and `AllowTcpForwarding` on the machine's sshd. Linux x86_64 machines get Mousse installed. A Mac must already have Mousse. To check by hand: `ssh <host> 'uname -sm; command -v curl sha256sum systemctl'`.

1. **Host key.** The app asks `ssh` itself for the host's key (so your own `~/.ssh/config` applies) and shows its fingerprint. Nothing is trusted silently: you confirm the fingerprint, and only then does Mousse write that key to its own `ssh_known_hosts`. This step never logs in and never runs a command on the machine. A changed key shows both fingerprints and needs a separate confirmation; a key marked `@revoked` stops. Mousse never edits your `~/.ssh/known_hosts` or a system file.
2. **Check.** With the key trusted, one read-only script reports the system, any Mousse already there, free disk space and the tools above. A host whose configuration uses `ProxyJump` or `ProxyCommand` is refused with a message saying so (see above). If your key is denied, the app shows the `ssh-copy-id` command. It never asks for a password.
3. **Plan.** Every change is listed before anything runs. Missing tools, an unrelated `~/.local/bin/mousse-cli` or `mousse-mms.service`, a machine that already belongs to a device set, and a stopped Mousse service that Mousse did not install block it, each with the fix.
4. **Run.** Every change is written to a journal on this computer first (`<profile>/net/ssh/<id>.json`), so a failed or cancelled run can be retried or undone.

### What runs on the machine

Every command is `exec /bin/sh -c '<script>'` with each value quoted, so a fish or zsh login shell never parses it. Documents and secrets (the invitation, the add-on settings, the checksum line) go on stdin, never in the command line.

| Step | On the machine |
| --- | --- |
| Install | Downloads `mousse-cli-<version>-linux-x86_64.AppImage` from the project's GitHub release into `~/.local/share/mousse/cli/<version>/` and checks it against the release's `SHA256SUMS-<version>.txt` (fetched over HTTPS by this computer). If the machine cannot reach GitHub, this computer downloads and verifies the file and sends it over SSH. Unpacks it with `--appimage-extract` and writes the launcher `~/.local/bin/mousse-cli`, a two-line wrapper that sets `ELECTRON_DISABLE_SANDBOX=1`. |
| Service | `mousse-cli service install --headless` (a systemd user unit, no sudo), then waits for the service. |
| Linger | `loginctl enable-linger <user>` when it is off. If the machine refuses without an administrator, the step is skipped and the app shows the command to run. |
| Join | A one-time invitation goes over stdin to `mousse-cli bridge join --name <name> --via ws://127.0.0.1:<port>/mousse-net`. A reverse tunnel (`ssh -R`, with `ExitOnForwardFailure`) lets the machine reach this computer for the join only; pinned TLS and the invitation protect it. |
| SSH access | `mousse-cli net transport configure ssh --settings-file <private temporary file>` with the endpoint and a fixed loopback port. |
| Approval | On this computer only: the approval and fingerprint are written to `approvals.json`, the machine's signed routes are adopted, and the first connection is opened. A machine can never approve itself. |

Login shells that cannot take a newline inside single quotes (csh, tcsh) fail on the multi-line scripts with an error from the shell; use sh, bash, zsh or fish as the login shell for the setup.

A machine that already runs Mousse (installed by you) skips Install and Service and is marked external: Mousse never stops, replaces or uninstalls it. A stopped one is not started for you; the app shows the command.

### Undo, update, rename

- **Undo setup** reverses the journaled steps in reverse order, each only while it is still Mousse's and unchanged: the SSH approval, the add-on (restored to what was there before), the device (revoked from this computer), the service and the launcher and install directory that setup created. Setup records a hash of the launcher and of the service unit it wrote; Undo removes them only while they still match, so an edited wrapper or unit is reported and left alone (and the service is left with a changed launcher). Lingering is turned off again only if this setup turned it on. Every invitation the setup issued is resolved from this computer's own records: an unused one is revoked, a used one names the device it admitted and that device is revoked. Anything you changed since is reported and left alone. The machine's data directory (`~/.mousse`) and device identity are never deleted; the app lists the commands if you want them gone.
- **Update** (only for machines Mousse installed) installs the new version beside the old one, rewrites the launcher, re-runs `service install --headless`, restarts the service and waits for the new version. It never runs `service stop`. If the new version does not answer, the launcher and unit go back to the previous install.
- **Rename SSH endpoint** changes the address this computer uses. The new address must offer the same host key.

### By hand

To undo without the app, on the machine: `mousse-cli net transport configure ssh --disable --settings-file <file>`, `mousse-cli service uninstall`, `rm ~/.local/bin/mousse-cli`, `rm -rf ~/.local/share/mousse/cli`. Then on this computer, revoke the device under Devices and remove its entry from `approvals.json`.

The reverse tunnel for the join also applies any `LocalForward`, `RemoteForward` or `DynamicForward` you configured for that host in `~/.ssh/config` (this is your own configuration for a host you typed, like the `ProxyCommand` note above); `ExitOnForwardFailure` makes a conflicting one fail loudly.
