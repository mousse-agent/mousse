# Mousse UAT Checklist

User acceptance testing checklist for Mousse v0.1.0. Run through each section on your target platform (Windows/macOS). Mark items **Pass**, **Fail**, or **N/A** and note any issues.

**Prerequisites**

- [ ] App builds and launches (`npm run dev` or packaged build)
- [ ] At least one LLM provider configured (API key or OAuth)
- [ ] A git repository available to open as a project (for project-scoped features)

---

## 1. Window & Chrome

- [ ] Custom title bar renders (logo, sidebar toggle, settings, window controls)
- [ ] No File / Edit / View menu buttons beside the logo
- [ ] Drag title bar to move window
- [ ] Minimize, maximize/restore, and close work (Windows)
- [ ] Traffic lights work (macOS)
- [ ] Snap to top edge enters full-work-area mode; drag down restores
- [ ] Resize window respects min size (900×600)
- [ ] **Acrylic themes only:** window is translucent when focused
- [ ] **Acrylic themes only:** window becomes opaque/solid when unfocused (click another app)
- [ ] **Acrylic themes only:** transparency returns when window is focused again
- [ ] Solid themes (Dark, Light, System) remain opaque regardless of focus

---

## 2. Threads Sidebar

- [ ] Toggle sidebar via title bar panel icon
- [ ] Resize sidebar via drag handle
- [ ] **Projects:** open folder adds project to list
- [ ] **Projects:** expand/collapse project sections
- [ ] **Projects:** rename via context menu
- [ ] **Projects:** pin/unpin project
- [ ] **Projects:** remove project
- [ ] **Threads:** create new thread (global and per-project)
- [ ] **Threads:** select thread loads its chat history
- [ ] **Threads:** rename thread
- [ ] **Threads:** pin/unpin thread
- [ ] **Threads:** delete thread
- [ ] **Threads:** context menu actions work
- [ ] **Search:** open thread search dialog
- [ ] **Search:** find threads by query; selecting result switches thread
- [ ] Navigate to **Scheduled** page from sidebar
- [ ] Navigate to **Channels** page from sidebar
- [ ] Divider between Projects and Threads sections resizes correctly

---

## 3. Main Agent Chat

- [ ] Chat history loads for active thread
- [ ] Send a text message; assistant responds (provider configured)
- [ ] Streaming response renders incrementally
- [ ] Markdown, code blocks, and syntax highlighting display correctly
- [ ] Tool/timeline messages render in chat
- [ ] Switch chat mode (e.g. Agent / Ask / custom skills)
- [ ] Select LLM provider and model from composer footer
- [ ] Attach file(s) to message; send with attachment
- [ ] Remove attached file before send
- [ ] Voice recording: start, stop, preview duration
- [ ] Send message with voice attachment
- [ ] Context usage indicator opens and shows token estimate
- [ ] Loading state shows while waiting for response
- [ ] New thread starts with empty chat
- [ ] Thread switch preserves per-thread message history

---

## 4. Main Area Panel

- [ ] Toggle main area panel (show/hide right panel)
- [ ] Resize chat vs main area via vertical divider
- [ ] **Agent CLI** tab shows agent terminal view
- [ ] **Browser** tab: navigate to URL
- [ ] **Browser** tab: back, forward, reload
- [ ] **Browser** tab: URL bar edit and submit
- [ ] **Terminal** tab: shell session starts
- [ ] **Terminal** tab: type commands; output appears
- [ ] **Terminal** tab: resize reflows terminal
- [ ] **Files** tab hidden without project; visible with project open
- [ ] **Files** tab: file tree lists project files
- [ ] **Files** tab: select file loads content in editor
- [ ] **Files** tab: edit file marks dirty; Save persists changes
- [ ] **Files** tab: refresh file tree
- [ ] **Git** tab: status shows changed files
- [ ] **Git** tab: view diff for a file
- [ ] **Git** tab: commit with message
- [ ] **Git** tab: push (if remote configured)
- [ ] **Git** tab: branch list and checkout

---

## 5. Agents & Tasks Window

- [ ] Open from Agents button in chat header (popover window)
- [ ] Popover closes when clicking outside main window
- [ ] **Environment** section lists local branches and agent worktrees
- [ ] Switch worktree; git status and diff stats update
- [ ] Create worktree from environment section
- [ ] Running agents list updates in real time
- [ ] Task queue shows pending / in-progress / completed / failed
- [ ] Close button dismisses popover

---

## 6. Settings

- [ ] Open settings from title bar gear icon
- [ ] Close settings (back or overlay dismiss)
- [ ] Sidebar section navigation scrolls to correct section
- [ ] **Profile:** edit username; persists on blur/Enter
- [ ] **Profile:** shuffle random username
- [ ] **Profile:** line-edit heatmap loads and displays activity
- [ ] **Appearance:** switch theme (Dark, Light, System, acrylic variants)
- [ ] **Appearance:** change accent color; UI updates live
- [ ] **Providers:** add provider via API key
- [ ] **Providers:** add provider via OAuth (if supported)
- [ ] **Providers:** remove / log out provider
- [ ] **Orchestrator:** change default LLM provider and model
- [ ] **MCP:** list configured MCP servers
- [ ] **MCP:** test server connection
- [ ] **MCP:** restart server
- [ ] **Skills:** list global and project skills
- [ ] **Skills:** refresh skills registry
- [ ] **Agents:** enable/disable agent types
- [ ] **Agents:** set per-agent model and headless mode
- [ ] Restart prompt appears when theme material change requires it (Windows)

---

## 7. Scheduled Jobs

- [ ] Open Scheduled page from threads sidebar
- [ ] Back button returns to main app
- [ ] Scheduler status displays (running / idle)
- [ ] Create job with name, prompt, and schedule preset
- [ ] Job appears in list with next run time
- [ ] **Run now** executes job immediately
- [ ] **Pause** stops future runs
- [ ] **Resume** re-enables job
- [ ] **Delete** removes job
- [ ] Refresh updates job list
- [ ] Job state labels update (scheduled, running, paused, completed, error)
- [ ] Close main window with active jobs hides to tray (does not quit)

---

## 8. Channels

- [ ] Open Channels page from threads sidebar
- [ ] Back button returns to main app
- [ ] Platform cards show Telegram, Discord, Webhook
- [ ] Edit channel config (tokens, URLs, allowed chats, etc.)
- [ ] Save config persists settings
- [ ] Connect individual platform
- [ ] Disconnect platform
- [ ] Connection state updates (connecting → connected / error)
- [ ] Pairing requests list loads (when applicable)
- [ ] Approve / reject pairing code
- [ ] Send test message to configured chat
- [ ] Activity feed shows inbound/outbound events
- [ ] Incoming channel message routes to orchestrator thread

---

## 9. System Tray & Lifecycle

- [ ] Tray icon appears (when supported)
- [ ] Tray **Show Mousse** restores window
- [ ] Tray **Quit** exits application
- [ ] Double-click tray icon shows window
- [ ] Second app instance focuses existing window (single-instance lock)
- [ ] App restart from settings works

---

## 10. Data Persistence

- [ ] Threads survive app restart
- [ ] Chat messages survive app restart
- [ ] Projects list survives app restart
- [ ] Settings survive app restart
- [ ] Scheduled jobs survive app restart
- [ ] Channel config survives app restart
- [ ] Line-edit stats accumulate over sessions

---

## 11. Error Handling & Edge Cases

- [ ] Send message without provider shows sensible error
- [ ] Invalid browser URL handled gracefully
- [ ] Git operations on non-repo path show error
- [ ] File save errors surfaced in UI
- [ ] Channel connect failure shows error state
- [ ] Scheduled job failure shows error state
- [ ] Very long thread titles truncate without breaking layout
- [ ] Narrow window width: sidebars and panels remain usable

---

## 12. Automated Tests (optional)

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes (channels, scheduled jobs, line-edit stats)

---

## Sign-off

| Tester | Date | Platform | Build | Pass / Fail |
|--------|------|----------|-------|-------------|
|        |      |          |       |             |

**Notes:**
