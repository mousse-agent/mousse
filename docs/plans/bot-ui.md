# Bot UI plan

Plan slug: `bot-ui`. One of four parallel planning threads: **Bot UI** (this), Bot Architecture, Teams UI, Teams Architecture.

Status: planning only. No product code, issues or PRs. Checked against `origin/master` at `33c119e5` (5 Nov 2026).

**Revision 3 (5 Nov 2026): simplified.** The earlier design (an Automations page with a timeline and event log, a bot side card, a model menu, servers, computer use) was too complex. Owner feedback:

> "this UI is toooo complex, we are aiming to build something simple"
> "adding a bot should be extremely easy - just click a plus button in the Chats Tab … rename "Roster" to "Bots", then the user needs to select an icon for the Bot -> fill in a short description -> that's it -> the bot is created, the model should be completely hidden, don't even list it in the composer."

The bot chat layout follows a reference image the owner shared, which matches the app's existing Chats surface (`ChatWorkspace`): avatar, name and time per message, small activity chips, and a plain composer.

## Mockups

[`docs/plans/mockups/bot-ui/`](mockups/bot-ui/). Each screen is the real Mousse desktop app, built from `origin/master` at `a6e46bbe` (Mousse dark). It was captured live from the Agents tab (the former Chats tab) of an isolated copy, then edited with the Chats surface's own markup and CSS. Each file is self-contained HTML with no network use. [`source/README.md`](mockups/bot-ui/source/README.md) explains how they are made.

| # | Mockup | States |
|---|---|---|
| 01 | [Bots in the Agents tab](mockups/bot-ui/01-bots-in-chats.html) | no bots yet; a few bots, one working |
| 02 | [New bot](mockups/bot-ui/02-new-bot.html) | pick a look (colour, accessory, Shuffle); an optional name; write what it should do; created, and it asks for its first permission |
| 03 | [Talking to a bot](mockups/bot-ui/03-bot-chat.html) | working; asks for something new; schedule and trigger set by asking; error; the bot menu; About this bot |
| 04 | [Bot faces](mockups/bot-ui/04-bot-faces.html) | live 3D: the New bot picker with avatars at 40 and 34 px; the six feelings; the 12 accessories |

---

## 1. The rules

Every later decision in this plan follows these five rules.

1. **One place.** Bots live in the Agents tab (called Chats until early November 2026), in the section now called Roster, renamed **Bots**. No new page, tab or rail icon.
2. **Little to fill in.** A look (a clay mouse in a colour with one accessory, already picked for you), an optional name and one sentence. Without a name, the bot names itself.
3. **No model anywhere.** Not in the dialog, not in the composer, not in the header, not in About. Mousse picks it.
4. **Everything else by asking.** What it does, when it runs, what it may use, its name: the user says it in the chat, and the bot confirms in plain words with one chip.
5. **One menu, one panel.** The bot's ⋯ menu (About this bot, Rename, Change look, Pause, Delete) and the About panel are the only extra surfaces.

### 1.1 The founders' notes, mapped to the rules

Quotes are from the founders' notes of 17 Oct and 29 Oct 2026.

| Founders' note | In this plan |
|---|---|
| "Creating a bot: name and icon, then chat; it requests permissions over time and becomes more automatic" | A face, a name and one sentence, then chat (§4.2). The name is optional; without one it is generated from the sentence. Permissions are asked for in the chat, one at a time (§4.5). |
| "Pro users can request all permissions upfront" | No separate mode. A user who wants that says so: "ask me for everything you'll need now". The bot then asks in a row of requests (§4.5). |
| "Base model should be auto-picked from the user's subscriptions … so non-experts can use bots" | Yes, and fully hidden (§4.7). |
| "Users switch models by asking the bot … maybe a sidecard selector on PC" | Dropped from the UI. Asking still works ("think harder", "be quicker"), but nothing names a model (§4.7). |
| "Bot sidecard should show agentic activity (browsing), permissions, and current model" | Activity is shown as chips in the chat. Permissions are in About this bot. The model is not shown (§4.4, §4.8). |
| "Proposed single page combining bots and scheduled tasks as a timeline plus event log history" | Not in this plan. A bot's chat is its history. Scheduled tasks stay where they are in Automations (§4.10). |
| "Event triggers (e.g. new GitHub PR …)" | Set by asking, confirmed with a chip, listed in About (§4.6). |
| "No dedicated workflow viewer; bot can render the workflow visually on request" | Yes. The chat already renders Mermaid, so no UI work is needed (§4.10). |
| "plan to make remote setup easy via Moose CLI over SSH, whole server as sandbox" | No bot-specific UI. Settings → Devices already sets up SSH machines. Placement is Bot Architecture's (§4.10). |
| "computer use as required for bots" | Later. When it comes, it is a chip in the chat that opens the screen (§4.10). |

### 1.2 Non-goals

- Any bot settings form, a model picker, a permissions page, a timeline or an event log.
- A bot-specific page, rail item or sidebar tab.
- Node editing of workflows (founders: "Users will not construct workflow nodes").
- Space bots and team bots: Teams UI owns adding a bot to a group or Space (§6.2).
- Backend design: Bot Architecture owns runtimes, enforcement, triggers and isolation. This plan lists what the UI needs (§6.1).

---

## 2. Current state

Read from `origin/master` at `33c119e5`.

- **Chats tab** (`src/renderer/components/chats/ChatsSidebar.tsx`), the third tab in the Home sidebar:
  - **Roster** (`:39-42`) shows `snapshot.agents` (published agent definitions) as avatars. Its + button opens Automations (`setScheduledOpen(true)`, titled "Manage agents"). When empty it says "Create and publish an agent in Automations to start a chat."
  - **Groups**, then **Recent** (direct chats).
- **Chat view** (`ChatWorkspace.tsx`):
  - The header shows avatar, name, `@slug · This device`, and a member count.
  - The transcript uses `chat-participant-message` (avatar, name, runtime badge, time, Markdown).
  - The status line reads "<name> working…".
  - The composer has Mention, "Agents run on this device" and send/stop. It has no model picker.
  - Questions use `ComposerQuestionModal` in `.chat-approval`.
- **Avatars** (`ChatAvatar`) are a coloured square with the first letter. The colour comes from a hash of the name (5 colours).
- **New chat dialog** (`NewChatDialog.tsx`) picks agents for a direct chat or a group.
- **Personal bots** (backend, `src/shared/bots/personal/*`, `src/mms/bots/*`):
  - **Definition:** `name, role, main, context[], permissions, triggers`. It has **no icon or description field**.
  - **Threads:** each bot has a home thread `bot:<id>`. Runs start child threads `bot:<id>:act:<actId>`.
  - **Walls:** when a run needs something outside its grant, it raises a wall and waits up to 30 min for the owner.
  - **Grantable tools:** only `web_search` and `web_fetch` (`BOT_APP_TOOLS`). Shell and MCP are refused as `policy_unenforceable`.
  - **Runtime:** bots run on the locked Claude Code runtime (#301).
  - **Owner input:** refused on bot threads (`bot_thread_read_only`).
  - **Editor:** the bot editor is a form in Automations → Bots (`BotsWorkspace.tsx`).
- **Models:** there is no automatic model. The default is the last one used.
- **Channels** (Telegram, Discord, webhook) were removed in #461.

### 2.1 The gap

| Wanted | Today |
|---|---|
| + in Bots makes a bot | + opens Automations. Bots and chat agents are separate things. |
| A face and one sentence | A form with name, role, instructions, model, tools and limits. There is no icon. |
| Chat with the bot | The owner can't type into bot threads. |
| Asks for permissions in the chat | Walls are answered in a separate inbox in Automations. |
| Schedules by asking | Bots can't call the schedule tools. Bot schedules are form fields. |
| Hidden automatic model | The default model is the first one in the list. |

---

## 3. Related work

Checked open PRs, issues created since 3 Nov, and PRs merged since 4 Nov (5 Nov 2026), on top of the full check from 4 Nov.

- **Already done:** #461 (channels removed), #301 (locked runtime), #304 (walls), #435 (inline permission requests in a turn), #472 (remote subagents).
- **Still needed:** everything in §4. No open PR or branch implements it.
- **Will collide:**
  - #590 ("Approval requests in a thread have no color") and #591 (stop button while waiting for approval) touch the same approval look that the ask card (§4.5) should share.
  - #595 ("Agents can only get secrets by asking you to paste them into the chat") is how a bot gets account access (Gmail in the mockups). The ask card should use its answer, never a pasted token.
  - The model catalog PRs (#537, #540–#542) feed the hidden automatic choice (§4.7). They add no UI here.
- **Conflicts:** none.

---

## 4. Design

### 4.1 Where bots live ([mockup 01](mockups/bot-ui/01-bots-in-chats.html))

- The Agents tab's **Roster** section is renamed **Bots**. On master the tab is labelled Agents and Roster lists agent definitions; this plan keeps the tab name and lists the owner's bots by the face each owner picked (§4.3).
- **+** next to Bots opens New bot (§4.2). It no longer opens Automations.
- **When empty,** the section reads "No bots yet. Press + to make one." The empty Chats page shows a face, reads "Make your first bot" and has a New bot button.
- **The face shows the state** by its motion, with no status dot (§4.3). Recent says the same thing in words ("Working…", "Wants to send email as you", "Needs you: sign in again", "Paused").
- **A bot's chat** is a direct chat (§4.4), so it also appears in Recent like any other chat.
- **Groups** stays as it is. Bots can be added to a group later (Teams UI).
- **Agent definitions** no longer appear in this row. They stay in Automations → Agents for subagents and advanced use.

### 4.2 New bot ([mockup 02](mockups/bot-ui/02-new-bot.html))

One small dialog in the Chats dialog style (`chat-dialog`):

1. **Pick a look.** The dialog opens with one already picked: a colour and accessory the owner's other bots don't use yet (§4.3). A large live preview sits on the left. On the right are the eight colours and the 12 accessories, each accessory shown on the mouse. **Shuffle** under the preview picks both. Most owners will not touch any of it.
2. **Name.** One line, optional. The placeholder says "Optional. Leave it empty and the bot names itself."
3. **What should it do?** One text box. The placeholder gives an example: "every morning, tell me which emails need a reply."
4. **Create bot.** It is enabled once the sentence is written.

If the name is left empty, the bot names itself from the sentence ("Inbox helper"). Either way it can be renamed from its menu or by asking. There are no model, permission, schedule or device fields.

The chat opens at once. The bot's first message:

- says, in one or two sentences, what it understood;
- asks for the first thing it needs, if anything (for example "read your Gmail").

If the sentence is unclear, it asks one question instead.

### 4.3 Bot faces ([mockup 04](mockups/bot-ui/04-bot-faces.html))

Each bot is a small 3D clay mouse, on theme with the name Mousse. The owner picked the direction from a family of matte clay mice, each in one bold colour with one chunky accessory, after earlier rounds of hand-drawn SVG mascots and dessert characters were judged not cute enough. Three references shaped it:

- **ChatGPT's dots.** Soft, fuzzy or clay characters in one bold colour each, told apart by their outline and one big accessory, with a "Customize your dot" picker.
- **Reddit's Snoo builder.** One base character that people dress up, so every avatar is personal and still recognisably the same mascot.
- **Simple faces carry feeling.** Two solid dark pill eyes whose size, slant and shape show the mood. No white in the eyes, no glossy anime eyes.

A face is a **look**, drawn live:

- **Colour** (8): coral, orange, yellow, green, teal, blue, purple, pink. It sets the body.
- **Accessory** (12, each in one fitting colour of its own): none, headphones (black), glasses (black), beret (black), goggles (brown leather), beanie (grey), cap (navy), crown (gold), bow tie (black), scarf (red), chef hat (white), hood (grey hoodie).

That is 96 looks. A new colour costs nothing, and a new accessory is a small shape in code, not new artwork. Every mouse is the same character: big round ears, a round head on a short body, big solid pill eyes, a dot nose, whiskers, tiny arms and feet, and a curled tail.

The bot stands on its own: no circle, tile or badge behind it. Lists, the header and messages show the head (40 px; 48 px in the Bots row) so the face stays big; About and the empty page show the whole mouse (88 to 104 px). Whiskers are dropped below about 56 px, where they turn to noise.

**New bots get distinct looks.** The first pick is the least-used accessory among the owner's bots, then the least-used colour, so the Bots row never starts with two identical mice.

**The feeling is the state.** The eyes carry it, and the ears, head and body back them up. The same mouse is used in the Bots row, Recent, the chat header, messages and About:

| State | Mouse |
|---|---|
| Idle | glances around, blinks, an ear twitches, breathes slowly |
| Working | holds a small laptop, looks down and reads along a line, paws tap |
| Needs you | eyes widen, ears up, waves one paw, two small hops |
| Stuck (error) | eyes slant down at the outer corners, ears droop, head tilts, a sweat drop, an occasional shiver |
| Paused | eyes close into soft curves, head drops, deep slow breaths, a floating "z" |
| Done | happy ^ ^ eyes, arms up, little bounces, tail wags |

Messages in the transcript keep the idle mouse. With reduced motion turned on, the mice are still and the pose alone shows the state.

**Rendering.** The app draws the mice with one WebGL fragment shader (signed distance fields, about 20 KB, no library): one shared canvas for all visible avatars, each drawn into its own viewport, with a cache of frames per look and state so long lists cost little. Off-screen mice don't animate. The mockups use frames baked from the same shader; `source/mice3d/mice.html` is the working reference and a live demo (the same file is mockup 04).

### 4.4 The bot's chat ([mockup 03](mockups/bot-ui/03-bot-chat.html))

The Chats layout, as in the reference image:

- **Header:** the face, the name, and the description sentence under it. On the right is a single ⋯ menu. There is no `@slug`, device or member count.
- **Messages:** the owner's own messages are right-aligned bubbles in a soft accent colour, with the time under them and no avatar or name. The bot's messages are full width, with its face, name, time and text. Activity is a row of small chips under the message. Each chip has an icon, a few words and an optional highlighted part ("read 41 emails", "drafted 3 replies · Gmail drafts", "sent 1 email · to Ana Costa"). There is never a tool log, command output or a diff.
- **While working:** one status line ("Inbox helper is working…") with a spinning chip for the current step. Send becomes Stop.
- **Composer:** text, attach and send. There is **no** model, effort, Mention or "runs on this device".

### 4.5 Asking for permission

- The first time the bot needs something new, its message carries an **ask card**: "Inbox helper wants to **send email as you**", one line explaining the limit, and **Not now** / **Allow**.
- **Allow** is remembered for this bot and listed in About, where it can be removed. After an answer, the card becomes one line: "✓ Allowed: send email as you".
- **Not now:** the bot says what it couldn't do and carries on without it.
- **While the owner is away:** a scheduled run that needs a new permission sends one notification and waits. The bot's dot and Recent line say "Wants to …". Further runs skip that step until the owner answers. There is one ask per permission at a time, never a pile.
- **Account sign-ins** (Gmail, GitHub) open the browser or a device code. Tokens are never pasted into the chat (#595).
- **Asking for everything upfront** is a chat request ("ask me now for all you'll need"). The bot answers with its ask cards in one message.

### 4.6 Schedules and triggers, by asking

- "Do this every weekday at 9" leads to "Done. I'll go through your inbox every weekday at 9:00" with a chip **every weekday · 09:00**.
- "Tell me right away if Maya writes" leads to a chip **new email from · Maya Chen**, with the honest delay in words ("within 5 minutes"), because triggers poll first.
- Each one is listed in About under **Runs**, with Remove. Results arrive as ordinary messages from the bot in its chat, and as a notification.

### 4.7 The model

- **Hidden.** Mousse picks the model from the user's signed-in subscriptions (Bot Architecture's automatic choice). It never appears in the UI.
- **No subscription signed in:** the bot's first message says so in plain words, with a **Sign in** button that opens Settings → Providers. It does not name models.
- **Asking** ("think harder", "be quicker", "use Opus") is accepted and acted on without showing a model name. The bot replies "Okay, I'll take more time on this", not "Switched to …".

### 4.8 The menu and About this bot

- **⋯ menu:** About this bot, Rename, Change face, Pause, Delete bot.
- **About this bot:** a narrow panel on the right of the chat, opened from the menu or by clicking the header. It shows:
  - the large face, the name and the description;
  - **Can use:** each allowed permission, with Remove;
  - **Runs:** each schedule and trigger, with Remove;
  - **Pause** and **Delete**.

  That is all. There is no model, folder picker, limits, log or device. Editing the description is asking the bot to change.

### 4.9 States

The UI shows only these states:

| State | Face (§4.3) | Recent line | In the chat |
|---|---|---|---|
| idle | blinks | last message | — |
| working | bobs, looks around | "Working…" | status line, Stop |
| needs you (ask) | hops, ring | "Wants to …" | ask card |
| stuck (error) | frowns, shakes | "Needs you: …" | red error line |
| paused | asleep, faded | "Paused" | one line: "Paused. Resume" |

- **Errors** are one red line in the bot's message with one way out: "Gmail sign-in expired. **Sign in again**". The bot adds what it will do next ("I'll try again as soon as you sign in").
- **Usage limits:** "Paused until 14:00 (your Claude usage limit)". The model is not named.
- **Repeated failures:** after three failed runs, the bot pauses its schedules and says so once.

### 4.10 Left out on purpose

Each of these stays out of the bot UI. If needed later, it appears in the chat.

- **An Automations page for bots, the timeline and the event log.** The chat is the history. Scheduled tasks stay in Automations as they are.
- **Workflow diagrams.** "Show me how you work" is answered with a Mermaid diagram, which the chat already renders.
- **Bot servers.** If a request needs more than this computer allows, the bot says so and offers one button, **Set up a server**. It opens the existing SSH setup in Settings → Devices.
- **Computer use.** Later, as a chip ("using the browser on build-01") that opens the screen with Stop.

---

## 5. Phases

### Phase 1: simple bots on this computer

- Rename Roster to Bots; + opens New bot; bot faces with animated states.
- New bot dialog; the bot takes the given name or names itself, and sends its first message.
- The owner can chat with the bot; chips for activity; the plain composer.
- Ask cards for permissions, remembered per bot; About with Remove; Pause and Delete.
- Schedules by asking.
- The hidden automatic model.
- Notifications for "needs you" and for results.

Phase 1 abilities are what Bot Architecture can enforce on this computer. Today that is web search and fetch, and the folders it grants. The Gmail example in the mockups shows the flow; it needs account access, which is Phase 2.

### Phase 2: accounts, triggers, servers

- Account sign-ins for bots (Gmail, GitHub) through the browser or a device code.
- Triggers by asking (polling).
- The **Set up a server** button when a request needs one.
- Bots in groups (with Teams UI).

### Phase 3

- Computer use as a chip and screen.
- Answering ask cards from the phone.

---

## 6. Cross-topic contracts

### 6.1 With Bot Architecture

Names are proposals; Bot Architecture owns the final shape.

| # | Contract | Used for |
|---|---|---|
| C1 | **Create from a face and a sentence.** `bots.create {face: {colour, accessory}, name?, description}` returns the bot with its `name` (generated when none is given); the description becomes its instructions; the first message is produced at once. | New bot |
| C2 | **Owner chat on the home thread.** The owner's messages on `bot:<id>` start a turn; `bot_thread_read_only` is lifted for the owner there. The chat is exposed to the Chats surface as a direct chat. | the chat |
| C3 | **Activity summaries.** Per turn, short `{icon, text, highlight?, live}` items for chips; no raw tool calls in this chat. | chips |
| C4 | **Ask.** A permission request becomes `{botId, requestId, title, note}` shown in the chat; answers `allow \| not_now`; allowed items persist per bot with `list` and `revoke`. One open ask per permission; runs skip that step while it waits. | ask card, About |
| C5 | **Schedules and triggers as bot tools.** The bot can add or remove its own schedules and polling triggers when the owner asks, and returns a short label for the chip; `list` and `remove` for About. | §4.6 |
| C6 | **Hidden model.** The model is resolved per turn from subscriptions; the bot can change speed or depth when asked, without the UI receiving a model name. "No subscription" and "usage limit until T" come as states. | §4.7, §4.9 |
| C7 | **State.** `idle \| working \| needs_you \| paused` plus an error text with one action. | dot, Recent line |
| C8 | **Definition fields.** `face {colour, accessory}`, `description`. Unknown values fall back to a default, so looks can gain colours and accessories later. | faces, header |

### 6.2 With Teams UI and Teams Architecture

- **The Chats tab is shared.** Teams UI keeps team chat on the Chats surface (`teams-ui.md`: "team chat *is* the Chats surface"). This plan no longer proposes removing it. Bots is a section in it, beside Groups.
- **The face** (§4.3) should be the same for a bot in a group or Space, and Teams UI's presence row can use its states.
- **A team bot** uses the same chat, ask card and About panel, with the audience shown. Teams UI owns where team bots are listed.
- **Shared subscriptions:** the hidden automatic model may use a team subscription. That is never shown either. Teams Architecture decides whether it is allowed.

---

## 7. Open questions and risks

### 7.1 Open questions

1. **Bots vs agent definitions in the Chats tab.** This plan lists only bots in the Bots row. Should published agents still be reachable from Chats (for example through New chat), or only from Automations?
2. **The name.** Resolved: the dialog has an optional Name field; left empty, the name is generated from the sentence and can be changed from the menu.
3. **Custom faces.** Should users be able to upload a picture or ask the bot to draw its own face? Proposal: not in Phase 1; 96 looks are enough to tell bots apart. More colours and accessories can be added over time with the same rules.
4. **Notification volume** for frequent results. Proposal: one notification per bot message, and none for chips.

### 7.2 Risks

| Risk | Mitigation |
|---|---|
| Hiding the model hides cost: a bot may quietly use an expensive model. | Bot Architecture's automatic choice picks the cheapest model that can do the job. Usage limits show as a pause with a time. |
| "Everything by asking" makes settings hard to find. | About lists everything the bot may use and every schedule, each removable, so nothing is hidden. |
| The chat promises more than this computer allows. | The bot says plainly what it can't do and offers one way forward (sign in, or set up a server). |
| A one-sentence description is vague. | The bot asks one clarifying question in its first message. |
| Live 3D faces add GPU work to the renderer. | One shared renderer, frames cached per face and state, no animation off screen or with reduced motion. If that is still too heavy, bake each face's frames once when it is created and play them as images, as the mockups do. |

---

## 8. Discussion with Fable

Two rounds with a Fable 5.1 subagent shaped revision 2. The points that still apply to the simple design:

- **One ask per permission, kept until answered**, with runs skipping that step instead of piling up requests (§4.5). Fable showed that the 30-minute wall timeout would otherwise create a new request every half hour.
- **The bot cannot change its own permissions.** It can only ask; the owner answers.
- **Honest trigger delays.** Triggers poll, so the chat says "within 5 minutes" (§4.6).
- **Credentials per bot**, never pasted into the chat (§4.5).

The following were dropped by the simplification:

- the change-proposal cards;
- the model menu and model refusals;
- the page-level timeline;
- the computer-use controls;
- the bot-server steps in the UI.

No new Fable round was held for this revision.

---

## 9. Acceptance criteria

### Phase 1

- [ ] The Chats tab shows **Bots** where Roster was, with a + button that opens New bot.
- [ ] New bot has three inputs (a look, already picked and changeable by colour, accessory and Shuffle; an optional name; a description) and one button. Create bot is disabled until the description is written.
- [ ] After Create, the bot appears in Bots and Recent with its face and the given or generated name, and its chat opens with the bot's first message.
- [ ] No screen in the bot flow names a model: not the dialog, header, composer, messages or About.
- [ ] The composer in a bot chat has only text, attach and send/stop.
- [ ] Activity appears as chips under the bot's message, never as tool rows.
- [ ] The first use of a new permission shows an ask card. Allow is remembered and listed in About; Remove takes it back; Not now continues without it.
- [ ] "Do this every weekday at 9" adds a schedule confirmed with a chip and listed in About; Remove stops it.
- [ ] The face shows each state by motion as in §4.3 (and stays still with reduced motion); Recent says it in words; an error shows one red line with one action.
- [ ] Rename, Change face, Pause and Delete work from the ⋯ menu.

### Phase 2

- [ ] A bot can sign in to an account through the browser or a device code, with no token pasted into the chat.
- [ ] "Tell me when …" adds a polling trigger confirmed with a chip and listed in About.
- [ ] When a request needs a server, the bot offers Set up a server, which opens the existing SSH setup.
