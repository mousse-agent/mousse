# SSH settings for editors

Editors such as VS Code, Cursor, Zed and the JetBrains IDEs open a folder on another computer by running the system `ssh` against a host name. `ssh` reads `~/.ssh/config`, so a `Host` name is the one way to reach every editor. Mousse keeps its own config file with one `Host` name per paired computer and adds one `Include` line for it to `~/.ssh/config`.

The code is `src/mms/net/editor/sshConfig.ts`. The tunnel behind the `ProxyCommand` (`mousse-cli net ssh-proxy`) and the owner's switch come in later changes; until then the names exist but do not connect.

**The rule above all others: Mousse never makes the user's other `ssh` commands fail.** An included file is read for every host, so a file `ssh` dislikes breaks `git push`, `scp` and every other `ssh`, not only the aliases. See [Never breaking ssh](#never-breaking-ssh).

## What Mousse writes

All of it is under `<Mousse home>/ssh`, which is `~/.mousse/ssh` unless `MOUSSE_HOME` is set. The folder is private to the user (see below).

| File | Content | Written when |
| --- | --- | --- |
| `ssh/config` | One `Host` block per paired computer of every profile | First use, at every start, and when computers change |
| `ssh/known_hosts` | The host keys each computer vouched for, one line per key, under its alias | When keys are pinned; a revoked computer's lines are removed |
| `ssh/state.json` | Whether the feature is on, when the line was added, whether the notice was seen. Shared by every profile | With the files above |
| `ssh/profiles/<profile>.json` | One profile's computers and their aliases | With the files above |
| `~/.ssh/config` | One line: `Include ~/.mousse/ssh/config` | First use (added), Settings undo (removed) |

**Profiles.** Every profile of the installation has its own service, and they run together. Each one keeps its own `profiles/<profile>.json` and only ever adds, renames or removes its own computers and their pinned keys. The `ssh/config` that `ssh` reads is the merge of all profile files, written under one lock that all profiles in the process share. One `Include` line serves all of them. Aliases are unique across profiles, also when the same computer is paired in two profiles.

A block looks like this:

```
Host mousse-workbox-3fa2c1
  HostName 127.0.0.1
  User bob
  ProxyCommand /path/to/mousse-cli net ssh-proxy nod_… --profile <profile>
  HostKeyAlias mousse-workbox-3fa2c1
  UserKnownHostsFile ~/.mousse/ssh/known_hosts
  StrictHostKeyChecking yes
  CheckHostIP no
  UpdateHostKeys no
  VerifyHostKeyDNS no
  ForwardAgent no
  ForwardX11 no
  ControlMaster no
```

- The name is `mousse-<computer name>-<start of its id>`: lowercase, digits and dashes only. It is minted once and kept in the profile file, so renaming a computer changes the comment above the block and never the name an editor remembers.
- `User` is written only when the computer has told Mousse its login name and the name is in the conservative set `[A-Za-z0-9_.@+]` plus inner spaces and `-`. Win32-OpenSSH 8.1 (the one built into Windows 10) splits a value at `=` and reads other punctuation differently, and a parse error in an included file fails every `ssh`.
- With `HostKeyAlias` set, `ssh` looks the host key up under the alias exactly as written; a `Port` elsewhere in the user's file does not change that name.
- The host keys are pinned under the alias with strict checking, so `ssh` never asks the person to trust a key. A new pin replaces every key stored for that alias, whatever its type, in one write: the computer's own current set (vouched for over Mousse Net by a later change) is the truth.
- `UserKnownHostsFile` is spelled like the `Include` line: `~/…` when the Mousse home is under the home directory (both Windows clients expand it, each to its own form of the path: `ssh -G` printed `C:\Users\me/.mousse/…` for Win32-OpenSSH and `/c/Users/me/.mousse/…` for Git for Windows), otherwise an absolute path with forward slashes. A reading of a known_hosts file by the two Windows clients end to end was not tested.
- `--profile <profile>` tells the proxy which profile's Mousse Net to use.

## The program the ProxyCommand starts

Found when the service is built and written again at every start and whenever the computers change, so a program that moved with an update is found:

- **Windows:** `mousse-cli.cmd` next to the app binary.
- **macOS:** `Contents/Resources/mousse-cli`; the app binary is in `Contents/MacOS`. A bare `mousse-cli` would not be on the `PATH` of an editor started from the Dock.
- **Linux AppImage:** the `.AppImage` file itself (`$APPIMAGE`), started with `--cli`, because the folder the launcher sits in is a new `/tmp/.mount_*` on every start.
- **Otherwise:** the launcher next to the binary, and last `mousse-cli` from `PATH`.

## The `Include` line

- **Automatic on first use.** The first call that needs an alias adds the line, with no dialog. The call reports `added: true` once, and the interface shows `EDITOR_SSH_NOTICE`: "Mousse added an Include line to ~/.ssh/config so your editor can reach your other computers. You can remove it in Settings." `net.editor.ssh.ack` marks it seen. The notice shows under the editor button after an open, and in Settings, Devices, Editors, where the switch and undo are.
- **A line removed by hand is a no.** After Mousse added the line, a call that finds it missing treats that as the person turning the feature off: it does not add it again, and answers `off`. Only `net.editor.ssh.enable` (Settings) adds it again.
- **A line moved under a `Host` line** is not copied to the top. `prepare` answers `scoped` and says to move it.
- **Undo removes only that line.** `net.editor.ssh.disable` removes lines that name only Mousse's file and leaves every other byte, then turns the feature off. First use does not turn it back on; `net.editor.ssh.enable` does. If the line cannot be removed, nothing changes and the person can try again. **A line the person edited** (a comment added to it, another file on the same line) is left: the answer says `leftover: true` and `status.included` and `status.edited` stay true, so the screen can say "remove this line by hand" instead of "removed".
- **At the very top.** `ssh` uses the first value it finds for each option, and an `Include` that comes after a `Host` or `Match` line is read for that block only ([ssh_config(5)](https://man.openbsd.org/ssh_config); [a bug report closed as intended](https://bugzilla.redhat.com/show_bug.cgi?id=1759421)). The line therefore goes in front of every other line (after a byte order mark if there is one), so no earlier line can override an alias.
- **The user's other lines are never changed.** The file is read and written as bytes, so CRLF, tabs, trailing spaces and bytes that are not UTF-8 survive. A file that is UTF-16 or binary is left alone and reported.
- **Changed in place.** The file is opened and rewritten, not replaced by a new file, so its owner, ACL, mode, hard links and extended attributes stay. (A new file renamed over it takes the folder's inherited ACL, which on Windows can leave `~/.ssh/config` unreadable for `ssh`, and drops POSIX ACLs and attributes.) The file is read again just before the write and the change is made again if another program changed it meanwhile, up to three times.
- **Files Mousse refuses to write.** One that is not writable by this account (read-only, a mode of `0444`), or on macOS and Linux owned by another account (root, a configuration manager). Mousse changes nothing and the message gives the exact line to add by hand. On Windows the owner is not checked; a file whose ACL does not let this account write fails to open, with the same result.
- **Symbolic links.** If `~/.ssh/config` is a link (common with dotfile managers), the file it leads to is written and the link stays. A link to a missing file creates that file. A link whose folder is missing is reported, not repaired.
- **A missing `~/.ssh`** is created (mode `0700` where that applies) when the file has to be created.

## Never breaking ssh

A file read through `Include` is checked by `ssh` itself, and a failure is fatal for the whole command. Win32-OpenSSH refuses an included file when an account other than the user, SYSTEM or Administrators has a **write-capable** entry on it (`Bad permissions. Try removing permissions for user: …`, exit 255), whatever host was asked for. Read-only entries for `Everyone`, `Users` and `Authenticated Users` are tolerated; `Modify` for any of them is not. Where the Mousse home carries an inherited entry for another account (a sandbox or service group is enough), a file made there would have broken every `ssh`, including `git push`.

Mousse prevents that in four steps:

1. **A private folder.** Before any file is written into `<Mousse home>/ssh`, the folder gets mode `0700` (macOS, Linux) or, on Windows, `icacls /inheritance:r` with full control for the current user, SYSTEM and Administrators only. Every file made in it afterwards inherits exactly that. If this fails, Mousse stops and changes nothing, `~/.ssh/config` included.
2. **A check before the line goes in.** The system `ssh` reads a scratch config that holds only the `Include` line (spelled with an absolute path) plus a dummy host, for an unrelated host name and for one alias (`ssh -F <scratch> -G <host>`). `-F` permission-checks included files, so this catches a loose ACL, a parse error and an option an old client does not know. On Windows every `ssh` found is checked: the one in `System32\OpenSSH`, Git for Windows' and any other on `PATH`. If it fails, or there is no `ssh` at all, the line is not added and the answer says why (`ssh_check_failed`, `no_ssh`).
3. **A check after.** The same read runs on the real `~/.ssh/config` once the line is in. If it fails, the file is put back exactly as it was (or removed again if Mousse had created it) and the answer says so.
4. **At rest.** `status` repeats the read while the line is installed and reports `problem` if it fails. A sync that rewrites Mousse's file also reads it again and puts the old text back if the new one cannot be read.

Tests: the Windows ACL case (an extra `Modify` entry on the Mousse home and on the config itself, against Win32-OpenSSH) runs on Windows. The checks use a replaceable verifier so every failure path runs everywhere.

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

`~/…` is read by both, so it is the written form whenever it can be. When the Mousse home is on another drive or outside the home directory the absolute form is written, and Git for Windows' `ssh` will not follow it; the alias then does not exist for editors that use that client. Putting the Mousse home under the home directory avoids it. (The scratch check above uses the absolute spelling, which Git's `ssh` skips; the check on the real file uses the written spelling.)

## Questions from the plan

### Does Win32-OpenSSH support `Include`?

Yes, in the client. `Include` came to upstream OpenSSH in 7.3 ([release notes](https://www.openssh.com/txt/release-7.3)). Win32-OpenSSH had a bug where an absolute Windows path was resolved under `~/.ssh` ([issue 1511](https://github.com/PowerShell/Win32-OpenSSH/issues/1511), closed for 8.1, with a report in 2025 that it returned). On the version installed with Windows 11 here (9.5p2) a quoted absolute path with a drive letter, forward or backward slashes, was read, a drive-less path was not, and `~/…` was read.

It also checks the owner and ACL of every included file; see above. Not confirmed: whether the VS Code Remote-SSH extension reads included files through `ssh -G` or with its own parser. This is part of the matrix for the change that launches editors.

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

Local methods on the `net.v1` capability, for the clients on this computer only (a paired computer cannot call them). The window uses them for the notice under the editor button and for the Editors row in Settings, Devices. No CLI command uses them.

| Method | Does |
| --- | --- |
| `net.editor.ssh.status` | Reads the state, and reads the config with `ssh` while the line is installed. Writes nothing. Works while Net is off. |
| `net.editor.ssh.prepare` | First use: writes Mousse's files for the paired computers and adds the line if it was never added. Refused with `off` after an undo or a hand removal, with `scoped` when the line sits under a `Host` line. |
| `net.editor.ssh.enable` | Turns the feature on again after an undo, then does what `prepare` does. |
| `net.editor.ssh.disable` | Undo. Works while Net is off. |
| `net.editor.ssh.ack` | The notice was seen. |

While the feature is used and on, Mousse rewrites its own files at start and when the device list changes: a new computer gets an alias, a revoked one loses its alias and its pinned keys, a moved launcher is found. That sync never touches `~/.ssh/config`.

## Opening a remote thread's folder

The editor button of a thread that runs on another computer (VS Code, Cursor, Windsurf, VSCodium, VS Code Insiders) opens the thread's folder in the editor on this computer over Remote - SSH. The main process does it (`src/main/remoteEditorFlow.ts`, `remoteEditor.ts`, `editors.ts`).

- **Which SSH name.** The SSH address this computer approved for that computer (`net/ssh/approvals.json`, read with `net.ssh.target`) is used as it is. One of Mousse's own names (`Host mousse-…` above) is used only once `mousse-cli net ssh-proxy` exists: `EDITOR_PROXY_READY` in `src/shared/remoteEditor.ts` is `false` until then, so `net.editor.ssh.prepare` is not called and nothing adds the `Include` line.
- **Host key of an approved address.** The key Mousse verified at approval is pinned in the profile's own known-hosts file. The editor's `ssh` reads the user's `~/.ssh/known_hosts`, so the first connection may ask to trust the key. Mousse's own names carry a pinned key and strict checking (above); approved addresses move to such a name when the proxy change lands.
- **No SSH to that computer.** The button stays and the note under it says what to do: approve the address the computer offers (button `Approve address…`), or open Settings, Devices at that computer (`Set up…` or `Open Devices…`). A Mac or Windows computer is told that Mousse sets SSH up on Linux computers only and that it needs an SSH server of its own.
- **Which folder.** The computer that runs the thread answers the routed `editor.folder`. A removed worktree (`workspace_not_ready`, state `missing`) is restored with the routed `workspace.restore` and the folder is asked for again once. This computer works `uriPath` out again from `path` and refuses the answer when they differ.
- **The command.** An argument array, `<editor command> --folder-uri vscode-remote://ssh-remote+<name><path>`, with each path segment percent-encoded. A host that is not `[user@]host[:port]` or a Mousse name is refused. Nothing goes through a shell, a `.cmd` or `.bat` launcher is refused on Windows, and the editor starts without `VSCODE_*`, `ELECTRON_*` and `NODE_OPTIONS` of Mousse's own environment, which would send the open to another window or run the command as plain Node. On macOS the script is `Contents/Resources/app/bin/` plus the editor's command name, then `code`, then the command on `PATH`.
- **Remote - SSH extension.** Never a reason to refuse. If it is not in the editor's own folder (`~/.vscode/extensions` and so on) nor among the extensions inside the app (`resources/app/extensions`, where Windsurf and Antigravity ship it), the editor still opens and a hint names the extension.
- **File manager.** It is not offered for a remote thread, since it would open this computer's own disk.
- **Settings.** Settings, Devices shows the Editors group only while the `Include` line is installed or its notice is pending. Undo removes the line and is final until editor connections exist; nothing in Settings adds the line before then.
- **Not tested.** A real editor against a real SSH server (a path with a space and `#`), the case of a Windows drive letter in `/C:/…` against `/c:/…`, `Code.exe --folder-uri` started directly on Windows, the bundled script name of VS Code Insiders on macOS (`bin/code` and `bin/code-insiders` are both tried; the public docs name only the `code-insiders` command), Cursor's `--folder-uri` when Cursor is already running (a forum report says it only focuses the window), and a mapped drive letter on a Windows computer.
