# Teams UI: plan

Status: plan only; nothing here is implemented. Written 2026-11-04 against `origin/master` at `e2015a41`, and simplified on 2026-11-05 (§10.1). One of four parallel plans: **Bot UI** (`bot-ui.md`), **Bot Architecture** (`bot-architecture.md`), **Teams UI** (this file), **Teams Architecture** (`teams-architecture.md`).

> **First build (11 November 2026).** A review against `master` at `1a23d270a` set the first slice and its decisions. They are recorded in [#866](https://github.com/mousse-agent/mousse/issues/866):
>
> - A team computer starts as one shared OS account, and its providers are for everyone.
> - Access follows the Teams UI model: a person is in a thread or not.
> - "Private" is not used, because it already means a thread that stays on this computer (`localOnly`).
> - A 7-day join link on Mousse ID points to a 24-hour Space invite bound to the person joining.
>
> Where this plan differs, #866 wins for the first build.


Mockups: [`docs/plans/mockups/teams-ui/`](mockups/teams-ui/), three static HTML files built from the Mousse app's own markup and stylesheet (§11). Each section below names the file and state that show it.

## 1. Summary

A **team** is a group of people who share computers and providers in Mousse. Members run threads on the team's computers from their own Mousse. They see their own threads and the threads shared with them, and they can share a thread or hand it to a teammate.

The design follows one rule: **a team adds people to things Mousse already has.** Apart from the team itself there is nothing new to learn: no new kind of access or message, and no new mode.

- One new place: the **Team** icon on the rail opens a page built like Settings, with three sections: Members, Computers, Providers.
- A thread is **private** (you and the people you add) or **open to the team**. Everyone in a thread can write in it and answer the agent.
- A provider signed in on a team computer is used by **Everyone** or **Only <person>**.
- **Hand off** makes someone else the thread's owner.

The design reuses what exists:

- Bridge's remote threads and per-device limits cover computers.
- The thread queue covers simultaneous messages.
- The model-switch marker is the model for the handoff divider.
- Settings → Providers covers sign-ins.

New work is mostly identity (a person on every message), per-thread access, and the Team page.

## 2. Inputs, goals and non-goals

### Founders' decisions treated as settled

- "Product focus is Teams (along with Moose+)." Teams is the main line of work this plan serves.
- "Grouping subscriptions will be a plugin, not a main feature." The core shows each subscription or key on its own. Pooling them is an extension (Phase 3).
- "Users will not construct workflow nodes; workflows are built by the bot" and "Bot model is auto-selected by default, changed by asking the bot rather than a slash command." These belong to the Bot plans. This plan adds no workflow or model-switch UI for bots.

### Goals, each tied to a meeting point

| Goal | Meeting point | Phase |
|---|---|---|
| G1. A team owns computers; members use them without seeing every team thread. | "A team, not a person, should own machines; members access team machines without seeing all team threads" | 1 |
| G2. Members reuse the team's AI access on team computers. | "Immediate need: shared environment reusing common AI subscriptions and CLI proxy" | 1 |
| G3. Threads are easy to share. Bots follow in Phase 2. | "with easy sharing of threads and bots" | 1 (threads), 2 (bots) |
| G4. A thread can be handed to a person. | "hand off threads to humans like agent context handoff" | 1 (plain), 2 (agent summary) |
| G5. Human avatars and typing indicators appear in threads. | "show human avatars and typing indicators" | 1 (avatars), 2 (typing) |
| G6. Simultaneous messages are queued and shown. | "simultaneous messages are queued" | 1 |
| G7. Invited people get a build new enough to join. | "need automatic nightly builds ... Invited users otherwise won't see the latest version" | 1 |
| G8. Projects bundle connections (Supabase, Vercel, GitHub) and skills. | "Moose MCP could hold project profiles (e.g. DinoMoney) ..." | 2 |
| G9. Team bots with their own GitHub account. | "Automated code review could be a scheduled Moose task with its own GitHub account" | 2 |
| G10. An entry point for a paid setup agent (Mousse+). | "a paid Moose setup wizard agent ... acting as a DevOps engineer" | 3 |

### Non-goals

- Pooling or grouping subscriptions in core (plugin, per the decision).
- A workflow builder of any kind.
- Containers per bot or per member. "Sandboxing now would be heavy; ... whole server as sandbox." The UI says plainly that hiding a thread does not protect its files (§4, assumption 4).
- A hosted web client for guests. Members use the Mousse app.
- Billing UI for Mousse+.
- Replacing Spaces. Standalone Spaces stay for groups that are not a team.

## 3. Current state and the gap

| Area | What exists (file) | Gap for Teams |
|---|---|---|
| People and identity | Net identity is one person (root key) plus their devices. `MemberRecord {user, rootKey, role, displayName}` in `src/shared/net/envelope.ts`. A Space owner's name defaults to the computer name (`src/mms/spaces/host/service.ts`, `create()`). The Mousse ID avatar is an initial (`src/renderer/components/MousseIdAvatar.tsx`), with "Mousse ID has no display name yet". `ProfileRecord {displayName, color, avatar?}` is in `src/shared/profiles/types.ts`. | No team or organisation object, no avatar image for a person in the network, and no human author on messages. |
| Machines | Bridge: remote threads, merged lists (`src/mms/bridge/routed/mergedLists.ts`), per-device switches and "Highest permission mode" (`src/renderer/components/NetDevicesSection.tsx`, `devices/DeviceLimitsDialog.tsx`, `devices/DeviceAccessRows.tsx`), add a machine over SSH (`devices/AddSshDeviceDialog.tsx`), editor connections over Net. | All of it is same-person only. No team-owned machines, and no limits for other people. |
| Spaces | Group chat hosted on its owner's computer. Roles `owner \| admin \| member` (`src/shared/net/capabilities.ts`). `sj1_` invites with a TTL of at most 24 h (`src/mms/spaces/host/invite.ts`). UI in Chats mode (`components/chats/ChatWorkspace.tsx`, `NetworkChatActions.tsx`, `ChatsSidebar.tsx`, `NetworkTranscript.tsx`). Behind `netSpaces`, default off (`src/shared/featureFlags.ts`). | No member list, role change or removal UI. Invite is a pasted string. `typing` and `presence.activity` are reserved in `src/shared/net/wire.ts` and unused. |
| Threads | `Thread` and `ChatMessage` (`src/shared/types.ts`) have no owner, visibility or human author. Only "from \<computer\>" (`hooks/useTurnSenders.ts` → `chat/components/agent-elements/user-message.tsx`). | Visibility, sharing, authorship, presence and typing are all missing. |
| Queue | Durable per-thread FIFO `QueuedMessage` with steer promotion (`src/shared/types.ts`). UI in `components/QueuedMessages.tsx`. Pending steers are joined into one text in `OrchestratorService.ts` (`drainEntry`). Normal items run one turn each. | No author on items. No rule for several people's items. |
| Handoff | A model switch records `contextHandoff {from, to}` (`src/mms/orchestrator/contextHandoff.ts`) and shows a divider. | No handoff to a person. Approvals always go to "the user". |
| Model access | Provider instances and private homes (`src/shared/providerInstances.ts`, `docs/PROVIDER_CREDENTIALS.md`). A remote thread uses its machine's sign-ins; its model picker reads `providers.snapshots` routed (`src/shared/bridge/routed.ts`). Usage page: `SubscriptionUsagePage.tsx`. | Nothing says whose access a thread uses or who may use it. No team keys or per-member seats. |
| MCP and skills | The MCP relay ("layer 2 Mousse MCP" in the meeting) is merged (#474): `src/mms/run/mcp/relay/*`, `McpRelaySettings` in `src/shared/integrations.ts`. Skills registry with project, profile and repository sources. `AGENTS.md` is read per turn (`src/mms/orchestrator/projectInstructions.ts`). Settings → Skills & MCP (`components/settings/SkillsMcpSettings.tsx`). Secret references: `src/mms/integrations/secrets.ts`. | No bundle per project, no team source for skills or MCP, and no Supabase, Vercel or GitHub connection model. |
| Bots | Personal bots (owner-only, `src/shared/bots/personal/definition.ts`), UI in Automations → Bots (`components/bots/BotsWorkspace.tsx`). Space bots register but have no runtime (`src/mms/bots/space/runtime/README.md`). | No team-owned bot, and no "share with team". |
| Updates | Nightly builds are automatic (`docs/releases.md`). The channel follows the installed build; stable never offers nightlies (#571). `UpdateChannel` and `setChannel` IPC exist (`src/shared/updates.ts`, `renderer/stores/updateStore.ts`). Contract versions are in `src/mms/contractVersions.ts`. | No team build choice, no version gate on joining, no invite download page. |
| Navigation | Rail: Home, Automations, Subscription usage, Settings (`NavigationRail.tsx`). Sidebar tabs Projects / Threads / Chats (`ThreadsSidebar.tsx`). Profile switcher (`components/profiles/ProfileSwitcher.tsx`). Side card sections Computer, Git, Actions, Lineage (`components/sideCard/`). | No place for a team. |

Channels were removed in #461, so the meeting's "removing channel features is still being considered" is already settled on `master`. Nothing in this plan depends on Channels.

## 4. Terms and assumptions

Proposed terms for `docs/GLOSSARY.md` once something ships:

- **Team:** people who share computers and providers. Each person is an **Admin** or a **Member**. Admins manage people, computers and providers; members use them. A team always has at least one admin.
- **Team computer:** a computer the team owns, which runs members' threads. It is not any one member's device. The UI says "computer", as Settings → Devices and the glossary already do. The meeting's "machine" is not used.
- **Team project:** a project that lives on a team computer. Its threads run there.
- **Open to the team:** a thread that everyone in the team can open. Otherwise a thread is private: its owner and the people added to it.
- **Hand off:** making another person the owner of a thread.

Assumptions, each made without asking the founders:

1. **"CLI proxy" means the team computer runs the subscription CLIs** (Claude Code, Codex, Grok) and Mousse drives them for members. That is how a remote thread works today. Using team access from a member's own laptop is Phase 3.
2. **Identity without Mousse ID.** A person is their Net root key plus a self-signed name and picture (64 KB at most). With Mousse ID, the invite dialog also takes email addresses.
3. **A team builds on the Space roster.** The Teams Architecture plan decides this; the UI assumes one membership system.
4. **Hiding is not secrecy.** A private thread is hidden from other members' lists and APIs. Admins of the computer can still read its files. The Computers page says so.
5. **Mousse+ is an optional hosted service.** The README and glossary say "There are no paid plans". Changing that wording is an open question (§9).
6. **Teams ships behind a profile feature flag** (`netTeams`, default off), like `netBridge` and `netSpaces`.

## 5. Design

**Where it lives.** A new rail icon, **Team**, sits between Automations and Subscription usage. It opens the **Team page**: the same overlay page as Settings (back arrow, a left nav with coloured icon tiles, grouped rows) with three sections: Members, Computers, Providers. With several teams, the page title switches teams.

**The sidebar does not change shape.** It keeps one list, as the README promises ("every thread, on any of them, shows up in one list"). Team projects carry a small team badge. A shared thread row shows the avatar of the last other person who wrote in it. There are no filter chips and no lock icons.

**Team projects.** "Open project" asks one more question when you are in a team: *Personal* or *Acme*. For Acme, you pick a team computer and the repository is cloned there. Anyone in the team can add a team project.

### 5.1 Create a team and invite people · [`01-getting-started.html`](mockups/teams-ui/01-getting-started.html), states 1–2

- **Create a team:** a dialog with the team name, its icon and your name. Your name defaults to the profile's display name, not the computer name, which fixes the Spaces default. Nothing else is asked; computers and providers are added later from the Team page.
- **Invite people:** a dialog with one link and a Copy button. The link works for 7 days. Anyone who opens it appears in Members as "wants to join", with Approve and Decline. With Mousse ID, the same dialog also takes email addresses.

### 5.2 Join, and get a build that can · [`01-getting-started.html`](mockups/teams-ui/01-getting-started.html), states 3–5

- **Link page** (`mousse.work/join/<team>#<invite>`): "Join Acme on Mousse", one **Download** button for the visitor's system, and "I have Mousse · open the invite". The download is the version the team's computers run, whether that is Stable or Nightly. The visitor is not asked to choose a channel. The invite stays in the URL fragment, so the web server never receives it.
- **Join dialog:** who invited you, your name and picture, and one sentence: "Acme sees your name and the threads you share. Your other threads and this computer stay private."
- **Too old to join:** the same dialog says "Update Mousse first" with the versions, and the button becomes **Update and join**. Mousse restarts once and opens the invite again. The check uses the compatibility the team's computers advertise, not the channel name. A member on a *newer* build than the team's computers joins normally.

### 5.3 Members · [`02-team-page.html`](mockups/teams-ui/02-team-page.html), Members

- A list of people: picture, name, email or "joined with a link", and a role (Admin or Member).
- People waiting to join, with Approve and Decline.
- **Invite** opens the invite dialog (§5.1).
- **Remove** is in each row's menu. Its confirmation says what happens in one paragraph:
  - they lose access to the team's computers;
  - their running threads stop, and their threads on team computers move to you;
  - their messages in shared threads stay.

### 5.4 Computers · [`02-team-page.html`](mockups/teams-ui/02-team-page.html), Computers and Add a computer

- A list of team computers: name, system, how many people are working there, and online status. Thread titles are never shown here.
- **Add computer:** an SSH address and a name, or one command to run on the computer (`mousse-cli team join tj1_…`). This reuses `AddSshDeviceDialog`.
- **For members:** one setting, **Highest permission mode**, the most a member's agent may do without asking. It is the existing device limit, applied to members. Admins can go higher.
- Each row's menu has Update and Remove. Team computers update to the team's version together, at night in the computer's time zone.

### 5.5 Providers · [`02-team-page.html`](mockups/teams-ui/02-team-page.html), Providers

- A list of what is signed in on team computers: provider, whose key or subscription it is, where it is signed in, and **who can use it**: **Everyone** or **Only <person>**.
- **Sign in** reuses the Settings → Providers flow, aimed at a team computer.
  - Members can sign in their own subscription, which is then **Only them**.
  - Admins can also add keys for Everyone.
- One line under the list: "Most personal subscriptions are for one person. Choose Everyone only if its plan allows it."
- Usage stays where it is today, on the Subscription usage page.

This replaces the earlier three kinds (team key, own seat, shared seat) with one question that has two answers.

### 5.6 Start a thread in a team project · [`03-working-together.html`](mockups/teams-ui/03-working-together.html), state 1

- Picking a team project in the composer fills in its computer.
- The model picker has two groups:
  - **Acme:** models from providers open to everyone;
  - **Yours:** models from your own sign-ins on that computer.
- One line under the composer says where the thread runs and who sees it: "Runs on acme-build-1, the project's computer. Only you see it until you share it."
- **New threads are private.** The meeting asked that members not see every team thread. One click in Share opens a thread to the team.

### 5.7 Working together in a thread · [`03-working-together.html`](mockups/teams-ui/03-working-together.html), state 2

- **Authors.** Every message shows its author's picture and name: mine on the right, others' on the left. The daemon stamps the author from the authenticated caller, so a client cannot name someone else. The current "from \<computer\>" stays as a detail.
- **Queue.** While a turn runs, anyone's message is queued, as today, with the author's picture on the row. Each queued message is its own turn, in order. People edit or remove only their own items, and Steer works only on your own item.
- **Approvals.** Anyone in the thread can answer the agent's questions and approvals. The transcript records who answered.
- **Typing** (Phase 2). "Priya is typing…" shows above the composer. It is never stored.
- **Side card.** It gets two new sections:
  - **People** lists who is in the thread, with a Share button.
  - **Runs on** replaces Computer for team threads. It shows the computer and its status, and whose access the thread uses ("Acme's Claude key"), with Terminal and Open in editor.
- **Computer offline.** The thread shows one banner, "acme-build-1 is offline", and becomes read-only. Messages wait in the queue until it is back. There is no mockup; it is one banner.

### 5.8 Share · [`03-working-together.html`](mockups/teams-ui/03-working-together.html), state 3

The Share popover has:

- a search box: "Add people from Acme…";
- the people in the thread, each with a remove button (the owner is marked);
- one switch: **Everyone in Acme can open it**;
- **Copy link** (a `mousse://` link that works only for people with access);
- **Hand off…**

Everyone in a thread can do everything in it. Only the owner can change who is in it, hand it off or delete it. Personal threads on personal computers never appear to the team.

### 5.9 Hand off · [`03-working-together.html`](mockups/teams-ui/03-working-together.html), states 4–5

- **Dialog:** pick a person (someone not in the thread is added) and add an optional message. "They become the owner and get a notice. You stay in the thread."
- **Effect:**
  - ownership changes;
  - the recipient gets a desktop notice;
  - the thread shows in their sidebar;
  - the transcript gets a divider in the style of the model-switch marker: "Sam handed this thread to Priya · 11:20".
- **The message** shows under the divider, marked "to Priya · the agent doesn't see this". It is the only message in Mousse that does not reach the agent.
- **Later.** In Phase 2, a switch in the same dialog asks the agent for a handoff summary, and the agent can ask for a person with the app tool `request_person`.

### 5.10 Later, and where it goes

Each later feature fits into a place that already exists. None adds a new section to the Team page.

- **Project connections and skills** (G8, Phase 2): a project's menu gets **Project settings**. It holds connections (Supabase, Vercel, GitHub) reached as MCP tools through the MCP relay, the project's skills, and a plain notice that agents can read these credentials.
- **Team bots** (G9, Phase 2): Automations → Bots gets a **Share with Acme** switch and a "Runs on" choice. The bot page itself belongs to the Bot UI plan.
- **Setup agent** (G10, Phase 3): one option in Add a computer, "Let the setup agent do it", marked Mousse+.
- **Subscription grouping** (Phase 3): an extension adds a provider entry to the Providers list.
- **Personal threads** (Phase 2): "Hand to a person" and "Move to a team project" appear in a personal thread's Share popover.

## 6. Phases and acceptance criteria

**Phase 1: "a shared computer with private threads".** It covers G1, G2, G3 (threads), G6, G7, and part of G4 and G5.

- Create a team. The Team page with Members, Computers and Providers. Link invites with approval, the link page, the join dialog, and Update and join.
- Team computers added over SSH or with the join command. The members' permission limit.
- Providers with Everyone or Only <person>.
- Team projects. Private threads by default. The Share popover. Authors on messages and queued items. Anyone in a thread answers approvals.
- The plain handoff, and Remove member.

Acceptance:
- [ ] Two people on two computers join one team. One adds a server over SSH, and both run threads on it from their own Mousse.
- [ ] A private thread never appears in another member's lists, search, CLI or remote APIs. Adding that member, or opening it to the team, makes it appear within a second while both are online.
- [ ] Every message shows its real author. A client that sends another author's id is refused.
- [ ] With two people sending during a running turn, the queue shows both items with their authors, and they run as two turns in order.
- [ ] Anyone in a thread can answer an approval, and the transcript records who did.
- [ ] Handoff changes the owner, adds the divider, notifies the recipient, and the handoff message is absent from the agent's input.
- [ ] A provider set to Only Priya is not offered to anyone else, and a member's thread cannot select it through the API.
- [ ] An invitee on a too-old build sees Update and join, updates, and lands back on the join dialog.
- [ ] Removing a member ends their access on every online team computer and moves their threads to the person who removed them.
- [ ] Each team thread's Runs on names the computer and whose access it uses.

**Phase 2: "the team's stack".** It covers the rest of G3, G4 and G5, plus G8 and G9.

- Typing and presence.
- An agent-written handoff summary. The agent can ask for a person.
- Project settings with connections and skills.
- Team bots.
- Hand a personal thread to a person, or move it to a team project.

Acceptance:
- [ ] A DinoMoney thread can query Supabase staging through a relayed MCP tool, with no credential in the member's own environment.
- [ ] A team reviewer bot comments on a PR as its own GitHub account, from a team computer.
- [ ] "Typing" disappears within 6 s of the last keystroke.

**Phase 3: "beyond the box".** It covers G10 and the rest of G2.

- The setup agent (Mousse+).
- Subscription grouping as an extension.
- Team providers used from a member's laptop, for keys only, never personal subscriptions.
- An audit view for admins. Teams on the phone.
- Containers per bot.

## 7. Contracts with the sibling plans

**Reconciling with the Teams Architecture draft** (`docs/plans/teams-architecture.md`):

| Teams Architecture | This plan's UI | Status |
|---|---|---|
| Team = a Space with `kind: 'team'` on `space.meta` (§6.2) | One roster, one invite | Agreed |
| `driver` and `assignee` (§6.6.4, §6.8 A) | The UI shows only the **owner**. Handoff sets the owner, and `assignee` follows it. Anyone in the thread answers approvals. | Simplified; no "Approvals go to" control |
| One turn per queued message (§6.6.2) | The same, with no merging | Agreed; no `queue.merge` needed |
| Presence in P2 (§6.7) | Typing and presence in Phase 2 | Aligned |
| Handoff kinds B and C (§6.8) | Personal-thread handoff in Phase 2 | Aligned |
| T0 own plans; T1 team sign-ins; T2 gateway; T3 grouping (§6.10) | Only <person> = T0 on a team computer; Everyone = T1; laptop use = T2 (Phase 3); grouping = T3 (Phase 3) | Agreed; the UI shows two choices, not four tiers |
| "Project profile" (§6.11) | "Project settings", Phase 2 | Open: the UI no longer needs a name for the bundle (§9) |
| `request_person {who?, reason}` (§6.8) | The agent asks for a person, Phase 2 | Agreed |

**Teams Architecture must provide the following.** The UI depends on each item.

1. **A team object:** id, name, icon, roles (`admin | member`), a signed roster with a name and picture per person, and link invites that last 7 days, with approval of each person.
2. **Team computers:** membership of a computer in a team, the members' highest permission mode, a working-now count, and update together.
3. **Thread access:** on `Thread`, an `owner`, a list of people, and `openToTeam: boolean`. Filtering happens in the daemon for lists, search, events, replay, the CLI and Bridge routes, not in the renderer.
4. **Authorship:** an `author` on `ChatMessage` and `QueuedMessage`, stamped by the daemon. One message kind, the handoff message, is kept out of the agent's input.
5. **Handoff:** an event that changes the owner, with the optional message.
6. **Provider access:** for each sign-in on a team computer, `usableBy: 'everyone' | <person>`, enforced when a turn starts.
7. **Compatibility advertised by team computers**, for Update and join and for the link page's download.
8. **Phase 2:** typing and presence, the handoff summary, `request_person`, project settings with connections and skills.

**Bot UI and Bot Architecture:** a bot owner can be a team, placed on a team computer, with its own GitHub account (Phase 2). Team admins can answer a team bot's walls.

**Extensions (#568):** a contribution point that adds a provider entry to Team → Providers and picks one of several keys or subscriptions when a turn starts (Phase 3).

## 8. Related work (checked 2026-11-04, rechecked 2026-11-05: no new team PRs or issues)

Checked against `origin/master` at `e2015a41`: all 8 open PRs, the 373 PRs merged since 2026-10-17, all 76 open issues, and remote branches active since 2026-10-21.

- **Already done:**
  - MCP relay (#474), which is the "layer 2 Mousse MCP" the meeting proposed. Phase 2 project settings build on it.
  - Automatic nightlies, and "a stable build always follows stable releases" (#571).
  - Adding a remote machine over SSH (#274) and editor connections (#391, #393). Team computers reuse both.
  - Personal bots on Claude Code (#289, #301, #304, #329).
  - Channels removed (#461).
- **Still needed:** everything in §6. No open PR or branch touches teams, thread visibility, message authorship, presence or typing.
- **Related open work:**
  - #476 (update all of a user's computers together): updating team computers together should share its mechanism.
  - #568 (extensions page): hosts the subscription-grouping plugin.
  - #125 (update pill; it adds Settings → Updates with the channel): the version gate's "Install and restart" should use the same updater states.
  - #44 (Mousse Net): the network the team sits on.
  - #488 (agents start or link threads) and #569 (computer use) are adjacent but independent.
  - #545 and #546 (queue readability and shortcuts): the queue with authors (§5.7) should land after or with them, since they change `QueuedMessages.tsx`.
- **Will collide:** #125 touches the updates UI that §5.2 uses. Land #125 first.
- **Conflicts:** none found. `docs/mousse-collaboration-plan.md` (Sept) proposed "shared conversation, explicit action" for a shared *room*. This plan keeps that rule for team chat (the Chats surface). Inside a *thread* every message goes to the agent (§10).

## 9. Open questions and risks

**Open questions for the founders**

1. **Mousse+ wording.** The README says "No paywalls … no feature behind a plan", and the glossary says "There are no paid plans". Meeting 1 names a paid setup agent and Mousse+. Either the wording changes to "the app is free; optional hosted services are paid", or the setup agent is free.
2. **Everyone on a personal subscription.** This plan allows it with one line of warning, because small teams will do it anyway. The alternative is to allow Everyone only for API keys and leave shared subscriptions to the grouping extension.
3. **Private by default.** New team threads start private, following "without seeing all team threads". A team that wants openness by default would need a team setting. This plan leaves the setting out until someone asks for it.
4. **One name for project bundles** in Phase 2: "project settings" (this plan), "project kit" or "project profile" (the meeting and the Teams Architecture draft). "Profile" already means one person's data in an installation.
5. **Admin audit:** should admins see the titles of private threads on team computers? This plan says no.

**Risks**

- **Terms of service.** Sharing a personal subscription may break its provider's terms. Mitigations: the warning line, and Only <person> as the default for subscriptions.
- **False sense of privacy.** Private hides a thread; it does not encrypt it. The Computers page says that admins of a computer can read its files.
- **One computer as a single point of failure.** When a team computer is offline, its threads are read-only (§5.7). Updates happen at night.
- **Fewer controls may be too few.** Removed items can come back if teams ask for them: per-computer access lists, a view-only level, merging queued messages, and notes. Each one would add a choice to every thread or every computer, so each needs a real request first.

## 10. Discussion with Fable, and the simplification pass

Two rounds with a Fable discussion partner (claude-fable-5-1) shaped the first version of this plan. The table keeps those points, with the current resolution after §10.1.

| Point Fable raised | Resolution |
|---|---|
| The MVP should be the laptop side first, sharing seats through each member's local picker. | **Kept team computers first.** Remote threads, the remote model picker and editor connections already exist. Laptop use is Phase 3. |
| Own seats on an admin's box are not private. | **Adopted.** The Providers page says what is signed in where; the privacy line covers files on the computer. |
| Shared seats exhaust the donor's rate limit. | **Simplified.** Only <person> is the default for subscriptions, and Everyone carries a warning. Usage stays on the Subscription usage page. Live quota meters were dropped. |
| Avatars and names need an identity that works without Mousse ID. | **Adopted** (assumption 2). Key fingerprints were dropped from the UI in §10.1. |
| A team should be a Space, to avoid several membership systems. | **Adopted for the data model.** The UI names a Team; the roster is one. |
| Private-by-default is a promise the computer cannot keep. | **Partly.** Threads start private (the meeting's requirement). The copy says hiding is not secrecy. |
| In a thread, human chatter collides with the agent. | **Every message goes to the agent.** People talk in team chat. The only people-only message is the handoff message. Notes were dropped in §10.1. |
| Batch, don't run each queued item as its own turn. | **One turn per message**, as in the Teams Architecture draft. Send together was dropped in §10.1. |
| Typing indicators don't prevent collisions. | **Adopted.** Typing is Phase 2 and is not the collision fix; the visible queue is. |
| "Driver" is the wrong word; anyone collaborating should be able to grab approvals. | **Adopted, further:** anyone in the thread answers approvals, and there is no "Approvals go to" control. |
| The agent-written handoff summary should be optional. | **Adopted.** The plain handoff is Phase 1. The summary is a Phase 2 switch. |
| Kits: "members don't see raw secrets" is false when an agent has a terminal. | **Adopted** for Phase 2 project settings. |
| Missing: who pays, remove member, notifications, degraded states, first run. | **Covered:** Runs on, Remove member, desktop notices, the offline banner, the join flow. |
| The version gate should use advertised compatibility, not the channel name. | **Adopted** (§5.2). |

### 10.1 Simplification pass (2026-11-05)

Feedback on the first mockups was that the design was too complex. This pass removed whatever a team can do without on day one, or what an existing place already covers:

| Removed or merged | Why |
|---|---|
| Overview page and Get started checklist | The Members and Computers pages show what is missing. |
| Team settings, Projects and Bots sections of the Team page | Team name and leave go in the page title's menu. Projects stay in the sidebar. Bots stay in Automations (Phase 2). |
| Three kinds of model access (team key, own seat, shared seat) | One question, "who can use it", with two answers. |
| Quota meters in the picker and side card | Usage already has a page. |
| "Builds the team uses" choice | The link page offers what the team's computers run. Compatibility, not the channel name, decides. |
| Three-step create dialog | Name only. Computers and invites come after. |
| Separate version-gate dialog | Merged into the join dialog as Update and join. |
| View vs collaborate | Everyone in a thread can do everything except manage access. |
| "Project members" general access | Two states: private, or open to the team. |
| Notes, and the Agent/Note composer switch | Every message goes to the agent. People talk in team chat. |
| Send together, the queue order line, steer limits | One turn per message, in order. You act on your own items. |
| "Approvals go to" | Anyone in the thread answers. Hand off changes the owner. |
| Facepile, presence dots | Phase 2, with typing. |
| "Waiting for you" list on Home | A desktop notice and the thread in the sidebar. |
| Sidebar filter chips and lock icons | A team badge on projects is enough. |
| Per-computer access lists, terminals and editor switches, quiet hours | One team setting: members' highest permission mode. |
| Role matrix and key fingerprints in Members | Two roles, described in one sentence. |
| Mousse+ cards in five places | One option in Add a computer, in Phase 3. |

## 11. Mockup index

| File | States |
|---|---|
| [`01-getting-started.html`](mockups/teams-ui/01-getting-started.html) | Create a team · Invite people · The invite link in a browser · Join · Join, when this Mousse is too old |
| [`02-team-page.html`](mockups/teams-ui/02-team-page.html) | Members · Computers · Add a computer · Providers |
| [`03-working-together.html`](mockups/teams-ui/03-working-together.html) | Start a thread in a team project · Two people and an agent · Share · Hand off · After the handoff |

How they are built: each state starts from a DOM snapshot of the real Mousse desktop app (build 0.1.2-local.20261103.2, default "mousse dark" theme, acrylic off). Scripted edits change the content using the app's own components and class names:

- the title bar, rail and sidebar;
- the transcript and the permission request;
- the queued messages and the composer;
- the side card;
- Settings groups, dialogs and the model picker.

The few new elements use only the app's design tokens: author pictures, the typing line and the handoff divider. Each file carries only the CSS rules of the app's stylesheet that its markup matches. Icons come from the app's own Hugeicons set. The Geist fonts load from `mockups/teams-ui/assets/`. Each window is 1440×900 and scales to fit.
