# Run the app in a development environment

Read this only when a change needs a direct check in the running app.

The user's installed Mousse (stable or nightly) is in daily use. It owns `~/.mousse`, its Electron user data, its background service (daemon), the installed app files and their launchers. To see a change working, run the app from the task's worktree in a development environment, never through the installed app or a packaged build.

- Start it with `npm run dev`, or `npm run dev:mms` for the daemon alone. By default these keep everything under `<worktree>/.mousse-dev/runtime` (Mousse home, Electron user data, browser and artifacts) and pick a renderer port from the checkout path, so each worktree runs beside the installed app and beside other worktrees. If two worktrees get the same port, set `MOUSSE_RENDERER_PORT`.
- Never use the real home from a checkout: do not run `npm start` or `npm run preview`, set `MOUSSE_DEV_USE_GLOBAL=1`, or point `MOUSSE_HOME` at `~/.mousse`. If the checkout's `.mousse-dev/dev.json` sets `"useGlobalHome": true`, run with `MOUSSE_DEV_USE_GLOBAL=0`.
- Send CLI commands to the development daemon with `node out/cli/index.js --home <worktree>/.mousse-dev/runtime …`. The installed `mousse-cli`, or any command without a development home, talks to the user's daemon.
- Scripted or headless runs (CDP, a fake provider) use the same isolated paths: set `MOUSSE_HOME` and `MOUSSE_ELECTRON_USER_DATA` under the worktree, and do not pass the agent's own provider credentials through. A new development home has no providers or sign-ins; add what the test needs there.
- Do not build installers or AppImages (`npm run dist*`) to test a change. Do not install or launch a packaged build, edit launchers or icons, or stop, restart or signal the installed app or its daemon. A packaged build uses the installed app's home and user data, and on Linux it rewrites the user's launchers when it starts. Build, install or restart the real app only when the user asks for it.
- Never write to `~/.mousse` or the installed app's user data. Stop the development app and daemon you started before handing back.
