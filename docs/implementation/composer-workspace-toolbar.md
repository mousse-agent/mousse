# Blank chat workspace toolbar

I extracted the project and worktree toolbar from teammate PR #41 (`9e9136d`), retaining its themed floating project picker, No project and Open project choices, device label, branch toggle, keyboard navigation, and responsive layout. I apply it to the initial composer and unstarted project drafts; it disappears after the first prompt starts the chat.

I persist workspace choices with each draft in its profile-local workspace state. A worktree requires a selected project and uses the existing thread worktree opt-in API. The first send waits for creation or a draft's worktree update. Changing projects creates a new hidden draft instead of relocating an existing thread's transcript. I transfer staged text, browser attachments, files, and voice notes before selection/model calls so a service failure keeps the prompt recoverable.

I preserve the current default branch's structured send errors and microphone handling. I check the active profile and thread before applying a returned model update, and I prevent workspace preparation from starting after navigation. The toolbar adds no backend, rich-reference, agent-chat, or Linux-window behavior.

The focused checks are `tests/createComposerThread.test.ts`, `tests/threadWorktreeToggle.test.ts`, and `scripts/check-composer-workspace.mjs`. The Chromium fixture covers project/worktree selection, draft changes, keyboard and outside-click dismissal, pending navigation, creation/selection/model failure recovery, structured send rejection, profile-local persistence, and narrow layouts. Its platform flags exercise the shared renderer; native platform behavior remains outside this fixture. I made its SVG resolution and screenshot output use native filesystem paths on Windows.
