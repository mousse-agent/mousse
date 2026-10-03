# Gated Chats integration candidate

I combined the frozen PR #47 head `71780b2d8048b5ef034e0589d9cd9a73a65a6ffd` with the Net checkpoint `e9487e9be0b01d1a5ebc0022c63844e1fc2288ec` in a separate issue #44 worktree. I preserved both source histories and the existing Chats UI. This candidate does not merge #47, change remote master, or satisfy PLAN P7/P8's merged-backend prerequisite. Authentication changes still require the teammate review recorded on #47.

I retained profile-owned Net composition, the trusted Native adapter factory, Net and Chats domain registrations, and both Net and Antigravity cleanup owners. I reconciled frozen package dependencies and verified installation in this candidate's own node_modules.

I passed both source TypeScript configurations and lint on the two conflicted composition files. I ran focused Chats service, Chats resource protocol, profile-store injection and real Net Space profile checks. The initial macOS run exposed noncanonical /var fixture roots in Chats service and profile-store injection tests. I preserved strict production path guards and canonicalized only those two fixtures; all 34 affected tests passed on rerun. The unchanged resource protocol and real Net profile checks had already passed. I did not run a full suite, GUI visual qualification, paid provider qualification or a default-branch merge.

Publication and network dispatch are not implemented in this source-integration checkpoint. Their adopted contract is docs/net/chats-binding.md; local chats still use their existing execution behavior.
