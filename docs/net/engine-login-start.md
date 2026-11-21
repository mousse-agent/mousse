# Start at login with the new networking

When a profile's networking is first turned on and Mousse does not start at login, Settings → Devices asks once:
"Start Mousse at login so your other computers can reach this one?"

- **Start at login** installs the startup entry that `mousse-cli service install` writes ([STARTUP.md](../STARTUP.md)).
- **Not now** changes nothing.
- The answer is kept for the installation (`<MOUSSE_HOME>/net-engine-login-start.json`), so the question does not
  come back for its other profiles. Until it is answered, it stays, across restarts.
- The networking never removes the entry. `mousse-cli service uninstall` does.

At login the entry runs `mousse-cli service run`. Once that daemon is ready, it starts the networking of each profile
whose switch is on (`ProfileHost.startNetworkedProfiles`), with no window open.

## Owner check `phase1b.login-start` (attested)

On the Mac, with the packaged app and helper builds under test:

1. Pair the Mac and the PC, and see the PC's row read Connected in Settings → Devices on the Mac.
2. Install the startup entry: answer **Start at login**, or run
   `/Applications/Mousse.app/Contents/Resources/mousse-cli service install`. Check with
   `mousse-cli service status` that it reads installed, and that `~/Library/LaunchAgents/com.ryspa.mousse.mms.plist`
   runs `Contents/Resources/mousse-cli`.
3. Quit Mousse (tray → Quit), so no daemon runs.
4. Restart the Mac. Log in, and do not open Mousse.
5. On the PC, the Mac's row in Settings → Devices must read Connected within 30 s of the login. Connected needs both
   directions, so the PC's row on the Mac is Connected too; opening Mousse on the Mac afterwards shows it.
6. Attest with both builds, the app's and the helper's.
