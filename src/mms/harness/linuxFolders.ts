/**
 * The top folders of a Linux system that hold its own programs, libraries, settings and kernel views, which commands
 * need to run. Every other top folder (`/home`, `/mnt`, `/media`, `/opt`, `/srv`, `/var`, `/root`, `/run`, …) is
 * unreadable to a bot's commands, as Codex's `:minimal` profile keeps them. `/run` holds removable
 * drives (`/run/media/<user>`) and each signed-in user's runtime folder (`/run/user/<uid>`: network mounts, sign-in
 * sockets); commands need nothing there but NixOS's programs (`LINUX_RUN_KEPT_OPEN`).
 *
 * `/tmp` stays readable, not writable (it is denied with the other temporary folders): Claude Code's sandbox keeps its
 * own sockets there. Mousse still keeps some folders of its own there, each private to this user (mode 700), which a
 * bot's command can read since it runs as the same user: the ChatGPT token broker's socket folder (its socket can't be
 * used: the sandbox refuses every connect to a Unix socket), and for the seconds a task runs, `mousse-pr-*` (the title
 * and text of a pull request the owner opens), `mousse-pathspec-*` (the paths of files the owner stages or discards),
 * `mousse-trace-*` (Git's trace of the hooks of the owner's commit or push) and `mousse-acp-*` (the working folder of an
 * ACP agent's check). docs/bots.md lists them under what remains.
 *
 * Shared by every sandbox that locks a bot's commands to them (Claude Code's, and a bot's secret commands), so it
 * lives outside any one vendor's code.
 */
export const LINUX_SYSTEM_FOLDERS: readonly string[] = ['/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/usr', '/etc', '/proc', '/dev', '/sys', '/tmp', '/nix']

/**
 * What stays readable under the closed `/run` when it exists: on NixOS the system's programs are on the PATH through
 * `/run/current-system/sw/bin`, and the setuid wrappers (`sudo`, `ping`, …) through `/run/wrappers`, both leading into
 * `/nix`, which is open. Without them no command finds its programs there. Nothing else under `/run` is opened.
 */
export const LINUX_RUN_KEPT_OPEN: readonly string[] = ['/run/current-system/sw/bin', '/run/wrappers']
