# SSH settings for editors

Editors such as VS Code, Cursor, Zed and the JetBrains IDEs open a folder on another computer by running the system `ssh` against a host name. `ssh` reads `~/.ssh/config`, so a `Host` name is the one way to reach every editor. Mousse keeps its own config file with one `Host` name per paired computer and adds one `Include` line for it to `~/.ssh/config`.

The code is `src/mms/net/editor/sshConfig.ts`. The tunnel behind the `ProxyCommand` (`mousse-cli net ssh-proxy`) and the owner's switch come in later changes; until then the names exist but do not connect.

## What Mousse writes

| File | Content | Written when |
| --- | --- | --- |
| `<Mousse home>/ssh/config` | One `Host` block per paired computer | First use, and when computers change |
| `<Mousse home>/ssh/known_hosts` | The host key each computer vouched for, under its alias | When a key is pinned; a revoked computer's line is removed |
| `<Mousse home>/ssh/state.json` | Aliases, whether the feature is on, whether the notice was seen | With the files above |
| `~/.ssh/config` | One line: `Include ~/.mousse/ssh/config` | First use (added), Settings undo (removed) |

`<Mousse home>` is `~/.mousse` unless `MOUSSE_HOME` is set.

A block looks like this:

```
Host mousse-workbox-3fa2c1
  HostName 127.0.0.1
  Port 22
  User bob
  ProxyCommand /path/to/mousse-cli net ssh-proxy nod_…
  HostKeyAlias mousse-workbox-3fa2c1
  UserKnownHostsFile /home/me/.mousse/ssh/known_hosts
  StrictHostKeyChecking yes
  CheckHostIP no
  UpdateHostKeys no
  VerifyHostKeyDNS no
  ForwardAgent no
  ForwardX11 no
  ControlMaster no
```

- The name is `mousse-<computer name>-<start of its id>`: lowercase, digits and dashes only. It is minted once and kept in `state.json`, so renaming a computer changes the comment above the block and never the name an editor remembers.
- `Port 22` is written on purpose. A `Port` set for all hosts further down the user's file would turn the known_hosts name into `[alias]:<port>` and the pinned key would not be found.
- `User` is written only when the computer has told Mousse its login name and the name is safe to put in a config file.
- The host key is pinned under the alias with strict checking, so `ssh` never asks the person to trust a key. The key is vouched for over Mousse Net by a later change.

## The `Include` line

- **Automatic on first use.** The first call that needs an alias adds the line, with no dialog. The call reports `added: true` once, and the interface shows `EDITOR_SSH_NOTICE`: "Mousse added an Include line to ~/.ssh/config so your editor can reach your other computers." `net.editor.ssh.ack` marks it seen.
- **Undo removes only that line.** `net.editor.ssh.disable` removes lines that name only Mousse's file and leaves every other byte, then turns the feature off. First use does not turn it back on; `net.editor.ssh.enable` does. If the line cannot be removed, nothing changes and the person can try again.
- **At the very top.** `ssh` uses the first value it finds for each option, and an `Include` that comes after a `Host` or `Match` line is read for that block only ([ssh_config(5)](https://man.openbsd.org/ssh_config); [a bug report closed as intended](https://bugzilla.redhat.com/show_bug.cgi?id=1759421)). The line therefore goes in front of every other line (after a byte order mark if there is one), so no earlier line can override an alias. A copy of the line below a `Host` line does not count as installed.
- **The user's other lines are never changed.** The file is read and written as bytes, so CRLF, tabs, trailing spaces and bytes that are not UTF-8 survive. A file that is UTF-16 or binary is left alone and reported.
- **Writes are atomic.** A temporary file beside the target is renamed over it, keeping the file mode. The file is re-read just before the rename and the change is made again if another program changed it meanwhile.
- **Symbolic links.** If `~/.ssh/config` is a link (common with dotfile managers), the file it leads to is replaced and the link stays. A link to a missing file creates that file. A link whose folder is missing is reported, not repaired.
- **A missing `~/.ssh`** is created (mode `0700` where that applies) when the file has to be created.

## Which Include spelling

The line names `~/<path under home>` when the Mousse home is inside the home directory, and an absolute path otherwise. A path with spaces is double-quoted. A path with `%`, `${`, a quote, a backslash on macOS or Linux, or a glob character (`*?[`) is refused, because `ssh` versions disagree on how to read them.

On Windows the choice matters, because the clients disagree. Probed with `ssh -G -F <file>`:

| Include spelling | Win32-OpenSSH 9.5p2 (`System32\OpenSSH`) | OpenSSH 10.5p1 in Git for Windows |
| --- | --- | --- |
| `"~/.mousse/ssh/config"` | read | read |
| `../.mousse/ssh/config` (relative to `~/.ssh`) | read | read |
| `"C:/Users/me/.mousse/ssh/config"` | read | **not read** |
| `"C:\Users\me\.mousse\ssh\config"` | read | not read |
| `"/Users/me/.mousse/ssh/config"` (no drive) | not read | not read |
| `"/c/Users/me/.mousse/ssh/config"` | not tested | read |

`~/…` is read by both, so it is the written form whenever it can be. When the Mousse home is on another drive or outside the home directory the absolute form is written, and Git for Windows' `ssh` will not follow it; the alias then does not exist for editors that use that client. Putting the Mousse home under the home directory avoids it.

## Questions from the plan

### Does Win32-OpenSSH support `Include`?

Yes, in the client. `Include` came to upstream OpenSSH in 7.3 ([release notes](https://www.openssh.com/txt/release-7.3)). Win32-OpenSSH had a bug where an absolute Windows path was resolved under `~/.ssh` ([issue 1511](https://github.com/PowerShell/Win32-OpenSSH/issues/1511), closed for 8.1, with a report in 2025 that it returned). On the version installed with Windows 11 here (9.5p2) a quoted absolute path with a drive letter, forward or backward slashes, was read, a drive-less path was not, and `~/…` was read.

One more Windows rule found while probing: Win32-OpenSSH checks the owner and ACL of an included file and refuses it ("Bad owner or permissions") when an account other than the user, SYSTEM and Administrators can access it. A Mousse home under the user profile inherits the right ACL. If the home is on a shared folder, the alias fails until the extra ACL entries are removed.

Not confirmed: whether the VS Code Remote-SSH extension reads included files through `ssh -G` or with its own parser. This is part of the matrix for the change that launches editors.

### A `ProxyCommand` path with spaces

OpenSSH hands the `ProxyCommand` text to a shell after expanding `%` tokens, so Mousse writes `%%` for each `%` and quotes the program path.

- **macOS and Linux:** the path is single-quoted when it has anything but letters, digits and `@+=:,./%-`. A path with a backslash is refused.
- **Windows:** the path is double-quoted with forward slashes. Probed with a `.cmd` launcher (the form `mousse-cli` has on Windows) in a folder with a space:

| `ProxyCommand` | Win32-OpenSSH 9.5p2 | Git for Windows OpenSSH 10.5p1 |
| --- | --- | --- |
| `"C:/dir with space/x.cmd" args` | ran | ran |
| `"C:\dir with space\x.cmd" args` | ran | ran |
| `'C:/dir with space/x.cmd' args` | not tested | ran |
| unquoted `C:/dir with space/x.cmd args` | ran | not tested |
| 8.3 short path `C:\Users\me\AppData\Local\Temp\PCPROB~1\FAKEPR~1.cmd args` | ran | not tested |

Arguments after the path arrived intact, also with a quoted argument that contains a space.

**Fallback:** if a client turns out not to run a quoted path, write the 8.3 short path (`GetShortPathName`, or `cmd /c for %I in ("<path>") do @echo %~sI`), which has no spaces and needs no quoting. Short names can be switched off per volume, so this is the second choice. Microsoft's own PowerShell docs recommend it for a similar Win32-OpenSSH limit on paths with spaces ([Win32-OpenSSH issue 784](https://github.com/PowerShell/Win32-OpenSSH/issues/784)). A link or copy of the launcher at a path without spaces also works.

`$` and a backtick in a Windows path are refused, because Git for Windows' `ssh` passes the text to `sh`, where they would expand inside double quotes.

## Methods

Local methods on the `net.v1` capability, for the clients on this computer only (a paired computer cannot call them). No screen or CLI command uses them yet:

| Method | Does |
| --- | --- |
| `net.editor.ssh.status` | Reads the state. Writes nothing. Works while Net is off. |
| `net.editor.ssh.prepare` | First use: writes Mousse's files for the paired computers and adds the line if it is missing. Refused with `off` after an undo. |
| `net.editor.ssh.enable` | Turns the feature on after an undo, then does what `prepare` does. |
| `net.editor.ssh.disable` | Undo. Works while Net is off. |
| `net.editor.ssh.ack` | The notice was seen. |

While the feature is used and on, Mousse rewrites its own files when the device list changes: a new computer gets an alias, a revoked one loses its alias and its pinned key. That sync never touches `~/.ssh/config`.
