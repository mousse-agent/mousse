@echo off
setlocal
rem The packaged console-subsystem host provides a real Windows TTY. It also
rem keeps the daemon process separate from the Start Menu GUI executable.
set "MOUSSE_CLI=1"
"%~dp0mousse-cli.exe" --cli %*
exit /b %ERRORLEVEL%
