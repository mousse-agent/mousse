# Blank chat workspace toolbar

I extracted the project and worktree toolbar from teammate PR #41 (`9e9136d`), retaining its themed floating project picker, No project and Open project choices, device label, branch toggle, keyboard navigation, and responsive layout. I apply it to the initial composer and unstarted project drafts; it disappears after the first prompt starts the chat.

I persist workspace choices with each draft in its profile-local workspace state. A worktree requires a selected project and uses the existing thread worktree opt-in API. The first send waits for creation or a draft's worktree update. Changing projects creates a new hidden draft instead of relocating an existing thread's transcript. I transfer staged text, rich references, browser attachments, files, and voice notes before selection/model calls so a service failure keeps the prompt recoverable.

I preserve the current default branch's structured send errors and microphone handling. I check the active profile and thread before applying a returned model update, and I prevent workspace preparation from starting after navigation. I integrate rich-reference attachments alongside the toolbar while keeping agent DM and Group creation separate. I retain its existing worktree protocol and portable Chromium fixture.

The focused checks are `tests/createComposerThread.test.ts`, `tests/threadWorktreeToggle.test.ts`, and `scripts/check-composer-workspace.mjs`. The Chromium fixture covers project/worktree selection, draft changes, keyboard and outside-click dismissal, pending navigation, creation/selection/model failure recovery, structured send rejection, rich-reference resolution/transfer/recovery, project-path loading, profile-local persistence, and narrow layouts. Its platform flags exercise the shared renderer; native platform behavior remains outside this fixture. I made its SVG resolution and screenshot output use native filesystem paths on Windows.

I keep unresolved project-path lookups separate from confirmed standalone threads, so switching project threads preserves the Files or Git view. Project pills and project-context file links resolve the referenced project’s own draft instead of falling back to the previously active project, and I cancel their renderer updates after navigation or profile changes.

## Run on another computer

With no other computer connected, the computer item is plain text naming this computer (`appInfo.deviceName`, else "This computer"): there is no button, no menu and no hint. Once at least one other computer is connected (`bridge.nodes`; phones and a device from a daemon that predates `kind` handled as below), it becomes a button that opens a "Run on" menu: this computer first, then each connected computer. Phones are left out, and a device with no `kind` counts as a computer. The thread side card's menu uses the same rows (`sideCard/deviceMenu.ts`) and shows its Run on group under the same rule; only a new, empty thread can pick, and a started thread just names the computer it runs on. A draft that already names a computer keeps the menu, so a computer that dropped offline can be left.

The pick is `ComposerWorkspace.node` in the draft, saved with the other workspace choices. While a remote computer is picked:

- The project picker lists that computer's projects (`bridge.hub.projects`). Picking a computer carries the draft's project over only when both are Git repositories with the same history: the local daemon reads the project's root commits and normalized remotes (`projects.identity`), and `bridge.hub.matchProject` asks the target which of its projects shares a root commit, preferring the one that shares a remote. Nothing about a path is sent, and a folder that is not a repository, no match, or an ambiguous match gives No project (the worktree choice is cleared). The draft remembers its project from this computer (`localProjectId`), so picking this computer again restores it, and a move from one computer to another matches from that remembered project. Picking a different project on the other computer drops the remembered one.
- "Open project…" asks for a folder path on that computer, suggests its project paths, and calls `bridge.hub.openProject`. The computer's refusal ("That folder does not exist on this computer.") shows in the dialog.
- The model picker lists that computer's models (`bridge.hub.composerOptions`) and starts at its default; the pick is stamped on the new thread with `bridge.hub.setModel`.
- The worktree toggle is sent as `options.worktreeEnabled`.
- The first send (`startRemoteComposerThread`) creates the thread, sets the model, opens it in the remote thread view with `openRemoteThread` (which attaches to its display), and sends the message through `submitRemoteMessage`, which stages images and keeps the run for Stop. If the computer is no longer connected at send time, nothing is created: the draft returns to this computer and the composer shows "<name> is not connected".

Quick actions and file context always use this computer's workspace, so they ignore a remote draft (`localWorkspaceFor`).

The Chromium check also covers the static label, the Run on menu, the project carry-over and its return, Open project on another computer, and the first send (`scripts/check-composer-workspace.mjs`).
