#!/bin/bash
# Owned container session only; the image never changes host display/keyring state.
set -euo pipefail
unset ELECTRON_RUN_AS_NODE
if [[ ${DBUS_SESSION_BUS_ADDRESS:-} == '' ]]; then
  exec dbus-run-session -- "$0" "$@"
fi
export DISPLAY=:99 XDG_CURRENT_DESKTOP=GNOME
export XDG_RUNTIME_DIR=/tmp/mousse-linux-runtime
mkdir -p "$XDG_RUNTIME_DIR"; chmod 700 "$XDG_RUNTIME_DIR"
Xvfb "$DISPLAY" -screen 0 1280x720x24 -nolisten tcp >/tmp/mousse-xvfb.log 2>&1 &
xvfb_pid=$!
trap 'kill "$xvfb_pid" 2>/dev/null || true' EXIT
for i in {1..30}; do test -S /tmp/.X11-unix/X99 && break; sleep .1; done
# Task-local disposable password is read only from stdin, never argv or a log.
node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))' | gnome-keyring-daemon --unlock --components=secrets > /tmp/mousse-keyring-env
"$@"
