@echo off
setlocal
rem An editor's ssh runs "net ssh-proxy" on every reconnect. Starting the whole app for it takes about
rem 0.7 s; the proxy is a script of its own that runs on the app's runtime as plain Node in about 0.06 s.
rem (No label and no parenthesized block: %* is expanded whatever the arguments are.)
set "MOUSSE_SSH_PROXY="
if /i "%~1"=="net" if /i "%~2"=="ssh-proxy" if exist "%~dp0resources\app.asar" set "MOUSSE_SSH_PROXY=1"
if defined MOUSSE_SSH_PROXY set "ELECTRON_RUN_AS_NODE=1"
if defined MOUSSE_SSH_PROXY "%~dp0mousse-cli.exe" "%~dp0resources\app.asar\out\cli\ssh-proxy.js" %*
if defined MOUSSE_SSH_PROXY exit /b %ERRORLEVEL%
rem The packaged console-subsystem host provides a real Windows TTY. It also
rem keeps the daemon process separate from the Start Menu GUI executable.
set "MOUSSE_CLI=1"
"%~dp0mousse-cli.exe" --cli %*
exit /b %ERRORLEVEL%
