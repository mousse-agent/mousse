# Agent Chats

I added Projects and Chats as renderer modes. Search and New chat sit below the mode toggle, at opposite ends. Projects retains ordinary project threads, loose RECENTS and archives. Chats has a roster of published agents, named groups, and recent agent DMs. I used the [official Grok Bot chat guide](https://docs.x.ai/grok-bot/chat-and-collaboration) as a reference for agent DMs, group conversations and explicit @mention handoffs.

## Conversation ownership

`AgentChatService` owns each conversation in the admitted daemon profile. Its backing thread owns the workspace, runtime and execution lease. Only Groups can have an optional project association; Agent DMs use a scratch workspace. A Group project association provisions one existing task worktree; all agents, terminals and file operations use that same verified root. Unassociated chats use profile-owned scratch workspaces. Conversations, participant identities, pinned published revisions, messages and admission receipts persist in bounded atomic records. Renderer drafts and cursor presence are transient.

I route explicit @slugs only to group members. Unmentioned user messages start with the first agent; agents can hand off by mentioning another member. I preserve speaker identity and history in actual provider context, deduplicate response targets, and stop circular handoffs after at most eight distinct agent responses. A user can send another message to continue. Cancellation retains ownership until the provider settles; interrupted runs recover visibly after restart.

The current implementation admits published native Mousse agents, with thread or disabled memory. Unsupported external CLI runtimes remain visible but unavailable rather than executing through an unrelated runtime. Groups allow up to sixteen agents. The current user is a person participant with identity `self`; the domain reserves person identities for future Mousse Plus, while the current admission/UI creates agent-only groups plus the owner.

## Device scope

I keep execution on the current computer, following the explicit decision to defer other devices. Snapshots expose its hostname/platform and a local executor identity. Participant/device contracts allow future transports, but nonlocal assignment is rejected. No remote connectivity or pretend online inventory is added.

## Shared tools

`ChatResourceService` mediates one group-owned managed browser, real shared PTYs, revisioned text files and transient presence across GUI clients. Client and participant authority comes from daemon connection admission, not renderer parameters. Presence carries bounded coordinates or file selections, expires after disconnect/inactivity, and cannot grant filesystem authority.

The dedicated chat browser runtime validates the exact live agent execution, definition revision and backing thread before adapting it to the group's managed-session scope. It shares the same page with viewers while retaining grants, cancellation and human takeover fencing. Browser control leases stay inside the trusted host. GUI browser permission requests and exact agent tool approvals hydrate in the conversation UI after reload or chat switches.

Terminals retain the existing thread writer lease for their entire lifetime. An open terminal therefore blocks agent admission and file writes to that workspace until it closes; I preserve that ownership constraint. Multiple viewers share one PTY's output and an exclusive input controller. Files compare SHA-256 revisions while holding the same writer lease. Stale saves return current content and preserve the editor's unsaved draft. This is explicit conflict resolution, not a CRDT merge. Monaco displays other clients' cursor selections for the matching file revision; browser cursors account for screenshot crop and image scale. Shared surface state stays mounted when switching tool tabs.

Root AGENTS.md is appended to system prompts on each execution in ordinary and trusted agent-definition paths. Existing MOUSSE.md behavior and the agent's explicit project-instructions setting remain in force.

## Verification

I used focused chat service, resource service/adapter/browser runtime and framed daemon composition tests. These exercise real provider context with deterministic provider I/O, project worktrees, filesystem writes, real PTY ownership, group routing, approvals, profile isolation, stale save conflicts, two-client presence, browser actions and control fencing. Chromium fixtures mount the real App and Chats UI, including xterm and browser screenshots; Monaco uses an editor API harness for deterministic cursor/selection assertions. The navigation fixture covers collapsed rail/preview hover and RECENTS under three platform settings. I also ran affected native-agent production regressions and TypeScript checks. I did not run the full test suite.

I keep this work as local micro-commits without pushing, as instructed for this session.
