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
    -o UpdateHostKeys=no -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no \
    -o ForwardAgent=no -o ForwardX11=no -o PermitLocalCommand=no -o ClearAllForwardings=yes \
    -o ControlMaster=no -o ControlPersist=no -o ControlPath=none \
    -o LogLevel=ERROR -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
    -T [-l <user>] [-p <port>] -W 127.0.0.1:<daemon port> -- <host>
```

- **Host keys are never accepted on the fly.** The host must already be in Mousse's own `ssh_known_hosts` file or in your `~/.ssh/known_hosts` (a host you already ssh to from a terminal needs nothing more). Otherwise the dial fails with `Host key verification failed` and the device row says so.
- **Keys and agent only.** `BatchMode=yes` means ssh never prompts, so a password or a keyboard-interactive login cannot work for a background daemon. Mousse never asks for or stores a password and removes `SSH_ASKPASS*` from the environment it gives `ssh`. Add your key to the host (`ssh-copy-id -p <port> <user>@<host>`). The daemon needs access to your agent or a key file in `~/.ssh`: a daemon started from systemd or a LaunchAgent may not inherit `SSH_AUTH_SOCK`.
- **Your `~/.ssh/config` still applies** to the endpoint you approved, including `ProxyJump`, `ProxyCommand` and `Match exec`. That is your own configuration for a host you chose. Remove forwards from it that you do not want; `ClearAllForwardings=yes` drops `LocalForward`/`RemoteForward` for these dials.
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

To use the route from another computer today, add the host's key to `ssh_known_hosts` (or ssh to it once from a terminal) and write the approval entry shown above. The Devices screen's SSH setup and approve flows will do both from the app.

## Troubleshooting

| Detail on the device row | Meaning |
| --- | --- |
| `Host key verification failed` | The host key is not in either known_hosts file, or it changed. Confirm the fingerprint, then trust it. |
| `Permission denied` | No key or agent identity was accepted. Check `ssh-add -l` from the daemon's environment. |
| `does not allow TCP forwarding (AllowTcpForwarding)` | sshd on the host forbids `-W`. |
| `not listening on port` | Forwarding works but the daemon is down or on a different port. |
| `Waiting before trying SSH … again` | The per-endpoint spawn floor; the route manager retries on its own backoff. |
| An `https://` URL in the detail | The host asks for a browser re-authentication (for example Tailscale SSH "check"). Complete it in a terminal, then retry. |
