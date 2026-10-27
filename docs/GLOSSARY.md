# Glossary

Use these terms in issues, PRs, comments, and docs. If you need a term that is not here, explain it the first time it appears or use plain words instead. Add a term only when people will keep using it.

- **Daemon (MMS):** the background process (`mousse-cli service run`) that runs the Mousse Main Service. It owns agents, queues, the scheduler, and channels, and keeps running when clients quit.
- **Client:** the Electron GUI or the CLI. Clients talk to the daemon over a local socket and never run agents themselves.
- **Profile:** one person's threads, projects, schedules, channels, and settings inside an installation. Provider credentials and the model catalog are shared by all profiles.
- **Project:** a workspace directory registered in a profile.
- **Thread:** a conversation and its work history. A thread that changes a Git repository gets its own branch and worktree.
- **Turn:** one user message and the agent work it starts.
- **Run:** the saved record of a turn in the Run Engine, with its own ID. Stop, Steer, and Undo act on a run.
- **Steer:** a message sent to a turn that is still running, to change its direction.
- **Stop:** ends what a thread is doing and everything its subagents are doing, at every depth. The Stop button, the CLI, a channel's `/stop`, Lineage's Stop and Stop all, `task_cancel`, deleting a thread and settling it are all the same Stop. A subagent's result that is already waiting to be read is kept.
- **Provider:** the agent backend a thread uses, such as Claude or Codex. Each provider has an adapter that translates its protocol.
- **Provider instance:** one configured provider a profile can pick, with a stable id such as `claude`, `codex` or `pi:openai`. Every caller chooses an agent by instance id and model.
- **Agent:** a model working in a thread, including any subagents it starts.
- **Subagent:** a thread the main thread of a conversation starts to do part of its work. It has its own thread and history, runs with its own model and workspace, and reports its result back to the thread that started it (its parent).
- **Lineage:** the section of the thread side card that lists the subagents a thread started, with their status and model. A subagent does not appear in thread lists (the sidebar, search, the CLI, channels); the desktop app shows it under its parent, and a parent row shows what its subagents are doing.
- **Subagent card:** the entry in a thread's conversation for one task it gave a subagent. It shows the subagent's name, state, model and last result, stays after the task ends, and opens the subagent's thread. A call that failed or started nothing keeps its ordinary tool row.
- **Delegation:** one task handed to a subagent, with its own ID and result. Giving the same subagent a second task is a second delegation on the same thread. A delegation ends as done, failed, stopped or interrupted, and that outcome does not change once the result is read. While the subagent is still waiting on its own subagents or on a delivery, the delegation is waiting on subagents and has no result yet; it ends once the subagent has nothing left to wait for.
- **Subagent title:** the short name a thread gives a subagent when it starts it, such as "API reviewer". It is unique among that thread's subagents and is how the thread later continues, reads or cancels that subagent.
- **Continue (a subagent):** send a follow-up to a subagent that already exists, by its title. It carries on in the same thread with what it already read, as a new delegation, instead of a new subagent starting from nothing. A message a person types in a subagent's thread is also a follow-up, and its parent hears the result.
- **Background work:** agents and shells a provider started that keep running after the turn that started them ended. Claude keeps one live process per thread so they survive. While a thread has background work it shows Waiting, and a subagent's task waits too.
- **Continuation run:** a run of a thread that records a turn the provider started on its own, because background work finished and the provider wants to read the report. It opens with a short note and ends at the provider's result.
- **Workflow:** a published sequence of steps that can run from the canvas, chat, CLI, channels, or schedules.
- **Channel:** an outside chat connection, such as Telegram, Discord, or a webhook, that sends messages to Mousse and gets replies.
- **Mousse Net:** networking between Mousse installations. It covers Bridge and Spaces.
- **Bridge:** one person controlling agents on several of their own machines from one place.
- **Remote thread:** a thread that runs on another of the user's computers through Bridge; the local app shows it but the target computer owns it.
- **Space:** a group chat for a project. Members add their own bots, which run on the owner's machine with the owner's keys.
- **Mousse ID:** the optional account service. Signing in lets a person reach their computers from a phone and relays connections without seeing their content. It was called Mousse Plus; code and wire names such as `net.plus.*` and `plus-relay` keep the old name. There are no paid plans. The hosted service is maintained separately; this repository holds only its MIT client in `src/mms/net/plus/`, which core Net reaches through `src/mms/net/hosted.ts`. Builds without `MOUSSE_ID_ORIGIN` show no Mousse ID UI.
- **Leaf node:** a device, such as a phone, that joins a user's devices but cannot invite or revoke others.
- **Nightly:** a prerelease build of `master`, published once a day when there are new commits and every check passes, with a version such as `0.1.2-nightly.20261022.17`. See `docs/releases.md`.
- **Contract version:** the version of a protocol, saved format or schema that other builds rely on, such as the daemon protocol or the Run Engine database. Bumped only on incompatible changes; listed in `src/mms/contractVersions.ts`.
- **Primary checkout:** the first entry in `git worktree list`, normally the copy the user runs and reads.
