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
- **Provider:** the agent backend a thread uses, such as Claude or Codex. Each provider has an adapter that translates its protocol.
- **Provider instance:** one configured provider a profile can pick, with a stable id such as `claude`, `codex` or `pi:openai`. Every caller chooses an agent by instance id and model.
- **Agent:** a model working in a thread, including any subagents it starts.
- **Workflow:** a published sequence of steps that can run from the canvas, chat, CLI, channels, or schedules.
- **Channel:** an outside chat connection, such as Telegram, Discord, or a webhook, that sends messages to Mousse and gets replies.
- **Mousse Net:** networking between Mousse installations. It covers Bridge and Spaces.
- **Bridge:** one person controlling agents on several of their own machines from one place.
- **Space:** a group chat for a project. Members add their own bots, which run on the owner's machine with the owner's keys.
- **Mousse ID:** the optional account service. Signing in lets a person reach their computers from a phone and relays connections without seeing their content. It was called Mousse Plus; code and wire names such as `net.plus.*` and `plus-relay` keep the old name. There are no paid plans. The hosted service is maintained separately; this repository holds only its MIT client in `src/mms/net/plus/`, which core Net reaches through `src/mms/net/hosted.ts`. Builds without `MOUSSE_ID_ORIGIN` show no Mousse ID UI.
- **Leaf node:** a device, such as a phone, that joins a user's devices but cannot invite or revoke others.
- **Nightly:** a prerelease build of `master`, published once a day when there are new commits and every check passes, with a version such as `0.1.2-nightly.20261022.17`. See `docs/releases.md`.
- **Contract version:** the version of a protocol, saved format or schema that other builds rely on, such as the daemon protocol or the Run Engine database. Bumped only on incompatible changes; listed in `src/mms/contractVersions.ts`.
- **Primary checkout:** the first entry in `git worktree list`, normally the copy the user runs and reads.
