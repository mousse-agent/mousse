# Teams architecture

Planning document, not an implementation. Status: draft for the founders' review.

> **First build (11 November 2026).** A review against `master` at `1a23d270a` set the first slice and its decisions. They are recorded in [#866](https://github.com/mousse-agent/mousse/issues/866):
>
> - A team computer starts as one shared OS account, and its providers are for everyone.
> - Access follows the Teams UI model: a person is in a thread or not.
> - "Private" is not used, because it already means a thread that stays on this computer (`localOnly`).
> - A 7-day join link on Mousse ID points to a 24-hour Space invite bound to the person joining.
>
> Where this plan differs, #866 wins for the first build.


- **Baseline:** `origin/master` at `e2015a41` (4 November 2026), read in a detached worktree. The primary checkout was 41 commits behind.
- **Topic:** how Teams works under the hood.
- **Sibling plans:** [Bot UI](bot-ui.md), [Bot Architecture](bot-architecture.md) and [Teams UI](teams-ui.md). Section 9 lists what this plan needs from each and what it promises them.

Terms follow [the glossary](../GLOSSARY.md). Section 4 proposes the new terms.

---

## 1. Summary

A **team** owns one or more Linux machines. Every person on the team, every shared project and every team bot gets its own operating-system account on those machines. Each account runs an ordinary, unchanged single-user Mousse daemon. The OS account is the isolation boundary, which is what the founders meant by "Linux multi-user is how others isolate".

The pieces map onto what Mousse already has:

- **The team's identity** is an ordinary Mousse Net user whose signing authority lives in a service account on the team machine. That account never runs agents. The machines and the project and bot accounts are the team user's devices. Unlike a person's devices, they **do not trust each other by default**.
- **Membership** is a Space of a new kind, `team`. The team's people are its members, with the roles, invites and removal Spaces already have.
- **Personal threads** stay in the member's own account. They are private by default, can be shared read-only, and can be handed off by copying. Nobody else's prompt ever runs in them.
- **Live shared threads** run in a **project account**, on that account's own provider sign-ins (the "common AI subscriptions"). Teammates reach them through the remote-thread view Bridge already gives. That view is extended from "same person" to "member of this team with access to this project", using a deny-by-default list of allowed methods.
- **Messages from several people** are attributed to each person by the daemon and queue in the Run Engine's existing order. Presence and typing ride on the thread's stream.
- **Credentials and project profiles** (Supabase, Vercel, GitHub, MCP servers, skills) live in the project account and reach agents through the Mousse MCP and its relay. They never reach members' laptops.
- **Invited people** get the nightly channel through their invite link. Team machines update themselves.

Everything above is MIT core and runs self-hosted without Mousse ID. Mousse ID adds email invites, relaying and phones. Mousse+ is where hosted models, the extension and MCP catalog, and the setup-wizard agent would sit.

Top decisions are listed in §12.

---

## 2. Inputs: what the founders said

Settled decisions are quoted verbatim and bind this plan. Ideas are treated as strong intent.

| # | Source | Quote | How this plan treats it |
|---|---|---|---|
| D1 | Meeting 1, decisions | "Grouping subscriptions will be a plugin, not a main feature" | Binding. §6.10 keeps grouping out of core and defines the plugin seam. |
| D2 | Meeting 1, decisions | "Product focus is Teams (along with Moose+)" | Binding. Teams is the main product line; the Mousse+ boundary is in §6.13. |
| D3 | Meeting 2, decisions | "Users will not construct workflow nodes; workflows are built by the bot" | Binding on the bot plans. Teams only shares bots and their workflows (§6.9). |
| D4 | Meeting 2, decisions | "Bot model is auto-selected by default, changed by asking the bot rather than a slash command" | Binding on the bot plans. Teams supplies the list of subscriptions the bot picks from (§6.10). |
| M1 | Meeting 1 | "T3 code is single user, multiple boxes; Mac ties users to desktop sessions, so Linux multi-user is how others isolate" | Linux OS accounts are the isolation unit (§6.3–6.4). A Mac gets a labelled shared-login mode. |
| M2 | Meeting 1 | "A team, not a person, should own machines; members access team machines without seeing all team threads" | The team user owns the machines (§6.2). Threads are private by default (§6.5). |
| M3 | Meeting 1 | "Immediate need: shared environment reusing common AI subscriptions and CLI proxy, with easy sharing of threads and bots" | Defines the MVP (§7, P1). |
| M4 | Meeting 1 | "hand off threads to humans like agent context handoff, show human avatars and typing indicators; simultaneous messages are queued" | §6.6–6.8. |
| M5 | Meeting 1 | "layer 2 Moose MCP, installed in all Claude CLIs at setup, to unify credentials and run other MCPs … project profiles (e.g. DinoMoney) bundling Supabase, Vercel and GitHub access; skills sharing could work similarly" | §6.11. |
| M6 | Meeting 1 | "Releases only appear after manual builds; need automatic nightly builds, with stable releases still manual … Invited users otherwise won't see the latest version" | §6.12. Nightlies already exist; the gaps are invites and headless machines. |
| M7 | Meeting 1 | "Bots need isolation, possibly Docker VMs, to manage multiple GitHub accounts safely" and "Automated code review could be a scheduled Moose task with its own GitHub account" | One OS account per bot now, Docker later (§6.9). |
| M8 | Meeting 1 | "Enterprises would self-host open source, so revenue may come from models, extensions, MCPs" and "a paid Moose setup wizard agent" | §6.13. |
| M9 | Meeting 1 | "T3 code likely can't pivot to Teams without alienating its non-team user base" | §6.14. |
| M10 | Meeting 2 | "plan to make remote setup easy via Moose CLI over SSH, whole server as sandbox … Docker per bot considered later" | The team machine is set up over SSH (§6.3). The server is the sandbox; Docker comes in P4. |
| M11 | Meeting 1 | "Companies increasingly give people a $200 or $400 budget to bring their own subscriptions" | Bring-your-own subscription is the default for personal work (§6.10). |
| M12 | Meeting 1, next steps | "Verify whether Claude CLI is failing to detect MCPs as suspected" | A P0 task, with findings from the code (§6.11.1). |

A later product decision is recorded in the user's notes (20 October) and in the glossary entry for Mousse ID: "There are no paid plans". This plan keeps monetization off and only draws the boundary where Mousse+ would go.

---

## 3. Goals and non-goals

### Goals

- **G1. A team owns machines (M2).** A team has an identity that is not any one person, and machines enrolled to it. An admin who leaves takes no machine with them.
- **G2. Isolation on a shared machine (M1, M2).** On a team Linux machine, a member cannot read another member's threads, files, provider sign-ins or MCP tokens, either through Mousse or through an agent's shell. A bot cannot reach another bot's or project's credentials. This protects against curious teammates and prompt-injected agents, not against admins, who have root.
- **G3. Private by default, shared on purpose (M2, M3).** A member sees only their own threads, the shared threads of projects they belong to, and threads explicitly shared with them.
- **G4. A shared environment on common subscriptions (M3).** Teammates work in shared threads and use shared bots that run on provider sign-ins owned by the team, without anyone handing out tokens.
- **G5. Collaboration in a thread (M4).** Every human message is attributed to a person. Simultaneous messages queue in one defined order. Presence and typing show who is there. A thread can be handed to a person.
- **G6. Project profiles and credentials (M5).** A project carries its Supabase, Vercel and GitHub access, MCP servers and skills as one bundle. Agents use it through the Mousse MCP, and the raw secrets never reach members' laptops.
- **G7. Bots with their own accounts (M7).** A team bot, such as a code reviewer with its own GitHub account, runs in its own OS account, apart from members and from other bots.
- **G8. Invited people stay current (M6).** Someone invited to a team installs the nightly from the invite link and keeps receiving nightlies. Team machines update themselves. Stable releases stay manual.
- **G9. A self-hostable core (M8).** Teams works fully with the MIT code and a direct, Tailscale, SSH or self-hosted relay link. Mousse ID is a convenience.
- **G10. Subscription grouping stays a plugin (D1).** Core exposes a seam for it and contains no grouping logic.

### Non-goals

- **Protecting members from the team's admins.** Admins have root on team machines. The plan says so plainly instead of offering an "admin cannot read" switch it cannot enforce.
- **Hosting mutually untrusted strangers on one machine.** That needs containers or VMs (P4 and beyond). OS accounts are enough for a team.
- **macOS or Windows as a team machine with several members.** A Mac can be a member's computer, or a team machine in a labelled shared-login mode (§6.3.4).
- **Live collaboration inside a member's personal daemon.** Another person's prompt never runs as someone else's OS user (§10, Fable round 1, point 5).
- **Pooling personal Claude or ChatGPT plans across people in core (D1).** That belongs to the grouping plugin, which carries the provider-terms warning.
- **A web client, SSO and Docker per bot in the MVP.** Each comes in a later phase.
- **Terminals and editor connections to shared threads in the MVP.** These come in P2, for maintainers only (§6.5.3).
- **The UI itself.** Screens belong to the [Teams UI](teams-ui.md) plan. This plan defines the data and events those screens read.
- **Bot runtime internals.** Model selection, permissions growth, triggers and the timeline belong to [Bot Architecture](bot-architecture.md). This plan provides where team bots run and who may talk to them.
- **Paid plans.** Monetization stays off.

---

## 4. New terms (proposed glossary entries)

Each term is added to `docs/GLOSSARY.md` in the PR that introduces it.

- **Team:** a group of people who share machines, projects and bots in Mousse. A team has its own identity (the team user), and its membership is a team Space.
- **Team user:** the Mousse Net user that stands for a team. Its signing key lives in the team service account on a team machine, and its devices are the team's accounts. No person signs in as it.
- **Team Space:** the Space, of kind `team`, that holds a team's members and their roles, the team's machines and accounts, its projects and its policies.
- **Team machine:** a Linux computer enrolled to a team user. Members, projects and bots each get an OS account on it.
- **Team service account:** the OS account `mt-team` on a team machine. It holds the team user's key and hosts the team Space, and never runs an agent.
- **Member account:** the OS account (`mt-<handle>`) a member has on a team machine. It runs that member's own Mousse, on their identity and their own subscriptions.
- **Project account:** the OS account (`mt-p-<slug>`) that holds one or more team projects: their shared threads, credentials and provider sign-ins.
- **Bot account:** the OS account (`mt-b-<slug>`) that runs one team bot with that bot's own credentials, such as its own GitHub account.
- **Shared thread:** a thread that runs in a project account. Every member of the project with access can open it, and its collaborators can send to it.
- **Viewer grant:** permission for one person to read one of another person's personal threads.
- **Handoff:** giving a thread to another person or to a project. They get a copy of the history and the files and continue it on their own account. The original stays as a read-only record.
- **Driver:** the person a shared thread's running turn is for. Shown with their avatar.
- **Team channel:** the release channel (nightly or stable) that a team's invites and team machines follow.
- **Shared-login mode:** a Mac or Windows team machine where all projects run under one OS account, so everyone who uses its projects can read all of them.

---

## 5. Current state and the gap

All paths are in `origin/master` at `e2015a41`.

| Area | What exists | Gap for Teams |
|---|---|---|
| Local trust boundary | One daemon per OS user. The socket is 0600 and needs the owner token (`src/mms/protocol/server.ts:207`, `src/mms/ownership/MmsOwnerLease.ts:257`). Profiles share one daemon and the installation-wide `auth.json` (`src/mms/profiles/ProfileHost.ts:39`). The docs already say "using separate operating-system accounts remains the boundary for mutually untrusted users" (`docs/agents-workflows-profiles-browser-architecture.md:31`). | Already the right boundary. Nothing creates or manages OS accounts. |
| Identity | Ed25519 user root on one authority node; a signed roster of node delegations with capabilities `read/chat/write/terminal/settings` (`src/shared/net/identity.ts:31-69`, `src/shared/net/capabilities.ts`); authority transfer and recovery (`src/mms/net/enrollment/authorityTransfer.ts`). | No team or organization entity anywhere (`rg -i '\bteams?\b'` over `src/` matches only vendor variables). A machine can only belong to a person. |
| Same-person rule | Bridge refuses other people at `src/mms/net/sync/rpcDispatcher.ts:358`, `src/mms/bridge/hub/service.ts:248,1155`, `src/mms/bridge/artifacts.ts:231,415`, `src/mms/net/sync/nodeAuthority.ts:78` and `src/mms/net/NetService.ts:1836`. | Teammates cannot open a thread on a machine they do not own. Conversely, all of one user's nodes trust each other fully, which is wrong for a team's accounts. |
| Per-device policy and audit | `net_node_policy` holds block, highest permission mode, terminal and editor switches (`src/mms/net/store/nodePolicy.ts`). Bridge has an audit (`src/mms/net/store/audit.ts`). The routed method table is deny-by-default with a capability on each row (`src/shared/bridge/routed.ts:140`). | Policy is per device, never per person or per thread. |
| Spaces | Host-ordered signed streams; roles owner, admin and member; signed invites with role, uses and `joiner`; removal; sealed private streams with key rotation; archive and host move (`src/mms/spaces/host/meta.ts:787-1060`, `src/mms/spaces/host/invite.ts:19`, `src/mms/spaces/private/service.ts:150`). `space.thread` streams bound to bot executions (`net_space_thread_bindings` in `src/mms/spaces/host/service.ts`). Feature flag `netSpaces:false`. | A Space has a single owner that cannot change, and no notion of machines, accounts or projects. Spaces ship turned off. |
| Mousse ID | An account bound to one user root, with node registrations of kind `phone` or `computer` (`src/mms/net/plus/HostedProfileService.ts`, `src/mms/net/plus/MousseIdJoin.ts:26-80`). The relay admits other people's nodes only on Space routes (`HostedProfileService.ts:958-994`). | No teams, organizations or email invites. A team user has no account to bind to. |
| Thread attribution | `ChatMessage.role` names no person (`src/shared/types.ts:627`). `QueuedMessage.sentFrom` and `Thread.sentFrom` record a device only (`types.ts:881,1044`). `AnsweredBy` records `via` and `node` (`src/mms/run/ThreadApprovals.ts:46`). | Messages are not attributed to people. |
| Ordering | One active run per thread, a per-thread mutex, idempotent `clientRequestId` and `expectedSequence` (`src/mms/run/RunEngine.ts:481`). A durable FIFO queue with steer, promote and `queueRevision` (`src/mms/queue/ThreadMessageQueue.ts:123,432,484`). | Order within a thread is already defined; only the author is missing. Nothing orders or prioritizes runs *across* threads that share one sign-in. |
| Realtime | A sequenced event ring with gap-free subscribe (`src/mms/protocol/server.ts:1097-1253`), filtered by profile and client type only. Remote thread streams (`src/mms/bridge/remote/ThreadStreamAdapter.ts`). Wire types for `presence.*` and `typing` (`src/shared/net/envelope.ts:295-301`). Only bot presence is implemented. | No human presence or typing, and no per-thread read filter. |
| Handoff | Context fork and merge-back between threads (`src/mms/run/handoff/Transfers.ts`; `thread_fork` and `thread_merge_back` in `src/mms/run/mcp/appTools/thread.ts:1150,1188`). | No handoff between people, or from a person to a project. |
| Bots | Personal bots are owner-only (`audience: 'owner'`, `src/shared/bots/personal/definition.ts:28`), with grants, a scratch folder per activation, and Claude's locked runtime with its own sandbox (`src/mms/harness/claude/locked.ts`). Space bots have no model path (`src/mms/bots/space/runtime/README.md`). | Bots cannot be shared, and two bots of one person share an OS account. |
| Providers and CLI agents | Instances with private homes and a closed environment (`src/mms/harness/env.ts:63-371`). Claude Code runs through the Agent SDK, not ACP (`src/mms/harness/drivers/claudeCode.ts:200`). Codex and Pi token brokers hand out access tokens only (`src/mms/harness/vendors/codex/broker.ts`, `src/mms/harness/pi/oauthBroker.ts`). Using a Claude subscription as a model API is refused (`src/mms/harness/pi/extension/guard.ts:26-82`). | No "CLI proxy" component exists, and nothing does team-owned sign-ins, per-person usage, quotas or priority. |
| Mousse MCP | A per-profile loopback server with per-turn tokens (`src/mms/run/mcp/MousseMcpServer.ts:56`, `McpCredentials.ts:117`). The relay exposes the user's MCP servers to every agent (#474). | Issue #358: the token is on Claude Code's command line, readable by other OS users. `${secret:}` references and MCP OAuth tokens are plaintext 0600 files (`src/mms/profiles/secrets.ts:14-60`). There are no project profiles. |
| Remote setup | The app installs `mousse-cli` on a Linux machine over SSH, in the user's `$HOME`, at the inviting computer's version, with linger and no sudo (`src/mms/net/ssh/plan.ts:53-133`). | One account per run. Nothing provisions accounts or updates headless installs. |
| Releases | A nightly at 20:47 UTC when `master` changed; stable by tag (`docs/releases.md`). The installed build follows its own channel (#571). macOS has no in-app updates. | Invites carry no channel, and headless machines never update. |
| Prior design | `docs/mousse-collaboration-plan.md` (22 September): rooms, principals, explicit request versus message, roles, durable sequences. | Its code anchors (`src/mms/channels`, `src/mms/control`) are gone, but its safety rules hold and §6.6 keeps them. |

---

## 6. Design

### 6.1 Principles

1. **One principal per thread's compute.** A thread's files, credentials and processes belong to exactly one OS account. Only that account runs turns, and only for people its policy admits. Another person's prompt never runs inside a member's personal account.
2. **The OS account is the isolation unit, at the Mousse layer too.**
   - Members, projects and bots each get an account. Anything that needs real separation gets its own account.
   - Accounts that belong to the same team user still refuse each other by default (§6.2.1). Otherwise "the team owns them" would quietly mean "every team process can drive every other".
   - Checks inside one account are convenience, not a boundary, because agents have a shell.
3. **The daemon stays single-user.** Every account runs today's daemon unchanged. Teams adds policy at the Net edge and a little data, never a daemon that serves several users.
4. **Reuse identity and Spaces.** The team is a Net user and its membership is a Space. Teams adds no third kind of principal and no new cryptography.
5. **Privileged steps are visible and rare.** Creating accounts takes the admin's own `sudo` over SSH, shown as a plan first, the same way the SSH bootstrap works today. There is no long-running root process.
6. **Core does not depend on the hosted service.** Every team feature works with pasted invites and a direct or self-hosted link.
7. **Share by an explicit act.** Discussion never becomes a turn without an explicit send. This carries over the "shared conversation, explicit action" rule of `docs/mousse-collaboration-plan.md`.

### 6.2 Team identity and membership

#### 6.2.1 The team user

A team is created on its first team machine with `mousse-cli team create <name>`, which `team host init` runs (§6.3.2). This makes an ordinary Net user identity, a `usr_` root key and roster. Its **authority node** is the daemon of the team service account `mt-team`.

- **`mt-team` never runs agents.** Its daemon hosts the team Space, signs the team roster and node delegations, keeps the provisioning queue and runs the update timer. It is started with no provider instances and with the Run Engine's send paths refused. A prompt injection in any thread is then at least one OS account away from the team root key.
- **Team-owned nodes.** Every project and bot account is enrolled as a node of the team user. A node's owner is already recorded in `NodeDelegation.owner` (`src/shared/net/identity.ts:31`), so "the team owns its machines" needs no new field.
- **Team nodes do not trust each other.** Bridge treats one user's nodes as that person's trusted devices. For the team user that would let a prompt-injected bot drive a project's threads. So:
  - **Minimal capabilities.** Delegations for project and bot nodes carry only the capabilities that node's role needs. A bot node gets none for Bridge.
  - **Blocked by default.** On every team node, the per-device policy (`net_node_policy`) starts with every *other* team node blocked. Only `mt-team` is exempt, and only for its provisioning and update methods.
  - **Opening a pair is an admin act.** An admin can open one pair, for example "bot `reviewer` may start remote subagents in project account `dino`". This is recorded as a team policy event and applied as that pair's node policy.
- **Members' own nodes stay theirs.** A member account is a node of the *member's* user, not of the team's. Their laptop and their account on the team machine are their own devices, joined by today's Bridge.
- **The roster says it is a team.** The roster gains an optional `kind: 'team'`. Peers that ignore it see an ordinary user. It only changes how the GUI names the identity and grants nothing.
- **Recovery and rotation.**
  - On creation, the team root is exported to a passphrase-protected recovery file that the creating admin downloads. The UI asks each new admin to keep a copy off the machine.
  - Recovery uses the existing `--become-authority` flow with a higher recovery epoch.
  - "The team machine was compromised: rotate" becomes a documented and tested runbook (P1), because otherwise only the 7-day delegation lifetime limits a stolen key.
  - k-of-n signing among admins was considered and rejected for now (§10).
- **Mousse ID binding.** A Mousse ID account binds to one user root, and a team user has no email.
  - **P1:** `team host init` can bind the team user to the creating admin's Mousse ID account, using a device-code sign-in shown in the admin's terminal. Team nodes then get the hosted relay and members can reach the team machine without a public port or Tailscale. Without Mousse ID, the team machine needs a direct, Tailscale, SSH or self-hosted relay route, as Bridge does today.
  - **P2:** the hosted service gains team accounts (Q6). The current 5-device limit per account needs a rule for team nodes before then.

Why not keep the key on an admin's laptop: a headless team machine would then stop enrolling accounts whenever that laptop is closed. The team machine is the always-on thing the team owns.

#### 6.2.2 The team Space

Membership, roles and invites reuse Spaces. The team user creates and hosts one Space with `kind: 'team'`, and its `space.meta` stream gains sections only team Spaces use. Older peers treat these as unknown critical events and stop (`upgradeRequired`), which is the existing safe behaviour. The team Space's channels are also the team's group chat, which the [Teams UI](teams-ui.md) may show.

```ts
// src/shared/teams/types.ts (new)
type TeamRole = 'owner' | 'admin' | 'member'          // humans; the Space owner is the team user itself
type ProjectAccess = 'maintainer' | 'collaborator' | 'viewer'

interface TeamState {                                   // derived by replaying the team space.meta stream
  team: UserId                                          // the team user
  space: SpaceId
  name: string
  members: Record<UserId, TeamMember>
  machines: Record<NodeId, TeamMachine>
  accounts: Record<string /* os account */, TeamAccount>
  projects: Record<TeamProjectId, TeamProject>
  bots: Record<BotId, TeamBotPlacement>                 // contract with Bot Architecture, §9.2
  openPairs: { from: NodeId; to: NodeId; methods: 'subagents' | 'read' }[]   // §6.2.1
  policy: TeamPolicy
}

interface TeamMember { role: TeamRole; handle: string; displayName: string; avatar?: BlobId
  sshKeys: string[]                                     // installed in the member account by `sync`
}

interface TeamMachine { node: NodeId; name: string; os: 'linux' | 'macos' | 'windows'
  mode: 'multi-account' | 'shared-login'; registeredBy: UserId; registeredAt: number }

type TeamAccount =
  | { kind: 'service'; os: 'mt-team'; machine: NodeId; node: NodeId }
  | { kind: 'member'; os: string; machine: NodeId; member: UserId; node?: NodeId /* member's node there */ }
  | { kind: 'project'; os: string; machine: NodeId; node: NodeId /* team user's */; projects: TeamProjectId[] }
  | { kind: 'bot'; os: string; machine: NodeId; node: NodeId; bot: BotId }

interface TeamProject {
  id: TeamProjectId; name: string; repo?: { remote: string }
  account: string                                        // the project account that hosts it
  members: Record<UserId, ProjectAccess>                 // absent = no access
  defaultThreadAccess: 'project' | 'creator'             // §6.5.1
  profile?: ProjectProfileRef                            // §6.11
}

interface TeamPolicy {
  channel: 'nightly' | 'stable'                          // §6.12
  minVersion?: string                                    // §6.12
  membersMayCreateProjects: boolean                      // default false
  membersMayAddBots: boolean                             // reuses SpaceSettings.membersMayAddBots
  personalThreadViewerGrants: boolean                    // default true
  maxPermissionModeInProjects: PermissionMode            // default accept_edits; maintainers may go higher
  memberAccountLimits: { cpuQuotaPercent?: number; memoryMax?: string }   // systemd slice, §6.4
  instances: Record<string /* account:instanceId */, InstancePolicy>      // §6.10
}
```

**New meta events.** All are critical, and the host applies each one only after checking its author against the state just before it, exactly as `meta.ts` does for Space events.

- `team.machine.registered|removed` and `team.account.created|disabled|removed`: the team host.
- `team.project.created|updated|archived`: an admin.
- `team.project.access`: an admin, or a project maintainer.
- `team.policy.changed` and `team.pair.opened|closed`: an admin.

**The owner role.** A Space has one owner that cannot change ("no ownership transfer in v1", `docs/net/threat-model.md`). In a team Space that owner is the team user, so ownership never has to move when a person leaves.

- Humans hold `owner`, `admin` or `member` in `TeamState.members`.
- Actions Spaces reserve for the Space owner, such as promoting an admin, are applied by the team host when a human with team role `owner` sends a signed `team.request`.
- The host-principal limitation in `docs/net/threat-model.md` applies: the team machine can act as the team. That is intended, because the team owns the machine.

**Invites and joining.**

- **Self-hosted invites** are `sj1_` Space invite strings for the team Space, with a role. The team host issues them on an admin's signed request. The invite container gains an optional `team` section: team name, team channel, the installer URL for that channel, and the team machine's routes.
- **Mousse ID invites** (P2) wrap the same invite in an email link. The hosted service stores only the opaque invite token, the inviter's account and the email address.
- **Joining** makes the person a member of the Space and records their SSH public keys. It also queues their member account for the next `team host sync` (§6.3.2).

**Leaving or removal.** `member.removed` in the team Space has these effects, in order:

1. Every routed call from that person's nodes to team nodes is refused at once, because team policy is checked on every call (§6.5.3).
2. Their project access ends.
3. The next `team host sync` locks their member account: the password is locked, their SSH keys are removed, `loginctl disable-linger` is run and the daemon stops. The home is kept for an admin to archive or delete.

Shared threads they started stay in the project account, attributed to them.

### 6.3 Team machines and accounts

#### 6.3.1 Account layout on a Linux team machine

| OS account | Runs | Net identity | Holds | Reached by |
|---|---|---|---|---|
| `mt-team` | Team service daemon: team Space host, team user authority, provisioning queue, update timer. **No agents.** | Team user (authority node) | Team root key, team Space store | Admins |
| `mt-<handle>` | That member's own Mousse daemon | The member (a node of their roster) | Personal threads, worktrees, their own subscriptions in private homes, their own MCP servers and secrets | That member's devices, through today's Bridge |
| `mt-p-<slug>` | The daemon of one or more team projects | Team user | Shared threads, project checkouts and worktrees, project profiles and secrets, the account's own provider sign-ins | Project members, per §6.5 |
| `mt-b-<slug>` | One bot's daemon | Team user (the bot is placed here) | The bot's grant, its credentials (such as its own GitHub account), its scratch folders | Through the bot's triggers and audience (§6.9) |

**The smallest team has two team accounts.** It has `mt-team` and one project account, `mt-p-default`, plus one account per member.

- **Projects are separate from the start.** Each project is its own section in the team Space, so moving a project to an account of its own later is a `team host sync` step, not a data migration.
- **When to split.** A team should split projects into separate accounts once their credentials must not mix, such as two clients. The UI says so when a second project with a profile joins an account that already has one.
- **What sharing an account means.** While projects share an account, every agent in it can read every shared thread and every secret in it. Thread access rules there limit only people, not agents. This is a known limitation of the minimal setup, and the UI shows it.

**Groups and files:**

- **Groups.** `mousse-team` contains every `mt-*` account. `mt-p-<slug>-ro` exists per project mirror.
- **Homes are 0700.** No group reads another account's home.
- **The only shared files** are the team mirror at `/srv/mousse/<team>/mirror/<project>.git`, a bare repository readable by its project group. Member and bot accounts in that group can clone from it.
- **The mirror never prunes.** It sets `gc.pruneExpire=never`, and clones use `--reference … --dissociate`, so a pruned mirror can never break a clone.

**Hardening that `team host init` applies, and tells the admin about:**

- **Process lists.** `/proc` is mounted with `hidepid=2` and `gid=` set to an admin group. On a multi-person machine this is what keeps one account from reading another's command lines (issue #358).
- **No sudo** for any `mt-*` account.
- **SSH.** No SSH login for `mt-team`, project or bot accounts. Member accounts accept only that member's keys.
- **Resource limits.** Member accounts run in a systemd slice with the team's CPU and memory limits (`policy.memberAccountLimits`).

#### 6.3.2 Provisioning: `mousse-cli team host`

This follows the SSH bootstrap's model (`src/mms/net/ssh/plan.ts`): a plan shown first, idempotent steps, a journal for undo, and Linux only. The command produces a **plan of steps**. A person runs it from a terminal or the app, and the Mousse+ setup wizard (§6.13) would drive the same plan. That way the open-source path and the wizard cannot drift apart.

```text
mousse-cli team host init  --ssh admin@box   # once; needs the admin's sudo
mousse-cli team host sync  --ssh admin@box   # applies pending account changes; needs sudo
mousse-cli team host status                  # read-only: accounts, daemons, versions, pending changes
mousse-cli team account signin <account> <instance> --ssh admin@box   # runs that agent's own sign-in as the account
```

**`init`** runs these steps in order:

1. Checks the distribution, systemd, `loginctl` and free disk.
2. Creates `mt-team` and the groups, and applies the hardening.
3. Installs `mousse-cli` from the team channel.
4. Creates the team user, or joins an existing team as a further machine with a team machine invite.
5. Optionally binds the team user to the admin's Mousse ID account (§6.2.1).
6. Creates `mt-p-default`.
7. Installs the update timer (§6.12).

**`sync`** reads the provisioning queue, which holds the pending account events from the team Space. For each item it shows the plan, then:

- creates, locks or removes an `mt-*` account;
- installs `authorized_keys` for member accounts;
- runs `enable-linger`, installs the CLI into that home and starts its user service;
- enrolls the account's daemon. Project and bot accounts use an invite from `mt-team`.

A **member account** is enrolled by the member, not the admin:

1. The member's own authority node signs the delegation.
2. The member's computer completes the join through the team machine route. This is the same `mousse-cli bridge join --via` path the SSH bootstrap already uses, run as `mt-<handle>` with the member's own SSH key.
3. The member's root key never touches the team machine.

Until the member does this, their account exists but runs nothing, and the UI shows "Finish setting up your account on <machine>".

**Signing in project and bot accounts.** `team account signin` runs the agent's own sign-in flow (`claude auth login`, the Codex device flow) in a terminal as that account over the admin's SSH. Mousse's existing PTY sign-in in a private home is reused.

**No privileged daemon.** Root steps run only while an admin runs `init` or `sync` (assumption A3). Unattended provisioning would need a small root service that can only create and lock `mt-*` accounts. It stays a later option (Q3), because it would let whoever holds the team key create accounts as root.

**A registration, not an attestation.** `team.machine.registered` records what the admin's run saw. No policy assumes it proves anything about the hardware.

#### 6.3.3 Repositories on a team machine

- **Shared projects.** A shared project's checkout lives in its project account, and thread worktrees are made there by the existing `ThreadWorkspaceManager`.
- **Personal work.** A member who works on the project from their own account clones from the mirror into their own home, and their personal threads work there as today.
- **Keeping the mirror fresh.** The project account's daemon refreshes the mirror after every Publish or push, and once a minute while fetching is on.

#### 6.3.4 macOS and Windows

A Mac ties a person to a desktop session, and the login keychain of an account nobody is logged in to stays locked. Claude Code keeps its sign-in there. So a Mac or Windows computer joins a team in one of two ways:

- **As a member's own computer.** This is the normal case. Its threads are personal threads.
- **As a team machine in shared-login mode.** It is labelled "Everyone who uses this machine's projects can read all of them, and so can its login user". One OS account hosts the team user's project nodes as separate profiles, and the plan claims no isolation between them. The team Space records `mode: 'shared-login'`, and the UI shows the label on every project hosted there.

### 6.4 What is isolated, and from whom

Trust levels:

- **Admins:** trusted. They have root.
- **Members:** semi-trusted colleagues, who should not see each other's private work.
- **Agents:** act with their own account's full access.
- **Bots:** held to their grant, and to their account in any case.

| Resource | Where it lives | What protects it from other members and other accounts | Notes |
|---|---|---|---|
| Personal threads and history | `~mt-<handle>/.mousse/…` | Home is 0700; the daemon socket is 0600 and needs the owner token | Readable by others only through a viewer grant (§6.5.2) |
| Personal worktrees and files | The member's home | 0700 | |
| Personal provider sign-ins | The member's home: private homes and the OS vault | 0700. On a headless account the vault falls back to a passphrase file (`secretCodec`); P0 checks this (Q4). | Bring-your-own subscriptions |
| MCP turn tokens | Member daemon memory, passed to agents | #358 is fixed first, so the token goes in the environment or a file. `hidepid=2` is defence in depth. | **Blocker** for multi-member machines |
| `${secret:}` references and MCP OAuth tokens | The account's home, plaintext 0600 | The home is 0700 | Encrypting these adds little against an agent in the same account. The account is the boundary. |
| Project secrets and profile | `~mt-p-<slug>` | 0700. Routed reads return names, never values (§6.11.2). | Agents in that account can use them by design |
| Shared thread content | The project account | `teamAccess` at the routed edge (§6.5.3) | Within one project account, agents can read every thread there |
| Bot credentials | `~mt-b-<slug>` | 0700. Other team nodes are blocked (§6.2.1). | One bot, one GitHub account (M7) |
| Mousse-layer access between team accounts | — | Minimal capabilities and blocked-by-default node policy (§6.2.1) | Pairs are opened explicitly |
| Network | Shared | Not isolated in P1 | Containers in P4 add network policy |

### 6.5 Thread access

#### 6.5.1 Three kinds of thread

| Kind | Runs in | Who can open it | Who can send |
|---|---|---|---|
| Personal | The member's account or laptop | The owner. People with a viewer grant can read it. | The owner only |
| Shared | A project account | Project members, or only the listed people if the thread is restricted | Collaborators and maintainers of the project |
| Bot | A bot account | Set by the bot's audience (§6.9) | Set by the bot's audience |

- **Default access.** Each project sets the default for its shared threads: `project`, meaning everyone in the project, or `creator`. A `creator` thread is listed only for its creator, the project's maintainers and the people the creator adds.
- **Admins.** Team admins see every shared thread's metadata: title, project, creator, state and usage. They see its content only if they are project members. This is a product rule; admins can always read files as root.
- **Revoking access** stops new reads and sends at once. It cannot delete what a reader's computer already synced, and the UI says so.

#### 6.5.2 Viewer grants on personal threads

A personal thread's owner can let named teammates read it. This covers "look at what my agent did".

```ts
interface ThreadViewerGrant {          // kept on the node that runs the thread; signed by the owner's node
  v: 1; thread: ThreadId; owner: UserId; viewer: UserId; team: UserId
  issuedAt: number; expiresAt?: number; revokedAt?: number
}
```

- **What a viewer can do.** A viewer may call only routed rows marked `crossUser: 'viewer'`: `threads.get`, `thread.snapshot`, `queue.list`, the review diff, and file reads inside the thread's folder.
- **What a viewer can never do.** Send, steer, answer approvals, open a terminal or editor, Undo or Publish.
- **Reachability.** A grant on a laptop works only while that laptop is reachable, and the UI says "available while <computer> is online". For lasting sharing, hand the thread off or move it to a shared thread (§6.8).

#### 6.5.3 Cross-user routing for team access

Viewer grants and shared threads use one mechanism: Bridge's routed path. Today a single same-person comparison guards it. That comparison becomes a call to one access decision:

```ts
// src/mms/teams/access.ts (new)
type CrossUserLevel = 'viewer' | 'collaborator' | 'maintainer'
function teamAccess(peer: { user: UserId; node: NodeId }, self: { user: UserId; node: NodeId },
                    row: RoutedRow, target: { thread?: ThreadId; project?: ProjectId }): Decision
```

The decision goes in this order:

1. **Same person.** Today's behaviour, unchanged. The team user's own nodes are additionally subject to the blocked-by-default policy (§6.2.1).
2. **Another person.** Every check must pass:
   - `row.crossUser` is set. The new column defaults to absent, which means refused. That keeps the method table deny-by-default for people, as it is for devices.
   - `self` is a team project or bot node, or the target thread has a current viewer grant for `peer.user`.
   - The team Space is current, not `upgradeRequired`, and `peer.user` is an active member.
   - The peer node is current in that member's roster, its pinned root is used and its delegation has not expired.
   - `row.crossUser` is no higher than the member's access to the project. A thread restricted to `creator` also checks its participant list.
   - Team policy ceilings hold, including the highest permission mode.
3. **Anything else** gets the existing `forbidden`.

Every decision is written to the existing Bridge audit with the person's `usr_`.

**Rows opened in P1.** Only the rows a shared thread needs are marked:

- reading threads and snapshots;
- `orchestrator.send`, `orchestrator.steer`, `orchestrator.abort` and `answerQuestions`;
- `queue.*`;
- the review diff, and reading files in the thread's folder;
- `threads.create` in a project the member collaborates in.

Terminals, editor connections, Undo and Publish open in P2, for maintainers only. Merged lists (`src/mms/bridge/routed/mergedLists.ts`) add a member's team projects as project groups named with the team.

**Why routed access and not Space streams.** This was the main disagreement with Fable (§10). Space streams would let members append to a `space.thread` stream that the project daemon consumes. Members would never open a session to the project daemon. The plan does not take that route, for four reasons:

- **The full view already exists.** Bridge already shows remote threads in the same view as local ones (#372, #529), with files, review, Undo and terminals routed and audited. Streams would mean a second thread view, plus send, steer, approval and queue semantics rebuilt on envelopes.
- **The existing binding is too narrow.** It ties `space.thread` to a bot execution on the Space host node; shared threads would need a member-created binding and a host node separate from the execution node.
- **The extra exposure is limited.** It is one decision function at about ten same-person sites, and only rows explicitly marked `crossUser` are reachable. That is the same review discipline the table already demands for devices.
- **The comparison is testable.** P0 prototypes the function and lists every same-person site (§7). A P1 test walks every routed row and checks that a cross-user call is refused unless the row is marked.

### 6.6 Attribution, ordering and the queue

#### 6.6.1 Author on every human input

```ts
// src/shared/types.ts
interface HumanAuthor { user: UserId; node?: NodeId; displayName: string; avatar?: BlobId }
// ChatMessage (role 'user'):  author?: HumanAuthor
// QueuedMessage:              author?: HumanAuthor
// runs table:                 author_user TEXT NULL     (Run Engine migration; runDatabase contract bump)
// AnsweredBy {kind:'user'}:   user?: UserId
```

- **Set by the daemon.** The receiving daemon fills in the author from the authenticated peer: the routed session's `peer.user` and the roster's display name, or the local owner. A client cannot name its own author, which keeps the collaboration plan's rule that "Clients cannot nominate their own authenticated author".
- **Missing means the owner.** A missing author means the account's own user, so existing threads need no rewrite.

#### 6.6.2 Simultaneous messages in one thread

The Run Engine already gives each thread a total order:

- **Ordering.** A per-thread mutex and `expectedSequence` keep one active run per thread.
- **Queueing.** A send while a run is active goes into the durable FIFO with `order = max+1` (`ThreadMessageQueue.ts:123`).
- **One turn per message.** Each queued message is its own turn. The meeting's "simultaneous messages are queued" is exactly that, and merging messages into one turn would hide one person's request inside another's.
- **Authors and the next message.** Queued items show their author's avatar, and the thread shows "Next: Ana's message".
- **Editing the queue.** A person can edit or remove their own queued messages. A maintainer can reorder or remove anyone's. This adds a check to `queue.edit`, `queue.reorder` and `queue.remove` (`src/mms/protocol/handlers.ts:1958-2035`).
- **Steering.** Only the running turn's driver and the project's maintainers can steer it; everyone else queues. A steer from someone else would change another person's request without asking.
- **Approvals.** Any collaborator can answer an approval in a shared thread. The existing compare-and-set in `ThreadApprovals.ts` resolves a double answer once, and `answeredBy.user` records who decided.

#### 6.6.3 Runs across threads that share a sign-in

Every shared thread and bot in a project or bot account uses the same few sign-ins, which means one plan's rate window for all of them. The Run Engine only orders runs within a thread, so this plan adds a small admission step per provider instance in that account:

```ts
interface InstancePolicy {
  maxConcurrentRuns: number          // default 2
  botShare: number                   // max fraction of concurrent slots bots may hold; default 0.5
  reserveForPeople: number           // % of the plan window bots must leave unused; default 25
  perPersonRunsPerHour?: number      // optional limit by author
}
```

- **Waiting runs.** A run that cannot start waits in the queue with a visible reason ("Waiting: 2 runs already use Claude on this project"). People's runs go before bot runs.
- **Pausing near the limit.** Bot activations pause when the instance's usage window (from `gateway.usage()`) is above `100 − reserveForPeople` percent.
- **Hitting the limit.** The existing usage-limit pause and resume (#319) still applies when the limit is reached.

#### 6.6.4 The driver

`Thread.driver?: HumanAuthor` is the author of the running turn's message. It is set when the turn starts and cleared when it ends. The driver and maintainers can Stop it.

### 6.7 Presence and typing

Presence and typing are ephemeral and never stored. They ride on the thread's routed stream (`ThreadStreamAdapter`) as the existing ephemeral envelope types (`src/shared/net/envelope.ts:295-301`).

```ts
type ThreadPresence =
  | { kind: 'viewing'; user: UserId; node: NodeId; at: number }      // heartbeat every 20 s while the thread is visible
  | { kind: 'typing'; user: UserId; node: NodeId; at: number }       // at most every 3 s while the composer changes
  | { kind: 'left'; user: UserId; node: NodeId; at: number }
```

- **Expiry.** The thread's node drops a viewer after 45 s without a heartbeat, and drops typing after 6 s.
- **Who receives it.** Presence goes only to sessions that `teamAccess` allows to read that thread.
- **Local clients.** The daemon passes presence to its local clients as a `thread.presence` event.
- **Bots and agents** show their status from the run, not from presence.
- **Phase.** This comes in P2. The meeting listed it as an idea, while attribution and queueing are what make shared use correct.

### 6.8 Handoff between people

The meeting asked to hand threads to humans "like agent context handoff" (M4). There are three kinds.

**A. Assign a shared thread.** Nothing moves. "Hand to <person>" records a `handoff` event in the thread: from, to, a note, and, if asked, the agent's summary of the context. It also notifies that person and sets an `assignee` the UI shows. Anyone with access can still send; assignment is a signal, not a lock.

**B. Hand off a personal thread to a person.** The work moves to the other person's account:

1. The owner's daemon builds a **handoff package**:
   - the history and the provider-neutral context that `Transfers.ts` builds for a fork;
   - the latest snapshot as a Git bundle of its `refs/mousse/` commit, plus the thread's branch;
   - the repository identity, so the receiver can match a project with the same history (`sameAs`).
2. The package is sealed to the receiver's node and sent as a Bridge artifact. `src/mms/bridge/artifacts.ts` gets the `teamAccess` decision, limited to handoff packages.
3. The receiver accepts. Their daemon:
   - creates a new thread with `handedOffFrom {user, thread, node}`;
   - checks out the snapshot in a new worktree;
   - continues on *their* provider instance. A different model uses the existing model-switch context handoff (`ChatMessage.contextHandoff`).
4. The original becomes read-only, marked "Handed off to <person>".

**C. Move a personal thread to a project.** This is the common case of "let's work on this together". The same package goes to the project account. A collaborator of the project is the one who sends it, and the project daemon admits it after the `teamAccess` check. The new shared thread is attributed to its original owner and runs on the project's sign-ins from then on.

**Agent to person.** An agent in a shared or bot thread can ask for a person with an app tool `request_person {who?: UserId, reason}`. This becomes an assignment (A) plus a notification. It is the team version of a bot's escalation, and Bot Architecture owns the bot side (§9.2).

### 6.9 Team bots

A team bot is a bot placed on a bot account and owned by the team user. Bot Architecture defines what a bot is; this plan defines where it runs and who can reach it.

- **Its own OS account.** Each team bot runs in `mt-b-<slug>` on the personal bot engine (`src/mms/bots/activation/BotEngine.ts`). Putting the bot in its own account, with other team nodes blocked from it by default (§6.2.1), answers "bots need isolation … to manage multiple GitHub accounts safely" without Docker. The bot's `gh` sign-in, SSH key and Git identity live in that home only.
- **Who may talk to it.** A team bot adds `audience: 'team'` with a policy in the shape of the Space bot steer policy (`BotSteerPolicy`: owner | roles[] | everyone). The policy says who may trigger the bot, steer it and answer its walls. The bot's grant is approved by a team admin or by the maintainers of the bot's project.
- **Its provider.** It runs on its account's own sign-ins, subject to the instance policy (§6.6.3). The bot's automatic model choice (D4) picks from those instances.
- **Example: a code reviewer.** A `reviewer` bot account holds the review bot's own GitHub account. A schedule every 5 minutes polls for new PRs; event triggers are Bot Architecture's design. It reviews in a worktree cloned from the mirror, and comments as its own GitHub user.
- **Docker per bot (P4)** is a different runner for the same bot account. The account becomes the container's user and home, and network policy becomes possible.

### 6.10 Shared subscriptions and the "CLI proxy"

**What "CLI proxy" means here.** There is no proxy component in the code. Mousse drives subscription-signed CLI agents (Claude Code, Codex, Grok) for the user, and refuses to turn a Claude subscription into a model API (`src/mms/harness/pi/extension/guard.ts`). That refusal stays. So sharing a subscription means **running the work where the sign-in lives**, never moving tokens.

| Tier | What | Where the sign-in lives | Serves | Phase |
|---|---|---|---|---|
| T0 Bring your own | Each member's own Claude, ChatGPT or Grok plan (M11) | Their member account (private homes) or laptop | Their personal threads, and handoffs they receive | Works per account today |
| T1 Team sign-ins | A project or bot account signs in its own instances: a team or business seat, a plan bought for that account, or API keys. Admission follows §6.6.3. | That account; nothing leaves it | Every shared thread and team bot there. This is the "shared environment reusing common AI subscriptions and CLI proxy". | P1 |
| T2 Team gateway | An HTTP model gateway on the team machine, with per-member keys minted from the team Space, quotas, metering and audit. Claude Code uses `ANTHROPIC_BASE_URL` plus `apiKeyHelper`, Codex its API-key mode, Pi a direct key. | The gateway's account holds the upstream API keys | Members' personal threads that want team-paid API models | P3 |
| T3 Grouping | Pooling several people's personal plans | A plugin | Whoever installs it | Plugin (D1) |

**Terms.** A plan sold to one person and used by several people's prompts may break that plan's terms, wherever the machine is. T1 therefore recommends a team or business seat, or API keys, for project and bot accounts. When an account on a personal-looking plan is signed in to a project account, the UI says so. T3 is the plugin's responsibility and carries the same warning (D1).

**Usage and limits.**

- **Records.** Each run records `author_user` (§6.6.1) and its provider instance, so the project daemon can show team usage by person and instance from its run records.
- **Plan windows** come from `gateway.usage()`: Claude's 5-hour and weekly windows, and Codex's rate limits.
- **P1 limits** are counts and slots (§6.6.3), because Claude Code budgets are `unsupported` (`src/mms/harness/drivers/claudeCode.ts:42-52`).
- **Spend ceilings** come with T2, which can meter.

**The plugin seam (D1).** Core exposes an instance source, so a plugin can add instances and choose which one a run uses:

```ts
interface InstanceSourcePlugin {            // contract version: pluginInstanceSource 1
  id: string
  listInstances(scope: { profile: ProfileId; team?: UserId }): Promise<PluginInstance[]>
  choose(run: { thread: ThreadId; author?: UserId; wanted: ModelRef }): Promise<InstanceId | null>
}
```

Core ships no implementation, and this is the only hook for grouping. `docs/releases.md` already says a plugin API gets its own contract version.

### 6.11 Credentials, project profiles and the layer-2 Mousse MCP

#### 6.11.1 Checking the meeting's MCP claim (M12)

The code does not match the meeting's description:

- **Claude Code does not run through ACP.** It runs through the Agent SDK (`src/mms/harness/drivers/claudeCode.ts:200`). Every turn gets the `mousse` server and, since #474, `mousse-relay` (`src/mms/run/mcp/attachment.ts:66`, merged into the session at `ClaudeSubscriptionProviderService.ts:2144`).
- **ChatGPT no longer runs on Pi.** It runs on the Codex driver.
- **The relay already does most of layer 2.** "A layer 2 MCP that runs other MCPs" is mostly what the relay is.

P0 tests each remaining cause on a nightly build and records the result on an issue:

1. Claude added as a generic ACP agent. Its turns get MCP over HTTP only if the agent advertises it, and otherwise through a stdio bridge that must find `mousse-cli`.
2. An `HTTP(S)_PROXY` in the user's environment that also catches `127.0.0.1`, because Mousse sets no `NO_PROXY`.
3. A managed Claude policy (`allowManagedMcpServersOnly`).
4. Bot turns, which get `mousse` but not the relay.
5. No Run Engine, so `mcpEligible=false`.

#### 6.11.2 Project profiles

```ts
// src/shared/teams/projectProfile.ts (new)
interface ProjectProfile {
  id: string; name: string                         // e.g. "DinoMoney"
  scope: 'personal' | 'team-project'
  connections: Connection[]
  mcpServers: McpServerConfig[]                    // existing type, src/shared/integrations.ts:66
  skills: SkillRef[]                               // names in the project's skill set
  env: Record<string, SecretRef | string>          // for CLIs such as gh, vercel and supabase
}
type Connection =
  | { kind: 'github'; account: string; auth: SecretRef }
  | { kind: 'supabase'; projectRef: string; auth: SecretRef }
  | { kind: 'vercel'; team?: string; project?: string; auth: SecretRef }
  | { kind: 'custom'; name: string; env: Record<string, SecretRef> }
type SecretRef = { secret: string }                // a name in the account's secret store
```

**Where a profile lives.**

- **Team project.** The profile is part of the project account's Mousse settings, and its secrets never leave that account. Maintainers edit it through routed methods (`projects.profile.get|set`, maintainer only). Secret values are write-only through that path: a routed reader gets names, never values.
- **Personal project.** The same file lives in the member's own profile.

**How it reaches agents.**

- **MCP servers** in the profile join the account's MCP set. Agents use them through `mousse-relay`, which holds credentials on the server side (#474). This is M5's "unify credentials and run other MCPs".
- **CLI tools** need environment variables: a turn in a thread whose project has a profile gets `env` resolved into its launch environment, through the existing per-instance `env` path. Inside the project account that is fine, because the account is the boundary.

**Team skills.**

- **Source.** Team skills live in a Git repository `team-config` in the team mirror (`/srv/mousse/<team>/mirror/team-config.git`). It holds `skills/<name>/SKILL.md` and `profiles/<id>.json`, without secrets.
- **Distribution.** Every team account syncs it into `.mousse/skills`, which `SkillsRegistry` already reads (`src/mms/integrations/skills/SkillsRegistry.ts:53`). Members can pull it on their laptops.
- **Why Git.** Review and history for shared skills come for free.

**"Installed in all Claude CLIs at setup" (M5).** This is an explicit opt-in per member: "Use Mousse's MCP servers in my terminal agents".

- **How it installs.** It runs the agent's own command, such as `claude mcp add --scope user mousse-relay -- mousse-cli engine mcp-stdio` or the Codex equivalent, so Mousse still never edits an agent's files itself.
- **A new long-lived token.** Terminal sessions have no per-turn token, so this creates a **new long-lived per-profile relay token**. It is:
  - kept in the account's vault;
  - revocable in Settings;
  - limited to relay tools, never the `mousse` app tools;
  - named in the setting's description.

### 6.12 Release channels

**Today:**

- **Nightly** builds `master` daily when every check passes.
- **Stable** is tagged and published by hand.
- **An installed app follows its own build's channel** (`docs/releases.md`, #571).
- **macOS** has no in-app updates.
- **Headless installs** made by the SSH bootstrap never update.

**Changes:**

1. **The invite carries the channel.** The team's `policy.channel` (default `nightly`, per M6) goes into every invite. The invite page or CLI output links the installer for that channel: the newest nightly from the prerelease feed (`nightly.yml`, `nightly-linux.yml`), or the latest stable. Someone who installs from the link is on a nightly build, and the existing updater keeps them on nightlies.
2. **Team machines update themselves.** `mousse-cli update [--channel nightly|stable] [--check]` is new:
   - It downloads the CLI AppImage for the channel and checks it against the release's SHA256SUMS, as the SSH bootstrap does.
   - It installs the build under `/opt/mousse/<version>`, the one root-owned path. `sync` writes it, or a root helper that the update timer runs and that can only write there.
   - It restarts each `mt-*` user service in turn. Each service waits up to 10 minutes for running turns to finish, then stops them and marks them interrupted, as the desktop updater does.
   - `mt-team` runs it from a systemd timer one hour after the nightly publish time.
3. **The team keeps versions compatible.**
   - `policy.minVersion` follows the team machines' contract versions (`src/mms/contractVersions.ts`).
   - A member's computer that is older, or has a different `netProtocol`, shows "Update Mousse to work with <team>" with a download link. macOS members always get this nag, because unsigned macOS builds cannot update themselves.
   - Routed calls keep the existing version refusals.
4. **Stable stays manual.** Tagging is unchanged. A team can switch `policy.channel` to `stable`. Its machines then wait for a stable release newer than the running nightly and never go to an older build, which is what the desktop updater already does.

### 6.13 Self-hosting, enterprise and the Mousse+ boundary

| Layer | Contents | Licence and where |
|---|---|---|
| Core (this repository, MIT) | Team user, team Space, `team host` provisioning, OS-account isolation, routed team access, attribution, queue, instance admission, presence, handoff, team bots, project profiles, `team-config` skills, channel handling, the T2 gateway, the plugin seam | Self-hosted on any Linux machine. Links are direct, Tailscale, SSH or a self-hosted relay (`docs/net/PLAN.md` §4.5). |
| Mousse ID (hosted, a separate service; MIT client in `src/mms/net/plus/`) | Email invites and a team directory; the relay without opening ports; phones; a single sign-in for a team's people (later); device and team inventory | Optional. Every team feature also has a pasted-invite path. |
| Mousse+ (hosted, possible future revenue, off today) | A hosted model gateway behind the T2 interface; a catalog of extensions, MCP servers and team skills; the setup-wizard agent, which drives `team host`'s plan like a DevOps engineer (M8); managed team machines | Optional, built on core interfaces, and never a gate in core |

- **Enterprise self-hosting** means running core on its own machines with its own relay and, later, its own identity provider. Core never requires Mousse ID for a team feature. CI checks this with the existing builds without `MOUSSE_ID_ORIGIN`, which show no Mousse ID UI.
- **The setup wizard** is a bot (Bot Architecture) with a grant to run `mousse-cli team host` and `team account signin` over SSH and to fill in project profiles. Core supplies the commands and the plan; Mousse+ supplies the packaged agent.

### 6.14 Why this differs from T3 Code

T3 Code is "single user, multiple boxes": one person and many machines. A team version would have to bring other people into every surface its existing users rely on (M9).

Mousse already separates the person (a Net user), the device (a node), the shared room (a Space) and the OS account. Teams joins these pieces:

- **Machines belong to a team.**
- **People keep private work on shared machines,** and the OS provides the isolation, not UI filters.
- **Shared threads and bots run on the team's own subscriptions,** for any member.
- **The whole thing is open source and self-hostable.**

A single-user Mousse install is unchanged: none of this appears without a team.

---

## 7. Phases and acceptance criteria

Every phase ships behind a `teams` feature flag (default off), which needs `netBridge` and `netSpaces`.

### P0: checks and spikes (about one week)

**Scope:**

- **MCP causes.** Test the five MCP failure causes of §6.11.1 on a nightly build.
- **Fix #358.** No MCP token on the command line.
- **Spike: headless sign-ins (Q4).** Find out whether Claude Code and Codex keep their sign-in in an account with no desktop session, using a private home with file storage (`CLAUDE_SECURESTORAGE_CONFIG_DIR`, `src/mms/harness/env.ts:153`).
- **Spike: per-account daemons.** Run five account daemons (`mt-team`, `mt-p-default`, two members, one bot) on a 4-vCPU, 8 GB machine with linger and `hidepid=2`. Measure memory at idle and during a turn.
- **Spike: access decision.** Prototype `teamAccess` at `rpcDispatcher.ts:358`, and list every same-person site and every routed row.

**Done when:**

- [ ] Each MCP cause has a recorded outcome, and each failure has its own issue.
- [ ] #358 is closed: no Claude Code argument list contains a token, checked by a spawn-seam test.
- [ ] A written result says whether headless sign-ins persist, and with which storage.
- [ ] Memory per idle account daemon is measured and added to `docs/PERFORMANCE.md`.
- [ ] The list of same-person sites and routed rows is attached to the P1 issue.

### P1: MVP, a shared team machine (M3)

**Scope:**

- **Identity and membership:**
  - `team create`, `team host init|sync|status` and `team account signin`.
  - The team user with its recovery file and rotation runbook, and an optional Mousse ID binding.
  - The team Space with members, machines, accounts, projects, pairs and policy; invites and removal.
- **Machines and accounts:**
  - `mt-team` with no agents; member accounts enrolled by the member; `mt-p-default`; bot accounts.
  - Team nodes blocked from each other by default.
  - The team mirror.
- **Access and collaboration:**
  - `teamAccess` and the `crossUser` column.
  - Shared threads with author attribution, queue rules, approvals and the driver.
  - Instance admission across threads.
  - Viewer grants; handoff A (assign) and C (move to a project).
- **Bots, subscriptions and updates:**
  - Team bots on the personal bot engine with `audience: 'team'`, built with Bot Architecture.
  - T1 team sign-ins.
  - The invite carries the channel; `mousse-cli update` runs on the timer.

**Done when:**

- [ ] **Setup.** Two people on two laptops and one Ubuntu 24.04 server set up a team. One runs `team host init` and invites the other with a pasted invite. After one `sync` and the member's join, both see the team and the project. Nothing needs the hosted service.
- [ ] **No access to another member's account.** Member B cannot list or open member A's personal threads, read their files or send to them through the GUI or the CLI. An agent's shell in B's account cannot either: `cat ~mt-a/...` fails, and `/proc` shows no `mt-a` command lines.
- [ ] **Team accounts stay apart.** An agent in the bot account cannot reach the project account through Mousse, because its routed calls are refused. It also cannot reach the project account's files. Opening the pair in team policy allows only the opened methods.
- [ ] **Queued messages.** Both people open the same shared thread. Messages each sends while a turn runs queue in send order with the right author, and run one per turn. A steer from the person who is not driving is refused with a reason.
- [ ] **Approvals.** One approval answered at the same moment from both laptops resolves once and records who answered.
- [ ] **No tokens leave.** The shared thread runs on the project account's own Claude Code or Codex sign-in, and neither laptop holds its token.
- [ ] **People before bots.** With `maxConcurrentRuns: 2` and a bot running, a person's run starts before a second bot run, and a waiting run shows why it waits.
- [ ] **Team bot.** A team reviewer bot in its own account, with its own `gh` sign-in, reviews a PR on a schedule. Neither member account nor the project account can read its credentials.
- [ ] **Viewer grants.** A viewer grant lets B read one of A's laptop threads while A's laptop is online, and refuses every row not marked for viewers. Revoking it stops reads at once.
- [ ] **Move to a project.** Moving one of A's personal threads to the project creates a shared thread with the same files (equal snapshot hash) and history, attributed to A.
- [ ] **Removal.** Removing B refuses B's next routed call. After `sync`, B's account is locked and its daemon stopped.
- [ ] **Updates.** An invite on the nightly channel links the newest nightly installer. The server's timer installs the next nightly and restarts the account daemons, without interrupting a running turn that finishes within the 10-minute limit.
- [ ] **No change without a team.** Installs without a team behave as before: the existing Bridge, Spaces and profile tests pass unchanged.

### P2: collaboration polish and project profiles

**Scope:**

- Presence and typing (§6.7).
- Handoff B (to a person) and `request_person`.
- Terminals, editor connections, Undo and Publish on shared threads, for maintainers.
- Project profiles and the `team-config` skills repository.
- The opt-in relay install for terminal agents.
- Mousse ID team accounts, email invites and a team directory, which need the hosted service.
- A team usage view.

**Done when:**

- [ ] **Presence.** Avatars of people viewing a shared thread appear within 2 s and disappear within 45 s of leaving. Typing shows within 1 s and clears within 6 s. Neither is stored in thread history.
- [ ] **Handoff to a person.** A thread handed off from A to B continues on B's own instance with the same files and history. The original is read-only and says "Handed off to B".
- [ ] **Project profile.** A DinoMoney profile with GitHub, Supabase and Vercel lets an agent in a shared thread run `gh pr list`, `supabase projects list` and `vercel ls`, and use a Supabase MCP server. No routed read returns a secret value.
- [ ] **Team skills.** A skill added to `team-config` is available in every team account within one sync.
- [ ] **Terminal agents.** With the terminal opt-in, `claude` run in a terminal lists the `mousse-relay` tools. Revoking the token in Settings ends them.

### P3: the team gateway and spend limits

**Scope:**

- The T2 gateway with per-person keys, quotas, metering and audit.
- Spend ceilings per person and per project.
- A Mousse+ hosted twin behind the same interface, kept off.

**Done when:**

- [ ] **Metering.** A member's personal Claude Code thread using the team gateway (base URL plus `apiKeyHelper`) is metered to that member.
- [ ] **Ceilings.** A member over their ceiling is refused before the request starts.
- [ ] **Removal.** Removing a member invalidates their gateway key within one minute.

### P4: containers and enterprise

**Scope:**

- A Docker runner for bot accounts: Debian 13 minimal with X11 for computer use, per M10.
- Network policy per bot.
- Identity-provider sign-in, through Mousse ID or self-hosted OIDC.
- Several team machines, with projects placed by policy.
- Optional unattended provisioning.
- The setup-wizard bot (Mousse+).

**Done when** each item has its own issue with acceptance criteria, written before work starts.

---

## 8. Data and protocol changes in one list

| Change | Where | Contract version |
|---|---|---|
| `Roster.kind?: 'team'` | `src/shared/net/identity.ts` | `netEnvelope` (optional field, no bump) |
| Team Space meta events and `TeamState` | `src/shared/teams/`, `src/mms/teams/`, `src/mms/spaces/host/meta.ts` | `netProtocol` minor (new critical types) |
| `teamAccess`; `crossUser` on routed rows; team-node default block | `src/mms/teams/access.ts`, `src/shared/bridge/routed.ts`, about 10 same-person sites, `src/mms/net/store/nodePolicy.ts` | `netProtocol` minor |
| `HumanAuthor` on `ChatMessage`, `QueuedMessage` and `AnsweredBy`; `Thread.driver` and `assignee` | `src/shared/types.ts`, `src/mms/run/ThreadApprovals.ts` | `daemonProtocol` (optional fields) |
| `runs.author_user` | Run Engine migration | `runDatabase` bump |
| Instance admission (`InstancePolicy`) | `src/mms/run/` admission before `sendWithStart` | none |
| `ThreadViewerGrant` store | Per profile, `net.db` | `netProtocol` minor |
| Presence kinds on thread streams | `src/shared/net/wire.ts` | none (ephemeral; unknown types are skipped) |
| Handoff package artifact | `src/mms/bridge/artifacts.ts` | `netProtocol` minor |
| `ProjectProfile` | `src/shared/teams/projectProfile.ts`, profile settings | `profile` |
| Personal bot `audience: 'team'` | `src/shared/bots/personal/definition.ts` | Bot manifest version (Bot Architecture) |
| `mousse-cli team …` and `mousse-cli update` | `src/cli/commands/team.ts`, `src/cli/commands/update.ts` | none |
| Plugin instance source | `src/mms/harness/` | new `pluginInstanceSource` |

---

## 9. Cross-topic contracts

### 9.1 Teams UI (sibling plan `teams-ui`)

**This plan provides:**

- **Team state.** `teams.state` gives the `TeamState` of each team Space this profile belongs to, plus `teams.changed` events.
- **Thread rows.** Merged lists gain team project groups. Each row carries `kind: 'personal'|'shared'|'bot'`, `team`, `access`, and the `creator`, `driver` and `assignee` as `HumanAuthor`.
- **Attribution.** `author` on every user message and queued item, and `answeredBy.user` on approvals.
- **Waiting.** A waiting run has a reason: `queued_behind` (author) or `instance_busy` (instance, running count).
- **Presence.** `thread.presence` events (P2).
- **Refusals.** Typed refusals with plain causes: `not_team_member`, `no_project_access`, `viewer_only`, `not_driver`, `account_pending_sync`, `account_not_joined`, `team_upgrade_required`, `owner_offline`.
- **Invites.** Each invite carries the team name, channel, installer URL and inviter.
- **Usage.** Usage by person and instance from run records: counts in P1, spend in P3.

**This plan needs from Teams UI:**

- **Screens:**
  - the invite and join flow, including "Finish setting up your account on <machine>";
  - team settings: members, projects, machines and accounts with pending `sync` steps, and opened pairs;
  - the Share sheet: viewer grant, hand off, move to a project;
  - queue author chips, the driver and the Stop and steer rules;
  - the shared-login label and the shared-project-account warning;
  - "Update Mousse to work with <team>".
- **Agreement** that personal and shared threads are told apart everywhere a thread is listed.

### 9.2 Bot Architecture (sibling plan `bot-architecture`)

**This plan provides:**

- **Bot accounts.** One `mt-b-<slug>` per team bot, owned by the team user, with its own home for credentials, so one bot equals one GitHub account (M7). Other team nodes are blocked from it by default.
- **Audience.** `audience: 'team'` with a steer policy keyed by team role or project access.
- **Escalation to people.** `request_person` and handoff A, so a bot can hand work to a person.
- **Instances and admission.** The provider instances signed in on the bot's account, and the instance admission of §6.6.3, which keeps bots from starving people. Automatic model choice (D4) picks within those.
- **Containers later.** P4's Docker runner keeps the same account contract.

**This plan needs from Bot Architecture:**

- one bot engine that runs both personal and team bots, so the missing model path of Space bots is not rebuilt separately;
- grants that can name a project profile instead of raw credentials;
- event triggers (webhooks) that can reach a bot account through the team machine's exposed URL.

**Open between the two plans:** whether Space bots (`src/mms/bots/space/`) are retired in favour of team bots that answer in the team Space's channels. This plan assumes they are (A7).

**Already agreed:** #230's rule "Paid or shared bots stay off until spend can be reserved before each request" must be revisited with its owner. Team bots on T1 sign-ins are shared bots whose spend cannot be reserved on Claude Code. This plan proposes instance admission (§6.6.3) as the limit for subscription-backed bots, and real spend reservation only through the T2 gateway.

### 9.3 Bot UI (sibling plan `bot-ui`)

**This plan provides** for each bot: `owner` (a person or a team), `audience`, `account` and `machine`, the people who may steer it, and the instance it runs on with whose sign-in that is.

**This plan needs from Bot UI:**

- the bot side card shows which subscription the bot runs on and whether it is the team's or a person's, because in a team that is a cost question;
- the card shows when the bot is waiting because people are using the instance (§6.6.3).

---

## 10. Discussion with Fable (two rounds)

A Fable 5.1 subagent acted only as a critic and wrote no files. Its objections, and how each was resolved:

### Round 1

| # | Fable's challenge | Resolution |
|---|---|---|
| 1 | A persistent root "team host service" makes the team key root on every team machine, while the SSH bootstrap deliberately avoids sudo. | **Accepted.** No root daemon in P1. Privileged steps run only in `init` and `sync`, under the admin's own `sudo`, shown as a plan. Unattended provisioning is a later option (Q3). |
| 2 | "Machine attestation" attests nothing without a hardware root. | **Accepted.** Renamed to "machine registration", and no policy depends on it. |
| 3 | A team key on an admin's laptop blocks headless enrollment whenever the laptop is closed. | **Accepted.** The team authority lives in `mt-team` on the team machine, and admins hold recovery files. |
| 4 | A new `team_` principal rebuilds Spaces a third time and adds a third branch at every same-person check. | **Accepted with a change.** There is no new principal. Fable proposed a Space alone, but a Space cannot own devices. So the team is an ordinary Net user, which makes team-owned machines fall out of `NodeDelegation.owner`, plus a Space of kind `team` for membership. |
| 5 | Collaborator turns in the owner's personal daemon are a prompt-shaped shell into the owner's files, credentials and plan quota, with approvals going to an owner who may be offline. | **Accepted.** Principle 6.1.1: personal threads get viewer grants and handoff only. Live collaboration happens in project accounts. |
| 6 | Make the "CLI proxy" an API gateway with per-member keys, which doubles as the Mousse+ hosted gateway. Do not share Claude subscriptions. | **Partly accepted.** The founders asked for "reusing common AI subscriptions", and Mousse's case rests on subscriptions, so P1 shares *execution*: project and bot accounts sign in their own instances (T1) and no token moves. The gateway comes in P3 for API-key pooling and metering, and has a Mousse+ twin. Pooling personal plans stays a plugin with a terms warning. |
| 7 | The first P1 draft delivered identity and private threads: none of the "immediate need". | **Accepted.** P1 includes shared threads, team bots and team sign-ins. Presence moved to P2. |
| 8 | Encrypting `refs.json` adds little against an agent in the same account. Fix #358 first and use existing stores. | **Accepted.** #358 blocks P1, `hidepid=2` is added, and there is no new secrets format. |
| 9 | A team version pin cannot be enforced on macOS or on headless installs. | **Accepted.** Team machines update themselves, laptops get a nag and the existing contract refusals, and the channel travels in the invite link. |
| 10 | `--reference` clones break when the mirror prunes. | **Accepted.** The mirror never prunes, and clones use `--dissociate`. |

### Round 2

| # | Fable's challenge | Resolution |
|---|---|---|
| 11 | Making every project and bot daemon a node of the same team user undoes the OS-account boundary at the Mousse layer, because Bridge treats same-user nodes as one person's trusted devices. A prompt-injected bot could drive project threads. | **Accepted; it is now a principle (6.1.2).** Team nodes get minimal capabilities and block each other by default; pairs are opened by an admin, and a P1 acceptance test covers it. |
| 12 | A root key on the server is acceptable if `mt-team` never runs agents, recovery is held off the box, and rotation is tested. A team user has no Mousse ID binding, so there is no relay. | **Accepted.** `mt-team` refuses sends and has no instances. P1 includes a rotation runbook. P1 binds the team user to the creating admin's Mousse ID account (optional), and hosted team accounts come in P2 (Q6). k-of-n among admins was rejected as ceremony small teams will not perform. |
| 13 | Use Space streams for shared threads instead of relaxing the same-person rule. The `space.thread` execution binding already exists; terminals and the editor would not be available. | **Disagreed; kept routed access.** Reasons in §6.5.3: the full remote-thread view already exists, the stream path would need a second thread UI and rebuilt send, steer and approval semantics, and the exposure is limited by a deny-by-default `crossUser` column and a test over every row. Fable's point about scope is adopted: terminals, the editor, Undo and Publish are not cross-user in P1. |
| 14 | One project account is enough for a small team, but never fewer than two team accounts. Per-project accounts matter for credentials. | **Accepted.** The minimum is `mt-team` plus `mt-p-default`. Projects are separate sections from day one so they can be split later. The UI warns when a second project with credentials joins a shared account. |
| 15 | A team sign-in used by many people and bots is one rate window, and bots will starve people. Headless sign-in needs a story. | **Accepted.** Instance admission across threads with people before bots (§6.6.3), and `team account signin`. The terms concern is stated and steered toward team or business seats and API keys. |
| 16 | Member bootstrap is under-specified: the member must sign their own node's delegation, so their SSH key must be installed first. Team limits on a member's node cannot use per-device policy, which only the owner sets. | **Accepted.** Members' SSH keys are part of the team Space record and `sync` installs them. Team limits on member accounts are OS-level (systemd slice), not Mousse policy. |
| 17 | Contradictions with the meeting: one project account means agents see all shared threads there; moving a personal thread *into* a project is the common handoff and was missing; the wizard must drive the same plan as the CLI. Rename "trusted mode" so nobody reads it as isolated. | **Accepted.** Each is stated in §6.3.1. Handoff C was added, and `team host` produces a plan the wizard drives. The mode is called "shared-login mode". |

---

## 11. Assumptions, open questions and risks

### Assumptions (decided here; open to change)

- **A1.** Linux is the only supported team machine with several members. macOS and Windows get shared-login mode.
- **A2.** Admins are trusted with everything on team machines, and the plan promises nothing against them.
- **A3.** No long-running root process in P1. Account changes wait for an admin's `team host sync`.
- **A4.** The default team channel is `nightly` (M6). Teams can switch to `stable`.
- **A5.** "CLI proxy" means Mousse driving subscription-signed CLI agents. Sharing it means shared execution in project and bot accounts, not shared tokens.
- **A6.** Monetization stays off. Mousse+ is a boundary in this plan, not a feature.
- **A7.** Team bots replace Space bots as the way bots serve several people. To be confirmed with Bot Architecture.
- **A8.** Each queued human message is its own turn, with no merging.
- **A9.** A small team starts with one project account (`mt-p-default`) and splits when credentials must not mix.
- **A10.** In P1, the team user's Mousse ID binding, when used, belongs to the creating admin's account.

### Open questions

- **Q1.** Who may create projects and bot accounts: admins only (the default), or members when `membersMayCreateProjects` is on?
- **Q2.** Is the P0 memory measurement good enough for a 10-person team (about 15 daemons)? If not, idle daemons need to sleep, which needs its own design.
- **Q3.** Is unattended provisioning, a small root service limited to `mt-*` accounts, worth its risk for teams that add members often?
- **Q4.** Do Claude Code and Codex sign-ins survive in headless accounts with no desktop session (P0 spike)? If not, project accounts need API keys or the agent's own long-lived token command, and T1 becomes less attractive.
- **Q5.** Should a team admin get a "break glass" content view of a shared thread they are not a member of, recorded in the audit? Root can read it anyway; the question is only whether the product offers it.
- **Q6.** Does Mousse ID's hosted service model teams (directory, email invites, member limits), or only relay invite tokens? Its 5-device limit per account needs a rule for team accounts.
- **Q7.** Should Spaces' `historyVisibility: sinceJoin` be required before teams grow beyond close colleagues?
- **Q8.** Should the setup wizard (Mousse+) be the default way a team creates its first machine, with `team host init` as the manual path?
- **Q9.** Which provider plans' terms allow one seat on a machine to serve several people's prompts? This needs a check per provider before T1 is recommended in the UI.

### Risks

| Risk | Effect | Mitigation |
|---|---|---|
| Daemon memory per account | A 10-person team with 3 projects and 3 bots runs about 17 daemons | P0 measurement; one shared project account by default; Q2 |
| Spaces and Bridge are still behind flags and partly unqualified | Teams builds on code people do not use yet | P1 depends on them, so their qualification is part of P1 |
| A personal plan used by several people breaks the provider's terms | The team's account is suspended | T1 guidance and a UI warning; the gateway for API keys; pooling stays a plugin (D1); Q9 |
| Bots exhaust a shared plan window | People cannot work | Instance admission with people before bots and a reserve for people (§6.6.3) |
| The team machine is a single point of failure for the team's identity, and a compromise exposes the root | Losing or leaking the team user | `mt-team` runs no agents; off-machine recovery files; a tested rotation runbook; Space archives for backup (`docs/net/space-archive-operations.md`) |
| Same-person checks are spread over about 10 sites | A missed site leaks access | One `teamAccess` function, a test over every routed row, and a deny-by-default `crossUser` column |
| Agents in a shared project account share one shell user | One thread's agent can read another thread's worktree or secrets in that account | Stated in the UI; split into separate project accounts when it matters |
| Headless sign-ins and Linux keyrings | Claude Code may not keep its sign-in without a session keyring | P0 spike (Q4); file-based storage in private homes |

---

## 12. Top decisions

1. **The OS account is the isolation unit.** On a Linux team machine, each member, project and bot runs an unchanged single-user daemon in its own account. Team accounts block each other at the Mousse layer by default. macOS gets a labelled shared-login mode.
2. **The team is an ordinary Net user plus a team Space.** The team user's key lives in `mt-team`, which runs no agents. The team user owns the machines, and the team Space carries membership, roles and invites. No new kind of principal.
3. **Nobody drives someone else's personal thread.** Personal threads get read-only viewer grants and handoff by copy. Live multi-person work happens in shared threads in project accounts. Those are reached through Bridge's routed path, extended by one `teamAccess` decision and a deny-by-default `crossUser` column.
4. **Subscriptions are shared by running work where the sign-in lives.** Project and bot accounts have their own sign-ins, and no token moves. People go before bots on a shared plan. Bring-your-own covers personal work, an API gateway comes in P3, and pooling personal plans stays a plugin (D1).
5. **Every human message has an author set by the daemon.** Simultaneous messages queue one turn each in the Run Engine's order. Steering belongs to the driver and maintainers. Presence and typing are ephemeral and come in P2.

---

## 13. Related work check

Checked against `origin/master` at `e2015a41` on 4 November 2026: 8 open PRs, 76 open issues, PRs merged since 15 October, and remote branches with recent commits.

- **Already done:**
  - The MCP relay (#474, merged 2 November) covers most of M5's "run other MCPs".
  - Nightly builds and channel-following updates (#403, #570, #571).
  - Bridge remote threads in the same view as local ones (#372, #529).
  - Remote subagents (#472).
  - Personal bots with grants and the locked Claude runtime (#301, #304, #329).
  - Mousse ID join for computers and phones (#519, #554).
- **Still needed:** everything in §7. No open PR or branch touches teams, OS accounts, cross-user access, attribution or project profiles.
- **Conflicts:** #230 states "Paid or shared bots stay off until spend can be reserved before each request". Team bots on team sign-ins are shared bots, so P1's bot work needs that condition revisited with #230's owner (§9.2).
- **Will collide:**
  - The open model-catalog PRs (#537, #540, #541, #542) touch the provider and model listing that §6.10's plugin seam also touches. The seam lands after them.
  - #125 (update pill) touches `src/main/updates/`; §6.12 adds a CLI updater and leaves that module alone.
- **Related open issues:**
  - #358 (MCP token on the command line) is a P0 blocker.
  - #44 (Mousse Net) is the foundation P1 builds on.
  - #592 (permission changes apply only from the next message) matters for team permission ceilings.
- **Suggested order:**
  1. Fix #358.
  2. Run the P0 spikes.
  3. Let the model-catalog PRs land.
  4. Build P1 behind the `teams` flag, with the #230 condition settled first.
